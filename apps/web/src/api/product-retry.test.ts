import { afterEach, describe, expect, it, vi } from 'vitest';
import { productApi } from './product.ts';
import { clearCsrf } from './client.ts';
afterEach(() => {
  vi.unstubAllGlobals();
  clearCsrf();
});
describe('generated product transport quota timing', () => {
  it('keeps Retry-After through actual generated me/members requests used by the observer', async () => {
    vi.stubGlobal('window', {
      location: { origin: 'https://app.example.test' },
    });
    const fetch = vi.fn(
      async () =>
        new Response('{"detail":"quota"}', {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '17' },
        }),
    );
    vi.stubGlobal('fetch', fetch);
    await expect(productApi.me()).rejects.toMatchObject({
      status: 429,
      retryAfterSeconds: 17,
    });
    await expect(
      productApi.members('11111111-1111-4111-8111-111111111111'),
    ).rejects.toMatchObject({ status: 429, retryAfterSeconds: 17 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('does not retain malformed header values or attach quota timing to another status', async () => {
    vi.stubGlobal('window', {
      location: { origin: 'https://app.example.test' },
    });
    for (const [status, header] of [
      [429, 'private-token'],
      [503, '17'],
    ] as const) {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response('{}', {
              status,
              headers: {
                'Content-Type': 'application/json',
                'Retry-After': header,
              },
            }),
        ),
      );
      try {
        await productApi.me();
        throw new Error('expected denial');
      } catch (error) {
        expect(error).toMatchObject({ status, retryAfterSeconds: undefined });
        expect(JSON.stringify(error)).not.toContain('private-token');
      }
    }
  });
});
