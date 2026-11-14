import {
  isChatMessage,
  parseEventFrame,
  subscribeEvents,
  validChatBody,
  type ChatMessage,
  type EventFrame,
  type ProjectEvent,
} from '@code-along/contracts/events';
import { ApiError } from '../../api/client.ts';
import type { ChatRequest, DiscussionApi } from './api.ts';

export type RefreshKind = 'all' | 'project' | 'access' | 'revision';
export interface PendingMessage {
  readonly request: ChatRequest;
  readonly phase: 'sending' | 'unconfirmed';
  readonly error: string;
}
export interface DiscussionSnapshot {
  readonly phase:
    'loading' | 'connected' | 'reconnecting' | 'offline' | 'blocked';
  readonly ready: boolean;
  readonly canPost: boolean;
  readonly error: string;
  readonly messages: readonly ChatMessage[];
  readonly pending: readonly PendingMessage[];
  readonly hasOlder: boolean;
  readonly loadingOlder: boolean;
}
type Socket = Pick<
  WebSocket,
  | 'readyState'
  | 'send'
  | 'close'
  | 'onopen'
  | 'onclose'
  | 'onmessage'
  | 'onerror'
>;
interface Environment {
  socket: (url: string) => Socket;
  online: () => boolean;
  origin: string;
  listen: (type: 'online' | 'offline', callback: () => void) => () => void;
}
const environment = (): Environment => ({
  socket: (url) => new WebSocket(url),
  online: () => navigator.onLine,
  origin: window.location.origin,
  listen: (type, callback) => {
    window.addEventListener(type, callback);
    return () => window.removeEventListener(type, callback);
  },
});
const max = (left: string, right: string) =>
  BigInt(left) >= BigInt(right) ? left : right;
const nonceKey = (message: Pick<ChatMessage, 'author' | 'client_message_id'>) =>
  `${message.author.id}:${message.client_message_id}`;

