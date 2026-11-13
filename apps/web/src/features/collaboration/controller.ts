import {
  type HocuspocusProvider,
  HocuspocusProviderWebsocket,
  WebSocketStatus,
} from '@hocuspocus/provider';
import { ApiError } from '../../api/client.ts';
import { parsePresenceIdentity } from '@code-along/contracts/collaboration/presence';
import type { EditorDocument } from '../editor/model/document.ts';
import type { EditorWorkspace } from '../editor/model/workspace.ts';
import { documentTicket, type TicketLoader } from './api.ts';
import { DocumentCheckpoint } from './checkpoint.ts';
import { CanonicalProvider } from './provider.ts';

export interface Participant {
  readonly clientId: number;
  readonly userId: string;
  readonly name: string;
  readonly color: string;
}
interface Binding {
  file: EditorDocument;
  provider: HocuspocusProvider;
  checkpoint: DocumentCheckpoint;
  abort: AbortController;
  authenticated: boolean;
  synced: boolean;
  writable: boolean;
  permanent: boolean;
  attached: boolean;
  hadWriteGrant: boolean;
  unsubscribe: () => void;
}
export interface CollaborationStatus {
  readonly phase: 'connecting' | 'connected' | 'offline' | 'blocked';
  readonly save:
    'connecting' | 'read_only' | 'pending' | 'saving' | 'saved' | 'error';
  readonly error: string;
  readonly members: Readonly<Record<string, readonly Participant[]>>;
  readonly rescued: readonly { path: string; source: string }[];
  readonly offlineEditable: boolean;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f-]{27}$/;
/** Reconnect uses full Y.Doc sync; obsolete auth/CLOSE/update frames must never queue. */
class ProjectSocket extends HocuspocusProviderWebsocket {
  override send(message: unknown): void {
    if (this.webSocket?.readyState === 1) super.send(message);
  }
  override async connect(): Promise<unknown> {
    // WebKit may defer the old close event beyond the online retry. Hocuspocus's
    // connected fast path must not retain a CLOSING/CLOSED raw socket.
    if (
      this.status === WebSocketStatus.Connected &&
      this.webSocket?.readyState !== 1
    )
      this.status = WebSocketStatus.Disconnected;
    return super.connect();
  }
}
/** Only the admitted server's stamped identity is used in participant labels. */
export function participants(
  states: Map<number, Record<string, unknown>>,
): readonly Participant[] {
  const result: Participant[] = [];
  for (const [clientId, state] of states) {
    const user = state['user'];
    if (
      !user ||
      typeof user !== 'object' ||
      !('id' in user) ||
      !('display_name' in user) ||
      !('color' in user) ||
      typeof user.id !== 'string' ||
      !uuid.test(user.id) ||
      typeof user.display_name !== 'string' ||
      !user.display_name.trim() ||
      [...user.display_name].length > 80 ||
      /[\p{Cc}\p{Cf}\p{Cs}]/u.test(user.display_name) ||
      typeof user.color !== 'string' ||
      !/^#[0-9a-fA-F]{6}$/.test(user.color) ||
      !Number.isInteger(clientId) ||
      clientId < 0 ||
      clientId > 0xffffffff
    )
      continue;
    result.push(
      Object.freeze({
        clientId,
        userId: user.id,
        name: user.display_name,
        color: user.color,
      }),
    );
  }
  return Object.freeze(
    result.sort(
      (left, right) =>
        left.name.localeCompare(right.name) || left.clientId - right.clientId,
    ),
  );
}

