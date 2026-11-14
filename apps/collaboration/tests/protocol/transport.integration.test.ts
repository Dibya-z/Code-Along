import { readFile, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from 'vitest';
import { Pool } from 'pg';
import WebSocket from 'ws';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import {
  HocuspocusProvider,
  HocuspocusProviderWebsocket,
} from '@hocuspocus/provider';
import {
  createProofServer,
  type Admission,
} from '../../src/protocol/proof-server.ts';
import { CheckpointStore } from '../../src/persistence/checkpoint-store.ts';
import { CheckpointClient } from '../../src/protocol/checkpoint-client.ts';
import {
  parseCheckpointResponse,
  type CheckpointRequest,
} from '@code-along/contracts/collaboration';

const document_id = '10000000-0000-4000-8000-000000000001';
const name = `${document_id}:1`;
let admin: Pool, writer: Pool;
let server: ReturnType<typeof createProofServer>;
interface Client {
  ids: { document_id: string; generation: number; client_session_id: string };
  token: string;
  doc: Y.Doc;
  tracker: CheckpointClient;
  replies: string[];
  socket: HocuspocusProviderWebsocket;
  provider: HocuspocusProvider;
}
let clients: Client[] = [];
let children: ChildProcess[] = [];
const grants = new Map<string, Admission>();

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  await vi.waitFor(
    async () => {
      expect(await check()).toBe(true);
    },
    { timeout: 5000, interval: 10 },
  );
}
function client(
  url: string,
  writable = true,
  grantDocument = document_id,
  session: string = randomUUID(),
): Client {
  const ids = {
    document_id: grantDocument,
    generation: 1,
    client_session_id: session,
  };
  const token = randomUUID();
  grants.set(token, { ...ids, writable });
  const doc = new Y.Doc();
  const tracker = new CheckpointClient(doc, ids);
  const replies: string[] = [];
  const socket = new HocuspocusProviderWebsocket({
    url,
    WebSocketPolyfill: WebSocket,
    autoConnect: false,
    delay: 20,
    minDelay: 20,
    maxDelay: 50,
    jitter: false,
  });
  const provider = new HocuspocusProvider({
    websocketProvider: socket,
    name,
    token,
    document: doc,
    onStateless: ({ payload }) => {
      replies.push(payload);
      tracker.receive(payload);
    },
  });
  provider.attach();
  const c = { ids, token, doc, tracker, replies, socket, provider };
  clients.push(c);
  return c;
}
async function connect(c: ReturnType<typeof client>) {
  void c.socket.connect();
  await until(() => c.provider.isSynced);
}
function address() {
  return `ws://127.0.0.1:${server.address.port}`;
}
function save(
  c: ReturnType<typeof client>,
  r = c.tracker.capture(randomUUID()),
) {
  c.provider.sendStateless(JSON.stringify(r));
  return r;
}
async function reply(c: ReturnType<typeof client>, r: CheckpointRequest) {
  await until(() =>
    c.replies.some((v) => {
      const p = parseCheckpointResponse(v);
      return p.ok && p.value.checkpoint_id === r.checkpoint_id;
    }),
  );
  const p = parseCheckpointResponse(
    c.replies.find((v) => JSON.parse(v).checkpoint_id === r.checkpoint_id)!,
  );
  if (!p.ok) throw new Error('invalid_reply');
  return p.value;
}
async function childServer(): Promise<string> {
  const child = fork(
    fileURLToPath(new URL('../fixtures/transport-process.ts', import.meta.url)),
    [],
    {
      execArgv: [],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: {
        ...process.env,
        PROOF_ADMISSIONS: JSON.stringify(
          [...grants].map(([token, g]) => ({ token, ...g })),
        ),
      },
    },
  );
  children.push(child);
  const message = await Promise.race([
    once(child, 'message'),
    once(child, 'exit').then(() => {
      throw new Error('proof_child_exited');
    }),
  ]);
  return `ws://127.0.0.1:${(message[0] as { port: number }).port}`;
}
beforeAll(async () => {
  const host = process.env['PGHOST'];
  if (
    !host ||
    !/^\/tmp\/ca-pg18-[^/]+\/socket$/.test(host) ||
    process.env['PGUSER'] !== 'code_along_test' ||
    process.env['PGDATABASE'] !== 'postgres' ||
    ((await stat(host)).mode & 0o777) !== 0o700
  )
    throw new Error('Private PostgreSQL harness required');
  admin = new Pool({
    max: 3,
    connectionTimeoutMillis: 1000,
    idleTimeoutMillis: 200,
  });
  writer = new Pool({
    user: 'checkpoint_writer',
    max: 3,
    connectionTimeoutMillis: 1000,
    idleTimeoutMillis: 200,
  });
  writer.on('error', () => {
    throw new Error('unexpected_idle_database_error');
  });
  await admin.query(
    await readFile(new URL('../fixtures/schema.sql', import.meta.url), 'utf8'),
  );
});
beforeEach(async () => {
  grants.clear();
  await admin.query(
    'TRUNCATE checkpoint_proof.checkpoint_receipt,checkpoint_proof.document_state,checkpoint_proof.document',
  );
  await admin.query('INSERT INTO checkpoint_proof.document VALUES ($1,1)', [
    document_id,
  ]);
  server = createProofServer({
    store: new CheckpointStore(writer),
    async admit(token) {
      const grant = grants.get(token);
      if (!grant) throw new Error('admission_denied');
      return grant;
    },
  });
  await server.listen();
});
afterEach(async () => {
  for (const c of clients) {
    c.provider.destroy();
    c.socket.destroy();
    c.tracker.destroy();
    c.doc.destroy();
  }
  clients = [];
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit');
    }
  }
  children = [];
  await server.destroy();
  vi.restoreAllMocks();
});
afterAll(async () => {
  await writer.end();
  await admin.end();
});

