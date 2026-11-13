/** Trusted build tooling only. Learner code never runs in this Node process. */
import {
  readFile,
  writeFile,
  mkdir,
  rename,
  lstat,
  rm,
} from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  CORE_RUNTIME,
  RUNTIME_PROFILES,
} from '../../packages/contracts/execution/profiles.ts';
import { sha256 } from '../../packages/contracts/execution/runner.ts';
import {
  verifyRuntimeInventory,
  readRuntimeResponse,
  RUNTIME_ASSET_LIMITS,
  type RuntimeAsset,
} from '../../packages/contracts/execution/runtime-inventory.ts';
const coreNames = new Set([
  'pyodide.mjs',
  'pyodide.asm.mjs',
  'pyodide.asm.wasm',
  'python_stdlib.zip',
  'pyodide-lock.json',
]);
export async function verifyAssetBytes(
  asset: RuntimeAsset,
  bytes: Uint8Array,
): Promise<void> {
  if (
    bytes.length !== asset.bytes ||
    bytes.length > RUNTIME_ASSET_LIMITS.assetBytes ||
    (await sha256(bytes)) !== asset.sha256
  )
    throw new Error(`Runtime asset integrity check failed: ${asset.name}`);
}
async function verifiedFile(path: string, asset: RuntimeAsset) {
  const status = await lstat(path);
  if (
    !status.isFile() ||
    status.size !== asset.bytes ||
    status.size > RUNTIME_ASSET_LIMITS.assetBytes
  )
    throw new Error(`Invalid cached runtime asset: ${asset.name}`);
  const bytes = await readFile(path);
  await verifyAssetBytes(asset, bytes);
  return bytes;
}
export async function downloadReviewedWheel(
  asset: RuntimeAsset,
  request: typeof fetch = fetch,
): Promise<Uint8Array> {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,175}\.whl$/.test(asset.name) ||
    !Number.isSafeInteger(asset.bytes) ||
    asset.bytes < 1 ||
    asset.bytes > RUNTIME_ASSET_LIMITS.assetBytes ||
    !/^[a-f0-9]{64}$/.test(asset.sha256)
  )
    throw new Error('Invalid reviewed wheel request.');
  const url = `https://cdn.jsdelivr.net/pyodide/v${CORE_RUNTIME.engine_version}/full/${encodeURIComponent(asset.name)}`;
  let response: Response | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      response = await request(url, {
        credentials: 'omit',
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error('Pinned runtime download failed.');
      }
      break;
    } catch (error) {
      if (attempt === 2) throw error;
      await delay(100 * (attempt + 1));
    }
  }
  if (!response) throw new Error('Pinned runtime download failed.');
  const bytes = await readRuntimeResponse(response, asset.bytes);
  await verifyAssetBytes(asset, bytes);
  return bytes;
}
async function wheelBytes(
  cache: string,
  asset: RuntimeAsset,
): Promise<Uint8Array> {
  const file = join(cache, asset.name);
  try {
    return await verifiedFile(file, asset);
  } catch (error) {
    if (
      !error ||
      typeof error !== 'object' ||
      !('code' in error) ||
      error.code !== 'ENOENT'
    )
      throw error;
  }
  const bytes = await downloadReviewedWheel(asset);
  const temporary = `${file}.${randomUUID()}.partial`;
  try {
    await writeFile(temporary, bytes, { flag: 'wx' });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
  return bytes;
}
export async function copyRuntimeAssets(
  root = fileURLToPath(new URL('../../', import.meta.url)),
): Promise<void> {
  const destination = resolve(root, 'apps/runner-web/dist');
  const cache = resolve(root, '.runtime/runtime-assets');
  await mkdir(cache, { recursive: true });
  await mkdir(join(destination, 'runtime-manifests'), { recursive: true });
  for (const profile of RUNTIME_PROFILES) {
    const source =
      profile.identity.runtime_id === CORE_RUNTIME.runtime_id
        ? join(
            root,
            'apps/runner-web/public/runtime-manifests',
            profile.inventory,
          )
        : join(root, 'packages/runtime-profiles/manifests', profile.inventory);
    const encoded = await readFile(source);
    if (encoded.length > RUNTIME_ASSET_LIMITS.inventoryBytes)
      throw new Error('Runtime inventory exceeds its byte budget.');
    const inventory = await verifyRuntimeInventory(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(encoded)),
      profile.identity,
    );
    const target = join(
      destination,
      'runtime/v2',
      profile.identity.manifest_sha256,
    );
    await mkdir(target, { recursive: true });
    for (const asset of inventory.assets) {
      const bytes = coreNames.has(asset.name)
        ? await verifiedFile(
            join(root, 'apps/runner-web/node_modules/pyodide', asset.name),
            asset,
          )
        : await wheelBytes(cache, asset);
      await writeFile(join(target, asset.name), bytes);
      if (profile.identity.runtime_id === CORE_RUNTIME.runtime_id) {
        await mkdir(join(destination, 'runtime'), { recursive: true });
        await writeFile(join(destination, 'runtime', asset.name), bytes);
      }
    }
    await writeFile(
      join(destination, 'runtime-manifests', profile.inventory),
      encoded,
    );
    process.stdout.write(
      `Verified runtime profile: ${profile.name} (${inventory.assets.length} assets)\n`,
    );
  }
}
