import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, clearCsrf, parseRetryAfter } from './client.ts';
afterEach(() => {
  vi.unstubAllGlobals();
  clearCsrf();
});
describe('same-origin API client', () => {
  it('refuses external destinations before sending credentials', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(api('https://other.invalid/api/')).rejects.toThrow(
      'Only local',
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it('bootstraps a CSRF token and sends credentials only to the local API', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ csrfToken: 'masked-token' })),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'id' })));
    vi.stubGlobal('fetch', fetch);
    await expect(
      api('/api/v1/workspaces/', { method: 'POST', body: { name: 'Group' } }),
    ).resolves.toEqual({ id: 'id' });
    expect(
      new Headers(fetch.mock.calls[1]?.[1].headers).get('X-CSRFToken'),
    ).toBe('masked-token');
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({
      credentials: 'same-origin',
      body: '{"name":"Group"}',
    });
  });
  it('exposes typed failures and clears stale CSRF after forbidden', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response('{"detail":"denied"}', { status: 403 }),
        ),
    );
    await expect(api('/api/v1/me/')).rejects.toBeInstanceOf(ApiError);
  });
  it('reports network failures without leaking URLs', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('private host')),
    );
    await expect(api('/api/v1/me/')).rejects.toThrow('Could not connect');
  });
});

describe('shared credential transport', () => {
  it('shares one CSRF bootstrap between concurrent unsafe requests', async () => {
    const fetch = vi.fn(
      async (path: string) =>
        new Response(
          JSON.stringify(
            path === '/api/v1/csrf/'
              ? { csrfToken: 'masked-token' }
              : { ok: true },
          ),
          { headers: { 'Content-Type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetch);
    await Promise.all([
      api('/api/v1/one/', { method: 'POST', body: {} }),
      api('/api/v1/two/', { method: 'POST', body: {} }),
    ]);
    expect(
      fetch.mock.calls.filter((call) => call[0] === '/api/v1/csrf/'),
    ).toHaveLength(1);
  });
  it('does not expose HTML error pages through the client', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response('<html>private traceback</html>', { status: 403 }),
        ),
    );
    try {
      await api('/api/v1/me/');
      throw new Error('Expected denial');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      if (error instanceof ApiError)
        expect(JSON.stringify(error.body)).not.toContain('private traceback');
    }
  });
});

it('rejects a malformed success body instead of inventing a null result', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not-json')));
  await expect(api('/api/v1/me/')).rejects.toThrow('unreadable response');
});

describe('bounded Retry-After timing', () => {
  it('retains safe delta seconds and canonical HTTP-date without raw header text', () => {
    const now = Date.parse('2026-11-14T12:00:00Z');
    expect(parseRetryAfter('60', now)).toBe(60);
    expect(parseRetryAfter('0', now)).toBe(1);
    expect(parseRetryAfter('Sat, 14 Nov 2026 12:00:30 GMT', now)).toBe(30);
    for (const value of [
      null,
      'private-token',
      '60;token=secret',
      '-1',
      '1e2',
      '1.5',
      '99999999999999',
      '86401',
      '2026-11-14T12:00:30Z',
    ])
      expect(parseRetryAfter(value, now)).toBeUndefined();
  });
  it('exposes timing on429 only, including a safely replaced non-JSON response', async () => {
    for (const contentType of ['application/json', 'text/html']) {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(
              contentType === 'application/json'
                ? '{"detail":"quota"}'
                : 'not reflected',
              {
                status: 429,
                headers: { 'Content-Type': contentType, 'Retry-After': '17' },
              },
            ),
        ),
      );
      await expect(api('/api/v1/example/')).rejects.toMatchObject({
        status: 429,
        retryAfterSeconds: 17,
      });
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('{}', {
            status: 503,
            headers: {
              'Content-Type': 'application/json',
              'Retry-After': '17',
            },
          }),
      ),
    );
    await expect(api('/api/v1/example/')).rejects.toMatchObject({
      status: 503,
      retryAfterSeconds: undefined,
    });
  });
  it('does not echo an arbitrary or token-bearing header through errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('{}', {
            status: 429,
            headers: {
              'Content-Type': 'application/json',
              'Retry-After': 'private-token',
            },
          }),
      ),
    );
    try {
      await api('/api/v1/example/');
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).retryAfterSeconds).toBeUndefined();
      expect(JSON.stringify(error)).not.toContain('private-token');
    }
  });
});
