import type { Pool, PoolClient } from 'pg';
import {
  MAX_CHECKPOINT_STATE_BYTES,
  CHECKPOINT_PROTOCOL,
  CHECKPOINT_VERSION,
  parseCheckpointRequest,
  type CheckpointReceipt,
  type CheckpointRequest,
} from '@code-along/contracts/collaboration';
import {
  CheckpointStoreError,
  mergeBinaryState,
  stateHash,
  validateInitialState,
} from './binary-state.ts';

export interface DocumentScope {
  readonly document_id: string;
  readonly generation: number;
}
export interface StoredState extends DocumentScope {
  readonly binary: Uint8Array;
  readonly durable_revision: string;
  readonly state_sha256: string;
}
interface WriteResult {
  state: StoredState;
  receipt?: CheckpointReceipt;
}

interface StateRow {
  generation: string;
  binary_state: Buffer;
  durable_revision: string;
  state_sha256: string;
}
interface ReceiptRow {
  observed_counter: string;
  request_sha256: string;
  durable_revision: string;
  state_sha256: string;
}

const MAX_CAS_ATTEMPTS = 8;
const MAX_PENDING_WRITES = 32;

/**
 * Storage proof against checkpoint_proof fixture tables. No DDL or authorization.
 * The transport must authorize every call; IDs/counters never grant permission.
 */
