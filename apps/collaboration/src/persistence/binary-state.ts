import { createHash } from 'node:crypto';
import { MAX_CHECKPOINT_STATE_BYTES } from '@code-along/contracts/collaboration';
import * as Y from 'yjs';
import * as decoding from 'lib0/decoding';

export const MAX_SOURCE_BYTES = 128 * 1024;
export const MAX_STATE_STRUCTS = 16_384;
const MAX_STRUCT_SPAN = 8 * MAX_CHECKPOINT_STATE_BYTES;

type StoreErrorCode =
  | 'unauthorized'
  | 'invalid_state'
  | 'resource_limit'
  | 'generation_mismatch'
  | 'checkpoint_conflict'
  | 'storage_unavailable';

export class CheckpointStoreError extends Error {
  readonly code: StoreErrorCode;

  constructor(code: StoreErrorCode) {
    super(code);
    this.name = 'CheckpointStoreError';
    this.code = code;
  }
}

export function stateHash(state: Uint8Array): string {
  return createHash('sha256').update(state).digest('hex');
}

/** Preserve valid source exactly, including CRLF, and reject lossy UTF-8 input. */
export function validateSource(source: string): void {
  if (
    source.includes('\0') ||
    new TextDecoder('utf-8').decode(new TextEncoder().encode(source)) !== source
  ) {
    throw new CheckpointStoreError('invalid_state');
  }
  if (Buffer.byteLength(source, 'utf8') > MAX_SOURCE_BYTES) {
    throw new CheckpointStoreError('resource_limit');
  }
}

class StrictUpdateDecoder extends Y.UpdateDecoderV1 {
  override readString(): string {
    return new TextDecoder('utf-8', { fatal: true }).decode(
      decoding.readVarUint8Array(this.restDecoder),
    );
  }
}

function checkUpdate(state: Uint8Array): void {
  if (state.byteLength > MAX_CHECKPOINT_STATE_BYTES) {
    throw new CheckpointStoreError('resource_limit');
  }
  try {
    const decoded = Y.decodeUpdateV2(state, StrictUpdateDecoder);
    if (decoded.structs.length > MAX_STATE_STRUCTS) {
      throw new CheckpointStoreError('resource_limit');
    }
    let span = 0;
    for (const struct of decoded.structs) {
      span += struct.length;
      if (
        !Number.isSafeInteger(struct.length) ||
        struct.length < 1 ||
        span > MAX_STRUCT_SPAN
      ) {
        throw new CheckpointStoreError('resource_limit');
      }
      if (struct instanceof Y.GC) continue;
      if (
        !(struct instanceof Y.Item) ||
        !(
          struct.content instanceof Y.ContentString ||
          struct.content instanceof Y.ContentDeleted
        ) ||
        (typeof struct.parent === 'string' && struct.parent !== 'source') ||
        struct.parentSub !== null
      ) {
        throw new CheckpointStoreError('invalid_state');
      }
      if (struct.content instanceof Y.ContentString) {
        validateSource(struct.content.str);
      }
    }
  } catch (error) {
    if (error instanceof CheckpointStoreError) throw error;
    // Decoder errors can contain data; never expose their messages/causes.
    throw new CheckpointStoreError('invalid_state');
  }
}

/** Merge into a throwaway document. No caller-owned live Y.Doc is mutated. */
export function mergeBinaryState(
  persisted: Uint8Array,
  incoming: Uint8Array,
): Buffer {
  checkUpdate(persisted);
  checkUpdate(incoming);
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, persisted);
    Y.applyUpdate(doc, incoming);
    // Pinned Yjs 13.6.33 internals: full-state saves must not retain unresolved
    // causal fragments/deletion sets for unknown future structs.
    if (doc.store.pendingStructs !== null || doc.store.pendingDs !== null) {
      throw new CheckpointStoreError('invalid_state');
    }
    if ([...doc.share.keys()].some((name) => name !== 'source')) {
      throw new CheckpointStoreError('invalid_state');
    }
    const text = doc.getText('source');
    if (Object.keys(text.getAttributes()).length !== 0) {
      throw new CheckpointStoreError('invalid_state');
    }
    validateSource(text.toString());
    const merged = Buffer.from(Y.encodeStateAsUpdate(doc));
    checkUpdate(merged);
    return merged;
  } catch (error) {
    if (error instanceof CheckpointStoreError) throw error;
    throw new CheckpointStoreError('invalid_state');
  } finally {
    doc.destroy();
  }
}

export function validateInitialState(state: Uint8Array): Buffer {
  const empty = new Y.Doc();
  try {
    return mergeBinaryState(Y.encodeStateAsUpdate(empty), state);
  } finally {
    empty.destroy();
  }
}
