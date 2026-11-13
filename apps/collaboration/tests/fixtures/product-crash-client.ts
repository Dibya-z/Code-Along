/** Fresh real-provider clients for the private product crash/recovery gate. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Pool } from 'pg';
import WebSocket from 'ws';
import * as Y from 'yjs';
import {
  HocuspocusProvider,
  HocuspocusProviderWebsocket,
} from '@hocuspocus/provider';
import {
  parseCheckpointResponse,
  type CheckpointReceipt,
  type CheckpointRequest,
} from '@code-along/contracts/collaboration';
import { CheckpointClient } from '../../src/protocol/checkpoint-client.ts';
import { ProductCheckpointStore } from '../../src/persistence/checkpoint-store.ts';
import {
  FIXTURE_COOKIE,
  FIXTURE_ORIGIN,
  ownedConfiguration,
  type CrashGrant,
} from './product-crash-server.ts';
import { randomUUID } from 'node:crypto';

const EXACT_SOURCE = 'print("π 🐍")\r\n# exact source survives\n';
class FixtureWebSocket extends WebSocket {
  constructor(address: string | URL, protocols?: string | string[]) {
    super(address, protocols, {
      origin: FIXTURE_ORIGIN,
      headers: { Cookie: FIXTURE_COOKIE },
    });
  }
}
interface PacketDocument {
  document_id: string;
  generation: number;
  request: CheckpointRequest;
  receipt: CheckpointReceipt;
  canonical_base64: string;
  source: string;
  stale_base64: string;
}
interface Packet {
  version: 1;
  documents: PacketDocument[];
}
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('product_provider_deadline');
}
async function run(): Promise<void> {
  const [phase, path, portString] = process.argv.slice(2),
    port = Number(portString);
  if (
    (phase !== 'before' && phase !== 'after') ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    throw new Error('invalid_probe_configuration');
  const { config, directory } = await ownedConfiguration(path),
    packetPath = join(directory, 'product-crash-packet.json');
  const pool = new Pool({
    user: 'code_along_collaboration',
    max: 1,
    connectionTimeoutMillis: 1500,
    idleTimeoutMillis: 200,
  });
  pool.on('error', () => {
    process.exitCode = 1;
  });
  const store = new ProductCheckpointStore(pool),
    socket = new HocuspocusProviderWebsocket({
      url: `ws://127.0.0.1:${port}/collab`,
      WebSocketPolyfill: FixtureWebSocket,
      autoConnect: false,
      delay: 50,
      minDelay: 50,
      maxDelay: 100,
      jitter: false,
    });
  const clients = config[phase].map((entry: CrashGrant) => {
    const doc = new Y.Doc();
    doc.clientID = entry.grant.awareness_client_id;
    const replies: CheckpointReceipt[] = [],
      errors: string[] = [];
    const provider = new HocuspocusProvider({
      websocketProvider: socket,
      name: `${entry.grant.document.id}:${entry.grant.document.generation}`,
      token: entry.ticket,
      document: doc,
      onStateless: ({ payload }) => {
        const parsed = parseCheckpointResponse(payload);
        if (parsed.ok) {
          if (parsed.value.type === 'checkpoint.receipt')
            replies.push(parsed.value);
          else errors.push(parsed.value.code);
        }
      },
    });
    provider.attach();
    return { entry, doc, provider, replies, errors };
  });
  try {
    void socket.connect();
    await until(() => clients.every((client) => client.provider.isSynced));
    if (phase === 'before') {
      const packet: Packet = { version: 1, documents: [] };
      for (const [index, client] of clients.entries()) {
        const source = client.doc.getText('source');
        assert.equal(
          source.toString(),
          client.entry.grant.document.initial_source,
        );
        const tracker = new CheckpointClient(client.doc, {
          document_id: client.entry.grant.document.id,
          generation: client.entry.grant.document.generation,
          client_session_id: client.entry.grant.client_session_id,
        });
        try {
          source.delete(0, source.length);
          source.insert(
            0,
            index === 0
              ? 'deleted before the durable checkpoint'
              : EXACT_SOURCE,
          );
          const stale = Y.encodeStateAsUpdate(client.doc);
          if (index === 0) source.delete(0, source.length);
          const request = tracker.capture(randomUUID());
          assert.ok(request.observed_counter >= 2);
          client.provider.sendStateless(JSON.stringify(request));
          await until(() =>
            client.replies.some(
              (reply) => reply.checkpoint_id === request.checkpoint_id,
            ),
          );
          const receipt = client.replies.find(
            (reply) => reply.checkpoint_id === request.checkpoint_id,
          )!;
          assert.equal(client.errors.length, 0);
          assert.equal(
            tracker.receive(JSON.stringify(receipt))?.type,
            'checkpoint.receipt',
          );
          assert.equal(tracker.saved, true);
          const canonical = await store.load({
            document_id: request.document_id,
            generation: request.generation,
          });
          assert.equal(canonical.state_sha256, receipt.state_sha256);
          assert.deepEqual(
            Buffer.from(Y.encodeStateAsUpdate(client.doc)),
            Buffer.from(canonical.binary),
          );
          packet.documents.push({
            document_id: request.document_id,
            generation: request.generation,
            request,
            receipt,
            canonical_base64: Buffer.from(canonical.binary).toString('base64'),
            source: index === 0 ? '' : EXACT_SOURCE,
            stale_base64: Buffer.from(stale).toString('base64'),
          });
        } finally {
          tracker.destroy();
        }
      }
      await writeFile(packetPath, JSON.stringify(packet), {
        mode: 0o600,
        flag: 'wx',
      });
      process.stdout.write('product_checkpoint_committed\n');
      // Keep providers alive until Python has killed the actual product service.
      for await (const input of process.stdin) {
        if (String(input).includes('stop')) break;
      }
    } else {
      const packet = JSON.parse(await readFile(packetPath, 'utf8')) as Packet;
      assert.equal(packet.version, 1);
      assert.equal(packet.documents.length, 2);
      for (const client of clients) {
        const saved = packet.documents.find(
          (item) => item.document_id === client.entry.grant.document.id,
        )!;
        assert.equal(client.doc.getText('source').toString(), saved.source);
        assert.deepEqual(
          Buffer.from(Y.encodeStateAsUpdate(client.doc)),
          Buffer.from(saved.canonical_base64, 'base64'),
        );
        if (saved.source === '') {
          assert.ok(
            Y.decodeStateVector(Y.encodeStateVector(client.doc)).size > 0,
          );
          const deletionCheck = new Y.Doc();
          try {
            Y.applyUpdate(
              deletionCheck,
              Buffer.from(saved.canonical_base64, 'base64'),
            );
            Y.applyUpdate(
              deletionCheck,
              Buffer.from(saved.stale_base64, 'base64'),
            );
            assert.equal(deletionCheck.getText('source').toString(), '');
          } finally {
            deletionCheck.destroy();
          }
        }
        client.provider.sendStateless(JSON.stringify(saved.request));
        await until(() =>
          client.replies.some(
            (reply) => reply.checkpoint_id === saved.request.checkpoint_id,
          ),
        );
        assert.equal(client.errors.length, 0);
        assert.deepEqual(
          client.replies.find(
            (reply) => reply.checkpoint_id === saved.request.checkpoint_id,
          ),
          saved.receipt,
        );
        assert.deepEqual(
          Buffer.from((await store.load(saved.request)).binary),
          Buffer.from(saved.canonical_base64, 'base64'),
        );
      }
      const count = await pool.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM collaboration_checkpointreceipt',
      );
      assert.equal(count.rows[0]?.count, 2);
      process.stdout.write('product_recovery_verified\n');
    }
  } finally {
    for (const client of clients) {
      client.provider.destroy();
      client.doc.destroy();
    }
    socket.destroy();
    await pool.end();
  }
}
try {
  await run();
} catch {
  process.stderr.write('product_crash_probe_failed\n');
  process.exitCode = 1;
}
