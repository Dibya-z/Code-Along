import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CORE_RUNTIME,
  SCIENTIFIC_RUNTIME,
  type RuntimeIdentity,
} from '@code-along/contracts/execution/profiles';
import { prepareRuntime } from './runtime.ts';
const root = new URL('../../../', import.meta.url);
afterEach(() => vi.unstubAllGlobals());
async function fixture(identity: RuntimeIdentity, corrupt = false) {
  const scientific = identity.runtime_id === SCIENTIFIC_RUNTIME.runtime_id;
  const name = scientific ? 'pyodide-scientific.json' : 'pyodide-core.json';
  const inventory = await readFile(
    new URL(
      (scientific
        ? 'packages/runtime-profiles/manifests/'
        : 'apps/runner-web/public/runtime-manifests/') + name,
      root,
    ),
  );
  const urls: string[] = [];
  vi.stubGlobal('location', { origin: 'https://runtime.example.test' });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'https://runtime.example.test');
      urls.push(url.href);
      if (url.pathname.startsWith('/runtime-manifests/'))
        return new Response(Uint8Array.from(inventory).buffer);
      const basename = url.pathname.split('/').at(-1);
      const bytes = await readFile(
        new URL('apps/runner-web/node_modules/pyodide/' + basename, root),
      );
      if (corrupt && basename === 'pyodide.mjs') bytes[0] = (bytes[0] ?? 0) ^ 1;
      return new Response(Uint8Array.from(bytes).buffer);
    }),
  );
  return urls;
}
describe('Worker runtime preparation', () => {
  it('uses an absolute package base URL and loads only the selected package closure', async () => {
    const urls = await fixture(SCIENTIFIC_RUNTIME);
    const prepared = await prepareRuntime(SCIENTIFIC_RUNTIME);
    expect(prepared.base).toBe(
      `https://runtime.example.test/runtime/v2/${SCIENTIFIC_RUNTIME.manifest_sha256}/`,
    );
    expect(prepared.packages).toEqual(['numpy']);
    expect(Object.keys(prepared.lock.packages)).toEqual(['numpy']);
    expect(
      urls.every((url) => url.startsWith('https://runtime.example.test/')),
    ).toBe(true);
    expect(urls.filter((url) => url.endsWith('.whl'))).toEqual([]);
  });
  it('keeps scientific wheels out of the core profile', async () => {
    await fixture(CORE_RUNTIME);
    const prepared = await prepareRuntime(CORE_RUNTIME);
    expect(prepared.packages).toEqual([]);
    expect(prepared.lock.packages).toEqual({});
  });
  it('refuses changed executable bytes before importing the runtime', async () => {
    await fixture(CORE_RUNTIME, true);
    await expect(prepareRuntime(CORE_RUNTIME)).rejects.toThrow(
      'integrity verification',
    );
  });
  it('identifies an unavailable inventory without exposing a URL or retrying admission', async () => {
    const fetcher = vi.fn().mockRejectedValue(new TypeError('Load failed'));
    vi.stubGlobal('fetch', fetcher);
    await expect(prepareRuntime(CORE_RUNTIME)).rejects.toThrow(
      'could not load its reviewed inventory',
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('re-verifies warm public bytes and supplies large assets without a network fetch', async () => {
    await fixture(CORE_RUNTIME);
    const prepared = await prepareRuntime(CORE_RUNTIME);
    const cached = await prepared.completeCache();
    const network = vi
      .fn()
      .mockRejectedValue(new TypeError('owned offline fixture'));
    vi.stubGlobal('fetch', network);
    const replayed = await prepareRuntime(CORE_RUNTIME, cached);
    const response = await replayed.fetchAsset(
      replayed.base + 'pyodide.asm.wasm',
    );
    expect(response.headers.get('Content-Type')).toBe('application/wasm');
    expect((await response.arrayBuffer()).byteLength).toBe(9_598_218);
    expect(network).not.toHaveBeenCalled();
    await expect(
      replayed.fetchAsset('https://runtime.example.test/unreviewed'),
    ).rejects.toThrow('offline');
    expect(network).toHaveBeenCalledOnce();
  });
});
