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
  readonly project_id?: string;
  readonly file_id?: string;
  readonly initial_sha256?: string;
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
const MAX_PENDING_BYTES = 8 * MAX_CHECKPOINT_STATE_BYTES;

export type WriteGuard = () => void;
const unguarded: WriteGuard = () => undefined;
function captureScope(scope: DocumentScope): DocumentScope {
  return Object.freeze({
    document_id: scope.document_id,
    generation: scope.generation,
    ...(scope.project_id === undefined ? {} : { project_id: scope.project_id }),
    ...(scope.file_id === undefined ? {} : { file_id: scope.file_id }),
    ...(scope.initial_sha256 === undefined
      ? {}
      : { initial_sha256: scope.initial_sha256 }),
  });
}

// Closed mappings only: callers cannot supply SQL identifiers or arbitrary tables.
const TABLES = Object.freeze({
  proof: {
    state: 'checkpoint_proof.document_state',
    receipt: 'checkpoint_proof.checkpoint_receipt',
  },
  product: {
    state: 'collaboration_documentstate',
    receipt: 'collaboration_checkpointreceipt',
  },
});

/**
 * Storage proof against checkpoint_proof fixture tables. No DDL or authorization.
 * The transport must authorize every call; IDs/counters never grant permission.
 */
export class CheckpointStore {
  private readonly tails = new Map<string, Promise<void>>();
  private pending = 0;
  private pendingBytes = 0;
  private readonly mapping: (typeof TABLES)[keyof typeof TABLES];
  private readonly product: boolean;

  private readonly pool: Pool;

  constructor(pool: Pool, mapping: 'proof' | 'product' = 'proof') {
    if (mapping !== 'proof' && mapping !== 'product')
      throw new Error('invalid_storage_mapping');
    this.pool = pool;
    this.mapping = TABLES[mapping];
    this.product = mapping === 'product';
  }

