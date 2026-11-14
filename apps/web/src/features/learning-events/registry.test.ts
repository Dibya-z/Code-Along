import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VisibleLearningViews, refreshVisibleQuery } from './registry.ts';
afterEach(() => vi.useRealTimers());
describe('visible learning read registry', () => {
  it('refreshes only registered reads and rejects any failed visible read instead of confirming stale data', async () => {
    const changed = vi.fn(),
      visible = vi.fn(async () => {}),
      hidden = vi.fn();
    const registry = new VisibleLearningViews(changed, vi.fn());
    const remove = registry.register('visible progress', visible);
    await registry.refresh(new AbortController().signal);
    expect(visible).toHaveBeenCalledOnce();
    expect(hidden).not.toHaveBeenCalled();
    registry.register('visible list', async () => {
      throw new Error('REST503');
    });
    await expect(
      registry.refresh(new AbortController().signal),
    ).rejects.toThrow('REST503');
    remove();
    registry.destroy();
    expect(changed).toHaveBeenCalledTimes(3);
  });
  it('bounds registrations and a stale disposer cannot remove its replacement', async () => {
    const registry = new VisibleLearningViews(vi.fn(), vi.fn());
    const old = registry.register('same', async () => {});
    const replacement = vi.fn(async () => {});
    registry.register('same', replacement);
    old();
    for (let n = 0; n < 15; n++) registry.register(String(n), async () => {});
    expect(() => registry.register('overflow', async () => {})).toThrow(
      'Too many',
    );
    await registry.refresh(new AbortController().signal);
    expect(replacement).toHaveBeenCalledOnce();
    registry.destroy();
  });
  it('a known offer/deadline schedules one authoritative read and a past expiry does not spin', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2026-11-14T12:00:00Z'));
    const timeChanged = vi.fn(),
      registry = new VisibleLearningViews(vi.fn(), timeChanged);
    registry.register('offer', async () => {}, '2026-11-14T12:00:02Z');
    await vi.advanceTimersByTimeAsync(2049);
    expect(timeChanged).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(timeChanged).toHaveBeenCalledOnce();
    registry.register('offer', async () => {}, '2026-11-14T12:00:02Z');
    await vi.advanceTimersByTimeAsync(60000);
    expect(timeChanged).toHaveBeenCalledOnce();
    registry.destroy();
  });
  it('cancels an in-flight initial TanStack query before requiring a new post-head request', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    let firstAborted = false,
      requests = 0;
    const observer = new QueryObserver(client, {
      queryKey: ['progress', 'account', 'assignment'],
      queryFn: ({ signal }) => {
        requests++;
        if (requests > 1) return Promise.resolve('fresh after head');
        return new Promise<string>((_resolve, reject) =>
          signal.addEventListener('abort', () => {
            firstAborted = true;
            reject(new DOMException('aborted', 'AbortError'));
          }),
        );
      },
    });
    const stop = observer.subscribe(() => {});
    await refreshVisibleQuery(
      client,
      ['progress', 'account', 'assignment'],
      observer,
      new AbortController().signal,
    );
    expect(requests).toBe(2);
    expect(firstAborted).toBe(true);
    expect(observer.getCurrentResult().data).toBe('fresh after head');
    stop();
    client.clear();
  });
  it('TanStack result errors and aborts propagate; an unrelated Source key is never cancelled/refetched', async () => {
    const client = new QueryClient();
    const cancel = vi.spyOn(client, 'cancelQueries');
    const key = ['progress', 'account', 'assignment'];
    await expect(
      refreshVisibleQuery(
        client,
        key,
        { refetch: async () => ({ error: new Error('visible503') }) },
        new AbortController().signal,
      ),
    ).rejects.toThrow('visible503');
    expect(cancel).toHaveBeenCalledWith(
      { queryKey: key, exact: true },
      { silent: true },
    );
    expect(cancel).not.toHaveBeenCalledWith({
      queryKey: ['project'],
      exact: false,
    });
    const abort = new AbortController();
    abort.abort();
    const read = vi.fn();
    await expect(
      refreshVisibleQuery(client, key, { refetch: read }, abort.signal),
    ).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
    client.clear();
  });
});
