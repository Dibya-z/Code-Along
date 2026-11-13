import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import * as Y from 'yjs';
import {
  parseCheckpointRequest,
  type CheckpointReceipt,
} from '@code-along/contracts/collaboration';
import {
  mergeBinaryState,
  stateHash,
} from '../../src/persistence/binary-state.ts';
import type {
  StoredState,
  DocumentScope,
  WriteGuard,
} from '../../src/persistence/checkpoint-store.ts';
import type { Grant } from '../../src/product/admission.ts';

export const documentId = '10000000-0000-4000-8000-000000000001';
export function grant(
  document_id = documentId,
  source = 'print("starter")\n',
): Grant {
  return {
    version: 1,
    lease_id: randomUUID(),
    lease_token: 'A'.repeat(43),
    ttl_ms: 30_000,
    scope: 'write',
    client_session_id: randomUUID(),
    awareness_client_id: 123,
    workspace_id: '10000000-0000-4000-8000-000000000002',
    project_id: '10000000-0000-4000-8000-000000000003',
    workspace_acl_version: '1',
    project_acl_version: '1',
    user: {
      id: '10000000-0000-4000-8000-000000000004',
      display_name: 'River',
      color: '#2563eb',
    },
    document: {
      id: document_id,
      file_id: randomUUID(),
      generation: 1,
      schema_version: 1,
      initial_source: source,
      initial_sha256: stateHash(Buffer.from(source)),
    },
  };
}
export class MemoryStore {
  readonly states = new Map<string, StoredState>();
  readonly receipts = new Map<string, CheckpointReceipt>();
  beforeSave: (() => Promise<void>) | undefined;
  async initialize(
    scope: DocumentScope,
    seed: Uint8Array,
    guard: WriteGuard = () => undefined,
  ): Promise<StoredState> {
    guard();
    if (!this.states.has(scope.document_id))
      this.states.set(scope.document_id, {
        ...scope,
        binary: Uint8Array.from(seed),
        durable_revision: '0',
        state_sha256: stateHash(seed),
      });
    return this.load(scope, guard);
  }
  async load(
    scope: DocumentScope,
    guard: WriteGuard = () => undefined,
  ): Promise<StoredState> {
    guard();
    const found = this.states.get(scope.document_id);
    if (!found) throw new Error('not_found');
    return { ...found, binary: Uint8Array.from(found.binary) };
  }
  async saveState(
    scope: DocumentScope,
    state: Uint8Array,
    guard: WriteGuard = () => undefined,
  ): Promise<StoredState> {
    await this.beforeSave?.();
    guard();
    const old = await this.load(scope),
      binary = mergeBinaryState(old.binary, state),
      value = {
        ...scope,
        binary,
        durable_revision: String(BigInt(old.durable_revision) + 1n),
        state_sha256: stateHash(binary),
      };
    this.states.set(scope.document_id, value);
    return value;
  }
  async saveCheckpoint(
    frame: unknown,
    guard: WriteGuard = () => undefined,
  ): Promise<CheckpointReceipt> {
    const parsed = parseCheckpointRequest(frame);
    if (!parsed.ok) throw new Error('invalid_request');
    const request = parsed.value;
    const key = `${request.document_id}:${request.client_session_id}:${request.checkpoint_id}`,
      old = this.receipts.get(key);
    if (old) {
      guard();
      return old;
    }
    const state = await this.saveState(
      request,
      Buffer.from(request.state_base64, 'base64'),
      guard,
    );
    const { state_base64: _state, ...envelope } = request;
    void _state;
    const receipt: CheckpointReceipt = {
      ...envelope,
      type: 'checkpoint.receipt',
      durable_revision: state.durable_revision,
      state_sha256: state.state_sha256,
    };
    this.receipts.set(key, receipt);
    return receipt;
  }
  source(id = documentId): string {
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, this.states.get(id)!.binary);
      return doc.getText('source').toString();
    } finally {
      doc.destroy();
    }
  }
}
export const started = () => performance.now();