it('synchronizes edits and deletions, while synced alone never means Saved', async () => {
  const a = client(address()),
    b = client(address());
  await connect(a);
  await connect(b);
  expect(a.tracker.saved).toBe(false);
  a.doc.getText('source').insert(0, '\ufeffabc');
  await until(() => b.doc.getText('source').toString() === '\ufeffabc');
  const first = save(a);
  expect((await reply(a, first)).type).toBe('checkpoint.receipt');
  expect(a.tracker.saved).toBe(true);
  b.doc.getText('source').insert(2, '\ufeff');
  b.doc.getText('source').delete(3, 1);
  await until(() => a.doc.getText('source').toString() === '\ufeffa\ufeffc');
  expect(a.tracker.saved).toBe(false);
  const deletion = save(a);
  expect((await reply(a, deletion)).type).toBe('checkpoint.receipt');
  expect(a.tracker.saved).toBe(true);
  const persisted = await new CheckpointStore(writer).load(a.ids);
  const reloaded = new Y.Doc();
  try {
    Y.applyUpdate(reloaded, persisted.binary);
    expect(reloaded.getText('source').toString()).toBe('\ufeffa\ufeffc');
    expect(Buffer.from(reloaded.getText('source').toString(), 'utf8')).toEqual(
      Buffer.from('\ufeffa\ufeffc', 'utf8'),
    );
  } finally {
    reloaded.destroy();
  }
  expect(b.replies).toEqual([]); // Receipts are point-to-point, not room broadcast.
});
it('merges concurrent peer edits and persists their combined state', async () => {
  const a = client(address()),
    b = client(address());
  await connect(a);
  await connect(b);
  a.doc.getText('source').insert(0, 'A');
  b.doc.getText('source').insert(0, 'B');
  await until(
    () =>
      a.doc.getText('source').length === 2 &&
      a.doc.getText('source').toString() === b.doc.getText('source').toString(),
  );
  const r = save(a);
  expect((await reply(a, r)).type).toBe('checkpoint.receipt');
  const state = await new CheckpointStore(writer).load(a.ids);
  const restored = new Y.Doc();
  Y.applyUpdate(restored, state.binary);
  expect(restored.getText('source').toString()).toBe(
    a.doc.getText('source').toString(),
  );
  restored.destroy();
});
it('reconnects offline edits without re-inserting the initial source', async () => {
  const a = client(address()),
    b = client(address());
  await connect(a);
  await connect(b);
  a.doc.getText('source').insert(0, 'seed');
  await until(() => b.doc.getText('source').length === 4);
  a.socket.disconnect();
  await until(() => !a.provider.isSynced);
  a.doc.getText('source').insert(4, 'A');
  b.doc.getText('source').insert(4, 'B');
  await connect(a);
  await until(
    () =>
      a.doc.getText('source').length === 6 &&
      a.doc.getText('source').toString() === b.doc.getText('source').toString(),
  );
  const r = save(a);
  expect((await reply(a, r)).type).toBe('checkpoint.receipt');
});
it('replays the same receipt after a discarded network response', async () => {
  const a = client(address());
  await connect(a);
  a.doc.getText('source').insert(0, 'x');
  const r = save(a);
  const first = await reply(a, r);
  a.replies.length = 0;
  save(a, r);
  expect(await reply(a, r)).toEqual(first);
  const count = await admin.query(
    'SELECT count(*)::int AS count FROM checkpoint_proof.checkpoint_receipt',
  );
  expect(count.rows[0].count).toBe(1);
});
it('keeps a changed observed document dirty when an older receipt arrives', async () => {
  const a = client(address());
  await connect(a);
  const r = a.tracker.capture(randomUUID());
  a.doc.getText('source').insert(0, 'later');
  save(a, r);
  expect((await reply(a, r)).type).toBe('checkpoint.receipt');
  expect(a.tracker.saved).toBe(false);
});
it('rejects peer-forged receipt and server-internal broadcast opcodes', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const a = client(address()),
    b = client(address());
  await connect(a);
  await connect(b);
  const { state_base64: _bytes, ...envelope } = b.tracker.capture(randomUUID());
  void _bytes;
  const forged = JSON.stringify({
    ...envelope,
    type: 'checkpoint.receipt',
    durable_revision: '999',
    state_sha256: '0'.repeat(64),
  });
  expect(parseCheckpointResponse(forged).ok).toBe(true); // Valid shape and the victim's actual correlation fields.
  a.provider.sendStateless(forged);
  await until(() => !a.provider.isSynced);
  expect(b.replies).toEqual([]);
  expect(b.tracker.saved).toBe(false);
  const attacker = client(address());
  await connect(attacker);
  const enc = encoding.createEncoder();
  encoding.writeVarString(enc, name);
  encoding.writeVarUint(enc, 6);
  encoding.writeVarString(enc, forged);
  attacker.socket.webSocket!.send(encoding.toUint8Array(enc));
  await until(() => !attacker.provider.isSynced);
  expect(b.replies).toEqual([]);
  expect(b.tracker.saved).toBe(false);
});
it('denies a checkpoint claiming a different admitted session', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const a = client(address());
  await connect(a);
  const r = {
    ...a.tracker.capture(randomUUID()),
    client_session_id: randomUUID(),
  };
  save(a, r);
  await until(() => !a.provider.isSynced);
  expect(a.replies).toEqual([]);
});
it('returns read_only without a receipt or stored source change', async () => {
  const a = client(address(), false);
  await connect(a);
  const r = save(a);
  const result = await reply(a, r);
  expect(result.type).toBe('checkpoint.error');
  if (result.type === 'checkpoint.error') expect(result.code).toBe('read_only');
  expect(a.tracker.saved).toBe(false);
});
it('rejects invalid CRDT data before peer application', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const a = client(address()),
    b = client(address());
  await connect(a);
  await connect(b);
  a.doc.getMap('permissions').set('admin', true);
  await until(() => !a.provider.isSynced);
  expect(b.doc.share.has('permissions')).toBe(false);
});
it('returns storage_unavailable and no Saved receipt when the DB rejects commits', async () => {
  const a = client(address());
  await connect(a);
  await admin.query(
    'REVOKE UPDATE ON checkpoint_proof.document_state FROM checkpoint_writer',
  );
  try {
    const r = save(a);
    const result = await reply(a, r);
    expect(result.type).toBe('checkpoint.error');
    if (result.type === 'checkpoint.error')
      expect(result.code).toBe('storage_unavailable');
    expect(a.tracker.saved).toBe(false);
  } finally {
    await admin.query(
      'GRANT UPDATE ON checkpoint_proof.document_state TO checkpoint_writer',
    );
  }
});
it('stops accepting subsequent live writes after checkpoint storage failure', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const a = client(address()),
    b = client(address());
  await connect(a);
  await connect(b);
  await admin.query(
    'REVOKE UPDATE ON checkpoint_proof.document_state FROM checkpoint_writer',
  );
  try {
    const r = save(a);
    await reply(a, r);
    a.doc.getText('source').insert(0, 'local recovery');
    await until(() => !a.provider.isSynced);
    expect(b.doc.getText('source').toString()).toBe('');
    expect(a.tracker.saved).toBe(false);
  } finally {
    await admin.query(
      'GRANT UPDATE ON checkpoint_proof.document_state TO checkpoint_writer',
    );
  }
});
it('delivers transient cursor and selection awareness without creating receipts', async () => {
  const a = client(address()),
    b = client(address());
  await connect(a);
  await connect(b);
  a.provider.awareness!.setLocalStateField('selection', { anchor: 0, head: 0 });
  await until(
    () =>
      b.provider.awareness!.getStates().get(a.doc.clientID)?.['selection']
        ?.head === 0,
  );
  expect(a.replies).toEqual([]);
  expect(b.replies).toEqual([]);
});
it('restores acknowledged binary source after SIGKILL and a fresh collaboration process', async () => {
  // Grant registration occurs before the child receives its immutable fixture map.
  const a = client('ws://127.0.0.1:1');
  const url = await childServer();
  a.socket.setConfiguration({ url });
  await connect(a);
  const source = '\ufeffcommitted\r\n';
  a.doc.getText('source').insert(0, source);
  const r = save(a);
  expect((await reply(a, r)).type).toBe('checkpoint.receipt');
  a.doc.getText('source').insert(source.length, 'unacknowledged');
  await until(() => !a.provider.hasUnsyncedChanges);
  const killed = children[0]!;
  killed.kill('SIGKILL');
  await once(killed, 'exit');
  a.socket.disconnect();
  const fresh = client(
    'ws://127.0.0.1:1',
    true,
    document_id,
    a.ids.client_session_id,
  );
  const nextUrl = await childServer();
  fresh.socket.setConfiguration({ url: nextUrl });
  await connect(fresh);
  expect(fresh.doc.getText('source').toString()).toBe(source);
  expect(Buffer.from(fresh.doc.getText('source').toString(), 'utf8')).toEqual(
    Buffer.from(source, 'utf8'),
  );
  const retry = r;
  save(fresh, retry);
  expect((await reply(fresh, retry)).type).toBe('checkpoint.receipt');
});
