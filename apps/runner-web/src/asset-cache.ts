import { sha256 } from '@code-along/contracts/execution';
import {
  reviewedRuntime,
  type RuntimeIdentity,
} from '@code-along/contracts/execution/profiles';
import {
  canonicalInventory,
  RUNTIME_ASSET_LIMITS,
  verifyRuntimeInventory,
  type RuntimeInventory,
} from '@code-along/contracts/execution/runtime-inventory';

export interface RuntimeAssets {
  readonly inventory: RuntimeInventory;
  readonly assets: readonly {
    readonly name: string;
    readonly bytes: Uint8Array;
  }[];
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
/** Copy before hashing: neither a Worker nor a caller retains aliases to admitted bytes. */
export async function verifyCachedAssets(
  value: unknown,
  requested: RuntimeIdentity,
): Promise<RuntimeAssets> {
  const identity = Object.freeze({ ...requested });
  if (
    !object(value) ||
    Object.keys(value).length !== 2 ||
    !('inventory' in value) ||
    !Array.isArray(value['assets']) ||
    value['assets'].length < 1 ||
    value['assets'].length > RUNTIME_ASSET_LIMITS.assets
  )
    throw new Error('Invalid runtime asset cache.');
  const encoded = canonicalInventory(value['inventory']);
  if (
    new TextEncoder().encode(encoded).length >
    RUNTIME_ASSET_LIMITS.inventoryBytes
  )
    throw new Error('Runtime cache inventory exceeds its budget.');
  const inventoryInput: unknown = JSON.parse(encoded);
  let total = 0;
  const copied = value['assets'].map((asset: unknown) => {
    if (
      !object(asset) ||
      Object.keys(asset).length !== 2 ||
      typeof asset['name'] !== 'string' ||
      asset['name'].length > 180 ||
      !(asset['bytes'] instanceof Uint8Array) ||
      !(asset['bytes'].buffer instanceof ArrayBuffer) ||
      asset['bytes'].length < 1 ||
      asset['bytes'].length > RUNTIME_ASSET_LIMITS.assetBytes
    )
      throw new Error('Invalid cached runtime asset.');
    total += asset['bytes'].length;
    if (total > RUNTIME_ASSET_LIMITS.profileBytes)
      throw new Error('Runtime cache exceeds its byte budget.');
    return Object.freeze({
      name: asset['name'],
      bytes: Uint8Array.from(asset['bytes']),
    });
  });
  const inventory = await verifyRuntimeInventory(inventoryInput, identity);
  if (
    copied.length !== inventory.assets.length ||
    new Set(copied.map((asset) => asset.name)).size !== copied.length
  )
    throw new Error('Runtime cache is incomplete.');
  for (const asset of inventory.assets) {
    const bytes = copied.find((entry) => entry.name === asset.name)?.bytes;
    if (
      !bytes ||
      bytes.length !== asset.bytes ||
      (await sha256(bytes)) !== asset.sha256
    )
      throw new Error(
        'A cached Python runtime asset failed integrity verification.',
      );
  }
  return Object.freeze({ inventory, assets: Object.freeze(copied) });
}

/** Public reviewed assets only. Lifetime: one trusted frame; at most two profiles / 64 MiB. */
export class RuntimeAssetCache {
  private readonly entries = new Map<
    string,
    { data: RuntimeAssets; bytes: number }
  >();
  private closed = false;
  private readonly pending = new Map<string, Promise<void>>();
  async admit(value: unknown, identity: RuntimeIdentity): Promise<void> {
    if (this.closed) return;
    if (!reviewedRuntime(identity))
      throw new Error('This runtime profile is not reviewed.');
    const key = identity.manifest_sha256;
    const previous = this.pending.get(key);
    if (previous) return previous;
    const task = (async () => {
      const data = await verifyCachedAssets(value, identity);
      if (this.closed) return;
      const bytes = data.assets.reduce(
        (sum, asset) => sum + asset.bytes.length,
        0,
      );
      this.entries.delete(key);
      while (
        this.entries.size >= 2 ||
        [...this.entries.values()].reduce(
          (sum, entry) => sum + entry.bytes,
          0,
        ) +
          bytes >
          RUNTIME_ASSET_LIMITS.profileBytes
      ) {
        const first = this.entries.keys().next().value;
        if (!first) throw new Error('Runtime cache is full.');
        this.entries.delete(first);
      }
      this.entries.set(key, { data, bytes });
    })();
    this.pending.set(key, task);
    try {
      await task;
    } finally {
      if (this.pending.get(key) === task) this.pending.delete(key);
    }
  }
  async copy(identity: RuntimeIdentity): Promise<RuntimeAssets | undefined> {
    if (this.closed || !reviewedRuntime(identity)) return undefined;
    const key = identity.manifest_sha256;
    await this.pending.get(key)?.catch(() => undefined);
    if (this.closed) return undefined;
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    return {
      inventory: entry.data.inventory,
      assets: entry.data.assets.map((asset) => ({
        name: asset.name,
        bytes: Uint8Array.from(asset.bytes),
      })),
    };
  }
  close(): void {
    this.closed = true;
    this.entries.clear();
  }
}
