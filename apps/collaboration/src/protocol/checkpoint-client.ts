import * as Y from 'yjs';
import {
  CHECKPOINT_PROTOCOL,
  CHECKPOINT_VERSION,
  parseCheckpointResponse,
  type CheckpointRequest,
  type CheckpointResponse,
} from '@code-along/contracts/collaboration';

/** The transport must deliver server-only stateless replies over the admitted socket. */
export class CheckpointClient {
  private counter = 0;
  private savedCounter: number | null = null;
  private pending: CheckpointRequest | null = null;
  private readonly document: Y.Doc;
  private readonly ids: {
    document_id: string;
    generation: number;
    client_session_id: string;
  };
  private readonly changed = () => {
    this.counter += 1;
  };
  constructor(
    document: Y.Doc,
    ids: { document_id: string; generation: number; client_session_id: string },
  ) {
    this.document = document;
    this.ids = Object.freeze({ ...ids });
    document.on('update', this.changed);
  }
  get saved(): boolean {
    return this.savedCounter === this.counter;
  }
  capture(checkpointId: string): CheckpointRequest {
    if (this.pending) throw new Error('checkpoint_in_flight');
    const bytes = Y.encodeStateAsUpdate(this.document);
    let raw = '';
    for (const byte of bytes) raw += String.fromCharCode(byte);
    this.pending = Object.freeze({
      protocol: CHECKPOINT_PROTOCOL,
      version: CHECKPOINT_VERSION,
      type: 'checkpoint.request',
      ...this.ids,
      checkpoint_id: checkpointId,
      observed_counter: this.counter,
      state_base64: btoa(raw),
    });
    return this.pending;
  }
  retry(): CheckpointRequest {
    if (!this.pending) throw new Error('no_checkpoint_in_flight');
    return this.pending;
  }
  receive(frame: string): CheckpointResponse | null {
    const parsed = parseCheckpointResponse(frame);
    const p = this.pending;
    if (!p || !parsed.ok) return null;
    const r = parsed.value;
    if (
      r.document_id !== p.document_id ||
      r.generation !== p.generation ||
      r.client_session_id !== p.client_session_id ||
      r.checkpoint_id !== p.checkpoint_id ||
      r.observed_counter !== p.observed_counter
    )
      return null;
    if (r.type === 'checkpoint.receipt') this.savedCounter = r.observed_counter;
    this.pending = null;
    return r;
  }
  destroy(): void {
    this.document.off('update', this.changed);
  }
}
