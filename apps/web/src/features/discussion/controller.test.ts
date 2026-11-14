import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ChatMessage,
  ChatPage,
  EventPage,
  ProjectEvent,
} from '@code-along/contracts/events';
import type { DiscussionApi } from './api.ts';
import { DiscussionController } from './controller.ts';
import { ApiError } from '../../api/client.ts';
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const time = '2026-11-14T01:02:03Z';
function message(
  sequence: number,
  nonce = id(100 + sequence),
  author = id(1),
): ChatMessage {
  return {
    id: id(10 + sequence),
    project_id: id(2),
    client_message_id: nonce,
    sequence: String(sequence),
    author: { id: author, display_name: 'River' },
    body: 'Exact <b>plaintext</b> 🐍\r\n',
    created_at: time,
    deleted: false,
  };
}
function chatEvent(value: ChatMessage): ProjectEvent {
  return {
    protocol: 'code-along.events',
    version: 1,
    type: 'event',
    id: id(1000 + Number(value.sequence)),
    project_id: id(2),
    sequence: value.sequence,
    occurred_at: time,
    event_type: 'chat.message.created',
    data: { message: value },
  };
}
const page = (head = '0', items: readonly ChatMessage[] = []): ChatPage => ({
  items,
  head_sequence: head,
  next_after: items.at(-1)?.sequence ?? '0',
  next_before: items[0]?.sequence ?? null,
  has_more: false,
});
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function flush() {
  for (let n = 0; n < 30; n++) await Promise.resolve();
}
class Socket {
  readyState: WebSocket['readyState'] = 1;
  send = vi.fn();
  close = vi.fn();
  onopen: WebSocket['onopen'] = null;
  onmessage: WebSocket['onmessage'] = null;
  onclose: WebSocket['onclose'] = null;
  onerror: WebSocket['onerror'] = null;
  open() {
    this.onopen?.call(this as unknown as WebSocket, new Event('open'));
  }
  frame(value: unknown) {
    this.onmessage?.call(
      this as unknown as WebSocket,
      { data: JSON.stringify(value) } as MessageEvent,
    );
  }
}
function fixture() {
  vi.useFakeTimers();
  let online = true,
    latestHead = '0';
  const sockets: Socket[] = [],
    listeners = new Map<string, () => void>();
  const api = {
    authorize: vi.fn<DiscussionApi['authorize']>(async () => ({
      accountId: id(1),
      canPost: true,
    })),
    latest: vi.fn<DiscussionApi['latest']>(async () => page(latestHead)),
    older: vi.fn<DiscussionApi['older']>(async () => page()),
    events: vi.fn<DiscussionApi['events']>(async (after) => ({
      items: [],
      head_sequence: after,
      next_after: after,
      refresh_required: false,
    })),
    post: vi.fn<DiscussionApi['post']>(async (request) => ({
      ...message(1, request.client_message_id),
      body: request.body,
    })),
  };
  const refresh = vi.fn(async () => {});
  const model = new DiscussionController(id(1), id(2), api, refresh, {
    origin: 'https://app.example',
    online: () => online,
    socket: () => {
      const socket = new Socket();
      sockets.push(socket);
      return socket;
    },
    listen: (type, callback) => {
      listeners.set(type, callback);
      return () => {
        listeners.delete(type);
      };
    },
  });
  async function ready(head = '0') {
    latestHead = head;
    model.start();
    await flush();
    const socket = sockets.at(-1)!;
    socket.open();
    socket.frame({
      protocol: 'code-along.events',
      version: 1,
      type: 'subscribed',
      project_id: id(2),
      head_sequence: head,
      refresh_required: true,
      events: [],
    });
    await flush();
    return socket;
  }
  return {
    model,
    api,
    refresh,
    sockets,
    ready,
    online(value: boolean) {
      online = value;
      listeners.get(value ? 'online' : 'offline')?.();
    },
  };
}
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});
describe('ordinary project discussion observation', () => {
  it('honors a long read cooldown across heartbeat, manual rechecks and online events without losing messages, cursor or pending nonces', async () => {
    const f = fixture();
    f.api.latest.mockResolvedValueOnce(page('5', [message(5)]));
    await f.ready('5');
    f.api.post.mockRejectedValueOnce(new Error('Response uncertain'));
    expect(f.model.send('Keep this exact pending message')).toBe(true);
    await flush();
    const pending = f.model.getSnapshot().pending[0]!;
    const originalMessages = f.model.getSnapshot().messages;
    f.api.authorize.mockRejectedValueOnce(new ApiError(429, null, 50));
    f.model.recheck();
    await flush();
    const calls = f.api.authorize.mock.calls.length;
    f.model.recheck();
    f.online(false);
    f.online(true);
    await vi.advanceTimersByTimeAsync(49999);
    expect(f.api.authorize).toHaveBeenCalledTimes(calls);
    expect(f.model.getSnapshot().error).toContain('wait');
    expect(f.sockets).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(2);
    expect(f.model.getSnapshot().messages).toEqual(originalMessages);
    expect(f.model.getSnapshot().pending).toEqual([pending]);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.api.authorize).toHaveBeenCalledTimes(calls + 1);
    expect(f.sockets).toHaveLength(2);
    const socket = f.sockets[1]!;
    socket.open();
    expect(JSON.parse(socket.send.mock.calls[0]![0] as string)).toMatchObject({
      project_id: id(2),
      after_sequence: '5',
    });
    socket.frame({
      protocol: 'code-along.events',
      version: 1,
      type: 'subscribed',
      project_id: id(2),
      head_sequence: '5',
      refresh_required: false,
      events: [],
    });
    await flush();
    expect(f.model.getSnapshot().phase).toBe('connected');
    expect(f.api.post).toHaveBeenCalledTimes(1);
    expect(f.model.getSnapshot().messages).toEqual(originalMessages);
    expect(f.model.getSnapshot().pending[0]!.request).toBe(pending.request);
    f.model.retry(pending.request.client_message_id);
    await flush();
    expect(f.api.post).toHaveBeenCalledTimes(2);
    expect(f.api.post.mock.calls[1]![0]).toBe(pending.request);
    f.model.destroy();
  });
  it('applies an older-page cooldown to sends, retries and a write already awaiting authorization', async () => {
    const f = fixture();
    f.api.latest.mockResolvedValueOnce({
      ...page('5', [message(5)]),
      next_before: '5',
      has_more: true,
    });
    await f.ready('5');
    f.api.post.mockRejectedValueOnce(new Error('Response uncertain'));
    f.model.send('Existing pending message');
    await flush();
    const request = f.model.getSnapshot().pending[0]!.request;
    const authorization = deferred<{ accountId: string; canPost: boolean }>();
    f.api.authorize.mockReturnValueOnce(authorization.promise);
    f.model.send('Already checking authorization');
    f.api.older.mockRejectedValueOnce(new ApiError(429, null, 40));
    await f.model.older();
    const calls = f.api.authorize.mock.calls.length;
    expect(f.model.send('Must not create another nonce')).toBe(false);
    f.model.retry(request.client_message_id);
    await f.model.older();
    authorization.resolve({ accountId: id(1), canPost: true });
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.api.authorize).toHaveBeenCalledTimes(calls);
    expect(f.api.post).toHaveBeenCalledTimes(1);
    expect(f.api.older).toHaveBeenCalledTimes(1);
    expect(f.model.getSnapshot().pending).toHaveLength(2);
    expect(
      f.model.getSnapshot().pending.every((p) => p.phase === 'unconfirmed'),
    ).toBe(true);
    expect(f.model.getSnapshot().pending[0]!.request).toBe(request);
    expect(f.model.getSnapshot().messages).toEqual([message(5)]);
    f.model.destroy();
  });
  it('does not replay a throttled POST and keeps its exact request available for a later manual retry', async () => {
    const f = fixture();
    await f.ready();
    f.api.post.mockRejectedValueOnce(new ApiError(429, null, 10));
    f.model.send('Retry this same message later');
    await flush();
    const pending = f.model.getSnapshot().pending[0]!;
    expect(pending.phase).toBe('unconfirmed');
    expect(f.model.send('No new attempt during cooldown')).toBe(false);
    f.model.retry(pending.request.client_message_id);
    f.model.recheck();
    f.online(true);
    await vi.advanceTimersByTimeAsync(9999);
    expect(f.api.authorize).toHaveBeenCalledTimes(2);
    expect(f.api.post).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.api.authorize).toHaveBeenCalledTimes(3);
    expect(f.api.post).toHaveBeenCalledTimes(1);
    expect(f.model.getSnapshot().pending[0]!.request).toBe(pending.request);
    f.model.retry(pending.request.client_message_id);
    await flush();
    expect(f.api.post).toHaveBeenCalledTimes(2);
    expect(f.api.post.mock.calls[1]![0]).toBe(pending.request);
    f.model.destroy();
  });
  it.each([401, 403, 404])(
    'keeps denial %s authoritative when another in-flight request reports a cooldown',
    async (status) => {
      const f = fixture();
      await f.ready();
      const first = deferred<ChatMessage>(),
        second = deferred<ChatMessage>();
      f.api.post
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise);
      f.model.send('First pending');
      f.model.send('Second pending');
      await flush();
      first.reject(new ApiError(429, null, 45));
      await flush();
      second.reject(new ApiError(status, null, 60));
      await flush();
      expect(f.model.getSnapshot().phase).toBe('blocked');
      expect(f.model.getSnapshot().canPost).toBe(false);
      const calls = f.api.authorize.mock.calls.length;
      f.online(true);
      await vi.advanceTimersByTimeAsync(60000);
      expect(f.api.authorize).toHaveBeenCalledTimes(calls);
      expect(f.api.post).toHaveBeenCalledTimes(2);
      expect(f.model.getSnapshot().phase).toBe('blocked');
      expect(f.refresh).toHaveBeenCalledWith('access');
      f.model.destroy();
    },
  );
  it('keeps the ordinary exponential read reconnect delays for errors without server timing', async () => {
    const f = fixture();
    f.api.authorize
      .mockRejectedValueOnce(new Error('Network unavailable'))
      .mockRejectedValueOnce(new Error('Network unavailable'))
      .mockRejectedValueOnce(new Error('Network unavailable'));
    f.model.start();
    await flush();
    for (const [delay, calls] of [
      [1000, 1],
      [2000, 2],
      [4000, 3],
    ] as const) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(f.api.authorize).toHaveBeenCalledTimes(calls);
      await vi.advanceTimersByTimeAsync(1);
      expect(f.api.authorize).toHaveBeenCalledTimes(calls + 1);
    }
    f.model.destroy();
  });
  it.each([undefined, 0, -1, 1.5, Infinity, NaN, 86401])(
    'does not use an invalid Retry-After %s as a cooldown',
    async (seconds) => {
      const f = fixture();
      f.api.authorize.mockRejectedValueOnce(new ApiError(429, null, seconds));
      f.model.start();
      await flush();
      await vi.advanceTimersByTimeAsync(999);
      expect(f.api.authorize).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(f.api.authorize).toHaveBeenCalledTimes(2);
      f.model.destroy();
    },
  );
  it('keeps existing manual retries available at the20-pending new-message capacity', async () => {
    const f = fixture();
    await f.ready();
    f.api.post.mockRejectedValue(new Error('Uncertain'));
    for (let n = 0; n < 20; n++)
      expect(f.model.send(`Message ${n}`)).toBe(true);
    await flush();
    expect(f.model.getSnapshot().pending).toHaveLength(20);
    expect(f.model.send('Over capacity')).toBe(false);
    const request = f.model.getSnapshot().pending[0]!.request;
    f.api.post.mockResolvedValueOnce({
      ...message(1, request.client_message_id),
      body: request.body,
    });
    f.model.retry(request.client_message_id);
    await flush();
    expect(f.api.post).toHaveBeenCalledTimes(21);
    expect(f.model.getSnapshot().pending).toHaveLength(19);
    f.model.destroy();
  });
  it('releases a cancelled older-page loading flag across reconnect without accepting its stale result', async () => {
    const f = fixture(),
      older = deferred<ChatPage>();
    const latest = {
      ...page('5', [message(5)]),
      next_before: '5',
      has_more: true,
    };
    f.api.latest.mockResolvedValue(latest);
    await f.ready('5');
    f.api.older.mockReturnValueOnce(older.promise);
    const previous = f.model.older();
    expect(f.model.getSnapshot().loadingOlder).toBe(true);
    f.online(false);
    expect(f.model.getSnapshot().loadingOlder).toBe(false);
    f.online(true);
    await flush();
    const socket = f.sockets.at(-1)!;
    socket.open();
    socket.frame({
      protocol: 'code-along.events',
      version: 1,
      type: 'subscribed',
      project_id: id(2),
      head_sequence: '5',
      refresh_required: true,
      events: [],
    });
    await flush();
    older.resolve(page('5', [message(1)]));
    await previous;
    await flush();
    expect(f.model.getSnapshot().messages).toEqual([message(5)]);
    f.api.older.mockResolvedValueOnce(page('5', [message(2)]));
    await f.model.older();
    expect(f.api.older).toHaveBeenCalledTimes(2);
    expect(f.model.getSnapshot().loadingOlder).toBe(false);
    expect(f.model.getSnapshot().messages).toEqual([message(2), message(5)]);
    f.model.destroy();
  });
  it('buffers notifications across bootstrap snapshots and repairs events after the hello head', async () => {
    const f = fixture(),
      snapshot = deferred<ChatPage>();
    f.api.latest.mockReturnValueOnce(snapshot.promise);
    const socket = await f.ready('5');
    expect(f.model.getSnapshot().ready).toBe(false);
    const value = message(6);
    socket.frame(chatEvent(value));
    snapshot.resolve(page('5'));
    await flush();
    expect(f.model.getSnapshot().phase).toBe('connected');
    expect(f.model.getSnapshot().messages).toEqual([value]);
    expect(f.api.events).not.toHaveBeenCalled();
    expect(f.refresh).toHaveBeenCalledWith('all');
    f.model.destroy();
  });
  it('repairs a final dropped notification from the authenticated head without another live event', async () => {
    const f = fixture(),
      socket = await f.ready();
    f.api.events.mockResolvedValueOnce({
      items: [chatEvent(message(1))],
      head_sequence: '1',
      next_after: '1',
      refresh_required: false,
    });
    socket.frame({
      protocol: 'code-along.events',
      version: 1,
      type: 'head',
      project_id: id(2),
      head_sequence: '1',
    });
    await flush();
    expect(f.api.events).toHaveBeenCalledWith('0', expect.any(AbortSignal));
    expect(f.model.getSnapshot().messages).toEqual([message(1)]);
    f.model.destroy();
  });
  it('uses paged contiguous event replay for gaps while chat sequence gaps remain valid', async () => {
    const f = fixture(),
      socket = await f.ready();
    const change: ProjectEvent = {
      ...chatEvent(message(1)),
      event_type: 'project.changed',
      data: { metadata_version: 2 },
    };
    const revision: ProjectEvent = {
      ...chatEvent(message(2)),
      event_type: 'revision.created',
      data: { revision_id: id(90) },
    };
    f.api.events
      .mockResolvedValueOnce({
        items: [change, revision],
        head_sequence: '3',
        next_after: '2',
        refresh_required: false,
      })
      .mockResolvedValueOnce({
        items: [chatEvent(message(3))],
        head_sequence: '3',
        next_after: '3',
        refresh_required: false,
      });
    socket.frame({
      protocol: 'code-along.events',
      version: 1,
      type: 'head',
      project_id: id(2),
      head_sequence: '3',
    });
    await flush();
    expect(f.api.events.mock.calls.map(([after]) => after)).toEqual(['0', '2']);
    expect(f.refresh.mock.calls).toEqual([['all'], ['project'], ['revision']]);
    expect(f.model.getSnapshot().messages).toEqual([message(3)]);
    f.model.destroy();
  });
  it('resnapshots explicitly pruned history before moving to its new head', async () => {
    const f = fixture(),
      socket = await f.ready('5');
    f.api.events.mockResolvedValueOnce({
      items: [],
      head_sequence: '20',
      next_after: '20',
      refresh_required: true,
    });
    f.api.latest.mockResolvedValueOnce(page('20', [message(20)]));
    socket.frame({
      protocol: 'code-along.events',
      version: 1,
      type: 'head',
      project_id: id(2),
      head_sequence: '20',
    });
    await flush();
    expect(f.refresh).toHaveBeenCalledTimes(2);
    expect(f.model.getSnapshot().messages).toEqual([message(20)]);
    f.model.destroy();
  });
  it('reconciles author+nonce and never downgrades event-proven Sent when the HTTP response later fails', async () => {
    const f = fixture(),
      socket = await f.ready(),
      result = deferred<ChatMessage>();
    f.api.post.mockReturnValueOnce(result.promise);
    expect(f.model.send('Exact <b>plaintext</b> 🐍\r\n')).toBe(true);
    await flush();
    const request = f.model.getSnapshot().pending[0]!.request;
    socket.frame(chatEvent(message(1, request.client_message_id, id(8))));
    await flush();
    expect(f.model.getSnapshot().pending).toHaveLength(1);
    const own = message(2, request.client_message_id);
    socket.frame(chatEvent(own));
    await flush();
    expect(f.model.getSnapshot().pending).toHaveLength(0);
    result.reject(new Error('Response lost'));
    await flush();
    expect(f.model.getSnapshot().pending).toHaveLength(0);
    expect(
      f.model.getSnapshot().messages.filter((item) => item.author.id === id(1)),
    ).toEqual([own]);
    f.model.destroy();
  });
  it('retries the same frozen request only manually after fresh authorization and never queues offline sends', async () => {
    const f = fixture();
    await f.ready();
    f.api.post.mockRejectedValueOnce(new Error('Lost response'));
    f.model.send('hello');
    await flush();
    const request = f.model.getSnapshot().pending[0]!.request;
    expect(f.model.getSnapshot().pending[0]!.phase).toBe('unconfirmed');
    expect(Object.isFrozen(request)).toBe(true);
    f.online(false);
    expect(f.model.send('offline')).toBe(false);
    f.model.retry(request.client_message_id);
    await flush();
    expect(f.api.post).toHaveBeenCalledTimes(1);
    f.online(true);
    await flush();
    expect(f.api.post).toHaveBeenCalledTimes(1);
    f.model.retry(request.client_message_id);
    await flush();
    expect(f.api.post).toHaveBeenCalledTimes(2);
    expect(f.api.post.mock.calls[0]![0]).toBe(f.api.post.mock.calls[1]![0]);
    expect(f.api.authorize.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(f.model.getSnapshot().pending).toHaveLength(0);
    f.model.destroy();
  });
  it('blocks malformed/foreign frames and ignores late account-scoped work after teardown', async () => {
    const f = fixture(),
      socket = await f.ready();
    socket.frame({ ...chatEvent(message(1)), project_id: id(8) });
    expect(f.model.getSnapshot().phase).toBe('blocked');
    expect(f.model.send('blocked')).toBe(false);
    expect(socket.close).toHaveBeenCalled();
    f.model.destroy();
    const g = fixture(),
      delayed = deferred<ChatMessage>();
    await g.ready();
    g.api.post.mockReturnValueOnce(delayed.promise);
    g.model.send('old account');
    await flush();
    const notify = vi.fn();
    g.model.subscribe(notify);
    g.model.destroy();
    delayed.resolve(message(1));
    await flush();
    expect(notify).not.toHaveBeenCalled();
  });
  it('rejects replay holes without advancing the cursor or calling an unbounded event loop', async () => {
    const f = fixture(),
      socket = await f.ready();
    f.api.events.mockResolvedValueOnce({
      items: [chatEvent(message(2))],
      head_sequence: '2',
      next_after: '2',
      refresh_required: false,
    } satisfies EventPage);
    socket.frame({
      protocol: 'code-along.events',
      version: 1,
      type: 'head',
      project_id: id(2),
      head_sequence: '2',
    });
    await flush();
    expect(f.model.getSnapshot().phase).toBe('reconnecting');
    expect(f.model.getSnapshot().messages).toEqual([]);
    expect(f.api.events).toHaveBeenCalledOnce();
    f.model.destroy();
  });
});
