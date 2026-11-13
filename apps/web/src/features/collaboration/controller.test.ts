import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Y from 'yjs';
import { sha256, sourceBytes } from '@code-along/contracts/execution';
import { CORE_RUNTIME } from '@code-along/contracts/execution/profiles';
import { ApiError } from '../../api/client.ts';
import { EditorWorkspace } from '../editor/model/workspace.ts';
import { documentTicket } from './api.ts';
import { participants, ProjectCollaboration } from './controller.ts';

interface SocketOptions {
  onStatus: (event: { status: string }) => void;
  onOpen: () => void;
  onClose: (data: { event: { code: number; reason: string } }) => void;
}
interface ProviderOptions {
  document: Y.Doc;
  token: () => Promise<string>;
  onAuthenticated: (data: { scope: 'read-write' | 'readonly' }) => void;
  onSynced?: (data: { state: boolean }) => void;
  onAuthenticationFailed: () => void;
  onAwarenessChange: () => void;
  onStateless: (data: { payload: string }) => void;
  onClose: (data: { event: { code: number; reason: string } }) => void;
}
const transport = vi.hoisted(() => {
  class Socket {
    static instances: Socket[] = [];
    attempts = vi.fn(async () => {});
    status = 'disconnected';
    shouldConnect = true;
    async connect() {
      if (this.status === 'connected') return;
      this.shouldConnect = true;
      await this.attempts();
    }
    disconnect = vi.fn(() => {
      this.shouldConnect = false;
      if (this.webSocket) this.webSocket.readyState = 2;
    });
    destroy = vi.fn();
    webSocket: { readyState: number } | null = null;
    frames: unknown[] = [];
    send(frame: unknown) {
      this.frames.push(frame);
    }
    constructor(readonly options: SocketOptions) {
      Socket.instances.push(this);
    }
    open() {
      this.status = 'connected';
      this.webSocket = { readyState: 1 };
      this.options.onOpen();
      this.options.onStatus({ status: 'connected' });
    }
  }
  class Provider {
    static instances: Provider[] = [];
    attached = false;
    updates = 0;
    states = new Map<number, Record<string, unknown>>();
    awareness = {
      getStates: () => this.states,
      setLocalStateField: vi.fn((key: string, value: unknown) => {
        const clientId = this.options.document.clientID;
        this.states.set(clientId, {
          ...this.states.get(clientId),
          [key]: value,
        });
        this.options.onAwarenessChange();
      }),
    };
    sendStateless = vi.fn();
    attach = vi.fn(() => {
      this.attached = true;
    });
    detach = vi.fn(() => {
      this.attached = false;
    });
    onClose = vi.fn();
    initialize = () => {};
    private changed = () => {
      if (this.attached) this.updates++;
    };
    constructor(readonly options: ProviderOptions) {
      Provider.instances.push(this);
      options.document.on('update', this.changed);
    }
    destroy() {
      this.detach();
      this.options.document.off('update', this.changed);
    }
  }
  return { Socket, Provider };
});
vi.mock('@hocuspocus/provider', () => ({
  HocuspocusProvider: transport.Provider,
  HocuspocusProviderWebsocket: transport.Socket,
  WebSocketStatus: {
    Connected: 'connected',
    Connecting: 'connecting',
    Disconnected: 'disconnected',
  },
}));
vi.mock('./api.ts', () => ({ documentTicket: vi.fn() }));
vi.mock('./provider.ts', () => ({
  CanonicalProvider: class extends transport.Provider {
    constructor(options: ProviderOptions, initialized: () => void) {
      super(options);
      this.initialize = initialized;
    }
  },
}));

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
async function setup(
  viewer = false,
  count = 1,
  ticket?: typeof documentTicket,
) {
  vi.useFakeTimers();
  vi.stubGlobal(
    'window',
    Object.assign(new EventTarget(), {
      location: new URL('https://app.example'),
    }),
  );
  vi.stubGlobal('navigator', { onLine: true });
  const workspace = new EditorWorkspace(id(1), id(2), 'project', true);
  const file = {
    id: id(3),
    document_id: id(4),
    generation: 1,
    kind: 'python' as const,
    path: 'main.py',
    initial_source: '',
    initial_sha256: await sha256(sourceBytes('')),
  };
  const files = Array.from({ length: count }, (_, index) => ({
    ...file,
    id: id(3 + index * 10),
    document_id: id(4 + index * 10),
    path: index ? `helper${index}.py` : 'main.py',
  }));
  workspace.reconcile(
    {
      id: id(2),
      name: 'Shared',
      role: viewer ? 'viewer' : 'owner',
      archived: false,
      workspace_archived: false,
      metadata_version: 1,
      entrypoint_file_id: id(3),
      runtime_id: CORE_RUNTIME.runtime_id,
    },
    files,
  );
  await Promise.all(files.map((file) => workspace.loadSource(file)));
  vi.mocked(documentTicket).mockResolvedValue({
    ticket: 'transient-ticket',
    expires_at: new Date(Date.now() + 30000).toISOString(),
    document_name: `${file.document_id}:1`,
  });
  const model = new ProjectCollaboration(workspace, ticket);
  const socketCount = transport.Socket.instances.length;
  model.start();
  const socket = transport.Socket.instances.at(-1)!,
    providers = transport.Provider.instances.slice(-count),
    provider = providers[0]!;
  socket.open();
  await Promise.resolve();
  async function admit() {
    for (const provider of providers) {
      await provider.options.token();
      provider.options.onAuthenticated({
        scope: viewer ? 'readonly' : 'read-write',
      });
      provider.initialize();
    }
  }
  return {
    workspace,
    file,
    model,
    socket,
    provider,
    providers,
    socketCount,
    admit,
    close: () => {
      model.destroy();
      workspace.destroy();
    },
  };
}
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('project transport lifecycle', () => {
  it('uses only the capability admission closure for initial sync and fresh reconnect tickets', async () => {
    const ticket = vi.fn<typeof documentTicket>(async () => ({
      ticket: 'capability-ticket',
      expires_at: new Date(Date.now() + 30000).toISOString(),
      document_name: `${id(4)}:1`,
    }));
    const f = await setup(false, 1, ticket);
    await f.admit();
    expect(ticket).toHaveBeenCalledWith(
      id(2),
      f.workspace.file(id(3)),
      'write',
      expect.any(String),
      expect.any(AbortSignal),
    );
    vi.stubGlobal('navigator', { onLine: false });
    window.dispatchEvent(new Event('offline'));
    vi.stubGlobal('navigator', { onLine: true });
    window.dispatchEvent(new Event('online'));
    f.socket.open();
    await Promise.resolve();
    await f.admit();
    expect(ticket).toHaveBeenCalledTimes(2);
    expect(documentTicket).not.toHaveBeenCalled();
    f.close();
  });
  it('keeps a newly authenticated document unloaded/read-only until the initial-state adapter completes', async () => {
    const f = await setup();
    f.provider.options.onAuthenticated({ scope: 'read-write' });
    f.provider.options.onSynced?.({ state: true });
    expect(f.workspace.file(id(3))!.loaded).toBe(false);
    expect(f.model.getSnapshot().save).toBe('connecting');
    f.provider.initialize();
    expect(f.workspace.file(id(3))!.loaded).toBe(true);
    expect(f.model.getSnapshot().save).toBe('pending');
    f.close();
  });
  it('seeds only this admitted account/document awareness identity and preserves remote client IDs', async () => {
    const f = await setup();
    await f.admit();
    const remote = {
      user: { id: id(7), display_name: 'River', color: '#2563eb' },
    };
    f.provider.states.set(77, remote);
    const identity = {
      protocol: 'code-along.presence',
      version: 1,
      type: 'presence.identity',
      document_id: id(4),
      generation: 1,
      client_session_id: vi.mocked(documentTicket).mock.calls[0]![3],
      awareness_client_id: f.workspace.file(id(3))!.doc.clientID,
      user: { id: id(1), display_name: 'Mira', color: '#2563eb' },
    };
    for (const changed of [
      { document_id: id(9) },
      { generation: 2 },
      { client_session_id: id(9) },
      { awareness_client_id: 77 },
      { user: { ...identity.user, id: id(9) } },
    ])
      f.provider.options.onStateless({
        payload: JSON.stringify({ ...identity, ...changed }),
      });
    expect(f.provider.awareness.setLocalStateField).not.toHaveBeenCalled();
    const sourceRevision = f.workspace.sourceRevision;
    f.provider.options.onStateless({ payload: JSON.stringify(identity) });
    expect(f.provider.states.get(identity.awareness_client_id)).toEqual({
      user: { ...identity.user, name: 'Mira', colorLight: '#2563eb33' },
    });
    expect(f.provider.states.get(77)).toBe(remote);
    expect(f.workspace.sourceRevision).toBe(sourceRevision);
    expect(f.model.getSnapshot().members[id(3)]).toHaveLength(2);
    f.close();
    f.provider.options.onStateless({ payload: JSON.stringify(identity) });
    expect(f.provider.awareness.setLocalStateField).toHaveBeenCalledOnce();
  });
  it('drops obsolete transport frames instead of replaying a queued CLOSE into fresh admission', async () => {
    const f = await setup();
    f.socket.webSocket = null;
    f.socket.send('obsolete-close');
    f.socket.webSocket = { readyState: 3 };
    f.socket.send('offline-update');
    expect(f.socket.frames).toEqual([]);
    f.socket.webSocket = { readyState: 1 };
    f.socket.send('fresh-auth');
    expect(f.socket.frames).toEqual(['fresh-auth']);
    f.close();
  });
  it('accepts an80-code-point safe profile even when it occupies160 UTF-16 units', () => {
    const name = '🐍'.repeat(80);
    const safe = participants(
      new Map([
        [12, { user: { id: id(1), display_name: name, color: '#236543' } }],
      ]),
    );
    expect(safe[0]?.name).toBe(name);
    for (const display_name of [
      name + 'x',
      'Hidden\u200bName',
      'Control\nName',
    ])
      expect(
        participants(
          new Map([
            [12, { user: { id: id(1), display_name, color: '#236543' } }],
          ]),
        ),
      ).toEqual([]);
  });
  it('uses one shared socket with independent document admissions and does not render Saved on sync', async () => {
    const f = await setup(false, 2);
    await f.admit();
    expect(f.model.getSnapshot().phase).toBe('connected');
    expect(f.model.getSnapshot().save).not.toBe('saved');
    expect(documentTicket).toHaveBeenCalledWith(
      id(2),
      f.workspace.file(id(3)),
      'write',
      expect.any(String),
      expect.any(AbortSignal),
    );
    expect(f.workspace.file(id(3))!.loaded).toBe(true);
    expect(transport.Socket.instances.length - f.socketCount).toBe(1);
    expect(documentTicket).toHaveBeenCalledTimes(2);
    expect(vi.mocked(documentTicket).mock.calls[0]![3]).not.toBe(
      vi.mocked(documentTicket).mock.calls[1]![3],
    );
    f.close();
  });
  it('detaches offline writers, preserves bounded canonical edits, then obtains a fresh admission', async () => {
    const f = await setup();
    await f.admit();
    const file = f.workspace.file(id(3))!;
    vi.stubGlobal('navigator', { onLine: false });
    window.dispatchEvent(new Event('offline'));
    expect(f.provider.attached).toBe(false);
    expect(f.model.getSnapshot().offlineEditable).toBe(true);
    const sent = f.provider.updates;
    file.replace('print("offline")\n');
    expect(f.provider.updates).toBe(sent);
    expect(f.model.getSnapshot().save).not.toBe('saved');
    vi.stubGlobal('navigator', { onLine: true });
    window.dispatchEvent(new Event('online'));
    f.socket.open();
    await Promise.resolve();
    await f.admit();
    expect(documentTicket).toHaveBeenCalledTimes(2);
    expect(f.provider.attached).toBe(true);
    expect(file.text.toString()).toBe('print("offline")\n');
    f.close();
  });
  it('restarts a raw socket stuck CLOSING after online without reviving authorization blocks', async () => {
    const f = await setup();
    await f.admit();
    window.dispatchEvent(new Event('online'));
    vi.advanceTimersByTime(2000);
    expect(f.socket.attempts).toHaveBeenCalledOnce();
    vi.stubGlobal('navigator', { onLine: false });
    window.dispatchEvent(new Event('offline'));
    expect(f.socket.status).toBe('connected');
    expect(f.socket.webSocket?.readyState).toBe(2);
    vi.stubGlobal('navigator', { onLine: true });
    window.dispatchEvent(new Event('online'));
    vi.advanceTimersByTime(1500);
    expect(f.socket.attempts).toHaveBeenCalledTimes(2);
    expect(f.socket.shouldConnect).toBe(true);
    f.socket.options.onClose({ event: { code: 4403, reason: 'unauthorized' } });
    window.dispatchEvent(new Event('online'));
    vi.advanceTimersByTime(30000);
    expect(f.socket.attempts).toHaveBeenCalledTimes(2);
    expect(f.model.getSnapshot().phase).toBe('blocked');
    f.close();
  });
  it('freezes revoked/storage subscriptions while keeping source exportable, including routed CLOSE', async () => {
    for (const event of [
      { code: 4403, reason: 'unauthorized' },
      { code: 1013, reason: 'storage_unavailable' },
      { code: 1000, reason: 'generation_mismatch' },
    ]) {
      const f = await setup();
      await f.admit();
      f.workspace.file(id(3))!.replace('unconfirmed work');
      if (event.code === 1000) f.provider.options.onClose({ event });
      else f.socket.options.onClose({ event });
      expect(f.model.getSnapshot().phase).toBe('blocked');
      expect(f.provider.attached).toBe(false);
      expect(f.model.getSnapshot().offlineEditable).toBe(false);
      expect(f.workspace.snapshotInput().files[0]!.source).toBe(
        'unconfirmed work',
      );
      f.close();
    }
  });
  it.each([403, 409])(
    'stops automatic retries when a fresh ticket reports revoked access or generation (%s)',
    async (status) => {
      const f = await setup();
      await f.admit();
      vi.mocked(documentTicket).mockRejectedValueOnce(new ApiError(status, {}));
      await expect(f.provider.options.token()).rejects.toThrow('admission');
      f.provider.options.onAuthenticationFailed();
      expect(f.model.getSnapshot().phase).toBe('blocked');
      vi.advanceTimersByTime(60000);
      expect(f.socket.attempts).toHaveBeenCalledOnce();
      f.close();
    },
  );
  it('never enables offline writing for a viewer and keeps cursor changes out of the workbench snapshot', async () => {
    const f = await setup(true);
    await f.admit();
    expect(f.model.getSnapshot().save).toBe('read_only');
    const stable = f.model.getEditingSnapshot();
    f.provider.states.set(55, {
      user: { id: id(7), display_name: '<River>', color: '#236543' },
    });
    f.provider.states.set(56, {
      user: { id: id(7), display_name: '<River>', color: '#236543' },
    });
    f.provider.states.set(57, {
      user: { id: 'fake', display_name: 'Spoof', color: 'red' },
    });
    f.provider.options.onAwarenessChange();
    expect(f.model.getSnapshot().members[id(3)]).toHaveLength(2);
    expect(f.model.getEditingSnapshot()).toBe(stable);
    vi.stubGlobal('navigator', { onLine: false });
    window.dispatchEvent(new Event('offline'));
    expect(f.model.getSnapshot().offlineEditable).toBe(false);
    f.close();
  });
});
