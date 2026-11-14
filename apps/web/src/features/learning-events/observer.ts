import {
  parseLearningFrame,
  type LearningAudience,
} from '@code-along/contracts/learning-events';
import { ApiError } from '../../api/client.ts';

export interface LearningScope {
  readonly accountId: string;
  readonly assignmentId: string;
  readonly audience: LearningAudience;
}
export interface LearningUpdates {
  readonly phase:
    'starting' | 'refreshing' | 'current' | 'stale' | 'offline' | 'denied';
  readonly anchor: string | null;
  readonly error: unknown;
  readonly retryAt: number | null;
  readonly live: boolean;
}
export interface LearningObserverIO {
  authorize: (signal: AbortSignal) => Promise<void>;
  head: (signal: AbortSignal) => Promise<string>;
  refresh: (signal: AbortSignal) => Promise<void>;
  connect: (
    after: string | null,
    events: {
      open: () => void;
      frame: (raw: unknown) => void;
      close: (code: number) => void;
    },
  ) => () => void;
}
const maximum = (a: string, b: string) => (BigInt(a) >= BigInt(b) ? a : b);

/** One coalesced cursor per account/assignment/audience; a cursor never replaces an actual successful view read. */
export class LearningObserver {
  private state: LearningUpdates = Object.freeze({
    phase: 'starting',
    anchor: null,
    error: null,
    retryAt: null,
    live: false,
  });
  private readonly listeners = new Set<() => void>();
  private readonly lifetime = new AbortController();
  private readAbort: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private reconnect: ReturnType<typeof setTimeout> | null = null;
  private disconnect: (() => void) | null = null;
  private socketEpoch = 0;
  private epoch = 0;
  private seen = '0';
  private viewRevision = 0;
  private anchoredViews = -1;
  private lastRead = 0;
  private inFlight = false;
  private wanted = false;
  private force = false;
  private paused = false;
  private denied = false;
  private streaming = false;
  private failures = 0;
  private notBefore = 0;
  private started = false;
  private repairRequested = false;
  constructor(
    readonly scope: LearningScope,
    private readonly active: () => boolean,
    private readonly io: LearningObserverIO,
  ) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private current(epoch = this.epoch) {
    return (
      !this.lifetime.signal.aborted && this.active() && epoch === this.epoch
    );
  }
  private update(patch: Partial<LearningUpdates>) {
    if (!this.current()) return;
    this.state = Object.freeze({ ...this.state, ...patch });
    for (const listener of this.listeners) listener();
  }
  start(streaming: boolean) {
    if (this.started || !this.current()) return;
    this.started = true;
    this.streaming = streaming;
    void this.open();
    this.poll();
  }
  configure(streaming: boolean) {
    if (this.streaming === streaming || !this.current()) return;
    this.streaming = streaming;
    if (!this.started) return;
    this.denied = false;
    this.epoch++;
    this.readAbort?.abort();
    this.stopSocket();
    this.update({ anchor: null, phase: 'starting', live: false });
    this.seen = '0';
    void this.open();
  }
  viewsChanged() {
    this.viewRevision++;
    this.request(true);
  }
  refresh = () => {
    if (Date.now() < this.notBefore) return;
    this.repairRequested = this.denied;
    this.denied = false;
    this.failures = 0;
    this.epoch++;
    this.readAbort?.abort();
    this.stopSocket();
    this.update({ phase: 'starting', live: false });
    this.request(true, true);
  };
  focus = () => this.request(true);
  offline = () => {
    this.paused = true;
    this.epoch++;
    this.readAbort?.abort();
    this.stopSocket();
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.update({
      phase: 'offline',
      live: false,
      retryAt: this.notBefore > Date.now() ? this.notBefore : null,
    });
  };
  online = () => {
    if (!this.paused) return;
    this.paused = false;
    if (!this.denied) void this.open();
  };
  private stopSocket() {
    this.socketEpoch++;
    this.disconnect?.();
    this.disconnect = null;
    if (this.reconnect) clearTimeout(this.reconnect);
    this.reconnect = null;
  }
  private open() {
    this.request(true);
  }
  private attach(epoch: number) {
    if (this.streaming && !this.disconnect) {
      const socket = ++this.socketEpoch;
      const current = () => this.current(epoch) && socket === this.socketEpoch;
      this.disconnect = this.io.connect(this.state.anchor, {
        open: () => {
          if (current()) this.update({ live: true });
        },
        frame: (raw) => {
          if (current()) this.receive(raw);
        },
        close: (code) => {
          if (!current()) return;
          this.disconnect = null;
          this.update({ live: false });
          if (code === 4403 || code === 4400) {
            this.denied = true;
            this.epoch++;
            this.readAbort?.abort();
            this.stopSocket();
            this.update({
              phase: code === 4403 ? 'denied' : 'stale',
              error: new Error('Live learning access must be checked again.'),
            });
          } else {
            this.update({ phase: 'stale' });
            const wait = Math.min(
              60000,
              1000 * 2 ** Math.min(this.failures++, 6),
            );
            this.reconnect = setTimeout(() => {
              this.reconnect = null;
              void this.open();
            }, wait);
          }
        },
      });
    }
  }
  private receive(raw: unknown) {
    const parsed = parseLearningFrame(raw);
    if (
      !parsed.ok ||
      parsed.value.assignment_id !== this.scope.assignmentId ||
      parsed.value.audience !== this.scope.audience
    ) {
      this.denied = true;
      this.epoch++;
      this.readAbort?.abort();
      this.stopSocket();
      this.update({
        live: false,
        phase: 'stale',
        error: new Error(
          'Live learning updates could not be verified. Recheck access.',
        ),
      });
      return;
    }
    this.seen = maximum(this.seen, parsed.value.head_generation);
    if (
      this.state.anchor === null ||
      BigInt(this.seen) > BigInt(this.state.anchor)
    )
      this.request(false);
  }
  private poll() {
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.current()) return;
      if (
        !this.paused &&
        !this.denied &&
        (this.streaming || Date.now() - this.lastRead >= 30000)
      )
        this.request(Date.now() - this.lastRead >= 30000);
      this.poll();
    }, 10000);
  }
  private request(force: boolean, manual = false) {
    if (!this.current() || this.paused || (this.denied && !manual)) return;
    this.wanted = true;
    this.force ||= force;
    if (!this.started) return;
    if (Date.now() < this.notBefore) {
      if (!this.retry) this.defer(this.notBefore - Date.now());
      return;
    }
    if (this.retry && !manual) return;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    if (!this.inFlight) void this.pump();
  }
  private async pump() {
    this.inFlight = true;
    const epoch = this.epoch;
    const abort = new AbortController();
    this.readAbort = abort;
    const current = () =>
      this.current(epoch) && !abort.signal.aborted && !this.paused;
    try {
      for (let repeat = 0; repeat < 2 && this.wanted && current(); repeat++) {
        this.wanted = false;
        const force = this.force;
        this.force = false;
        this.update({ phase: 'refreshing', retryAt: null });
        await this.io.authorize(abort.signal);
        if (!current()) return;
        if (this.repairRequested) {
          this.repairRequested = false;
          // Repair current role/stream metadata, without advancing a head.
          await this.io.refresh(abort.signal);
          if (!current()) return;
        }
        this.attach(epoch);
        if (!current()) return;
        const before = this.streaming ? await this.io.head(abort.signal) : '0';
        if (!current()) return;
        this.seen = maximum(this.seen, before);
        if (
          !force &&
          !this.force &&
          this.state.anchor !== null &&
          BigInt(before) <= BigInt(this.state.anchor) &&
          BigInt(this.seen) <= BigInt(this.state.anchor) &&
          this.anchoredViews === this.viewRevision
        ) {
          this.update({ phase: 'current', error: null });
          continue;
        }
        this.force = false;
        const views = this.viewRevision;
        await this.io.refresh(abort.signal);
        if (!current()) return;
        const after = this.streaming ? await this.io.head(abort.signal) : '0';
        if (!current()) return;
        if (BigInt(after) < BigInt(before))
          throw new Error('The learning head moved backwards. Recheck access.');
        this.seen = maximum(this.seen, after);
        this.anchoredViews = views;
        this.lastRead = Date.now();
        // Views cover the BEFORE head. A later head requires another real read.
        this.update({ anchor: before, error: null });
        if (
          BigInt(this.seen) > BigInt(before) ||
          views !== this.viewRevision ||
          this.force
        )
          this.wanted = true;
        else {
          this.wanted = false;
          this.failures = 0;
          this.update({ phase: 'current' });
        }
      }
      if (this.wanted && current())
        this.defer(Math.min(60000, 1000 * 2 ** Math.min(this.failures++, 6)));
    } catch (error) {
      if (current()) this.failed(error);
    } finally {
      this.inFlight = false;
      if (this.readAbort === abort) this.readAbort = null;
      if (
        this.current() &&
        this.wanted &&
        !this.retry &&
        !this.denied &&
        !this.paused
      )
        queueMicrotask(() => {
          if (!this.inFlight) void this.pump();
        });
    }
  }
  private failed(error: unknown) {
    if (error instanceof ApiError && [401, 403, 404].includes(error.status)) {
      this.denied = true;
      this.epoch++;
      this.readAbort?.abort();
      this.stopSocket();
      this.update({ phase: 'denied', live: false, error, retryAt: null });
      return;
    }
    const seconds =
      error instanceof ApiError && error.status === 429
        ? error.retryAfterSeconds
        : undefined;
    this.update({ phase: 'stale', error });
    this.wanted = true;
    this.force = true;
    const delay =
      (seconds ?? Math.min(60, 2 ** Math.min(this.failures++, 6))) * 1000;
    if (seconds !== undefined) this.notBefore = Date.now() + delay;
    this.defer(delay);
  }
  private defer(delay: number) {
    if (this.retry) clearTimeout(this.retry);
    this.update({ phase: 'stale', retryAt: Date.now() + delay });
    this.retry = setTimeout(() => {
      this.retry = null;
      if (!this.disconnect && this.streaming) void this.open();
      else this.request(false);
    }, delay);
  }
  destroy() {
    this.lifetime.abort();
    this.epoch++;
    this.readAbort?.abort();
    this.stopSocket();
    if (this.timer) clearTimeout(this.timer);
    if (this.retry) clearTimeout(this.retry);
    this.listeners.clear();
  }
}
