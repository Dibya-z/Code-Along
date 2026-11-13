/**
 * Actual ProductServer/storage crash fixture, restricted to an owned PG18 cluster.
 * Admission is a clearly test-only private adapter; this does not certify Django
 * session policy. The real provider and production persistence remain unchanged.
 */
import assert from 'node:assert/strict';
import { lstat, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Pool } from 'pg';
import { ProductCheckpointStore } from '../../src/persistence/checkpoint-store.ts';
import { createProductServer } from '../../src/product/product-server.ts';
import {
  AdmissionError,
  parseGrant,
  type Grant,
} from '../../src/product/admission.ts';

export const FIXTURE_ORIGIN = 'https://product-crash.example.test';
export const FIXTURE_COOKIE = 'codealong_session=owned-crash-fixture';
export interface CrashGrant {
  ticket: string;
  grant: Grant;
}
export interface CrashConfiguration {
  before: CrashGrant[];
  after: CrashGrant[];
}
export async function ownedConfiguration(
  path: string | undefined,
): Promise<{ config: CrashConfiguration; directory: string }> {
  if (
    !path ||
    !/^\/tmp\/ca-pg18-[^/]+\/product-crash-config.json$/.test(path) ||
    process.env['PGHOST'] !== join(dirname(path), 'socket') ||
    process.env['PGUSER'] !== 'code_along_test' ||
    process.env['PGDATABASE'] !== 'postgres'
  )
    throw new Error('owned_cluster_required');
  const file = await lstat(path),
    directory = dirname(path),
    parent = await lstat(directory);
  if (
    !file.isFile() ||
    file.isSymbolicLink() ||
    (file.mode & 0o777) !== 0o600 ||
    (parent.mode & 0o777) !== 0o700 ||
    file.uid !== process.getuid?.()
  )
    throw new Error('private_fixture_required');
  const config = JSON.parse(await readFile(path, 'utf8')) as CrashConfiguration;
  for (const phase of [config.before, config.after]) {
    assert.equal(phase.length, 2);
    for (const entry of phase) {
      assert.match(entry.ticket, /^[A-Za-z0-9_-]{43}$/);
      parseGrant(
        entry.grant,
        `${entry.grant.document.id}:${entry.grant.document.generation}`,
      );
    }
  }
  return { config, directory };
}
async function serve(): Promise<void> {
  const [phase, path] = process.argv.slice(2);
  if (phase !== 'before' && phase !== 'after') throw new Error('invalid_phase');
  const { config } = await ownedConfiguration(path);
  const tickets = new Map(
    config[phase].map((entry) => [entry.ticket, entry.grant]),
  );
  const pool = new Pool({
    user: 'code_along_collaboration',
    max: 2,
    connectionTimeoutMillis: 1500,
    idleTimeoutMillis: 200,
  });
  const server = createProductServer({
    store: new ProductCheckpointStore(pool),
    appOrigin: FIXTURE_ORIGIN,
    sessionCookieName: 'codealong_session',
    controlSecret: 'owned-crash-control-fixture-secret-32-chars',
    port: 0,
    debounce: 60_000,
    admission: {
      async consume(input) {
        const grant = tickets.get(input.ticket);
        if (
          !grant ||
          input.cookie !== FIXTURE_COOKIE ||
          input.origin !== FIXTURE_ORIGIN ||
          input.document_name !==
            `${grant.document.id}:${grant.document.generation}`
        )
          throw new AdmissionError('unauthorized');
        tickets.delete(input.ticket);
        return { grant, started: performance.now() };
      },
      async renew(lease) {
        return { grant: lease.grant, started: performance.now() };
      },
    },
  });
  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      await server.destroy();
      await pool.end();
    })());
  pool.on('error', () => {
    void stop().finally(() => {
      process.exitCode = 1;
    });
  });
  process.once('SIGTERM', () => {
    void stop();
  });
  process.once('SIGINT', () => {
    void stop();
  });
  try {
    assert.equal(
      (await pool.query('SELECT current_user')).rows[0]?.current_user,
      'code_along_collaboration',
    );
    await server.listen();
    process.stdout.write(
      `${JSON.stringify({ event: 'product_server_ready', port: server.address.port })}\n`,
    );
  } catch {
    await stop();
    throw new Error('product_server_start_failed');
  }
}
if (process.argv[1]?.endsWith('/product-crash-server.ts')) {
  try {
    await serve();
  } catch {
    process.stderr.write('product_crash_fixture_failed\n');
    process.exitCode = 1;
  }
}