/** One transport per account/project, with independently admitted document providers. */
export class ProjectCollaboration {
  private socket: HocuspocusProviderWebsocket | undefined;
  private bindings = new Map<string, Binding>();
  private listeners = new Set<() => void>();
  private started = false;
  private closed = false;
  private blocked = false;
  private connected = false;
  private paused = false;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private unsubscribe: (() => void) | undefined;
  private status: CollaborationStatus = Object.freeze({
    phase: 'connecting',
    save: 'connecting',
    error: '',
    members: {},
    rescued: [],
    offlineEditable: false,
  });
  private editingStatus: Pick<
    CollaborationStatus,
    'phase' | 'save' | 'offlineEditable'
  > = { phase: 'connecting', save: 'connecting', offlineEditable: false };
  constructor(
    readonly workspace: EditorWorkspace,
    private readonly ticket: TicketLoader = documentTicket,
  ) {}
  getSnapshot = (): CollaborationStatus => this.status;
  getEditingSnapshot = () => this.editingStatus;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private publish(update: Partial<CollaborationStatus> = {}): void {
    if (this.closed) return;
    const phases = [...this.bindings.values()].map(
      (binding) => binding.checkpoint.getSnapshot().phase,
    );
    const save: CollaborationStatus['save'] = phases.includes('error')
      ? 'error'
      : !phases.length || phases.includes('connecting')
        ? 'connecting'
        : phases.every((phase) => phase === 'read_only')
          ? 'read_only'
          : phases.every((phase) => phase === 'saved')
            ? 'saved'
            : phases.includes('saving')
              ? 'saving'
              : 'pending';
    const next = {
      ...this.status,
      phase: this.blocked
        ? ('blocked' as const)
        : this.connected
          ? ('connected' as const)
          : ('offline' as const),
      save,
      offlineEditable:
        !this.blocked &&
        !this.paused &&
        !this.connected &&
        !navigator.onLine &&
        this.bindings.size > 0 &&
        [...this.bindings.values()].every(
          (binding) => binding.file.loaded && binding.hadWriteGrant,
        ),
      ...update,
    };
    if (
      Object.keys(next).every(
        (key) =>
          next[key as keyof CollaborationStatus] ===
          this.status[key as keyof CollaborationStatus],
      )
    )
      return;
    this.status = Object.freeze(next);
    if (
      next.phase !== this.editingStatus.phase ||
      next.save !== this.editingStatus.save ||
      next.offlineEditable !== this.editingStatus.offlineEditable
    )
      this.editingStatus = Object.freeze({
        phase: next.phase,
        save: next.save,
        offlineEditable: next.offlineEditable,
      });
    for (const listener of this.listeners) listener();
  }
  start(): void {
    if (this.started || this.closed || !this.workspace.canonical) return;
    this.started = true;
    const url = new URL('/collab', window.location.origin);
    url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.socket = new ProjectSocket({
      url: url.href,
      autoConnect: false,
      maxDelay: 15000,
      delay: 1000,
      messageReconnectTimeout: 30000,
      onStatus: ({ status }) => {
        this.connected = status === WebSocketStatus.Connected;
        if (status === WebSocketStatus.Disconnected) this.detachForReconnect();
        this.publish();
      },
      onOpen: () => {
        // Attach after Hocuspocus records the open event; attach then starts fresh auth once.
        queueMicrotask(() => {
          if (this.closed || this.blocked || this.paused) return;
          for (const binding of this.bindings.values())
            if (!binding.attached) {
              binding.provider.attach();
              binding.attached = true;
            }
        });
      },
      onClose: ({ event }) => {
        if (event.code === 4403)
          this.stopWrites(
            'Project access or a file generation changed. Export unsaved work before refreshing.',
          );
        else if (event.code === 1013)
          this.stopWrites(
            'Server storage or collaboration capacity is unavailable. Export unconfirmed work before rechecking access.',
          );
        else
          this.publish({
            error:
              event.code === 1013
                ? 'Collaboration is temporarily unavailable. Your code remains in this tab.'
                : '',
          });
      },
    });
    this.unsubscribe = this.workspace.subscribe(this.reconcile);
    window.addEventListener('offline', this.offline);
    window.addEventListener('online', this.online);
    this.reconcile();
    void this.socket.connect();
  }
  private detachForReconnect(): void {
    this.connected = false;
    for (const binding of this.bindings.values()) {
      binding.authenticated = false;
      binding.synced = false;
      binding.checkpoint.connection(false, false);
      binding.file.markSaved(false);
      if (binding.attached) {
        binding.provider.onClose();
        binding.provider.detach();
        binding.attached = false;
      }
    }
  }
  private offline = (): void => {
    this.detachForReconnect();
    this.socket?.disconnect();
    this.publish({
      members: {},
      error:
        'Offline edits stay on this device until fresh server admission and a checkpoint receipt.',
    });
  };
  private online = (): void => {
    const admitted =
      this.connected &&
      [...this.bindings.values()].some(
        (binding) => binding.authenticated && binding.synced,
      );
    if (!this.blocked && !this.paused && !admitted)
      this.reconnect('Rechecking access and reconnecting…');
  };
  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    if (paused)
      this.stopWrites(
        'Editing is paused until project access can be checked. Export your open code if needed.',
      );
    else this.retry();
  }
  private ready(binding: Binding): void {
    const ready =
      this.connected &&
      binding.authenticated &&
      binding.synced &&
      !this.blocked &&
      !this.paused;
    binding.checkpoint.connection(
      ready,
      ready && binding.writable && this.workspace.getSnapshot().writable,
    );
    this.publish();
  }
  private checkpointChanged(binding: Binding): void {
    const status = binding.checkpoint.getSnapshot();
    binding.file.markSaved(status.phase === 'saved');
    this.publish(status.error ? { error: status.error } : {});
  }
  private reconcile = (): void => {
    if (this.closed || !this.socket) return;
    for (const [id, binding] of this.bindings)
      if (this.workspace.file(id) !== binding.file) {
        if (binding.file.loaded && binding.file.dirty)
          this.publish({
            rescued: [
              ...this.status.rescued,
              {
                path: binding.file.metadata.path,
                source: binding.file.text.toString(),
              },
            ],
          });
        this.release(binding);
        this.bindings.delete(id);
      }
    for (const file of this.workspace.documents()) {
      const retained = this.bindings.get(file.metadata.id);
      if (retained) {
        this.ready(retained);
        continue;
      }
      const sessionId = crypto.randomUUID(),
        abort = new AbortController();
      const checkpoint = new DocumentCheckpoint(
        file.doc,
        {
          document_id: file.metadata.document_id,
          generation: file.metadata.generation,
          client_session_id: sessionId,
        },
        (frame) => binding.provider.sendStateless(frame),
        (code) => {
          if (code === 'storage_unavailable')
            this.reconnect(
              'Server saving is unavailable. Changes remain unconfirmed; reconnecting.',
            );
          else this.stopWrites(checkpoint.getSnapshot().error);
        },
      );
      const provider = new CanonicalProvider(
        {
          websocketProvider: this.socket,
          name: `${file.metadata.document_id}:${file.metadata.generation}`,
          document: file.doc,
          token: async () => {
            try {
              const grant = await this.ticket(
                this.workspace.projectId,
                file,
                this.workspace.getSnapshot().writable ? 'write' : 'read',
                sessionId,
                abort.signal,
              );
              if (
                this.closed ||
                this.blocked ||
                abort.signal.aborted ||
                this.workspace.file(file.metadata.id) !== file
              )
                throw new Error('Collaboration session ended.');
              return grant.ticket;
            } catch (error) {
              if (
                error instanceof ApiError &&
                [401, 403, 404, 409].includes(error.status)
              )
                binding.permanent = true;
              throw new Error('Collaboration admission is unavailable.', {
                cause: error,
              });
            }
          },
          onAuthenticated: ({ scope }) => {
            if (this.closed || abort.signal.aborted) return;
            binding.authenticated = true;
            binding.writable =
              scope === 'read-write' && this.workspace.getSnapshot().writable;
            binding.hadWriteGrant = binding.writable;
            this.publish({ error: '' });
            this.ready(binding);
          },
          onAuthenticationFailed: () => {
            if (this.closed || abort.signal.aborted || this.blocked) return;
            if (binding.permanent)
              this.stopWrites(
                'Project access changed. Export your code before refreshing.',
              );
            else
              this.reconnect(
                'The collaboration connection could not be admitted. Retrying…',
              );
          },
          onClose: ({ event }) => {
            if (this.closed || abort.signal.aborted || this.blocked) return;
            binding.authenticated = false;
            binding.synced = false;
            checkpoint.connection(false, false);
            if (
              event.code === 4403 ||
              ['unauthorized', 'read_only', 'generation_mismatch'].includes(
                event.reason,
              )
            )
              this.stopWrites(
                'Project access or this file generation changed. Export unconfirmed work before refreshing.',
              );
            else
              this.reconnect(
                'Collaboration admission ended. Rechecking access…',
              );
          },
          onStateless: ({ payload }) => {
            if (
              this.closed ||
              abort.signal.aborted ||
              this.blocked ||
              this.workspace.file(file.metadata.id) !== file
            )
              return;
            const identity = parsePresenceIdentity(payload);
            if (identity.ok) {
              const value = identity.value;
              if (
                value.document_id === file.metadata.document_id &&
                value.generation === file.metadata.generation &&
                value.client_session_id === sessionId &&
                value.awareness_client_id === file.doc.clientID &&
                value.user.id === this.workspace.accountId
              ) {
                provider.awareness?.setLocalStateField('user', {
                  ...value.user,
                  name: value.user.display_name,
                  colorLight: `${value.user.color}33`,
                });
              }
              return;
            }
            checkpoint.receive(payload);
          },
          onAwarenessChange: () => {
            if (this.closed || abort.signal.aborted) return;
            const members = {
              ...this.status.members,
              [file.metadata.id]: participants(
                provider.awareness?.getStates() ?? new Map(),
              ),
            };
            this.publish({ members });
          },
        },
        () => {
          if (
            this.closed ||
            this.blocked ||
            abort.signal.aborted ||
            !binding.authenticated ||
            !binding.attached ||
            this.workspace.file(file.metadata.id) !== file
          )
            return;
          binding.synced = true;
          file.synchronizedFromServer();
          this.ready(binding);
        },
        () =>
          this.stopWrites(
            'The server document could not be synchronized. Export your local code before refreshing.',
          ),
      );
      const binding: Binding = {
        file,
        provider,
        checkpoint,
        abort,
        authenticated: false,
        synced: false,
        writable: false,
        permanent: false,
        attached: false,
        hadWriteGrant: false,
        unsubscribe: () => {},
      };
      this.bindings.set(file.metadata.id, binding);
      binding.unsubscribe = checkpoint.subscribe(() =>
        this.checkpointChanged(binding),
      );
      file.awareness = provider.awareness;
      provider.attach();
      binding.attached = true;
    }
    this.publish();
  };
  private stopWrites(error: string): void {
    if (this.closed) return;
    this.blocked = true;
    for (const binding of this.bindings.values()) {
      binding.checkpoint.connection(false, false);
      binding.file.markSaved(false);
      binding.provider.detach();
      binding.attached = false;
      binding.hadWriteGrant = false;
    }
    this.socket?.disconnect();
    this.publish({ error });
  }
  private reconnect(error: string): void {
    if (this.closed || this.blocked) return;
    this.detachForReconnect();
    this.socket?.disconnect();
    this.publish({ error });
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      if (!this.closed && !this.blocked) void this.socket?.connect();
    }, 1500);
  }
  retry = (): void => {
    if (this.closed || this.paused) return;
    this.blocked = false;
    for (const binding of this.bindings.values()) binding.permanent = false;
    this.reconnect('Reconnecting to collaboration…');
  };
  save = (): void => {
    for (const binding of this.bindings.values()) binding.checkpoint.save();
  };
  private release(binding: Binding): void {
    binding.abort.abort();
    binding.unsubscribe();
    binding.checkpoint.destroy();
    binding.file.awareness = null;
    binding.provider.destroy();
  }
  destroy(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.retryTimer);
    this.unsubscribe?.();
    window.removeEventListener('offline', this.offline);
    window.removeEventListener('online', this.online);
    for (const binding of this.bindings.values()) this.release(binding);
    this.bindings.clear();
    this.socket?.destroy();
    this.listeners.clear();
  }
}
