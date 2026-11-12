import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, clearCsrf } from './client.ts';
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
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({
      credentials: 'same-origin',
      headers: { 'X-CSRFToken': 'masked-token' },
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
