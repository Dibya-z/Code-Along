import { afterEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import WebSocket from 'ws';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import {
  HocuspocusProvider,
  HocuspocusProviderWebsocket,
} from '@hocuspocus/provider';
import {
  createProductServer,
  inspectFrame,
} from '../../src/product/product-server.ts';
import { parsePresenceIdentity } from '@code-along/contracts/collaboration/presence';
import { CORE_RUNTIME } from '@code-along/contracts/execution/profiles';
import { HELPER_RELEASE } from '../../src/product/control.ts';
import { CheckpointStoreError } from '../../src/persistence/binary-state.ts';
import { CheckpointClient } from '../../src/protocol/checkpoint-client.ts';
import {
  AdmissionError,
  type AdmissionClient,
  type Grant,
} from '../../src/product/admission.ts';
import { documentId, grant, MemoryStore } from './fixtures.ts';

const appOrigin = 'https://app.test',
  cookie = 'codealong_session=actual';
class AuthenticatedWebSocket extends WebSocket {
  constructor(address: string | URL, protocols?: string | string[]) {
    super(address, protocols, {
      origin: appOrigin,
      headers: { Cookie: `irrelevant=hidden; ${cookie}` },
    });
  }
}
const servers: ReturnType<typeof createProductServer>[] = [],
  clients: {
    provider: HocuspocusProvider;
    socket: HocuspocusProviderWebsocket;
    doc: Y.Doc;
  }[] = [];
afterEach(async () => {
  const owned = clients.splice(0);
  for (const c of owned) c.provider.destroy();
  for (const socket of new Set(owned.map((c) => c.socket))) socket.destroy();
  for (const c of owned) c.doc.destroy();
  for (const s of servers.splice(0)) await s.destroy();
});
async function until(predicate: () => boolean | Promise<boolean>) {
  await vi.waitFor(async () => expect(await predicate()).toBe(true), {
    timeout: 3000,
    interval: 10,
  });
}
async function setup(
  options: {
    ttl?: number;
    renew?: AdmissionClient['renew'];
    store?: MemoryStore;
  } = {},
) {
  const grants = new Map<string, Grant>(),
    store = options.store ?? new MemoryStore();
  const consume = vi.fn<AdmissionClient['consume']>(async (input) => {
    expect(input.cookie).toBe(cookie);
    expect(input.origin).toBe(appOrigin);
    const value = grants.get(input.ticket);
    if (!value) throw new AdmissionError('unauthorized');
    grants.delete(input.ticket);
    return { grant: value, started: performance.now() };
  });
  const server = createProductServer({
    store,
    admission: {
      consume,
      renew:
        options.renew ??
        (async (lease) => ({ grant: lease.grant, started: performance.now() })),
    },
    appOrigin,
    sessionCookieName: 'codealong_session',
    controlSecret: 'c'.repeat(40),
    port: 0,
    debounce: 20,
  });
  servers.push(server);
  await server.listen();
  function client(value = grant(), socket?: HocuspocusProviderWebsocket) {
    const doc = new Y.Doc();
    value.awareness_client_id = doc.clientID;
    if (options.ttl) value.ttl_ms = options.ttl;
    const token = Buffer.from(
      randomUUID().replaceAll('-', '').padEnd(32, 'a'),
    ).toString('base64url');
    grants.set(token, value);
    const transport =
      socket ??
      new HocuspocusProviderWebsocket({
        url: `ws://127.0.0.1:${server.address.port}/collab`,
        WebSocketPolyfill: AuthenticatedWebSocket,
        autoConnect: false,
        delay: 20,
        minDelay: 20,
        maxDelay: 40,
        jitter: false,
      });
    const replies: string[] = [];
    const provider = new HocuspocusProvider({
      websocketProvider: transport,
      name: `${value.document.id}:1`,
      token,
      document: doc,
      onStateless: ({ payload }) => replies.push(payload),
    });
    provider.attach();
    const entry = { provider, socket: transport, doc };
    clients.push(entry);
    return { ...entry, grant: value, replies };
  }
  async function connect(c: ReturnType<typeof client>) {
    void c.socket.connect();
    await until(() => c.provider.isSynced);
    // These fixtures register one-use admission grants. Automatic retries after
    // an intentional denial/expiry cannot be admitted and can leave a fresh
    // CONNECTING ws socket when the test tears down. Explicit connect remains
    // available; actual fresh-ticket reconnect has separate integration gates.
    c.socket.setConfiguration({ autoConnect: false });
  }
  return { server, client, connect, store, consume };
}
function frame(
  name: string,
  opcode: number,
  append?: (encoder: encoding.Encoder) => void,
): Uint8Array {
  const out = encoding.createEncoder();
  encoding.writeVarString(out, name);
  encoding.writeVarUint(out, opcode);
  append?.(out);
  return encoding.toUint8Array(out);
}

describe('product collaboration transport', () => {
  it('initializes real starter once, multiplexes document admissions and persists correlated deletion-only checkpoints', async () => {
    const f = await setup(),
      first = f.client(),
      second = f.client(
        grant('10000000-0000-4000-8000-000000000099', 'other\r\n'),
        first.socket,
      );
    await f.connect(first);
    await until(() => second.provider.isSynced);
    expect(first.doc.getText('source').toString()).toBe('print("starter")\n');
    expect(second.doc.getText('source').toString()).toBe('other\r\n');
    expect(f.consume).toHaveBeenCalledTimes(2);
    const tracker = new CheckpointClient(first.doc, {
      document_id: documentId,
      generation: 1,
      client_session_id: first.grant.client_session_id,
    });
    try {
      first.doc.getText('source').delete(0, first.doc.getText('source').length);
      const request = tracker.capture(randomUUID());
      first.provider.sendStateless(JSON.stringify(request));
      await until(() =>
        first.replies.some(
          (reply) => tracker.receive(reply)?.type === 'checkpoint.receipt',
        ),
      );
      expect(tracker.saved).toBe(true);
      expect(f.store.source()).toBe('');
      const third = f.client(grant());
      await f.connect(third);
      expect(third.doc.getText('source').toString()).toBe('');
    } finally {
      tracker.destroy();
    }
  });
  it('stamps identity and rejects awareness removal/claim for another client', async () => {
    const f = await setup(),
      a = f.client(),
      b = f.client();
    await f.connect(a);
    await f.connect(b);
    a.provider.awareness!.setLocalStateField('user', {
      id: 'spoof',
      name: 'spoof',
      color: 'red',
    });
    await until(
      () =>
        b.provider.awareness!.getStates().get(a.doc.clientID)?.['user']?.id ===
        a.grant.user.id,
    );
    const room = f.server.hocuspocus.documents.get(`${documentId}:1`)!;
    b.provider.awareness!.setLocalStateField('user', {});
    await until(() => room.awareness.getStates().has(b.doc.clientID));
    const update = encoding.createEncoder();
    encoding.writeVarUint(update, 1);
    encoding.writeVarUint(update, b.doc.clientID);
    encoding.writeVarUint(update, 999);
    encoding.writeVarString(update, 'null');
    const bytes = frame(`${documentId}:1`, 1, (out) =>
      encoding.writeVarUint8Array(out, encoding.toUint8Array(update)),
    );
    const raw = a.socket.webSocket as unknown as WebSocket;
    raw.send(bytes);
    await until(
      () =>
        !room
          .getConnections()
          .some(
            (c) =>
              c.context.lease.grant.client_session_id ===
              a.grant.client_session_id,
          ),
    );
    expect(room.awareness.getStates().has(b.doc.clientID)).toBe(true);
  });
  it('ignores read-only source writes and denies checkpoint commits', async () => {
    const f = await setup(),
      g = grant();
    g.scope = 'read';
    const c = f.client(g);
    await f.connect(c);
    c.doc.getText('source').insert(0, 'unauthorized');
    const tracker = new CheckpointClient(c.doc, {
      document_id: documentId,
      generation: 1,
      client_session_id: g.client_session_id,
    });
    try {
      c.provider.sendStateless(JSON.stringify(tracker.capture(randomUUID())));
      await until(() =>
        c.replies.some((reply) => JSON.parse(reply).code === 'read_only'),
      );
      expect(f.store.source()).toBe('print("starter")\n');
    } finally {
      tracker.destroy();
    }
  });
  it('expires idle subscribers fail closed when renewal is unavailable', async () => {
    const f = await setup({
        ttl: 180,
        renew: async () => {
          throw new AdmissionError('unavailable');
        },
      }),
      c = f.client();
    await f.connect(c);
    await until(() => f.server.hocuspocus.getConnectionsCount() === 0);
    expect(f.store.source()).toBe('print("starter")\n');
  });
  it('rechecks lease after an explicit checkpoint waits, returning no receipt after expiry', async () => {
    let resolve: () => void = () => undefined;
    const held = new Promise<void>((done) => {
        resolve = done;
      }),
      store = new MemoryStore();
    const f = await setup({
        store,
        ttl: 180,
        renew: async () => {
          throw new AdmissionError('unavailable');
        },
      }),
      c = f.client();
    await f.connect(c);
    store.beforeSave = () => held;
    c.doc.getText('source').insert(0, 'later');
    const tracker = new CheckpointClient(c.doc, {
      document_id: documentId,
      generation: 1,
      client_session_id: c.grant.client_session_id,
    });
    c.provider.sendStateless(JSON.stringify(tracker.capture(randomUUID())));
    await until(() => f.server.hocuspocus.getConnectionsCount() === 0);
    resolve();
    await new Promise<void>((done) => setTimeout(done, 30));
    expect(
      c.replies.some(
        (reply) => JSON.parse(reply).type === 'checkpoint.receipt',
      ),
    ).toBe(false);
    expect(f.store.source()).toBe('print("starter")\n');
    tracker.destroy();
  });
  it('requires exact upgrade path, Origin and actual session cookie', async () => {
    const f = await setup();
    for (const [path, origin, headers] of [
      ['/collab?ticket=hidden', appOrigin, { Cookie: cookie }],
      ['/collab', 'https://wrong.test', { Cookie: cookie }],
      ['/collab', appOrigin, {}],
    ] as const) {
      const socket = new WebSocket(
        `ws://127.0.0.1:${f.server.address.port}${path}`,
        { origin, headers },
      );
      socket.on('error', () => undefined);
      const response = once(socket, 'unexpected-response');
      const [, reply] = (await response) as [unknown, { statusCode: number }];
      expect(reply.statusCode).toBe(403);
      socket.terminate();
    }
    const health = await fetch(
      `http://127.0.0.1:${f.server.address.port}/health`,
    );
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: 'ok' });
  });
  it('rejects unknown opcodes, noncanonical names and trailing frame bytes before provider decoding', () => {
    const name = `${documentId}:1`;
    expect(inspectFrame(frame(name, 3)).name).toBe(name);
    for (const bytes of [
      frame(name, 6),
      frame(`${documentId}:01`, 3),
      Uint8Array.from([...frame(name, 3), 0]),
    ])
      expect(() => inspectFrame(bytes)).toThrow();
  });
});

