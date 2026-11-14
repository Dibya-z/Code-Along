import type { SourceCandidate } from '../execution/source-actions.ts';
import type { SubmissionDetail, SubmissionRequest } from './types.ts';
import { prepareSubmission, validateReceipt } from './validation.ts';

export interface SubmissionState {
  readonly phase:
    'empty' | 'preparing' | 'ready' | 'sending' | 'uncertain' | 'confirmed';
  readonly candidate: SourceCandidate | null;
  readonly body: SubmissionRequest | null;
  readonly receipt: SubmissionDetail | null;
  readonly error: unknown;
}
/** One explicit source choice and one immutable request. No persistence or offline replay. */
export class SubmissionModel {
  private state: SubmissionState = Object.freeze({
    phase: 'empty',
    candidate: null,
    body: null,
    receipt: null,
    error: null,
  });
  private readonly listeners = new Set<() => void>();
  private closed = false;
  private busy = false;
  constructor(
    private readonly actorId: string,
    private readonly workId: string,
    private readonly active: () => boolean,
    private readonly authorize: () => Promise<{ id: string }>,
    private readonly send: (body: SubmissionRequest) => Promise<unknown>,
  ) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private current() {
    return !this.closed && this.active();
  }
  private publish(update: Partial<SubmissionState>) {
    if (!this.current()) return;
    this.state = Object.freeze({ ...this.state, ...update });
    for (const listener of this.listeners) listener();
  }
  async prepare(capture: () => Promise<SourceCandidate> | SourceCandidate) {
    if (!this.current() || this.busy || this.state.body) return;
    this.busy = true;
    this.publish({ phase: 'preparing', error: null });
    try {
      // Invoke capture in the click's synchronous turn, before hashing or authentication.
      const pending = capture();
      const prepared = await prepareSubmission(await pending);
      if (this.current()) this.publish({ ...prepared, phase: 'ready' });
    } catch (error) {
      this.publish({ phase: 'empty', error });
    } finally {
      this.busy = false;
    }
  }
  async submit() {
    const { candidate, body } = this.state;
    if (
      !candidate ||
      !body ||
      !this.current() ||
      this.busy ||
      this.state.phase === 'confirmed'
    )
      return;
    this.busy = true;
    this.publish({ phase: 'sending', error: null });
    try {
      const actor = await this.authorize();
      if (!this.current() || actor.id !== this.actorId)
        throw new Error(
          'Your account session changed. Reopen this work to check its submissions.',
        );
      // Availability, Source and Work snapshots deliberately do not gate this original nonce.
      const response = await this.send(body);
      if (!this.current()) return;
      const { detail } = await validateReceipt(
        response,
        this.actorId,
        this.workId,
        candidate,
        body,
      );
      this.publish({ phase: 'confirmed', receipt: detail, error: null });
    } catch (error) {
      this.publish({ phase: 'uncertain', error });
    } finally {
      this.busy = false;
    }
  }
  clear() {
    if (this.busy || !this.current()) return;
    this.publish({
      phase: 'empty',
      candidate: null,
      body: null,
      receipt: null,
      error: null,
    });
  }
  destroy() {
    this.closed = true;
    this.listeners.clear();
  }
}
