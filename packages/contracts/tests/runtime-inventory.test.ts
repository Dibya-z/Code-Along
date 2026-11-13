import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  CORE_RUNTIME,
  SCIENTIFIC_RUNTIME,
  RUNTIME_PROFILES,
} from '../execution/profiles.ts';
import {
  readRuntimeResponse,
  verifyRuntimeInventory,
  canonicalInventory,
} from '../execution/runtime-inventory.ts';
const root = new URL('../../../', import.meta.url);
describe('reviewed runtime inventory and bounded transport', () => {
  it('verifies both immutable inventories and exactly the pinned scientific dependency closure', async () => {
    const lock = JSON.parse(
      await readFile(
        new URL('apps/runner-web/node_modules/pyodide/pyodide-lock.json', root),
        'utf8',
      ),
    ) as {
      info: { python: string };
      packages: Record<
        string,
        { depends: string[]; file_name: string; sha256: string }
      >;
    };
    for (const profile of RUNTIME_PROFILES) {
      const path =
        profile.identity.runtime_id === CORE_RUNTIME.runtime_id
          ? 'apps/runner-web/public/runtime-manifests/'
          : 'packages/runtime-profiles/manifests/';
      const inventory = await verifyRuntimeInventory(
        JSON.parse(
          await readFile(new URL(path + profile.inventory, root), 'utf8'),
        ),
        profile.identity,
      );
      expect(inventory.version_pin).toBe(profile.identity.engine_version);
      expect(lock.info.python).toBe(profile.identity.python_version);
      const closure = new Set<string>();
      function visit(name: string) {
        if (closure.has(name)) return;
        closure.add(name);
        for (const dependency of lock.packages[name]!.depends)
          visit(dependency);
      }
      profile.packages.forEach(visit);
      expect(
        inventory.assets
          .filter((asset) => asset.name.endsWith('.whl'))
          .map((asset) => asset.name)
          .sort(),
      ).toEqual(
        [...closure].map((name) => lock.packages[name]!.file_name).sort(),
      );
      for (const name of closure)
        expect(
          inventory.assets.find(
            (asset) => asset.name === lock.packages[name]!.file_name,
          )?.sha256,
        ).toBe(lock.packages[name]!.sha256);
      expect(Object.isFrozen(inventory.assets)).toBe(true);
    }
  });
  it('rejects inventory changes, unexpected profiles and overly nested metadata before loading code', async () => {
    const source = JSON.parse(
      await readFile(
        new URL(
          'packages/runtime-profiles/manifests/pyodide-scientific.json',
          root,
        ),
        'utf8',
      ),
    );
    source.assets[0].sha256 = '0'.repeat(64);
    await expect(
      verifyRuntimeInventory(source, SCIENTIFIC_RUNTIME),
    ).rejects.toThrow('does not match');
    await expect(
      verifyRuntimeInventory(source, {
        ...SCIENTIFIC_RUNTIME,
        runtime_id: 'custom',
      }),
    ).rejects.toThrow('does not match');
    let nested: unknown = 0;
    for (let n = 0; n < 10; n++) nested = { next: nested };
    expect(() => canonicalInventory(nested)).toThrow('nesting limit');
  });
  it('retains exact binary response bytes within the declared budget', async () => {
    const bytes = await readRuntimeResponse(
      new Response(new Uint8Array([0, 255, 3])),
      3,
    );
    expect([...bytes]).toEqual([0, 255, 3]);
  });
  it('rejects a large Content-Length before reading its body', async () => {
    let cancelled = false;
    const stream = new ReadableStream({
      cancel() {
        cancelled = true;
      },
    });
    await expect(
      readRuntimeResponse(
        new Response(stream, { headers: { 'Content-Length': '4' } }),
        3,
      ),
    ).rejects.toThrow('byte budget');
    expect(cancelled).toBe(true);
  });
  it('cancels chunked overflow without trusting a missing or dishonest Content-Length', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(
      readRuntimeResponse(
        new Response(stream, { headers: { 'Content-Length': '1' } }),
        3,
      ),
    ).rejects.toThrow('byte budget');
    expect(cancelled).toBe(true);
    await expect(
      readRuntimeResponse(new Response('missing', { status: 404 }), 10),
    ).rejects.toThrow('could not be loaded');
  });
});
