import type { FeedbackPublication, FeedbackScope } from './types.ts';
import { validatePublication } from './validation.ts';

interface PublishedState {
  readonly latest: FeedbackPublication | null;
  readonly ready: boolean;
  readonly history: readonly FeedbackPublication[] | null;
  readonly error: unknown;
  readonly historyError: unknown;
}
export interface PublishedFeedbackIO {
  authorize: (signal: AbortSignal) => Promise<void>;
  latest: (signal: AbortSignal) => Promise<FeedbackPublication | null>;
  history: (signal: AbortSignal) => Promise<readonly FeedbackPublication[]>;
}
/** Independent abortable read channels. Immutable publication proof cannot be erased by an older read. */
export class PublishedFeedbackModel {
  private state: PublishedState = Object.freeze({
    latest: null,
    ready: false,
    history: null,
    error: null,
    historyError: null,
  });
  private readonly listeners = new Set<() => void>();
  private readonly reads = new Map<'latest' | 'history', AbortController>();
  private closed = false;
  constructor(
    private readonly scope: FeedbackScope,
    private readonly active: () => boolean,
    private readonly io: PublishedFeedbackIO,
  ) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private current() {
    return !this.closed && this.active();
  }
  private update(value: Partial<PublishedState>) {
    if (!this.current()) return;
    this.state = Object.freeze({ ...this.state, ...value });
    for (const listener of this.listeners) listener();
  }
  acceptConfirmed(value: FeedbackPublication) {
    if (!this.current()) return;
    if (
      value.assignment_id !== this.scope.assignmentId ||
      value.submission_id !== this.scope.submissionId ||
      value.assignment_version_id !== this.scope.versionId
    )
      throw new Error('Feedback publication belongs to another submission.');
    // Only the direct, fully validated publication command calls this seam.
    if (!this.state.latest || value.number > this.state.latest.number)
      this.update({ latest: value, ready: true });
  }
  private async read(kind: 'latest' | 'history', outer?: AbortSignal) {
    outer?.throwIfAborted();
    if (!this.current())
      throw new DOMException('Feedback lifetime changed.', 'AbortError');
    this.reads.get(kind)?.abort();
    const abort = new AbortController();
    this.reads.set(kind, abort);
    const cancel = () => abort.abort();
    outer?.addEventListener('abort', cancel, { once: true });
    const current = () =>
      this.current() && !abort.signal.aborted && this.reads.get(kind) === abort;
    const check = () => {
      if (!current())
        throw new DOMException('Feedback read replaced.', 'AbortError');
    };
    this.update(kind === 'latest' ? { error: null } : { historyError: null });
    try {
      await this.io.authorize(abort.signal);
      check();
      if (kind === 'latest') {
        const raw = await this.io.latest(abort.signal);
        check();
        const latest =
          raw === null ? null : await validatePublication(raw, this.scope);
        check();
        if (
          latest &&
          this.state.latest &&
          latest.number === this.state.latest.number &&
          JSON.stringify(latest) !== JSON.stringify(this.state.latest)
        )
          throw new Error(
            'A published feedback identity changed. Recheck access.',
          );
        this.update({
          ready: true,
          ...(latest &&
          (!this.state.latest || latest.number > this.state.latest.number)
            ? { latest }
            : {}),
        });
      } else {
        const raw = await this.io.history(abort.signal);
        check();
        if (raw.length > 20)
          throw new Error('Feedback history exceeds its bound.');
        const incoming = await Promise.all(
          raw.map((value) => validatePublication(value, this.scope)),
        );
        check();
        const merged = new Map(
          (this.state.history ?? []).map((value) => [value.number, value]),
        );
        for (const value of incoming) {
          if (
            merged.has(value.number) &&
            JSON.stringify(merged.get(value.number)) !== JSON.stringify(value)
          )
            throw new Error(
              'A published feedback identity changed. Recheck access.',
            );
          merged.set(value.number, value);
        }
        if (merged.size > 20)
          throw new Error('Feedback history exceeds its bound.');
        this.update({
          history: Object.freeze(
            [...merged.values()].sort((a, b) => b.number - a.number),
          ),
        });
      }
    } catch (error) {
      if (current())
        this.update(kind === 'latest' ? { error } : { historyError: error });
      throw error;
    } finally {
      outer?.removeEventListener('abort', cancel);
      if (this.reads.get(kind) === abort) this.reads.delete(kind);
    }
  }
  latest = (signal?: AbortSignal) => this.read('latest', signal);
  history = (signal?: AbortSignal) => this.read('history', signal);
  destroy() {
    this.closed = true;
    for (const read of this.reads.values()) read.abort();
    this.reads.clear();
    this.listeners.clear();
  }
}
