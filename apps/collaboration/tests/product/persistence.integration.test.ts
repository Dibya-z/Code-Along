import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { execFileSync, fork } from 'node:child_process';
import { once } from 'node:events';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import * as Y from 'yjs';
import {
  ProductCheckpointStore,
  type DocumentScope,
} from '../../src/persistence/checkpoint-store.ts';
import { CheckpointStoreError } from '../../src/persistence/binary-state.ts';

let admin: Pool,
  writer: Pool,
  store: ProductCheckpointStore,
  scope: DocumentScope;
function state(source: string): Uint8Array {
  const doc = new Y.Doc();
  try {
    doc.getText('source').insert(0, source);
    return Y.encodeStateAsUpdate(doc);
  } finally {
    doc.destroy();
  }
}
function text(binary: Uint8Array): string {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, binary);
    return doc.getText('source').toString();
  } finally {
    doc.destroy();
  }
}
function checkpoint(
  binary: Uint8Array,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    protocol: 'code-along.checkpoint',
    version: 1,
    type: 'checkpoint.request',
    document_id: scope.document_id,
    generation: scope.generation,
    client_session_id: '10000000-0000-4000-8000-000000000002',
    checkpoint_id: randomUUID(),
    observed_counter: 1,
    state_base64: Buffer.from(binary).toString('base64'),
    ...extra,
  });
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
    throw new Error('owned_postgres_harness_required');
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  let fixture: { documents: DocumentScope[] };
  try {
    const output = execFileSync(
      `${root}.venv/bin/python`,
      [
        fileURLToPath(
          new URL('../fixtures/product-schema.py', import.meta.url),
        ),
      ],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 30_000,
        env: {
          ...process.env,
          CODE_ALONG_COLLABORATION_DB_USER: 'code_along_collaboration',
          CODE_ALONG_COLLABORATION_DB_PASSWORD:
            'owned-product-fixture-password-32-characters',
        },
      },
    );
    fixture = JSON.parse(output) as typeof fixture;
  } catch {
    throw new Error('django_product_fixture_failed');
  }
  scope = fixture.documents[0]!;
  const config = {
    host,
    port: 5432,
    database: 'postgres',
    connectionTimeoutMillis: 1000,
    idleTimeoutMillis: 100,
  };
  admin = new Pool({ ...config, user: 'code_along_test', max: 3 });
  writer = new Pool({ ...config, user: 'code_along_collaboration', max: 4 });
  admin.on('error', () => undefined);
  writer.on('error', () => undefined);
  store = new ProductCheckpointStore(writer);
});
beforeEach(async () => {
  await admin.query(
    `DROP TRIGGER IF EXISTS product_fail_receipt ON collaboration_checkpointreceipt;DROP FUNCTION IF EXISTS public.product_fail_receipt();TRUNCATE collaboration_checkpointreceipt,collaboration_documentstate`,
  );
  store = new ProductCheckpointStore(writer);
});
afterAll(async () => {
  await writer?.end();
  await admin?.end();
});
describe('Django-schema restricted product persistence', () => {
  it('uses the restricted production role, denies account/source/DDL/metadata writes and initializes defaults', async () => {
    expect(
      (await writer.query('SELECT current_user')).rows[0]?.current_user,
    ).toBe('code_along_collaboration');
    for (const sql of [
      'SELECT * FROM accounts_user',
      'SELECT initial_source FROM projects_projectfile',
      'CREATE TABLE public.product_forbidden (x int)',
      'DELETE FROM collaboration_documentstate',
      `UPDATE projects_collaborationdocument SET generation=generation`,
    ])
      await expect(writer.query(sql)).rejects.toMatchObject({ code: '42501' });
    await store.initialize(scope, state('starter'));
    const row = (
      await admin.query(
        'SELECT initialized_at,updated_at,durable_revision::text FROM collaboration_documentstate',
      )
    ).rows[0];
    expect(row.initialized_at).toBeInstanceOf(Date);
    expect(row.updated_at).toBeInstanceOf(Date);
    expect(row.durable_revision).toBe('0');
  });
  it('initializes concurrently once and never reseeds short or empty binary documents', async () => {
    const other = new ProductCheckpointStore(writer);
    const result = await Promise.all([
      store.initialize(scope, state('first')),
      other.initialize(scope, state('second')),
    ]);
    expect(text(result[0]!.binary)).toBe(text(result[1]!.binary));
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, result[0]!.binary);
      doc.getText('source').delete(0, doc.getText('source').length);
      doc.getText('source').insert(0, 'x');
      await store.saveState(scope, Y.encodeStateAsUpdate(doc));
      expect(
        text((await other.initialize(scope, state('must not seed'))).binary),
      ).toBe('x');
      doc.getText('source').delete(0, 1);
      await store.saveState(scope, Y.encodeStateAsUpdate(doc));
      expect(
        text((await other.initialize(scope, state('must not seed'))).binary),
      ).toBe('');
    } finally {
      doc.destroy();
    }
    expect(
      (
        await admin.query(
          'SELECT count(*)::int AS count FROM collaboration_documentstate',
        )
      ).rows[0]?.count,
    ).toBe(1);
  });
  it('commits deletion-only receipts atomically and returns the original idempotent receipt', async () => {
    const base = await store.initialize(scope, state('remove me')),
      doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, base.binary);
      doc.getText('source').delete(0, 9);
      const frame = checkpoint(Y.encodeStateAsUpdate(doc));
      const first = await store.saveCheckpoint(frame),
        retry = await store.saveCheckpoint(frame);
      expect(retry).toEqual(first);
      expect(text((await store.load(scope)).binary)).toBe('');
      expect(
        (
          await admin.query(
            'SELECT count(*)::int AS count FROM collaboration_checkpointreceipt',
          )
        ).rows[0]?.count,
      ).toBe(1);
      await expect(
        store.saveCheckpoint(
          JSON.stringify({ ...JSON.parse(frame), observed_counter: 2 }),
        ),
      ).rejects.toMatchObject({ code: 'checkpoint_conflict' });
    } finally {
      doc.destroy();
    }
  });
  it('merges stale writers across independent queues through CAS without losing deletion history', async () => {
    const base = await store.initialize(scope, state('base')),
      a = new Y.Doc(),
      b = new Y.Doc();
    try {
      Y.applyUpdate(a, base.binary);
      Y.applyUpdate(b, base.binary);
      a.getText('source').delete(0, 4);
      b.getText('source').insert(4, 'new');
      await Promise.all([
        store.saveCheckpoint(checkpoint(Y.encodeStateAsUpdate(a))),
        new ProductCheckpointStore(writer).saveCheckpoint(
          checkpoint(Y.encodeStateAsUpdate(b)),
        ),
      ]);
      expect(text((await store.load(scope)).binary)).toBe('new');
    } finally {
      a.destroy();
      b.destroy();
    }
  });
  it('rejects queued work after lease expiry and rolls back an in-flight transaction before COMMIT', async () => {
    await store.initialize(scope, state('base'));
    const blocker = await admin.connect();
    let live = true;
    const guard = () => {
      if (!live) throw new CheckpointStoreError('unauthorized');
    };
    await blocker.query('BEGIN');
    await blocker.query('SELECT * FROM collaboration_documentstate FOR UPDATE');
    const first = store.saveState(scope, state('first'), guard),
      queued = store.saveState(scope, state('second'), guard);
    // Attach rejection handlers before the barrier is released.
    const settled = Promise.allSettled([first, queued]);
    await vi.waitFor(async () =>
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS count FROM pg_stat_activity WHERE usename='code_along_collaboration' AND wait_event_type='Lock'",
          )
        ).rows[0]?.count,
      ).toBe(1),
    );
    live = false;
    await blocker.query('ROLLBACK');
    blocker.release();
    const results = await settled;
    expect(
      results.every(
        (r) =>
          r.status === 'rejected' &&
          r.reason instanceof CheckpointStoreError &&
          r.reason.code === 'unauthorized',
      ),
    ).toBe(true);
    expect(text((await store.load(scope)).binary)).toBe('base');
  });
  it('bounds pending queued bytes and operation count before database work', async () => {
    await store.initialize(scope, state('base'));
    const blocker = await admin.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT * FROM collaboration_documentstate FOR UPDATE');
    const pending: Array<Promise<unknown>> = [];
    for (let i = 0; i < 9; i++)
      pending.push(store.saveState(scope, new Uint8Array(1024 * 1024)));
    const settled = Promise.allSettled(pending);
    await blocker.query('ROLLBACK');
    blocker.release();
    const results = await settled;
    expect(
      results.filter(
        (r) =>
          r.status === 'rejected' &&
          r.reason instanceof CheckpointStoreError &&
          r.reason.code === 'resource_limit',
      ).length,
    ).toBeGreaterThanOrEqual(1);
    // A saturated queue recovers after failed writes settle.
    await expect(store.saveState(scope, state('valid'))).resolves.toBeDefined();
  });
  it('rolls back source and receipt together on an insert/commit failure without leaking driver data', async () => {
    await store.initialize(scope, state('base'));
    await admin.query(
      `CREATE FUNCTION public.product_fail_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PRIVATE_DRIVER_DETAIL'; END $$; CREATE CONSTRAINT TRIGGER product_fail_receipt AFTER INSERT ON collaboration_checkpointreceipt DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.product_fail_receipt()`,
    );
    await expect(
      store.saveCheckpoint(checkpoint(state('uncommitted'))),
    ).rejects.toMatchObject({
      code: 'storage_unavailable',
      message: 'storage_unavailable',
    });
    expect(text((await store.load(scope)).binary)).toBe('base');
    expect(
      (
        await admin.query(
          'SELECT count(*)::int AS count FROM collaboration_checkpointreceipt',
        )
      ).rows[0]?.count,
    ).toBe(0);
  });
  it('rejects deleted/mismatched product metadata and checksum corruption', async () => {
    await store.initialize(scope, state('base'));
    await expect(
      store.load({ ...scope, file_id: randomUUID() }),
    ).rejects.toMatchObject({ code: 'generation_mismatch' });
    await admin.query(
      'UPDATE projects_projectfile SET deleted_at=clock_timestamp() WHERE id=$1',
      [scope.file_id],
    );
    await expect(store.saveState(scope, state('stale'))).rejects.toMatchObject({
      code: 'generation_mismatch',
    });
    await admin.query(
      'UPDATE projects_projectfile SET deleted_at=NULL WHERE id=$1',
      [scope.file_id],
    );
    await admin.query(
      "UPDATE collaboration_documentstate SET state_sha256=repeat('0',64)",
    );
    await expect(store.load(scope)).rejects.toMatchObject({
      code: 'storage_unavailable',
    });
  });
  it('recovers an acknowledged binary checkpoint in a fresh native Node process', async () => {
    await store.initialize(scope, state('base'));
    const receipt = await store.saveCheckpoint(
      checkpoint(state('acknowledged')),
    );
    const child = fork(
      fileURLToPath(
        new URL('../fixtures/product-restart-probe.ts', import.meta.url),
      ),
      [],
      {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        execArgv: [],
        env: { ...process.env, PRODUCT_DOCUMENT_ID: scope.document_id },
      },
    );
    const [message] = (await once(child, 'message')) as [
      { source: string; revision: string },
    ];
    await once(child, 'exit');
    expect(message.source).toContain('acknowledged');
    expect(message.revision).toBe(receipt.durable_revision);
  });
});
