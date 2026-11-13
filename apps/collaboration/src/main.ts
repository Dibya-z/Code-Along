import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Pool, type PoolConfig } from 'pg';
import { ProductCheckpointStore } from './persistence/checkpoint-store.ts';
import { createAdmissionClient, privateBase } from './product/admission.ts';
import { createProductServer } from './product/product-server.ts';

export function configuration(env: NodeJS.ProcessEnv) {
  const required = (name: string): string => {
    const value = env[name];
    if (!value || /[\r\n]/.test(value))
      throw new Error('invalid_collaboration_configuration');
    return value;
  };
  const secret = required('CODE_ALONG_COLLABORATION_SECRET'),
    controlSecret = required('CODE_ALONG_COLLABORATION_CONTROL_SECRET');
  if (
    !/^[\x21-\x7e]{32,256}$/.test(secret) ||
    !/^[\x21-\x7e]{32,256}$/.test(controlSecret) ||
    secret === controlSecret
  )
    throw new Error('invalid_collaboration_configuration');
  const api = required('CODE_ALONG_COLLABORATION_API_URL');
  privateBase(api);
  const appOrigin = required('CODE_ALONG_APP_ORIGIN'),
    origin = new URL(appOrigin);
  if (
    origin.origin !== appOrigin ||
    !['https:', 'http:'].includes(origin.protocol)
  )
    throw new Error('invalid_collaboration_configuration');
  const sessionCookieName = required('CODE_ALONG_SESSION_COOKIE_NAME');
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(sessionCookieName))
    throw new Error('invalid_collaboration_configuration');
  const host = env['CODE_ALONG_COLLABORATION_HOST'] ?? '127.0.0.1';
  if (!['127.0.0.1', '0.0.0.0', '::1', '::'].includes(host))
    throw new Error('invalid_collaboration_configuration');
  const rawPort = env['CODE_ALONG_COLLABORATION_PORT'] ?? '1234',
    port = Number(rawPort);
  if (!/^[1-9][0-9]{0,4}$/.test(rawPort) || port > 65535)
    throw new Error('invalid_collaboration_configuration');
  const user = required('PGUSER');
  if (user !== 'code_along_collaboration')
    throw new Error('invalid_collaboration_configuration');
  const sslmode = required('PGSSLMODE');
  if (!['disable', 'verify-full'].includes(sslmode))
    throw new Error('invalid_collaboration_configuration');
  const dbPort = required('PGPORT');
  if (!/^[1-9][0-9]{0,4}$/.test(dbPort) || Number(dbPort) > 65535)
    throw new Error('invalid_collaboration_configuration');
  const pool: PoolConfig = {
    host: required('PGHOST'),
    port: Number(dbPort),
    database: required('PGDATABASE'),
    user,
    password: required('PGPASSWORD'),
    max: 4,
    connectionTimeoutMillis: 2000,
    idleTimeoutMillis: 10_000,
    application_name: 'code-along-collaboration',
    ssl:
      sslmode === 'disable'
        ? false
        : {
            rejectUnauthorized: true,
            ...(env['PGSSLROOTCERT']
              ? { ca: readFileSync(env['PGSSLROOTCERT'], 'utf8') }
              : {}),
          },
  };
  return {
    pool,
    api,
    secret,
    controlSecret,
    appOrigin,
    sessionCookieName,
    host,
    port,
  };
}
export async function start(env: NodeJS.ProcessEnv = process.env) {
  const config = configuration(env),
    pool = new Pool(config.pool);
  const server = createProductServer({
    store: new ProductCheckpointStore(pool),
    admission: createAdmissionClient({
      base: config.api,
      secret: config.secret,
    }),
    controlSecret: config.controlSecret,
    appOrigin: config.appOrigin,
    sessionCookieName: config.sessionCookieName,
    host: config.host,
    port: config.port,
  });
  let closing: Promise<void> | undefined;
  const stop = () =>
    (closing ??= (async () => {
      await server.destroy();
      await pool.end();
    })());
  pool.on('error', () => {
    process.stderr.write('collaboration_database_unavailable\n');
    void stop().finally(() => {
      process.exitCode = 1;
    });
  });
  try {
    const role = await pool.query<{
      current_user: string;
      rolsuper: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolreplication: boolean;
      rolbypassrls: boolean;
    }>(
      'SELECT current_user,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=current_user',
    );
    const row = role.rows[0];
    if (
      !row ||
      row.current_user !== 'code_along_collaboration' ||
      row.rolsuper ||
      row.rolcreatedb ||
      row.rolcreaterole ||
      row.rolreplication ||
      row.rolbypassrls
    )
      throw new Error('invalid_collaboration_configuration');
    await server.listen();
  } catch {
    await stop();
    throw new Error('collaboration_startup_failed');
  }
  return { server, pool, stop };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const running = await start();
    const stop = () => {
      void running.stop().catch(() => {
        process.exitCode = 1;
      });
    };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    process.stdout.write('collaboration_ready\n');
  } catch {
    process.stderr.write('collaboration_startup_failed\n');
    process.exitCode = 1;
  }
}
