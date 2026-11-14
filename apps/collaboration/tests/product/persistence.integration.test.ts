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
  scope: DocumentScope,
  scopeWithoutState: DocumentScope;
const root = fileURLToPath(new URL('../../../../', import.meta.url));

async function fillReceipts(count: number): Promise<void> {
  await admin.query(
    `INSERT INTO collaboration_checkpointreceipt
     (document_id,generation,client_session_id,checkpoint_id,observed_counter,
      request_sha256,durable_revision,state_sha256)
     SELECT $1,$2,gen_random_uuid(),gen_random_uuid(),n,repeat('0',64),1,repeat('0',64)
     FROM generate_series(1,$3::integer) n`,
    [scope.document_id, scope.generation, count],
  );
}

async function receiptCount(): Promise<number> {
  return (
    await admin.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM collaboration_checkpointreceipt WHERE document_id=$1',
      [scope.document_id],
    )
  ).rows[0]!.count;
}

function pruneReceipts(): void {
  // The owner invokes the actual Django retention service. The Node role gains
  // no cleanup privilege, and fixture failures never print driver/source data.
  const code = String.raw`
import os,sys
sys.path.insert(0, 'apps/api')
os.environ['DJANGO_SETTINGS_MODULE']='config.settings.test'
from django.conf import settings
settings.DATABASES['default'].update(NAME='postgres',USER='code_along_test',PASSWORD='',HOST=os.environ['PGHOST'],PORT=5432,CONN_MAX_AGE=0,OPTIONS={'connect_timeout':2,'sslmode':'disable'})
import django
django.setup()
from django.db import connections
from code_along.collaboration.retention import prune_checkpoint_receipts
try:
    prune_checkpoint_receipts(apply=True)
finally:
    connections.close_all()
`;
  try {
    execFileSync(`${root}.venv/bin/python`, ['-c', code], {
      cwd: root,
      timeout: 15_000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
  } catch {
    throw new Error('django_product_retention_failed');
  }
}
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
  scopeWithoutState = fixture.documents[1]!;
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
      'DELETE FROM collaboration_checkpointreceipt',
      'TRUNCATE collaboration_checkpointreceipt',
      'ALTER TABLE collaboration_checkpointreceipt DISABLE TRIGGER ALL',
      `UPDATE projects_collaborationdocument SET generation=generation`,
    ])
      await expect(writer.query(sql)).rejects.toMatchObject({ code: '42501' });
    await expect(
      writer.query(
        `INSERT INTO collaboration_checkpointreceipt
         (document_id,generation,client_session_id,checkpoint_id,observed_counter,
          request_sha256,durable_revision,state_sha256)
         VALUES ($1,$2,$3,$4,1,repeat('0',64),1,repeat('0',64))`,
        [
          scopeWithoutState.document_id,
          scopeWithoutState.generation,
          randomUUID(),
          randomUUID(),
        ],
      ),
    ).rejects.toMatchObject({
      code: '23503',
      constraint: 'checkpoint_receipt_document_state',
    });
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
  it('keeps duplicates valid at the receipt cap, then merges a pruned full-state retry without resurrecting deleted source', async () => {
    const base = await store.initialize(scope, state('remove me')),
      deleted = new Y.Doc(),
      current = new Y.Doc();
    try {
      Y.applyUpdate(deleted, base.binary);
      deleted.getText('source').delete(0, 9);
      const frame = checkpoint(Y.encodeStateAsUpdate(deleted)),
        first = await store.saveCheckpoint(frame),
        originalId = (
          await admin.query<{ id: string }>(
            'SELECT id::text FROM collaboration_checkpointreceipt WHERE checkpoint_id=$1',
            [first.checkpoint_id],
          )
        ).rows[0]!.id;
      await fillReceipts(4095);
      expect(await receiptCount()).toBe(4096);
      // A receipt describes one prior commit. It does not restore that commit's
      // historical plaintext when a duplicate request is acknowledged.
      Y.applyUpdate(current, (await store.load(scope)).binary);
      current.getText('source').insert(0, 'current');
      const before = await store.saveState(
        scope,
        Y.encodeStateAsUpdate(current),
      );
      expect(await store.saveCheckpoint(frame)).toEqual(first);
      expect(text((await store.load(scope)).binary)).toBe('current');
      current.getText('source').insert(0, 'must roll back: ');
      await expect(
        store.saveCheckpoint(checkpoint(Y.encodeStateAsUpdate(current))),
      ).rejects.toMatchObject({
        code: 'resource_limit',
        message: 'resource_limit',
      });
      expect(await store.load(scope)).toEqual(before);
      expect(await receiptCount()).toBe(4096);
      await admin.query(
        "UPDATE collaboration_checkpointreceipt SET recorded_at=clock_timestamp()-interval '26 hours' WHERE document_id=$1",
        [scope.document_id],
      );
      await admin.query(
        "UPDATE collaboration_checkpointreceipt SET recorded_at=clock_timestamp()-interval '27 hours' WHERE id=$1",
        [originalId],
      );
      pruneReceipts();
      expect(await receiptCount()).toBe(4096 - 512);
      expect(
        (
          await admin.query(
            'SELECT id FROM collaboration_checkpointreceipt WHERE id=$1',
            [originalId],
          )
        ).rowCount,
      ).toBe(0);
      expect(await store.load(scope)).toEqual(before);
      const retry = await store.saveCheckpoint(frame);
      expect(retry.checkpoint_id).toBe(first.checkpoint_id);
      expect(BigInt(retry.durable_revision)).toBeGreaterThan(
        BigInt(before.durable_revision),
      );
      expect(retry).not.toEqual(first);
      const newId = (
        await admin.query<{ id: string }>(
          'SELECT id::text FROM collaboration_checkpointreceipt WHERE checkpoint_id=$1',
          [retry.checkpoint_id],
        )
      ).rows[0]!.id;
      expect(newId).not.toBe(originalId);
      expect(await receiptCount()).toBe(4096 - 512 + 1);
      expect(retry.state_sha256).toBe((await store.load(scope)).state_sha256);
      // Reintroducing a stale pre-deletion update cannot resurrect its Yjs IDs.
      await store.saveState(scope, base.binary);
      expect(text((await store.load(scope)).binary)).toBe('current');
    } finally {
      deleted.destroy();
      current.destroy();
    }
  });
  it('enforces the actual receipt cap across concurrent restricted-role inserts and TEMP shadowing', async () => {
    const base = await store.initialize(scope, state('base'));
    await fillReceipts(4095);
    const outcomes = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        writer.query(
          `INSERT INTO collaboration_checkpointreceipt
         (document_id,generation,client_session_id,checkpoint_id,observed_counter,
          request_sha256,durable_revision,state_sha256)
         VALUES ($1,$2,$3,$4,1,$5,1,$5)`,
          [
            scope.document_id,
            scope.generation,
            randomUUID(),
            randomUUID(),
            base.state_sha256,
          ],
        ),
      ),
    );
    expect(
      outcomes.filter((outcome) => outcome.status === 'fulfilled'),
    ).toHaveLength(1);
    const failures = outcomes.filter(
      (outcome) => outcome.status === 'rejected',
    );
    expect(failures).toHaveLength(3);
    for (const failure of failures)
      expect(failure.reason).toMatchObject({
        code: '54000',
        constraint: 'checkpoint_receipt_capacity',
      });
    expect(await receiptCount()).toBe(4096);
    const adversary = await writer.connect();
    try {
      const temporary = (
        await adversary.query<{ allowed: boolean }>(
          "SELECT has_database_privilege(current_database(), 'TEMP') AS allowed",
        )
      ).rows[0]!.allowed;
      // Prove this owned fixture actually exercises the adversary; no extra
      // permission is granted to manufacture TEMP availability.
      expect(temporary).toBe(true);
      if (temporary) {
        await adversary.query(
          `CREATE TEMP TABLE collaboration_documentstate (document_id uuid PRIMARY KEY);
           CREATE TEMP TABLE collaboration_checkpointreceipt (document_id uuid)`,
        );
        await adversary.query(
          'INSERT INTO pg_temp.collaboration_documentstate VALUES ($1)',
          [scope.document_id],
        );
        expect(
          (
            await adversary.query<{ count: number }>(
              'SELECT count(*)::int AS count FROM pg_temp.collaboration_checkpointreceipt',
            )
          ).rows[0]!.count,
        ).toBe(0);
        await expect(
          adversary.query(
            `INSERT INTO public.collaboration_checkpointreceipt
             (document_id,generation,client_session_id,checkpoint_id,observed_counter,
              request_sha256,durable_revision,state_sha256)
             VALUES ($1,$2,$3,$4,1,$5,1,$5)`,
            [
              scope.document_id,
              scope.generation,
              randomUUID(),
              randomUUID(),
              base.state_sha256,
            ],
          ),
        ).rejects.toMatchObject({
          code: '54000',
          constraint: 'checkpoint_receipt_capacity',
        });
      }
    } finally {
      // Discard this owned session so its TEMP objects cannot shadow later tests.
      adversary.release(true);
    }
    expect(await receiptCount()).toBe(4096);
    const blocked = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        new ProductCheckpointStore(writer).saveCheckpoint(
          checkpoint(base.binary),
        ),
      ),
    );
    expect(
      blocked.every(
        (outcome) =>
          outcome.status === 'rejected' &&
          outcome.reason instanceof CheckpointStoreError &&
          outcome.reason.code === 'resource_limit',
      ),
    ).toBe(true);
    expect(await store.load(scope)).toEqual(base);
    expect(await receiptCount()).toBe(4096);
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
  it.each([
    ['generic driver failure', ''],
    [
      'unrelated capacity constraint',
      " USING ERRCODE='54000',CONSTRAINT='unrelated_capacity'",
    ],
    [
      'capacity name with another code',
      " USING ERRCODE='P0001',CONSTRAINT='checkpoint_receipt_capacity'",
    ],
  ])(
    'rolls back source and receipt on an insert/commit failure without leaking driver data (%s)',
    async (_label, detail) => {
      await store.initialize(scope, state('base'));
      await admin.query(
        `CREATE FUNCTION public.product_fail_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PRIVATE_DRIVER_DETAIL'${detail}; END $$; CREATE CONSTRAINT TRIGGER product_fail_receipt AFTER INSERT ON collaboration_checkpointreceipt DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.product_fail_receipt()`,
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
    },
  );
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