  private enqueue<T>(
    scope: DocumentScope,
    bytes: number,
    guard: WriteGuard,
    work: () => Promise<T>,
  ): Promise<T> {
    if (
      this.pending >= MAX_PENDING_WRITES ||
      this.pendingBytes + bytes > MAX_PENDING_BYTES
    ) {
      return Promise.reject(new CheckpointStoreError('resource_limit'));
    }
    const key = scope.document_id;
    this.pending += 1;
    this.pendingBytes += bytes;
    const operation = (this.tails.get(key) ?? Promise.resolve()).then(() => {
      guard();
      return work();
    });
    const tail = operation.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    return operation.finally(() => {
      this.pending -= 1;
      this.pendingBytes -= bytes;
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
  }

  private async transaction<T>(
    work: (client: PoolClient) => Promise<T>,
    guard: WriteGuard = unguarded,
  ): Promise<T> {
    let client: PoolClient | undefined;
    let discard = false;
    const disconnected = () => {
      discard = true;
    };
    try {
      guard();
      client = await this.pool.connect();
      guard();
      client.on('error', disconnected);
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await client.query("SET LOCAL statement_timeout = '3s'");
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query('SET LOCAL synchronous_commit = on');
      const result = await work(client);
      guard();
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
    const metadata = await client.query<{
      generation: string;
      project_id?: string;
      file_id?: string;
      initial_sha256?: string;
    }>(
      this.product
        ? `SELECT d.generation::text, d.project_id::text, d.file_id::text, f.initial_sha256 FROM projects_collaborationdocument d
           JOIN projects_projectfile f ON f.id=d.file_id AND f.project_id=d.project_id AND f.generation=d.generation
           WHERE d.id=$1 AND f.deleted_at IS NULL AND d.kind='text' AND d.schema_version=1`
        : 'SELECT generation::text FROM checkpoint_proof.document WHERE document_id = $1',
      [scope.document_id],
    );
    if (
      metadata.rows[0]?.generation !== String(scope.generation) ||
      (this.product &&
        (['project_id', 'file_id', 'initial_sha256'] as const).some(
          (key) =>
            scope[key] !== undefined && metadata.rows[0]?.[key] !== scope[key],
        ))
    ) {
      throw new CheckpointStoreError('generation_mismatch');
    }
    const result = await client.query<StateRow>(
      `SELECT generation::text, binary_state, durable_revision::text, state_sha256
       FROM ${this.mapping.state} WHERE document_id = $1 AND generation = $2`,
      [scope.document_id, scope.generation],
    );
    const row = result.rows[0];
    if (!row) throw new CheckpointStoreError('storage_unavailable');
    if (stateHash(row.binary_state) !== row.state_sha256) {
      throw new CheckpointStoreError('storage_unavailable');
    }
    validateInitialState(row.binary_state);
    return Object.freeze({
      ...scope,
      binary: Uint8Array.from(row.binary_state),
      durable_revision: row.durable_revision,
      state_sha256: row.state_sha256,
    });
  }

  load(
    scope: DocumentScope,
    guard: WriteGuard = unguarded,
  ): Promise<StoredState> {
    const captured = captureScope(scope);
    return this.transaction(
      (client) => this.readState(client, captured),
      guard,
    );
  }

  async initialize(
    scope: DocumentScope,
    seed: Uint8Array,
    guard: WriteGuard = unguarded,
  ): Promise<StoredState> {
    const captured = captureScope(scope);
    if (seed.byteLength > MAX_CHECKPOINT_STATE_BYTES) {
      return Promise.reject(new CheckpointStoreError('resource_limit'));
    }
    const binary = validateInitialState(Uint8Array.from(seed));
    return this.enqueue(captured, binary.byteLength, guard, () =>
      this.transaction(async (client) => {
        await client.query(
          this.product
            ? `INSERT INTO collaboration_documentstate (document_id,generation,binary_state,durable_revision,state_sha256)
               SELECT d.id,d.generation,$3,0,$4 FROM projects_collaborationdocument d
               JOIN projects_projectfile f ON f.id=d.file_id AND f.project_id=d.project_id AND f.generation=d.generation
               WHERE d.id=$1 AND d.generation=$2 AND d.kind='text' AND d.schema_version=1 AND f.deleted_at IS NULL
               ON CONFLICT (document_id) DO NOTHING`
            : `INSERT INTO checkpoint_proof.document_state
               (document_id,generation,binary_state,durable_revision,state_sha256)
               SELECT document_id,generation,$3,0,$4 FROM checkpoint_proof.document
               WHERE document_id=$1 AND generation=$2 ON CONFLICT (document_id) DO NOTHING`,
          [
            captured.document_id,
            captured.generation,
            binary,
            stateHash(binary),
          ],
        );
        return this.readState(client, captured);
      }, guard),
    );
  }

  saveState(
    scope: DocumentScope,
    state: Uint8Array,
    guard: WriteGuard = unguarded,
  ): Promise<StoredState> {
    const captured = captureScope(scope);
    if (state.byteLength > MAX_CHECKPOINT_STATE_BYTES) {
      return Promise.reject(new CheckpointStoreError('resource_limit'));
    }
    const binary = Buffer.from(state);
    return this.enqueue(
      captured,
      binary.byteLength,
      guard,
      async () => (await this.write(captured, binary, undefined, guard)).state,
    );
  }

  saveCheckpoint(
    frame: unknown,
    guard: WriteGuard = unguarded,
  ): Promise<CheckpointReceipt> {
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
    return this.enqueue(scope, incoming.byteLength, guard, async () => {
      const result = await this.write(scope, incoming, request, guard);
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
    guard: WriteGuard = unguarded,
  ): Promise<WriteResult> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const result = await this.transaction(async (client) => {
        const stored = await this.readState(client, scope);
        if (request) {
          const old = await client.query<ReceiptRow>(
            `SELECT observed_counter::text, request_sha256, durable_revision::text, state_sha256
             FROM ${this.mapping.receipt}
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
          `UPDATE ${this.mapping.state}
           SET binary_state=$3, state_sha256=$4, durable_revision=durable_revision+1${this.product ? ', updated_at=clock_timestamp()' : ''}
           WHERE document_id=$1 AND generation=$2 AND durable_revision=$5${this.product ? ` AND EXISTS (SELECT 1 FROM projects_collaborationdocument d JOIN projects_projectfile f ON f.id=d.file_id AND f.project_id=d.project_id AND f.generation=d.generation WHERE d.id=$1 AND d.generation=$2 AND d.kind='text' AND d.schema_version=1 AND f.deleted_at IS NULL)` : ''}
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
            `INSERT INTO ${this.mapping.receipt}
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
      }, guard);
      if (result) return result;
    }
    throw new CheckpointStoreError('storage_unavailable');
  }
}

/** Fixed Django-owned product tables; no account/session or DDL privileges. */
export class ProductCheckpointStore extends CheckpointStore {
  constructor(pool: Pool) {
    super(pool, 'product');
  }
}