it('fails the whole room closed after actual storage queue backpressure', async () => {
  const store = new MemoryStore();
  store.saveCheckpoint = async () => {
    throw new CheckpointStoreError('resource_limit');
  };
  const f = await setup({ store }),
    a = f.client(),
    b = f.client();
  await f.connect(a);
  await f.connect(b);
  const tracker = new CheckpointClient(a.doc, {
    document_id: documentId,
    generation: 1,
    client_session_id: a.grant.client_session_id,
  });
  a.provider.sendStateless(JSON.stringify(tracker.capture(randomUUID())));
  await until(() => f.server.hocuspocus.getConnectionsCount() === 0);
  expect(store.source()).toBe('print("starter")\n');
  tracker.destroy();
});
it('pins initially-live and newly-live capture rooms across cold-load waits and disconnects', async () => {
  const store = new MemoryStore(),
    original = store.initialize.bind(store),
    coldId = '10000000-0000-4000-8000-000000000077';
  let release = () => undefined as void,
    entered = false,
    first = true;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  store.initialize = async (scope, seed, guard) => {
    const result = await original(scope, seed, guard);
    if (scope.document_id === coldId && first) {
      first = false;
      entered = true;
      await gate;
    }
    return result;
  };
  const f = await setup({ store }),
    a = f.client();
  await f.connect(a);
  const bGrant = grant(coldId, 'cold starter\n');
  const files = [
    {
      file_id: a.grant.document.file_id,
      document_id: documentId,
      generation: 1,
      path: 'main.py',
      initial_source: a.grant.document.initial_source,
      initial_sha256: a.grant.document.initial_sha256,
    },
    {
      file_id: bGrant.document.file_id,
      document_id: coldId,
      generation: 1,
      path: 'other.py',
      initial_source: bGrant.document.initial_source,
      initial_sha256: bGrant.document.initial_sha256,
    },
  ];
  const response = fetch(
    `http://127.0.0.1:${f.server.address.port}/internal/v1/captures/`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${'c'.repeat(40)}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        version: 1,
        capture_id: randomUUID(),
        project_id: a.grant.project_id,
        metadata_version: 1,
        entrypoint_file_id: a.grant.document.file_id,
        runtime: CORE_RUNTIME,
        helper_release: HELPER_RELEASE,
        files,
      }),
    },
  );
  await until(() => entered);
  const b = f.client(bGrant);
  await f.connect(b);
  b.doc.getText('source').insert(0, 'latest ');
  await until(
    () =>
      f.server.hocuspocus.documents
        .get(`${coldId}:1`)
        ?.getText('source')
        .toString()
        .startsWith('latest ') === true,
  );
  a.provider.destroy();
  a.socket.destroy();
  b.provider.destroy();
  b.socket.destroy();
  await until(() => f.server.hocuspocus.getConnectionsCount() === 0);
  expect(f.server.hocuspocus.documents.has(`${documentId}:1`)).toBe(true);
  expect(f.server.hocuspocus.documents.has(`${coldId}:1`)).toBe(true);
  release();
  const reply = await response;
  expect(reply.status).toBe(200);
  expect(reply.headers.get('cache-control')).toBe('private, no-store');
  const result = (await reply.json()) as {
    manifest: { files: { document_id: string; source: string }[] };
  };
  expect(
    result.manifest.files.find((file) => file.document_id === coldId)?.source,
  ).toBe('latest cold starter\n');
  await until(
    () =>
      !f.server.hocuspocus.documents.has(`${coldId}:1`) &&
      !f.server.hocuspocus.documents.has(`${documentId}:1`),
  );
});

