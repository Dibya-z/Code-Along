import {
  runtimeProfile,
  type RuntimeIdentity,
} from '@code-along/contracts/execution/profiles';
import {
  readRuntimeResponse,
  verifyRuntimeInventory,
  RUNTIME_ASSET_LIMITS,
} from '@code-along/contracts/execution/runtime-inventory';
import { sha256 } from '@code-along/contracts/execution';
import { verifyCachedAssets, type RuntimeAssets } from './asset-cache.ts';
interface LockPackage {
  readonly file_name: string;
}
interface LockFile {
  readonly info: Record<string, unknown>;
  readonly packages: Record<string, LockPackage>;
}
async function runtimeBytes(
  url: string,
  limit: number,
  label: string,
  request: typeof fetch = fetch,
) {
  try {
    return await readRuntimeResponse(
      await request(url, { credentials: 'omit', cache: 'force-cache' }),
      limit,
    );
  } catch {
    throw new Error(
      `Python runtime could not load ${label}. Check the runtime connection and try again.`,
    );
  }
}
export async function prepareRuntime(
  identity: RuntimeIdentity,
  warm?: unknown,
) {
  const profile = runtimeProfile(identity.runtime_id);
  if (!profile) throw new Error('This Python runtime profile is not reviewed.');
  const restored =
    warm === undefined ? undefined : await verifyCachedAssets(warm, identity);
  const inventory =
    restored?.inventory ??
    (await verifyRuntimeInventory(
      JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(
          await runtimeBytes(
            `/runtime-manifests/${profile.inventory}?sha256=${identity.manifest_sha256}`,
            RUNTIME_ASSET_LIMITS.inventoryBytes,
            'its reviewed inventory',
          ),
        ),
      ),
      identity,
    ));
  const assets = new Map(
    restored?.assets.map((asset) => [asset.name, asset.bytes]),
  );
  const originalFetch = globalThis.fetch.bind(globalThis);
  const base = new URL(
    `/runtime/v2/${identity.manifest_sha256}/`,
    location.origin,
  ).href;
  const assetBytes = async (name: string) => {
    const spec = inventory.assets.find((asset) => asset.name === name);
    if (!spec) throw new Error('This runtime asset is not reviewed.');
    let bytes = assets.get(name);
    if (!bytes) {
      bytes = await runtimeBytes(base + name, spec.bytes, name, originalFetch);
      if (bytes.length !== spec.bytes || (await sha256(bytes)) !== spec.sha256)
        throw new Error(
          'A Python runtime asset failed integrity verification.',
        );
      assets.set(name, Uint8Array.from(bytes));
    }
    return bytes;
  };
  let lock: LockFile | undefined;
  for (const asset of inventory.assets) {
    if (asset.name.endsWith('.whl')) continue;
    const bytes = await assetBytes(asset.name);
    if (asset.name === 'pyodide-lock.json')
      lock = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      ) as LockFile;
  }
  if (!lock || lock.info['python'] !== identity.python_version)
    throw new Error('Python runtime metadata did not match its profile.');
  const wheelNames = new Set(
    inventory.assets
      .filter((asset) => asset.name.endsWith('.whl'))
      .map((asset) => asset.name),
  );
  const packages = Object.fromEntries(
    Object.entries(lock.packages).filter(([, entry]) =>
      wheelNames.has(entry.file_name),
    ),
  );
  const fetchAsset: typeof fetch = async (input, options) => {
    const url = new URL(
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
      location.origin,
    );
    const method =
      options?.method ?? (input instanceof Request ? input.method : 'GET');
    const spec = inventory.assets.find(
      (asset) => url.href === base + asset.name,
    );
    if (method.toUpperCase() !== 'GET' || !spec)
      return originalFetch(input, options);
    const bytes = await assetBytes(spec.name);
    return new Response(Uint8Array.from(bytes), {
      headers: {
        'Content-Type': spec.name.endsWith('.wasm')
          ? 'application/wasm'
          : spec.name.endsWith('.mjs')
            ? 'text/javascript'
            : spec.name.endsWith('.json')
              ? 'application/json'
              : 'application/octet-stream',
        'Content-Length': String(bytes.length),
      },
    });
  };
  const completeCache = async (): Promise<RuntimeAssets> => {
    for (const asset of inventory.assets) await assetBytes(asset.name);
    return {
      inventory,
      assets: inventory.assets.map((asset) => ({
        name: asset.name,
        bytes: Uint8Array.from(assets.get(asset.name)!),
      })),
    };
  };
  return {
    base,
    packages: [...profile.packages],
    lock: { ...lock, packages },
    fetchAsset,
    completeCache,
  };
}
