import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  CORE_RUNTIME,
  SCIENTIFIC_RUNTIME,
} from '@code-along/contracts/execution/profiles';
import { RUNTIME_ASSET_LIMITS } from '@code-along/contracts/execution/runtime-inventory';
import { RuntimeAssetCache, verifyCachedAssets } from './asset-cache.ts';

async function fixture() {
  const inventory = JSON.parse(
    await readFile(
      new URL('../public/runtime-manifests/pyodide-core.json', import.meta.url),
      'utf8',
    ),
  ) as { assets: { name: string }[] };
  const assets = await Promise.all(
    inventory.assets.map(async (asset) => ({
      name: asset.name,
      bytes: Uint8Array.from(
        await readFile(
          new URL(`../node_modules/pyodide/${asset.name}`, import.meta.url),
        ),
      ),
    })),
  );
  return { inventory, assets };
}
describe('trusted-frame public runtime cache', () => {
  it('admits only a complete reviewed inventory and copies bytes on both boundaries', async () => {
    const raw = await fixture(),
      original = raw.assets[0]!.bytes[0];
    const cache = new RuntimeAssetCache();
    const pending = cache.admit(raw, CORE_RUNTIME);
    raw.assets[0]!.bytes[0] = (original ?? 0) ^ 1;
    const waitingCopy = cache.copy(CORE_RUNTIME);
    await pending;
    expect((await waitingCopy)!.assets[0]!.bytes[0]).toBe(original);
    const first = (await cache.copy(CORE_RUNTIME))!;
    expect(first.assets[0]!.bytes[0]).toBe(original);
    first.assets[0]!.bytes[0] = (original ?? 0) ^ 1;
    expect((await cache.copy(CORE_RUNTIME))!.assets[0]!.bytes[0]).toBe(
      original,
    );
    expect(await cache.copy(SCIENTIFIC_RUNTIME)).toBeUndefined();
    expect(Object.keys(first).sort()).toEqual(['assets', 'inventory']);
    cache.close();
    expect(await cache.copy(CORE_RUNTIME)).toBeUndefined();
  });
  it('rejects changed bytes, incomplete/duplicate sets, forged profiles and undeclared fields', async () => {
    const raw = await fixture();
    const bad = {
      ...raw,
      assets: raw.assets.map((asset, i) =>
        i ? asset : { ...asset, bytes: new Uint8Array(asset.bytes.length) },
      ),
    };
    await expect(verifyCachedAssets(bad, CORE_RUNTIME)).rejects.toThrow(
      'integrity',
    );
    await expect(
      verifyCachedAssets({ ...raw, assets: raw.assets.slice(1) }, CORE_RUNTIME),
    ).rejects.toThrow('incomplete');
    await expect(
      verifyCachedAssets(
        { ...raw, assets: raw.assets.map(() => raw.assets[0]) },
        CORE_RUNTIME,
      ),
    ).rejects.toThrow('incomplete');
    await expect(verifyCachedAssets(raw, SCIENTIFIC_RUNTIME)).rejects.toThrow(
      'reviewed',
    );
    await expect(
      verifyCachedAssets(
        { ...raw, source: 'never cache learner source' },
        CORE_RUNTIME,
      ),
    ).rejects.toThrow();
  });
  it('rejects shared backing buffers and count/byte excess before copying or decoding assets', async () => {
    const raw = await fixture();
    for (const bytes of [
      new Uint8Array(new SharedArrayBuffer(8)),
      new Uint8Array(RUNTIME_ASSET_LIMITS.assetBytes + 1),
    ])
      await expect(
        verifyCachedAssets(
          { ...raw, assets: [{ name: raw.assets[0]!.name, bytes }] },
          CORE_RUNTIME,
        ),
      ).rejects.toThrow();
    await expect(
      verifyCachedAssets(
        { ...raw, assets: Array.from({ length: 33 }, () => raw.assets[0]) },
        CORE_RUNTIME,
      ),
    ).rejects.toThrow();
  });
  it('cannot repopulate a frame after disposal while validation is pending', async () => {
    const cache = new RuntimeAssetCache();
    const pending = cache.admit(await fixture(), CORE_RUNTIME);
    cache.close();
    await pending;
    expect(await cache.copy(CORE_RUNTIME)).toBeUndefined();
  });
});
