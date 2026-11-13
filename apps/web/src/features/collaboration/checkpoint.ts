import * as Y from 'yjs';
import {
  CHECKPOINT_PROTOCOL,
  CHECKPOINT_VERSION,
  MAX_CHECKPOINT_STATE_BYTES,
  parseCheckpointResponse,
  receiptCoversObservedState,
  type CheckpointRequest,
} from '@code-along/contracts/collaboration';

export interface CheckpointStatus {
  readonly phase:
    'connecting' | 'read_only' | 'pending' | 'saving' | 'saved' | 'error';
  readonly error: string;
  readonly revision: string;
}
interface Identity {
  document_id: string;
  generation: number;
  client_session_id: string;
}
const errors = {
  unauthorized:
    'Project access changed. Your code remains available for export.',
  read_only: 'This project is read only. Export any unsaved local changes.',
  generation_mismatch:
    'This server file was replaced. Open your work as a local copy.',
  checkpoint_conflict:
    'Saving stopped because this request conflicts with an earlier checkpoint. Export your code.',
  invalid_state:
    'The server could not accept this document. Export your code before refreshing.',
  resource_limit:
    'The collaboration limit was reached. Export your code before reconnecting.',
  storage_unavailable:
    'Server saving is unavailable. Your changes are not confirmed saved.',
} as const;

/** A synced event is not a receipt. One immutable request survives retries and reconnects. */
export class DocumentCheckpoint {
  private counter = 0;
  private savedCounter: number | null = null;
  private pending: CheckpointRequest | null = null;
  private connected = false;
  private writable = false;
  private stopped = false;
  private blocked = false;
  private attempts = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private listeners = new Set<() => void>();
  private status: CheckpointStatus = Object.freeze({
    phase: 'connecting',
    error: '',
    revision: '',
  });
  constructor(
    private readonly doc: Y.Doc,
    private readonly identity: Identity,
    private readonly send: (frame: string) => void,
    private readonly rejected: (code: keyof typeof errors) => void = () => {},
  ) {
    doc.on('update', this.changed);
  }

  getSnapshot = (): CheckpointStatus => this.status;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  get observedCounter(): number {
    return this.counter;
  }
  get request(): Readonly<CheckpointRequest> | null {
    return this.pending;
  }
  private publish(
    phase: CheckpointStatus['phase'],
    error = '',
    revision = this.status.revision,
  ): void {
    if (
      this.stopped ||
      (phase === this.status.phase &&
        error === this.status.error &&
        revision === this.status.revision)
    )
      return;
    this.status = Object.freeze({ phase, error, revision });
    for (const listener of this.listeners) listener();
  }
  private changed = (): void => {
    if (this.stopped) return;
    if (this.counter === Number.MAX_SAFE_INTEGER) {
      this.blocked = true;
      this.publish(
        'error',
        'This editing session reached its limit. Export your code and reopen the project.',
      );
      return;
    }
    this.counter++;
    if (this.connected && this.writable && !this.blocked) {
      this.publish(this.pending ? 'saving' : 'pending');
      if (!this.pending) this.schedule(500);
    }
  };
  connection(connected: boolean, writable: boolean): void {
    if (this.stopped) return;
    if (this.connected === connected && this.writable === writable) return;
    this.connected = connected;
    this.writable = writable;
    clearTimeout(this.timer);
    if (!connected) {
      this.savedCounter = null;
      this.publish('connecting');
    } else if (!writable) this.publish('read_only');
    else if (!this.blocked) {
      this.publish('pending');
      this.schedule(0);
    }
  }
  private schedule(delay: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.save(), delay);
  }
  save = (): void => {
    clearTimeout(this.timer);
    if (this.stopped || this.blocked || !this.connected || !this.writable)
      return;
    if (!this.pending && this.savedCounter === this.counter) {
      this.publish('saved');
      return;
    }
    try {
      if (!this.pending) {
        const state = Y.encodeStateAsUpdate(this.doc);
        if (state.length > MAX_CHECKPOINT_STATE_BYTES) throw new Error('limit');
        let binary = '';
        for (const byte of state) binary += String.fromCharCode(byte);
        this.pending = Object.freeze({
          protocol: CHECKPOINT_PROTOCOL,
          version: CHECKPOINT_VERSION,
          type: 'checkpoint.request',
          ...this.identity,
          checkpoint_id: crypto.randomUUID(),
          observed_counter: this.counter,
          state_base64: btoa(binary),
        });
      }
      this.publish('saving');
      this.send(JSON.stringify(this.pending));
      this.attempts++;
      this.schedule(
        Math.min(15000, 5000 * 2 ** Math.min(this.attempts - 1, 2)),
      );
    } catch {
      this.publish(
        'error',
        'Server saving could not be completed. Export your code if the connection does not recover.',
      );
      if (this.pending) this.schedule(5000);
      else this.blocked = true;
    }
  };
  receive(frame: string): boolean {
    if (this.stopped || !this.connected || !this.pending) return false;
    const result = parseCheckpointResponse(frame);
    if (!result.ok) return false;
    const response = result.value,
      pending = this.pending;
    if (
      response.document_id !== pending.document_id ||
      response.generation !== pending.generation ||
      response.client_session_id !== pending.client_session_id ||
      response.checkpoint_id !== pending.checkpoint_id ||
      response.observed_counter !== pending.observed_counter
    )
      return false;
    clearTimeout(this.timer);
    if (response.type === 'checkpoint.error') {
      this.publish('error', errors[response.code]);
      if (response.code === 'storage_unavailable') this.schedule(5000);
      else this.blocked = true;
      this.rejected(response.code);
      return true;
    }
    this.savedCounter = response.observed_counter;
    this.pending = null;
    this.attempts = 0;
    const covered = receiptCoversObservedState(response, pending, {
      ...this.identity,
      observed_counter: this.counter,
    });
    this.publish(covered ? 'saved' : 'pending', '', response.durable_revision);
    if (!covered) this.schedule(500);
    return true;
  }
  destroy(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.doc.off('update', this.changed);
    this.pending = null;
    this.listeners.clear();
  }
}
