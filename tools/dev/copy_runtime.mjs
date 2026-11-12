import { readFile, mkdir, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const root = new URL('../../', import.meta.url);
const inventory = JSON.parse(
  await readFile(
    new URL('apps/runner-web/public/runtime-manifests/pyodide-core.json', root),
    'utf8',
  ),
);
const destination = new URL('apps/runner-web/dist/runtime/', root);
await mkdir(destination, { recursive: true });
for (const asset of inventory.assets) {
  const input = new URL(
    `apps/runner-web/node_modules/pyodide/${asset.name}`,
    root,
  );
  const bytes = await readFile(input);
  if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256)
    throw new Error('runtime_integrity_failure');
  await copyFile(input, new URL(asset.name, destination));
}
import { URL } from 'node:url';
