import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client.ts';
import { LearningObserver, type LearningObserverIO } from './observer.ts';
import { LEARNING_PROTOCOL } from '@code-along/contracts/learning-events';
const assignmentId = '11111111-1111-4111-8111-111111111111';
const scope = {
  accountId: '22222222-2222-4222-8222-222222222222',
  assignmentId,
  audience: 'participant' as const,
};
const frame = (generation: string, type = 'head') =>
  JSON.stringify({
    protocol: LEARNING_PROTOCOL,
    version: 1,
    scope: 'assignment',
    assignment_id: assignmentId,
    audience: 'participant',
    type,
    head_generation: generation,
  });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function flush() {
  for (let count = 0; count < 24; count++) await Promise.resolve();
}
const observers: LearningObserver[] = [];
function fixture(overrides: Partial<LearningObserverIO> = {}) {
  let active = true,
    generation = '0';
  const sockets: Parameters<LearningObserverIO['connect']>[1][] = [];
  const io = {
    authorize: vi.fn<LearningObserverIO['authorize']>(
      overrides.authorize ?? (async () => {}),
    ),
    head: vi.fn<LearningObserverIO['head']>(
      overrides.head ?? (async () => generation),
    ),
    refresh: vi.fn<LearningObserverIO['refresh']>(
      overrides.refresh ?? (async () => {}),
    ),
    connect: vi.fn<LearningObserverIO['connect']>(
      overrides.connect ??
        ((_after, handlers) => {
          sockets.push(handlers);
          handlers.open();
          return vi.fn();
        }),
    ),
  };
  const observer = new LearningObserver(scope, () => active, io);
  observers.push(observer);
  return {
    observer,
    io,
    sockets,
    leave: () => {
      active = false;
    },
    head: (value: string) => {
      generation = value;
    },
  };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse('2026-11-14T12:00:00Z'));
});
afterEach(() => {
  for (const observer of observers.splice(0)) observer.destroy();
  vi.useRealTimers();
});
describe('head-anchored visible learning refresh', () => {
  it('fresh actual account authorization precedes every real refresh, including fallback mode', async () => {
    for (const streaming of [true, false]) {
      const f = fixture();
      f.observer.start(streaming);
      await flush();
      const actor = deferred<void>();
      f.io.authorize.mockImplementationOnce(() => actor.promise);
      f.observer.focus();
      await flush();
      expect(f.io.refresh).toHaveBeenCalledOnce();
      f.observer.viewsChanged();
      actor.reject(new ApiError(403, {}));
      await flush();
      expect(f.io.refresh).toHaveBeenCalledOnce();
      expect(f.observer.getSnapshot()).toMatchObject({
        phase: 'denied',
        anchor: '0',
      });
      await vi.advanceTimersByTimeAsync(30000);
      expect(f.io.refresh).toHaveBeenCalledOnce();
      f.observer.destroy();
    }
  });
  it('a deferred foreign actual identity cannot read or advance an old-account view after cached scope stayed active', async () => {
    const f = fixture();
    f.observer.start(true);
    await flush();
    f.io.authorize.mockRejectedValueOnce(
      new Error('Your account changed. Reopen this assignment.'),
    );
    f.head('1');
    f.observer.focus();
    await flush();
    expect(f.io.refresh).toHaveBeenCalledOnce();
    expect(f.observer.getSnapshot()).toMatchObject({
      phase: 'stale',
      anchor: '0',
    });
  });
  it('gets a head before reads and after reads; only actual successful reads advance the anchor', async () => {
    const order: string[] = [];
    const f = fixture({
      head: async () => {
        order.push('head');
        return '7';
      },
      refresh: async () => {
        order.push('read');
      },
    });
    f.observer.viewsChanged();
    expect(order).toEqual([]);
    f.observer.start(true);
    await flush();
    expect(order).toEqual(['head', 'read', 'head']);
    expect(f.observer.getSnapshot()).toMatchObject({
      phase: 'current',
      anchor: '7',
    });
    f.io.refresh.mockRejectedValueOnce(new Error('visible REST503'));
    f.head('8');
    f.sockets[0]!.frame(frame('8'));
    await flush();
    expect(f.observer.getSnapshot()).toMatchObject({
      phase: 'stale',
      anchor: '7',
    });
  });
  it('repeats anchored reads when a marker/head races bootstrap instead of assigning the newer head to old data', async () => {
    const read = deferred<void>();
    const f = fixture();
    f.io.refresh.mockImplementationOnce(() => read.promise);
    f.observer.start(true);
    await flush();
    expect(f.observer.getSnapshot().anchor).toBeNull();
    f.head('2');
    f.sockets[0]!.frame(frame('2', 'learning.changed'));
    read.resolve();
    await flush();
    expect(f.io.refresh).toHaveBeenCalledTimes(2);
    expect(f.observer.getSnapshot()).toMatchObject({
      phase: 'current',
      anchor: '2',
    });
  });
  it('repairs a dropped final notification through authenticated HTTP head without another marker', async () => {
    const f = fixture();
    f.observer.start(true);
    await flush();
    f.head('9');
    expect(f.io.refresh).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(10000);
    expect(f.io.refresh).toHaveBeenCalledTimes(2);
    expect(f.observer.getSnapshot().anchor).toBe('9');
  });
  it('coalesces duplicates/out-of-order markers into maximum seen with one in-flight read', async () => {
    const f = fixture();
    f.observer.start(true);
    await flush();
    const read = deferred<void>();
    f.io.refresh.mockImplementationOnce(() => read.promise);
    f.head('9007199254740993');
    f.sockets[0]!.frame(frame('9007199254740993'));
    await flush();
    for (const value of ['1', '2', '9007199254740993', '3'])
      f.sockets[0]!.frame(frame(value));
    expect(f.io.refresh).toHaveBeenCalledTimes(2);
    read.resolve();
    await flush();
    expect(f.io.refresh).toHaveBeenCalledTimes(2);
    expect(f.observer.getSnapshot().anchor).toBe('9007199254740993');
  });
  it('bounds immediate work while heads keep advancing, leaves stale and backs off', async () => {
    let head = 0;
    const f = fixture({ head: async () => String(++head) });
    f.observer.start(true);
    await flush();
    expect(f.io.refresh).toHaveBeenCalledTimes(2);
    expect(f.observer.getSnapshot().phase).toBe('stale');
    await vi.advanceTimersByTimeAsync(999);
    expect(f.io.refresh).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.io.refresh).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1999);
    expect(f.io.refresh).toHaveBeenCalledTimes(4);
  });
  it('honors actual429 Retry-After across markers, focus, explicit refresh and offline/reconnect', async () => {
    const f = fixture();
    f.io.refresh.mockRejectedValueOnce(new ApiError(429, {}, 17));
    f.observer.start(true);
    await flush();
    const until = Date.now() + 17000;
    expect(f.observer.getSnapshot().retryAt).toBe(until);
    f.observer.focus();
    f.observer.refresh();
    f.sockets[0]!.frame(frame('4'));
    f.observer.offline();
    f.observer.online();
    await flush();
    await vi.advanceTimersByTimeAsync(16999);
    expect(f.io.refresh).toHaveBeenCalledOnce();
    f.head('4');
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(f.io.refresh).toHaveBeenCalledTimes(2);
    expect(f.observer.getSnapshot()).toMatchObject({
      phase: 'current',
      anchor: '4',
    });
  });
  it('refreshes time-dependent eligibility on visible focus/periodic fallback with an unchanged head', async () => {
    const f = fixture();
    f.observer.start(true);
    await flush();
    await vi.advanceTimersByTimeAsync(10000);
    expect(f.io.refresh).toHaveBeenCalledOnce();
    f.observer.focus();
    await flush();
    expect(f.io.refresh).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30000);
    expect(f.io.refresh).toHaveBeenCalledTimes(3);
  });
  it('without a real participation uses bounded REST/focus refresh and never opens a head or socket', async () => {
    const f = fixture();
    f.observer.start(false);
    await flush();
    expect(f.io.head).not.toHaveBeenCalled();
    expect(f.io.connect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(29999);
    expect(f.io.refresh).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.io.refresh).toHaveBeenCalledTimes(2);
    f.observer.configure(true);
    await flush();
    expect(f.io.connect).toHaveBeenCalledOnce();
    expect(f.io.head).toHaveBeenCalled();
  });
  it('new visible registrations get a real anchored read even at the same generation', async () => {
    const f = fixture();
    f.observer.start(true);
    await flush();
    f.observer.viewsChanged();
    await flush();
    expect(f.io.refresh).toHaveBeenCalledTimes(2);
    expect(f.observer.getSnapshot().phase).toBe('current');
  });
  it('a real authorization close aborts a pending refresh and cannot mark it current afterward or reconnect automatically', async () => {
    const f = fixture();
    f.observer.start(true);
    await flush();
    const read = deferred<void>();
    f.io.refresh.mockImplementationOnce(() => read.promise);
    f.head('2');
    f.sockets[0]!.frame(frame('2'));
    await flush();
    f.sockets[0]!.close(4403);
    read.resolve();
    await flush();
    expect(f.observer.getSnapshot()).toMatchObject({
      phase: 'denied',
      anchor: '0',
    });
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.io.connect).toHaveBeenCalledOnce();
  });
  it('rejects foreign or malformed frames and does not infer any trusted domain fact', async () => {
    for (const raw of [
      frame('1').replace(assignmentId, scope.accountId),
      frame('1').replace('participant', 'teaching'),
      '{"type":"complete"}',
    ]) {
      const f = fixture();
      f.observer.start(true);
      await flush();
      f.sockets[0]!.frame(raw);
      expect(f.observer.getSnapshot()).toMatchObject({
        phase: 'stale',
        anchor: '0',
        live: false,
      });
    }
  });
  it('old socket and HTTP completions cannot update a replaced account/lifetime', async () => {
    const f = fixture();
    f.observer.start(true);
    await flush();
    const read = deferred<void>();
    f.io.refresh.mockImplementationOnce(() => read.promise);
    f.head('2');
    f.sockets[0]!.frame(frame('2'));
    await flush();
    f.leave();
    const snapshot = f.observer.getSnapshot();
    read.resolve();
    await flush();
    f.sockets[0]!.frame(frame('3'));
    f.sockets[0]!.close(4403);
    expect(f.observer.getSnapshot()).toBe(snapshot);
  });
  it('offline aborts current reads and a fresh admission ignores the old socket after reconnect', async () => {
    const f = fixture();
    f.observer.start(true);
    await flush();
    const old = f.sockets[0]!;
    f.observer.offline();
    f.observer.online();
    await flush();
    expect(f.io.authorize).toHaveBeenCalledTimes(2);
    expect(f.io.connect).toHaveBeenCalledTimes(2);
    const snapshot = f.observer.getSnapshot();
    old.frame(frame('9'));
    old.close(4403);
    expect(f.observer.getSnapshot()).toBe(snapshot);
  });
});