export class CheckpointStore {
  private readonly tails = new Map<string, Promise<void>>();
  private pending = 0;

  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  private enqueue<T>(scope: DocumentScope, work: () => Promise<T>): Promise<T> {
    if (this.pending >= MAX_PENDING_WRITES) {
      return Promise.reject(new CheckpointStoreError('resource_limit'));
    }
    const key = scope.document_id;
    this.pending += 1;
    const operation = (this.tails.get(key) ?? Promise.resolve()).then(work);
    const tail = operation.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    return operation.finally(() => {
      this.pending -= 1;
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
  }

  private async transaction<T>(
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    let client: PoolClient | undefined;
    let discard = false;
    const disconnected = () => {
      discard = true;
    };
    try {
      client = await this.pool.connect();
      client.on('error', disconnected);
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await client.query("SET LOCAL statement_timeout = '3s'");
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query('SET LOCAL synchronous_commit = on');
      const result = await work(client);
      await client.query('COMMIT');
      return result; // A receipt is exposed only after COMMIT succeeds.
    } catch (error) {
      if (client) {
        try {
          await client.query('ROLLBACK');
        } catch {
          discard = true;
        }
      }
      if (error instanceof CheckpointStoreError) throw error;
      throw new CheckpointStoreError('storage_unavailable');
    } finally {
      if (client) {
        client.release(discard);
        client.off('error', disconnected);
      }
    }
  }

  private async readState(
    client: PoolClient,
    scope: DocumentScope,
  ): Promise<StoredState> {
    const metadata = await client.query<{ generation: string }>(
      'SELECT generation::text FROM checkpoint_proof.document WHERE document_id = $1',
      [scope.document_id],
    );
    if (metadata.rows[0]?.generation !== String(scope.generation)) {
      throw new CheckpointStoreError('generation_mismatch');
    }
    const result = await client.query<StateRow>(
      `SELECT generation::text, binary_state, durable_revision::text, state_sha256
       FROM checkpoint_proof.document_state WHERE document_id = $1 AND generation = $2`,
      [scope.document_id, scope.generation],
    );
    const row = result.rows[0];
    if (!row) throw new CheckpointStoreError('storage_unavailable');
    if (stateHash(row.binary_state) !== row.state_sha256) {
      throw new CheckpointStoreError('storage_unavailable');
    }
    return Object.freeze({
      ...scope,
      binary: Uint8Array.from(row.binary_state),
      durable_revision: row.durable_revision,
      state_sha256: row.state_sha256,
    });
  }

  load(scope: DocumentScope): Promise<StoredState> {
    const captured = Object.freeze({
      document_id: scope.document_id,
      generation: scope.generation,
    });
    return this.transaction((client) => this.readState(client, captured));
  }

  async initialize(
    scope: DocumentScope,
    seed: Uint8Array,
  ): Promise<StoredState> {
    const captured = Object.freeze({
      document_id: scope.document_id,
      generation: scope.generation,
    });
    if (seed.byteLength > MAX_CHECKPOINT_STATE_BYTES) {
      return Promise.reject(new CheckpointStoreError('resource_limit'));
    }
    const binary = validateInitialState(Uint8Array.from(seed));
    return this.enqueue(captured, () =>
      this.transaction(async (client) => {
        await client.query(
          `INSERT INTO checkpoint_proof.document_state
         (document_id, generation, binary_state, durable_revision, state_sha256)
         SELECT document_id, generation, $3, 0, $4
         FROM checkpoint_proof.document WHERE document_id = $1 AND generation = $2
         ON CONFLICT (document_id) DO NOTHING`,
          [
            captured.document_id,
            captured.generation,
            binary,
            stateHash(binary),
          ],
        );
        return this.readState(client, captured);
      }),
    );
  }

  saveState(scope: DocumentScope, state: Uint8Array): Promise<StoredState> {
    const captured = Object.freeze({
      document_id: scope.document_id,
      generation: scope.generation,
    });
    if (state.byteLength > MAX_CHECKPOINT_STATE_BYTES) {
      return Promise.reject(new CheckpointStoreError('resource_limit'));
    }
    const binary = Buffer.from(state);
    return this.enqueue(
      captured,
      async () => (await this.write(captured, binary)).state,
    );
  }

  saveCheckpoint(frame: unknown): Promise<CheckpointReceipt> {
    const decoded = parseCheckpointRequest(frame);
    if (!decoded.ok) {
      return Promise.reject(
        new CheckpointStoreError(
          decoded.error === 'message_too_large'
            ? 'resource_limit'
            : 'invalid_state',
        ),
      );
    }
    const request = decoded.value;
    const incoming = Buffer.from(request.state_base64, 'base64');
    const scope = Object.freeze({
      document_id: request.document_id,
      generation: request.generation,
    });
    return this.enqueue(scope, async () => {
      const result = await this.write(scope, incoming, request);
      if (!result.receipt)
        throw new CheckpointStoreError('storage_unavailable');
      return result.receipt;
    });
  }

  private toReceipt(
    request: CheckpointRequest,
    state: Pick<StoredState, 'durable_revision' | 'state_sha256'>,
  ): CheckpointReceipt {
    return Object.freeze({
      protocol: CHECKPOINT_PROTOCOL,
      version: CHECKPOINT_VERSION,
      type: 'checkpoint.receipt',
      document_id: request.document_id,
      generation: request.generation,
      client_session_id: request.client_session_id,
      checkpoint_id: request.checkpoint_id,
      observed_counter: request.observed_counter,
      durable_revision: state.durable_revision,
      state_sha256: state.state_sha256,
    });
  }

  private async write(
    scope: DocumentScope,
    incoming: Buffer,
    request?: CheckpointRequest,
  ): Promise<WriteResult> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const result = await this.transaction(async (client) => {
        const stored = await this.readState(client, scope);
        if (request) {
          const old = await client.query<ReceiptRow>(
            `SELECT observed_counter::text, request_sha256, durable_revision::text, state_sha256
             FROM checkpoint_proof.checkpoint_receipt
             WHERE document_id=$1 AND generation=$2 AND client_session_id=$3 AND checkpoint_id=$4`,
            [
              scope.document_id,
              scope.generation,
              request.client_session_id,
              request.checkpoint_id,
            ],
          );
          const receipt = old.rows[0];
          if (receipt) {
            if (
              receipt.observed_counter !== String(request.observed_counter) ||
              receipt.request_sha256 !== stateHash(incoming)
            ) {
              throw new CheckpointStoreError('checkpoint_conflict');
            }
            return {
              state: stored,
              receipt: this.toReceipt(request, receipt),
            };
          }
        }
        const merged = mergeBinaryState(stored.binary, incoming);
        const digest = stateHash(merged);
        const update = await client.query<{ durable_revision: string }>(
          `UPDATE checkpoint_proof.document_state
           SET binary_state=$3, state_sha256=$4, durable_revision=durable_revision+1
           WHERE document_id=$1 AND generation=$2 AND durable_revision=$5
           RETURNING durable_revision::text`,
          [
            scope.document_id,
            scope.generation,
            merged,
            digest,
            stored.durable_revision,
          ],
        );
        const revision = update.rows[0]?.durable_revision;
        if (!revision) return null; // Lost CAS: reload and merge in a new transaction.
        if (request) {
          await client.query(
            `INSERT INTO checkpoint_proof.checkpoint_receipt
             (document_id,generation,client_session_id,checkpoint_id,observed_counter,
              request_sha256,durable_revision,state_sha256)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [
              scope.document_id,
              scope.generation,
              request.client_session_id,
              request.checkpoint_id,
              request.observed_counter,
              stateHash(incoming),
              revision,
              digest,
            ],
          );
        }
        const state = Object.freeze({
          ...scope,
          binary: Uint8Array.from(merged),
          durable_revision: revision,
          state_sha256: digest,
        });
        return request
          ? { state, receipt: this.toReceipt(request, state) }
          : { state };
      });
      if (result) return result;
    }
    throw new CheckpointStoreError('storage_unavailable');
  }
}
