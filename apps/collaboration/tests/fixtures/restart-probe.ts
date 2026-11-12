/** Trusted fixture invoked by the owned PostgreSQL restart test. */
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import * as Y from 'yjs';
import {
  CHECKPOINT_PROTOCOL,
  CHECKPOINT_VERSION,
} from '@code-along/contracts/collaboration';
import { CheckpointStore } from '../../src/persistence/checkpoint-store.ts';

const [phase, packetPath] = process.argv.slice(2);
if (
  !packetPath ||
  !/^\/tmp\/ca-pg18-[^/]+\/packet.json$/.test(packetPath) ||
  process.env['PGHOST'] !== packetPath.replace('/packet.json', '/socket')
)
  throw new Error('Owned cluster required');
const admin = new Pool({ max: 1, connectionTimeoutMillis: 1000 });
const writer = new Pool({
  user: 'checkpoint_writer',
  max: 1,
  connectionTimeoutMillis: 1000,
});
const document_id = '10000000-0000-4000-8000-000000000001';
const scope = { document_id, generation: 1 };
const doc = new Y.Doc();
try {
  const store = new CheckpointStore(writer);
  if (phase === 'before') {
    await admin.query(
      await readFile(new URL('./schema.sql', import.meta.url), 'utf8'),
    );
    await admin.query('INSERT INTO checkpoint_proof.document VALUES ($1,1)', [
      document_id,
    ]);
    await store.initialize(scope, Y.encodeStateAsUpdate(doc));
    doc.getText('source').insert(0, 'durable after database recovery');
    const request = JSON.stringify({
      protocol: CHECKPOINT_PROTOCOL,
      version: CHECKPOINT_VERSION,
      type: 'checkpoint.request',
      ...scope,
      client_session_id: randomUUID(),
      checkpoint_id: randomUUID(),
      observed_counter: 1,
      state_base64: Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64'),
    });
    const receipt = await store.saveCheckpoint(request);
    await writeFile(packetPath, JSON.stringify({ request, receipt }), {
      mode: 0o600,
      flag: 'wx',
    });
  } else if (phase === 'after') {
    const packet = JSON.parse(await readFile(packetPath, 'utf8')) as {
      request: string;
      receipt: unknown;
    };
    const loaded = await store.load(scope);
    Y.applyUpdate(doc, loaded.binary);
    assert.equal(
      doc.getText('source').toString(),
      'durable after database recovery',
    );
    assert.deepEqual(
      await store.saveCheckpoint(packet.request),
      packet.receipt,
    );
    console.log('checkpoint_recovery_verified');
  } else throw new Error('Unknown proof phase');
} finally {
  doc.destroy();
  await writer.end();
  await admin.end();
}
