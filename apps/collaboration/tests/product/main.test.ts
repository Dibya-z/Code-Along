import { describe, it, expect } from 'vitest';
import { configuration } from '../../src/main.ts';
const env = {
  CODE_ALONG_COLLABORATION_SECRET: 's'.repeat(40),
  CODE_ALONG_COLLABORATION_CONTROL_SECRET: 'c'.repeat(40),
  CODE_ALONG_COLLABORATION_API_URL: 'http://127.0.0.1:18001',
  CODE_ALONG_APP_ORIGIN: 'https://app.test',
  CODE_ALONG_SESSION_COOKIE_NAME: 'codealong_session',
  PGHOST: '/tmp/private-owned-fixture',
  PGPORT: '5432',
  PGDATABASE: 'postgres',
  PGUSER: 'code_along_collaboration',
  PGPASSWORD: 'owned-fixture-password',
  PGSSLMODE: 'disable',
};
describe('native collaboration startup configuration', () => {
  it('uses fixed service endpoints and dedicated bounded database pool', () => {
    const config = configuration(env);
    expect(config.port).toBe(1234);
    expect(config.pool).toMatchObject({
      user: 'code_along_collaboration',
      max: 4,
      ssl: false,
      connectionTimeoutMillis: 2000,
    });
  });
  it('refuses missing or identical service credentials, owner roles, ambiguous URLs and weak TLS modes', () => {
    for (const patch of [
      { CODE_ALONG_COLLABORATION_SECRET: '' },
      { CODE_ALONG_COLLABORATION_SECRET: '🔐'.repeat(40) },
      { CODE_ALONG_COLLABORATION_CONTROL_SECRET: 'x '.repeat(40) },
      {
        CODE_ALONG_COLLABORATION_CONTROL_SECRET:
          env.CODE_ALONG_COLLABORATION_SECRET,
      },
      { PGUSER: 'code_along_test' },
      { PGSSLMODE: 'require' },
      { CODE_ALONG_COLLABORATION_API_URL: 'http://api.test/?token=hidden' },
      { CODE_ALONG_APP_ORIGIN: 'https://app.test/path' },
      { CODE_ALONG_SESSION_COOKIE_NAME: '' },
    ])
      expect(() => configuration({ ...env, ...patch })).toThrowError(
        'invalid_collaboration_configuration',
      );
  });
});