/** One ordinary account/project observation lifetime. Pending writes are memory-only and manual. */
export class DiscussionController {
  private state: DiscussionSnapshot = Object.freeze({
    phase: 'loading',
    ready: false,
    canPost: false,
    error: '',
    messages: [],
    pending: [],
    hasOlder: false,
    loadingOlder: false,
  });
  private listeners = new Set<() => void>();
  private messages = new Map<string, ChatMessage>();
  private nonces = new Map<string, string>();
  private pending = new Map<string, PendingMessage>();
  private socket: Socket | undefined;
  private epoch = 0;
  private closed = false;
  private started = false;
  private blocked = false;
  private cursor: string | null = null;
  private head = '0';
  private before: string | null = null;
  private buffer: ProjectEvent[] = [];
  private bufferBytes = 0;
  private hello: Extract<EventFrame, { type: 'subscribed' }> | null = null;
  private receivedHello = false;
  private working = false;
  private read = new AbortController();
  private writes = new Set<AbortController>();
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private attempt = 0;
  private lastFrame = 0;
  private unlisten: (() => void)[] = [];
  private readonly env: Environment;
  constructor(
    readonly accountId: string,
    readonly projectId: string,
    private readonly api: DiscussionApi,
    private readonly refresh: (kind: RefreshKind) => Promise<void>,
    env?: Environment,
  ) {
    this.env = env ?? environment();
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private publish(update: Partial<DiscussionSnapshot> = {}, content = false) {
    if (this.closed) return;
    this.state = Object.freeze({
      ...this.state,
      ...update,
      ...(content
        ? {
            messages: Object.freeze(
              [...this.messages.values()].sort((a, b) =>
                BigInt(a.sequence) < BigInt(b.sequence) ? -1 : 1,
              ),
            ),
            pending: Object.freeze([...this.pending.values()]),
          }
        : {}),
    });
    for (const listener of this.listeners) listener();
  }
  start() {
    if (this.started || this.closed) return;
    this.started = true;
    this.unlisten = [
      this.env.listen('online', () => {
        if (!this.blocked) this.connect();
      }),
      this.env.listen('offline', () => this.disconnected('offline')),
    ];
    this.heartbeat = setInterval(() => {
      if (
        !this.blocked &&
        this.env.online() &&
        Date.now() - this.lastFrame > 30000
      )
        this.disconnected('reconnecting');
    }, 5000);
    this.connect();
  }
  private current(epoch: number) {
    return !this.closed && epoch === this.epoch && !this.read.signal.aborted;
  }
  private connect() {
    if (this.closed || this.blocked || this.socket || !this.env.online())
      return;
    clearTimeout(this.retryTimer);
    this.read.abort();
    this.read = new AbortController();
    const epoch = ++this.epoch;
    this.receivedHello = false;
    this.hello = null;
    this.working = false;
    this.lastFrame = Date.now();
    this.publish({
      phase: this.state.ready ? 'reconnecting' : 'loading',
      error: '',
      loadingOlder: false,
    });
    void this.api
      .authorize(this.read.signal)
      .then((grant) => {
        if (!this.current(epoch)) return;
        if (grant.accountId !== this.accountId)
          return this.block(
            'This account session changed. Reopen the project.',
          );
        this.publish({ canPost: grant.canPost });
        const url = new URL('/events', this.env.origin);
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        const socket = this.env.socket(url.href);
        this.socket = socket;
        this.lastFrame = Date.now();
        socket.onopen = () => {
          if (this.current(epoch))
            socket.send(subscribeEvents(this.projectId, this.cursor));
        };
        socket.onmessage = (event) => {
          if (this.current(epoch)) {
            try {
              this.receive(event.data, epoch);
            } catch {
              this.block(
                'The discussion update could not be verified. Recheck project access.',
              );
            }
          }
        };
        socket.onerror = () => {
          if (this.current(epoch)) this.disconnected('reconnecting');
        };
        socket.onclose = (event) => {
          if (!this.current(epoch)) return;
          if (event.code === 4403 || event.code === 4400) {
            this.block(
              event.code === 4403
                ? 'Discussion access changed. Recheck project access before continuing.'
                : 'The discussion protocol could not be verified. Recheck the project.',
            );
            void this.refresh('access').catch(() => {});
          } else
            this.disconnected(this.env.online() ? 'reconnecting' : 'offline');
        };
      })
      .catch((error: unknown) => {
        if (this.current(epoch)) this.failed(error);
      });
  }
  private releaseSocket() {
    const socket = this.socket;
    this.socket = undefined;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      socket.close();
    }
  }
  private disconnected(phase: 'offline' | 'reconnecting') {
    if (this.closed || this.blocked) return;
    this.read.abort();
    this.epoch++;
    this.working = false;
    this.releaseSocket();
    this.publish({
      phase,
      loadingOlder: false,
      error:
        phase === 'offline'
          ? 'Offline. Messages are not queued. Reconnect before sending or retrying.'
          : 'Live discussion updates are reconnecting. Confirmed messages remain here.',
    });
    if (this.env.online())
      this.retryTimer = setTimeout(
        () => this.connect(),
        Math.min(15000, 1000 * 2 ** Math.min(this.attempt++, 4)),
      );
  }
  private block(error: string) {
    this.blocked = true;
    clearTimeout(this.retryTimer);
    this.read.abort();
    this.epoch++;
    this.releaseSocket();
    for (const write of this.writes) write.abort();
    this.publish({
      phase: 'blocked',
      canPost: false,
      error,
      loadingOlder: false,
    });
  }
  private failed(error: unknown) {
    if (error instanceof ApiError && [401, 403, 404].includes(error.status)) {
      this.block(
        'Discussion access is unavailable. Recheck project access before continuing.',
      );
      void this.refresh('access').catch(() => {});
    } else this.disconnected(this.env.online() ? 'reconnecting' : 'offline');
  }
  private queue(event: ProjectEvent) {
    const bytes = new TextEncoder().encode(JSON.stringify(event)).length;
    if (this.buffer.length >= 100 || this.bufferBytes + bytes > 512 * 1024) {
      this.buffer = [];
      this.bufferBytes = 0;
    }
    this.buffer.push(event);
    this.bufferBytes += bytes;
  }
  private receive(raw: unknown, epoch: number) {
    const parsed = parseEventFrame(raw);
    if (!parsed.ok || parsed.value.project_id !== this.projectId)
      return this.block(
        'The discussion update could not be verified. Recheck project access.',
      );
    this.lastFrame = Date.now();
    const frame = parsed.value;
    if (frame.type === 'subscribed') {
      if (this.receivedHello)
        return this.block(
          'The discussion subscription changed unexpectedly. Recheck project access.',
        );
      this.receivedHello = true;
      this.hello = frame;
      this.head = max(this.head, frame.head_sequence);
    } else if (frame.type === 'head') {
      if (!this.receivedHello)
        return this.block(
          'The discussion subscription was not established. Recheck project access.',
        );
      this.head = max(this.head, frame.head_sequence);
    } else {
      this.head = max(this.head, frame.sequence);
      if (frame.event_type === 'chat.message.created')
        this.ingest(frame.data.message);
      this.queue(frame);
    }
    this.schedule(epoch);
  }
  private ingest(message: ChatMessage) {
    if (message.project_id !== this.projectId)
      throw new Error('Discussion project identity changed.');
    const existing = this.messages.get(message.id),
      sameNonce = this.nonces.get(nonceKey(message));
    const pending =
      message.author.id === this.accountId
        ? this.pending.get(message.client_message_id)
        : undefined;
    if (pending && !message.deleted && pending.request.body !== message.body)
      throw new Error('Discussion request content changed.');
    if (
      (sameNonce && sameNonce !== message.id) ||
      (existing &&
        (existing.sequence !== message.sequence ||
          nonceKey(existing) !== nonceKey(message)))
    )
      throw new Error('Discussion identity changed.');
    if (existing?.deleted && !message.deleted) return;
    this.messages.set(message.id, message);
    this.nonces.set(nonceKey(message), message.id);
    if (message.author.id === this.accountId)
      this.pending.delete(message.client_message_id);
    this.publish({}, true);
  }
  private async bootstrap(anchor: string, epoch: number) {
    const [, page] = await Promise.all([
      this.refresh('all'),
      this.api.latest(this.read.signal),
    ]);
    if (!this.current(epoch)) return;
    if (BigInt(page.head_sequence) < BigInt(anchor))
      throw new Error('Discussion snapshot predates the subscription.');
    for (const message of page.items) this.ingest(message);
    this.before = page.next_before;
    this.cursor = anchor;
    this.publish({ ready: true, hasOlder: page.has_more });
  }
  private async apply(event: ProjectEvent) {
    if (event.event_type === 'chat.message.created')
      this.ingest(event.data.message);
    else
      await this.refresh(
        event.event_type === 'revision.created'
          ? 'revision'
          : event.event_type === 'project.access.changed'
            ? 'access'
            : 'project',
      );
  }
  private schedule(epoch: number) {
    if (this.working || !this.receivedHello || !this.current(epoch)) return;
    this.working = true;
    void this.synchronize(epoch)
      .catch((error: unknown) => {
        if (this.current(epoch)) this.failed(error);
      })
      .finally(() => {
        if (this.current(epoch)) {
          this.working = false;
          if (
            this.hello ||
            (this.cursor !== null && BigInt(this.head) > BigInt(this.cursor))
          )
            this.schedule(epoch);
        }
      });
  }
  private async synchronize(epoch: number) {
    const hello = this.hello;
    this.hello = null;
    if (hello) {
      if (this.cursor === null || hello.refresh_required)
        await this.bootstrap(hello.head_sequence, epoch);
      else hello.events.forEach((event) => this.queue(event));
    }
    while (this.current(epoch) && this.cursor !== null) {
      const cursor = this.cursor;
      this.buffer = this.buffer
        .filter((event) => BigInt(event.sequence) > BigInt(cursor))
        .sort((a, b) => (BigInt(a.sequence) < BigInt(b.sequence) ? -1 : 1));
      this.bufferBytes = this.buffer.reduce(
        (total, event) =>
          total + new TextEncoder().encode(JSON.stringify(event)).length,
        0,
      );
      const event = this.buffer[0];
      if (event && BigInt(event.sequence) === BigInt(this.cursor) + 1n) {
        this.buffer.shift();
        await this.apply(event);
        if (this.current(epoch)) this.cursor = event.sequence;
        continue;
      }
      if (BigInt(this.head) <= BigInt(this.cursor)) break;
      const page = await this.api.events(this.cursor, this.read.signal);
      if (!this.current(epoch)) return;
      this.head = max(this.head, page.head_sequence);
      if (page.refresh_required) {
        await this.bootstrap(page.head_sequence, epoch);
        continue;
      }
      if (!page.items.length)
        throw new Error('Incomplete project event history.');
      for (const item of page.items) {
        if (BigInt(item.sequence) !== BigInt(this.cursor) + 1n)
          throw new Error('Incomplete project event history.');
        await this.apply(item);
        if (!this.current(epoch)) return;
        this.cursor = item.sequence;
      }
      if (page.next_after !== this.cursor)
        throw new Error('Project event cursor changed.');
    }
    if (this.current(epoch)) {
      this.attempt = 0;
      this.publish({ phase: 'connected', error: '' });
    }
  }
  setWritable(writable: boolean) {
    const canPost = writable && !this.blocked;
    if (this.state.canPost !== canPost) this.publish({ canPost });
  }
  recheck() {
    if (this.closed) return;
    this.blocked = false;
    this.releaseSocket();
    this.connect();
  }
  async older() {
    if (
      !this.before ||
      this.state.loadingOlder ||
      this.closed ||
      this.blocked ||
      !this.env.online() ||
      this.read.signal.aborted ||
      !this.receivedHello ||
      !this.state.hasOlder
    )
      return;
    const epoch = this.epoch;
    this.publish({ loadingOlder: true });
    try {
      const page = await this.api.older(this.before, this.read.signal);
      if (this.current(epoch)) {
        page.items.forEach((message) => this.ingest(message));
        this.before = page.next_before;
        this.publish({ hasOlder: page.has_more, error: '' });
      }
    } catch {
      if (this.current(epoch))
        this.publish({
          error: 'Older messages could not be loaded. Retry when connected.',
        });
    } finally {
      if (this.current(epoch)) this.publish({ loadingOlder: false });
    }
  }
  send(body: string): boolean {
    if (
      this.closed ||
      !this.state.ready ||
      !this.state.canPost ||
      this.blocked ||
      !this.env.online() ||
      this.pending.size >= 20 ||
      !validChatBody(body)
    )
      return false;
    const request = Object.freeze({
      client_message_id: crypto.randomUUID(),
      body,
    });
    this.pending.set(request.client_message_id, {
      request,
      phase: 'sending',
      error: '',
    });
    this.publish({}, true);
    void this.attemptPost(request);
    return true;
  }
  retry(clientId: string) {
    const pending = this.pending.get(clientId);
    if (
      !pending ||
      pending.phase === 'sending' ||
      this.closed ||
      this.blocked ||
      !this.env.online()
    )
      return;
    this.pending.set(clientId, { ...pending, phase: 'sending', error: '' });
    this.publish({}, true);
    void this.attemptPost(pending.request);
  }
  private async attemptPost(request: ChatRequest) {
    const abort = new AbortController();
    this.writes.add(abort);
    const timeout = setTimeout(() => abort.abort(), 30000);
    try {
      const grant = await this.api.authorize(abort.signal);
      if (grant.accountId !== this.accountId) {
        this.block('This account session changed. Reopen the project.');
        throw new Error('Account session changed.');
      }
      if (!this.closed)
        this.publish({ canPost: grant.canPost && !this.blocked });
      if (
        this.closed ||
        abort.signal.aborted ||
        grant.accountId !== this.accountId ||
        !grant.canPost ||
        !this.env.online()
      )
        throw new Error('Current account/project permission is required.');
      const message = await this.api.post(request, abort.signal);
      if (
        !isChatMessage(message) ||
        message.project_id !== this.projectId ||
        message.author.id !== this.accountId ||
        message.client_message_id !== request.client_message_id ||
        message.deleted ||
        message.body !== request.body
      )
        throw new Error('Discussion response correlation failed.');
      if (!this.closed && !abort.signal.aborted) this.ingest(message);
    } catch (error) {
      if (
        !this.closed &&
        error instanceof ApiError &&
        [401, 403, 404].includes(error.status)
      )
        this.failed(error);
      if (
        !this.closed &&
        this.pending.has(request.client_message_id) &&
        !this.nonces.has(`${this.accountId}:${request.client_message_id}`)
      ) {
        this.pending.set(request.client_message_id, {
          request,
          phase: 'unconfirmed',
          error: 'Not confirmed. Recheck access, then retry this same message.',
        });
        this.publish({}, true);
      }
    } finally {
      clearTimeout(timeout);
      this.writes.delete(abort);
    }
  }
  destroy() {
    if (this.closed) return;
    this.closed = true;
    this.read.abort();
    for (const write of this.writes) write.abort();
    clearTimeout(this.retryTimer);
    clearInterval(this.heartbeat);
    this.unlisten.forEach((remove) => remove());
    this.releaseSocket();
    this.buffer = [];
    this.messages.clear();
    this.nonces.clear();
    this.pending.clear();
    this.listeners.clear();
  }
}
