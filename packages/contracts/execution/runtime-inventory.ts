import { reviewedRuntime, type RuntimeIdentity } from './profiles.ts';
import { sha256, sourceBytes } from './runner.ts';
export interface RuntimeAsset {
  readonly name: string;
  readonly bytes: number;
  readonly sha256: string;
}
export interface RuntimeInventory {
  readonly version: 1;
  readonly runtime_id: string;
  readonly package: 'pyodide';
  readonly version_pin: string;
  readonly python_version?: string;
  readonly packages?: readonly string[];
  readonly assets: readonly RuntimeAsset[];
}
export const RUNTIME_ASSET_LIMITS = Object.freeze({
  assetBytes: 32 * 1024 * 1024,
  profileBytes: 64 * 1024 * 1024,
  inventoryBytes: 64 * 1024,
  assets: 32,
});
export function canonicalInventory(value: unknown): string {
  function sort(entry: unknown, level: number): unknown {
    if (level > 8) throw new Error('Runtime inventory nesting limit exceeded.');
    if (Array.isArray(entry)) return entry.map((item) => sort(item, level + 1));
    if (entry && typeof entry === 'object')
      return Object.fromEntries(
        Object.entries(entry)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, item]) => [key, sort(item, level + 1)]),
      );
    return entry;
  }
  const encoded = JSON.stringify(sort(value, 0));
  if (typeof encoded !== 'string')
    throw new Error('Invalid runtime inventory.');
  return encoded;
}
export async function verifyRuntimeInventory(
  value: unknown,
  identity: RuntimeIdentity,
): Promise<RuntimeInventory> {
  if (
    !reviewedRuntime(identity) ||
    sourceBytes(canonicalInventory(value)).length >
      RUNTIME_ASSET_LIMITS.inventoryBytes ||
    (await sha256(sourceBytes(canonicalInventory(value)))) !==
      identity.manifest_sha256
  )
    throw new Error('Runtime inventory does not match the reviewed profile.');
  const inventory = value as RuntimeInventory;
  if (
    inventory.version !== 1 ||
    inventory.package !== 'pyodide' ||
    inventory.runtime_id !== identity.runtime_id ||
    inventory.version_pin !== identity.engine_version ||
    !Array.isArray(inventory.assets) ||
    inventory.assets.length < 1 ||
    inventory.assets.length > RUNTIME_ASSET_LIMITS.assets
  )
    throw new Error('Invalid runtime inventory.');
  const names = new Set<string>();
  let bytes = 0;
  for (const asset of inventory.assets) {
    if (
      !/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,179}$/.test(asset.name) ||
      names.has(asset.name) ||
      !Number.isSafeInteger(asset.bytes) ||
      asset.bytes < 1 ||
      asset.bytes > RUNTIME_ASSET_LIMITS.assetBytes ||
      !/^[a-f0-9]{64}$/.test(asset.sha256)
    )
      throw new Error('Invalid runtime asset.');
    names.add(asset.name);
    bytes += asset.bytes;
  }
  if (bytes > RUNTIME_ASSET_LIMITS.profileBytes)
    throw new Error('Runtime profile exceeds its asset budget.');
  return Object.freeze({
    ...inventory,
    assets: Object.freeze(
      inventory.assets.map((asset) => Object.freeze({ ...asset })),
    ),
    ...(inventory.packages
      ? { packages: Object.freeze([...inventory.packages]) }
      : {}),
  });
}
/** Bound before buffering, including chunked responses with no Content-Length. */
export async function readRuntimeResponse(
  response: Response,
  maximum: number,
): Promise<Uint8Array> {
  if (
    !Number.isSafeInteger(maximum) ||
    maximum < 1 ||
    maximum > RUNTIME_ASSET_LIMITS.assetBytes
  )
    throw new Error('Invalid runtime response byte budget.');
  if (!response.ok || !response.body)
    throw new Error('A reviewed runtime asset could not be loaded.');
  const declared = response.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
    await response.body.cancel();
    throw new Error('Runtime asset exceeds its byte budget.');
  }
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.length;
      if (length > maximum) {
        await reader.cancel();
        throw new Error('Runtime asset exceeds its byte budget.');
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