it('sends an own server identity and permits immediate idle presence with accurate same-account tab counts', async () => {
  const f = await setup(),
    a = f.client(),
    b = f.client();
  await f.connect(a);
  await f.connect(b);
  await until(() =>
    [a, b].every((client) =>
      client.replies.some((reply) => parsePresenceIdentity(reply).ok),
    ),
  );
  for (const client of [a, b]) {
    const frame = client.replies.find(
        (reply) => parsePresenceIdentity(reply).ok,
      )!,
      parsed = parsePresenceIdentity(frame);
    if (!parsed.ok) throw new Error('server_identity_required');
    const identity = parsed.value;
    expect(identity).toEqual({
      protocol: 'code-along.presence',
      version: 1,
      type: 'presence.identity',
      document_id: client.grant.document.id,
      generation: client.grant.document.generation,
      client_session_id: client.grant.client_session_id,
      awareness_client_id: client.doc.clientID,
      user: client.grant.user,
    });
    for (const privateField of [
      'lease_id',
      'lease_token',
      'ticket',
      'initial_source',
      'initial_sha256',
      'state_base64',
      'scope',
    ])
      expect(frame).not.toContain(`"${privateField}"`);
    expect(frame).not.toContain(client.grant.lease_token);
    expect(frame).not.toContain(client.grant.document.initial_source);
    // Ordinary equal-clock awareness echo cannot supply our own profile. The
    // separate admitted identity is applied with the normal local clock API.
    expect(
      client.provider.awareness!.getLocalState()?.['user'],
    ).toBeUndefined();
    const user = identity.user;
    client.provider.awareness!.setLocalStateField('user', {
      ...user,
      name: user.display_name,
      colorLight: `${user.color}33`,
    });
  }
  await until(() =>
    [a, b].every(
      (client) =>
        [...client.provider.awareness!.getStates().values()].filter(
          (state) => state['user']?.id === client.grant.user.id,
        ).length === 2,
    ),
  );
  expect(a.provider.awareness!.getStates().has(a.doc.clientID)).toBe(true);
  expect(b.provider.awareness!.getStates().has(b.doc.clientID)).toBe(true);
});
it('rejects a forged identity from a client before it can reach another subscriber', async () => {
  const f = await setup(),
    a = f.client(),
    b = f.client();
  await f.connect(a);
  await f.connect(b);
  const forged = {
    protocol: 'code-along.presence',
    version: 1,
    type: 'presence.identity',
    document_id: documentId,
    generation: 1,
    client_session_id: a.grant.client_session_id,
    awareness_client_id: b.doc.clientID,
    user: { id: randomUUID(), display_name: 'Forged', color: '#2563eb' },
  };
  const bytes = frame(`${documentId}:1`, 5, (out) =>
    encoding.writeVarString(out, JSON.stringify(forged)),
  );
  expect(() => inspectFrame(bytes)).toThrow();
  (a.socket.webSocket as unknown as WebSocket).send(bytes);
  await until(() => f.server.hocuspocus.getConnectionsCount() === 1);
  expect(b.provider.isSynced).toBe(true);
  expect(b.replies.some((reply) => reply.includes('Forged'))).toBe(false);
});

