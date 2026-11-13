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
interface LockPackage {
  readonly file_name: string;
}
interface LockFile {
  readonly info: Record<string, unknown>;
  readonly packages: Record<string, LockPackage>;
}
async function runtimeBytes(url: string, limit: number, label: string) {
  try {
    return await readRuntimeResponse(
      await fetch(url, { credentials: 'omit', cache: 'force-cache' }),
      limit,
    );
  } catch {
    throw new Error(
      `Python runtime could not load ${label}. Check the runtime connection and try again.`,
    );
  }
}
export async function prepareRuntime(identity: RuntimeIdentity) {
  const profile = runtimeProfile(identity.runtime_id);
  if (!profile) throw new Error('This Python runtime profile is not reviewed.');
  const raw = await runtimeBytes(
    `/runtime-manifests/${profile.inventory}?sha256=${identity.manifest_sha256}`,
    RUNTIME_ASSET_LIMITS.inventoryBytes,
    'its reviewed inventory',
  );
  const inventory = await verifyRuntimeInventory(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)),
    identity,
  );
  const base = new URL(
    `/runtime/v2/${identity.manifest_sha256}/`,
    location.origin,
  ).href;
  let lock: LockFile | undefined;
  // Verify executable/stdlib/lock bytes before boot. loadPackage also checks wheel integrity.
  for (const asset of inventory.assets) {
    if (asset.name.endsWith('.whl')) continue;
    const bytes = await runtimeBytes(
      base + asset.name,
      asset.bytes,
      asset.name,
    );
    if (bytes.length !== asset.bytes || (await sha256(bytes)) !== asset.sha256)
      throw new Error('A Python runtime asset failed integrity verification.');
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
  return { base, packages: [...profile.packages], lock: { ...lock, packages } };
}
