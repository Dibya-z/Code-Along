import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ChatMessage,
  ChatPage,
  EventPage,
  ProjectEvent,
} from '@code-along/contracts/events';
import type { DiscussionApi } from './api.ts';
import { DiscussionController } from './controller.ts';
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