it('applies a bounded128-lease invalidation batch to all documents on the target transport while preserving other subscribers', async () => {
  const f = await setup(),
    a = f.client(),
    second = f.client(
      grant('10000000-0000-4000-8000-000000000088', 'second\n'),
      a.socket,
    ),
    other = f.client();
  await f.connect(a);
  await until(() => second.provider.isSynced);
  await f.connect(other);
  const url = `http://127.0.0.1:${f.server.address.port}/internal/v1/invalidations/`;
  const body = JSON.stringify({
    version: 1,
    event_id: randomUUID(),
    lease_ids: [
      a.grant.lease_id,
      ...Array.from({ length: 127 }, () => randomUUID()),
    ],
    reason: 'authorization_changed',
  });
  const denied = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  expect(denied.status).toBe(403);
  expect(f.server.hocuspocus.getConnectionsCount()).toBe(2);
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${'c'.repeat(40)}`,
      },
      body,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ version: 1, status: 'ok' });
  }
  await until(() => f.server.hocuspocus.getConnectionsCount() === 1);
  expect(other.provider.isSynced).toBe(true);
  expect(
    f.server.hocuspocus.documents
      .get(`${documentId}:1`)!
      .getConnections()
      .every(
        (connection) =>
          connection.context.lease.grant.client_session_id ===
          other.grant.client_session_id,
      ),
  ).toBe(true);
  expect(
    f.server.hocuspocus.documents
      .get('10000000-0000-4000-8000-000000000088:1')
      ?.getConnectionsCount() ?? 0,
  ).toBe(0);
});
it('cannot revive a shorter admitted lease with a renewal response received after its original deadline', async () => {
  let release = () => undefined as void,
    renewing = false;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await setup({
      renew: async (lease) => {
        renewing = true;
        await held;
        return {
          grant: { ...lease.grant, ttl_ms: 30_000 },
          started: performance.now(),
        };
      },
    }),
    c = f.client();
  c.grant.ttl_ms = 180;
  await f.connect(c);
  const expired = once(c.socket.webSocket as unknown as WebSocket, 'close');
  await until(() => renewing);
  await until(() => f.server.hocuspocus.getConnectionsCount() === 0);
  const [closeCode] = await expired;
  expect(closeCode).toBe(4401);
  release();
  await new Promise<void>((resolve) => setTimeout(resolve, 25));
  expect(f.server.hocuspocus.getConnectionsCount()).toBe(0);
  expect(f.store.source()).toBe('print("starter")\n');
});
