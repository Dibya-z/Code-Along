import { afterEach, describe, expect, it, vi } from 'vitest';
import { queryClient } from '../../app/providers.tsx';
import { getIdentity, replaceSession, safeDestination } from './session.ts';

afterEach(() => {
  queryClient.clear();
  vi.unstubAllGlobals();
});
function page() {
  const replace = vi.fn();
  vi.stubGlobal('window', {
    location: { origin: 'https://app.example.test', replace },
  });
  return replace;
}
function pendingIdentity() {
  let observed: AbortSignal | null | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          observed = init?.signal;
          observed?.addEventListener(
            'abort',
            () =>
              reject(new DOMException('Owned cancelled request', 'AbortError')),
            { once: true },
          );
        }),
    ),
  );
  return () => observed;
}
it('passes identity query cancellation through the typed client to the actual fetch', async () => {
  page();
  const signal = pendingIdentity(),
    cancellation = new AbortController();
  const result = getIdentity(cancellation.signal);
  await vi.waitFor(() => expect(signal()).toBeDefined());
  cancellation.abort();
  await expect(result).rejects.toMatchObject({ name: 'AbortError' });
  expect(signal()?.aborted).toBe(true);
});
it.each([401, 403])(
  'treats an explicit server denial as signed out (%s)',
  async (status) => {
    page();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('{}', {
          status,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    await expect(getIdentity()).resolves.toBeNull();
  },
);
it('aborts an active account query and clears scoped caches before replacement', async () => {
  const replace = page(),
    signal = pendingIdentity();
  const pending = queryClient
    .fetchQuery({
      queryKey: ['me'],
      queryFn: ({ signal }) => getIdentity(signal),
    })
    .catch(() => undefined);
  await vi.waitFor(() => expect(signal()).toBeDefined());
  queryClient.setQueryData(['project', 'owned-fixture'], {
    name: 'private fixture',
  });
  replace.mockImplementation(() => {
    expect(signal()?.aborted).toBe(true);
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
  });
  await replaceSession('/', false);
  await pending;
  expect(signal()?.aborted).toBe(true);
  expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
  expect(replace).toHaveBeenCalledExactlyOnceWith('/');
});

describe('post-authentication destination', () => {
  it('rejects external URLs and unrecognised paths', () => {
    for (const path of [
      'https://evil.invalid',
      '//evil.invalid',
      '/\\evil.invalid',
      '/api/v1/me/',
      '/invitations/token?next=//evil.invalid',
    ])
      expect(safeDestination(path)).toBe('/workspaces');
  });
  it('preserves only a complete invitation route', () => {
    const path = '/invitations/' + 'a'.repeat(43);
    expect(safeDestination(path)).toBe(path);
    expect(safeDestination(path + '?extra=1')).toBe('/workspaces');
  });
});
