import { readFile, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { Pool } from 'pg';
import * as Y from 'yjs';
import {
  CHECKPOINT_PROTOCOL,
  CHECKPOINT_VERSION,
  parseCheckpointResponse,
} from '@code-along/contracts/collaboration';
import { CheckpointStore } from '../../src/persistence/checkpoint-store.ts';
import { stateHash } from '../../src/persistence/binary-state.ts';

const documentId = '10000000-0000-4000-8000-000000000001';
const scope = { document_id: documentId, generation: 1 };
const session = '10000000-0000-4000-8000-000000000002';
let admin: Pool;
let writer: Pool;
let store: CheckpointStore;
let idleErrors = 0;

function binary(text = ''): Buffer {
  const doc = new Y.Doc();
  try {
    doc.getText('source').insert(0, text);
    return Buffer.from(Y.encodeStateAsUpdate(doc));
  } finally {
    doc.destroy();
  }
}
function textOf(state: Uint8Array): string {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, state);
    return doc.getText('source').toString();
  } finally {
    doc.destroy();
  }
}
function frame(state: Uint8Array, patch: Record<string, unknown> = {}): string {
  return JSON.stringify({
    protocol: CHECKPOINT_PROTOCOL,
    version: CHECKPOINT_VERSION,
    type: 'checkpoint.request',
    ...scope,
    client_session_id: session,
    checkpoint_id: randomUUID(),
    observed_counter: 1,
    state_base64: Buffer.from(state).toString('base64'),
    ...patch,
  });
}
async function waitForWriters(count: number, event: string): Promise<void> {
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    const result = await admin.query<{ count: number }>(
      `SELECT count(*)::int FROM pg_stat_activity
       WHERE usename='checkpoint_writer' AND wait_event_type='Lock'
       AND ($1='advisory' AND wait_event='advisory'
            OR $1='update' AND query LIKE 'UPDATE checkpoint_proof.document_state%')`,
      [event],
    );
    if (result.rows[0]?.count === count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Expected database barrier was not reached');
}
async function checkpointCount(): Promise<number> {
  const r = await admin.query<{ count: number }>(
    'SELECT count(*)::int FROM checkpoint_proof.checkpoint_receipt',
  );
  return r.rows[0]?.count ?? -1;
}
async function deferredCommitBarrier(): Promise<void> {
  await admin.query(`CREATE FUNCTION checkpoint_proof.block_commit() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(4242); RETURN NEW; END $$;
    CREATE CONSTRAINT TRIGGER proof_commit_gate AFTER INSERT ON checkpoint_proof.checkpoint_receipt
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION checkpoint_proof.block_commit()`);
}

beforeAll(async () => {
  // Fail closed: this fixture never accepts a shared database URL/host.
  const host = process.env['PGHOST'];
  if (
    !host ||
    !/^\/tmp\/ca-pg18-[^/]+\/socket$/.test(host) ||
    process.env['PGUSER'] !== 'code_along_test' ||
    process.env['PGDATABASE'] !== 'postgres'
  ) {
    throw new Error(
      'Run integration tests through tools/dev/postgres_cluster.py',
    );
  }
  const permissions = await stat(host);
  if ((permissions.mode & 0o777) !== 0o700)
    throw new Error('Private socket directory required');
  const config = {
    host,
    port: 5432,
    database: 'postgres',
    connectionTimeoutMillis: 1000,
    idleTimeoutMillis: 500,
  };
  admin = new Pool({ ...config, user: 'code_along_test', max: 3 });
  writer = new Pool({ ...config, user: 'checkpoint_writer', max: 4 });
  writer.on('error', () => {
    idleErrors += 1;
  });
  const version = await admin.query<{ version: number }>(
    "SELECT current_setting('server_version_num')::int AS version",
  );
  if (
    !version.rows[0] ||
    version.rows[0].version < 180000 ||
    version.rows[0].version >= 190000
  )
    throw new Error('PostgreSQL 18 required');
  await admin.query(
    await readFile(new URL('../fixtures/schema.sql', import.meta.url), 'utf8'),
  );
});

beforeEach(async () => {
  await admin.query(`DROP TRIGGER IF EXISTS proof_commit_gate ON checkpoint_proof.checkpoint_receipt;
    DROP FUNCTION IF EXISTS checkpoint_proof.block_commit();
    DROP TRIGGER IF EXISTS proof_fail_insert ON checkpoint_proof.checkpoint_receipt;
    DROP FUNCTION IF EXISTS checkpoint_proof.fail_insert();
    TRUNCATE checkpoint_proof.checkpoint_receipt, checkpoint_proof.document_state, checkpoint_proof.document`);
  await admin.query('INSERT INTO checkpoint_proof.document VALUES ($1,1)', [
    documentId,
  ]);
  store = new CheckpointStore(writer);
});

afterEach(() => {
  const unexpected = idleErrors;
  idleErrors = 0;
  expect(unexpected, 'Unexpected idle database connection errors').toBe(0);
});

afterAll(async () => {
  await writer?.end();
  await admin?.end();
});

describe('real binary checkpoint persistence', () => {
  it('rejects invalid initialization without creating state, then allows recovery', async () => {
    await expect(
      store.initialize(scope, new Uint8Array([255])),
    ).rejects.toMatchObject({ code: 'invalid_state' });
    const rows = await admin.query(
      'SELECT * FROM checkpoint_proof.document_state',
    );
    expect(rows.rowCount).toBe(0);
    expect(
      (await store.initialize(scope, binary('valid'))).durable_revision,
    ).toBe('0');
  });

  it('captures autosave bytes/scope before asynchronous work and returns defensive state copies', async () => {
    await store.initialize(scope, binary());
    const input = binary('captured');
    const mutable = { ...scope };
    const pending = store.saveState(mutable, input);
    input.fill(255);
    mutable.document_id = randomUUID();
    expect(textOf((await pending).binary)).toBe('captured');
    const loaded = await store.load(scope);
    loaded.binary.fill(255);
    expect(textOf((await store.load(scope)).binary)).toBe('captured');
  });

  it('initializes once under two competing cold seeds without duplicating text', async () => {
    const other = new CheckpointStore(writer);
    const source = '\ufeff# starter 🐍\r\n';
    const a = binary(source);
    const b = binary(source);
    expect(a.equals(b)).toBe(false);
    const [first, second] = await Promise.all([
      store.initialize(scope, a),
      other.initialize(scope, b),
    ]);
    expect(first.binary).toEqual(second.binary);
    expect(textOf(first.binary)).toBe(source);
    expect(Buffer.from(textOf(first.binary), 'utf8')).toEqual(
      Buffer.from(source, 'utf8'),
    );
    expect(first.durable_revision).toBe('0');
    expect((await store.initialize(scope, b)).binary).toEqual(first.binary);
  });

  it('persists actual binary state and a receipt in the same committed version', async () => {
    await store.initialize(scope, binary());
    const source = '\ufeffprint("π")\r\n';
    const request = frame(binary(source));
    const receipt = await store.saveCheckpoint(request);
    expect(parseCheckpointResponse(JSON.stringify(receipt)).ok).toBe(true);
    const loaded = await new CheckpointStore(writer).load(scope);
    expect(textOf(loaded.binary)).toBe(source);
    expect(Buffer.from(textOf(loaded.binary), 'utf8')).toEqual(
      Buffer.from(source, 'utf8'),
    );
    expect(loaded.durable_revision).toBe('1');
    expect(loaded.state_sha256).toBe(stateHash(loaded.binary));
    expect(receipt.state_sha256).toBe(loaded.state_sha256);
    expect(await checkpointCount()).toBe(1);
  });

  it('returns an identical receipt for duplicate/lost-response retries, including after later saves', async () => {
    await store.initialize(scope, binary());
    const request = frame(binary('first'));
    const receipt = await store.saveCheckpoint(request);
    const newer = await store.saveCheckpoint(frame(binary('# peer')));
    expect(newer.durable_revision).toBe('2');
    expect(await new CheckpointStore(writer).saveCheckpoint(request)).toEqual(
      receipt,
    );
    expect((await store.load(scope)).durable_revision).toBe('2');
    expect(await checkpointCount()).toBe(2);
  });

  it.each(['bytes', 'counter'])(
    'rejects idempotency key reuse with different %s',
    async (change) => {
      await store.initialize(scope, binary());
      const request = frame(binary('first'));
      await store.saveCheckpoint(request);
      const changed: Record<string, unknown> = JSON.parse(request);
      if (change === 'bytes')
        changed['state_base64'] = binary('different').toString('base64');
      else changed['observed_counter'] = 2;
      await expect(
        store.saveCheckpoint(JSON.stringify(changed)),
      ).rejects.toMatchObject({ code: 'checkpoint_conflict' });
      expect((await store.load(scope)).durable_revision).toBe('1');
      expect(await checkpointCount()).toBe(1);
    },
  );

  it('merges a delayed old autosave rather than resurrecting deleted source', async () => {
    const seed = binary('delete me');
    await store.initialize(scope, seed);
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, seed);
      doc.getText('source').delete(0, 9);
      await store.saveCheckpoint(frame(Y.encodeStateAsUpdate(doc)));
      const result = await store.saveState(scope, seed);
      expect(textOf(result.binary)).toBe('');
      expect(result.durable_revision).toBe('2');
      expect(await checkpointCount()).toBe(1);
    } finally {
      doc.destroy();
    }
  });

  it('uses CAS reload/merge across independent writers with the same stale revision', async () => {
    await store.initialize(scope, binary());
    const lock = await admin.connect();
    try {
      await lock.query('BEGIN');
      await lock.query(
        'SELECT * FROM checkpoint_proof.document_state FOR UPDATE',
      );
      const a = store.saveCheckpoint(frame(binary('A')));
      const b = new CheckpointStore(writer).saveCheckpoint(frame(binary('B')));
      const results = Promise.all([a, b]);
      await waitForWriters(2, 'update');
      await lock.query('COMMIT');
      const receipts = await results;
      expect(receipts.map((r) => r.durable_revision).sort()).toEqual([
        '1',
        '2',
      ]);
      const loaded = await store.load(scope);
      expect(textOf(loaded.binary).split('').sort().join('')).toBe('AB');
      expect(await checkpointCount()).toBe(2);
    } finally {
      await lock.query('ROLLBACK');
      lock.release();
    }
  });

  it('handles simultaneous duplicate requests with only one revision increment', async () => {
    await store.initialize(scope, binary());
    const request = frame(binary('once'));
    const receipts = await Promise.all([
      store.saveCheckpoint(request),
      new CheckpointStore(writer).saveCheckpoint(request),
    ]);
    expect(receipts[0]).toEqual(receipts[1]);
    expect((await store.load(scope)).durable_revision).toBe('1');
    expect(await checkpointCount()).toBe(1);
  });

  it('does not expose uncommitted state/receipts or resolve before COMMIT', async () => {
    await store.initialize(scope, binary());
    await deferredCommitBarrier();
    const lock = await admin.connect();
    try {
      await lock.query('SELECT pg_advisory_lock(4242)');
      let settled = false;
      const saving = store
        .saveCheckpoint(frame(binary('gated')))
        .finally(() => {
          settled = true;
        });
      await waitForWriters(1, 'advisory');
      expect(settled).toBe(false);
      expect(await checkpointCount()).toBe(0);
      expect((await store.load(scope)).durable_revision).toBe('0');
      await lock.query('SELECT pg_advisory_unlock(4242)');
      expect((await saving).durable_revision).toBe('1');
      expect(await checkpointCount()).toBe(1);
    } finally {
      await lock.query('SELECT pg_advisory_unlock_all()');
      lock.release();
    }
  });

  it.each(['insert', 'commit'])(
    'rolls back both state and receipt on a real %s failure',
    async (when) => {
      await store.initialize(scope, binary());
      await admin.query(`CREATE FUNCTION checkpoint_proof.fail_insert() RETURNS trigger LANGUAGE plpgsql
      AS $$ BEGIN RAISE EXCEPTION 'PRIVATE_DATABASE_DETAIL'; END $$;
      CREATE ${when === 'commit' ? 'CONSTRAINT ' : ''}TRIGGER proof_fail_insert
      ${when === 'commit' ? 'AFTER' : 'BEFORE'} INSERT ON checkpoint_proof.checkpoint_receipt
      ${when === 'commit' ? 'DEFERRABLE INITIALLY DEFERRED' : ''}
      FOR EACH ROW EXECUTE FUNCTION checkpoint_proof.fail_insert()`);
      const request = frame(binary('must rollback'));
      await expect(store.saveCheckpoint(request)).rejects.toMatchObject({
        message: 'storage_unavailable',
        code: 'storage_unavailable',
      });
      expect((await store.load(scope)).durable_revision).toBe('0');
      expect(textOf((await store.load(scope)).binary)).toBe('');
      expect(await checkpointCount()).toBe(0);
      await admin.query(
        'DROP TRIGGER proof_fail_insert ON checkpoint_proof.checkpoint_receipt',
      );
      expect((await store.saveCheckpoint(request)).durable_revision).toBe('1');
    },
  );

  it('loses the connection before commit without returning a receipt, then recovers on retry', async () => {
    await store.initialize(scope, binary());
    await deferredCommitBarrier();
    const lock = await admin.connect();
    const request = frame(binary('retry'));
    try {
      await lock.query('SELECT pg_advisory_lock(4242)');
      const result = expect(
        store.saveCheckpoint(request),
      ).rejects.toMatchObject({ code: 'storage_unavailable' });
      await waitForWriters(1, 'advisory');
      await admin.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename='checkpoint_writer' AND wait_event='advisory'",
      );
      await result;
      expect((await store.load(scope)).durable_revision).toBe('0');
      expect(await checkpointCount()).toBe(0);
      await lock.query('SELECT pg_advisory_unlock(4242)');
      expect((await store.saveCheckpoint(request)).durable_revision).toBe('1');
    } finally {
      await lock.query('SELECT pg_advisory_unlock_all()');
      lock.release();
    }
  });

  it('rejects stale/deleted generations without recreating metadata', async () => {
    await store.initialize(scope, binary());
    await admin.query(
      `DELETE FROM checkpoint_proof.document_state; UPDATE checkpoint_proof.document SET generation=2`,
    );
    await expect(
      store.saveCheckpoint(frame(binary('old'))),
    ).rejects.toMatchObject({ code: 'generation_mismatch' });
    await expect(store.initialize(scope, binary('old'))).rejects.toMatchObject({
      code: 'generation_mismatch',
    });
    await store.initialize({ ...scope, generation: 2 }, binary('new'));
    expect(textOf((await store.load({ ...scope, generation: 2 })).binary)).toBe(
      'new',
    );
  });

  it('treats a pruned receipt as a fresh merge, preserving newer source', async () => {
    const seed = binary('base');
    await store.initialize(scope, seed);
    const old = frame(seed);
    await store.saveCheckpoint(old);
    await store.saveCheckpoint(frame(binary('peer')));
    const text = textOf((await store.load(scope)).binary);
    await admin.query('DELETE FROM checkpoint_proof.checkpoint_receipt');
    expect((await store.saveCheckpoint(old)).durable_revision).toBe('3');
    expect(textOf((await store.load(scope)).binary)).toBe(text);
  });

  it('preserves bigint revisions beyond JavaScript integer precision', async () => {
    await store.initialize(scope, binary());
    await admin.query(
      'UPDATE checkpoint_proof.document_state SET durable_revision=9007199254740992',
    );
    const receipt = await store.saveCheckpoint(frame(binary('large revision')));
    expect(receipt.durable_revision).toBe('9007199254740993');
    expect(parseCheckpointResponse(JSON.stringify(receipt)).ok).toBe(true);
  });

  it('fails closed on malformed state and stored hash corruption without receipts', async () => {
    await store.initialize(scope, binary());
    await expect(
      store.saveCheckpoint(frame(new Uint8Array([255]))),
    ).rejects.toMatchObject({ code: 'invalid_state' });
    await admin.query(
      "UPDATE checkpoint_proof.document_state SET state_sha256=repeat('0',64)",
    );
    await expect(store.saveCheckpoint(frame(binary()))).rejects.toMatchObject({
      code: 'storage_unavailable',
    });
    expect(await checkpointCount()).toBe(0);
  });

  it('uses a DB role that cannot create product tables, change metadata or delete receipts', async () => {
    expect(
      (await writer.query('SELECT current_user')).rows[0]?.current_user,
    ).toBe('checkpoint_writer');
    for (const sql of [
      'CREATE TABLE checkpoint_proof.forbidden(x int)',
      'INSERT INTO checkpoint_proof.document VALUES (gen_random_uuid(),1)',
      'DELETE FROM checkpoint_proof.checkpoint_receipt',
    ]) {
      await expect(writer.query(sql)).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('bounds pending writes and recovers queue capacity afterward', async () => {
    await store.initialize(scope, binary());
    const requests = Array.from({ length: 32 }, () =>
      store.saveCheckpoint(frame(binary())),
    );
    await expect(store.saveCheckpoint(frame(binary()))).rejects.toMatchObject({
      code: 'resource_limit',
    });
    await Promise.all(requests);
    expect((await store.saveCheckpoint(frame(binary()))).durable_revision).toBe(
      '33',
    );
  });
});
