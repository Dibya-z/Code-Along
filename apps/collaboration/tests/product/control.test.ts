import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Hocuspocus, Document } from '@hocuspocus/server';
import { CORE_RUNTIME } from '@code-along/contracts/execution/profiles';
import {
  captureRevision,
  HELPER_RELEASE,
  parseCapture,
} from '../../src/product/control.ts';
import { LIMITS } from '../../src/product/limits.ts';
import { stateHash } from '../../src/persistence/binary-state.ts';
import type { ProductContext } from '../../src/product/product-server.ts';
import { documentId, grant, MemoryStore } from './fixtures.ts';
function input() {
  const g = grant();
  return {
    version: 1,
    capture_id: randomUUID(),
    project_id: g.project_id,
    metadata_version: 1,
    entrypoint_file_id: g.document.file_id,
    runtime: CORE_RUNTIME,
    helper_release: HELPER_RELEASE,
    files: [
      {
        file_id: g.document.file_id,
        document_id: documentId,
        generation: 1,
        path: 'main.py',
        initial_source: g.document.initial_source,
        initial_sha256: g.document.initial_sha256,
      },
    ],
  };
}
describe('private revision capture', () => {
  it('pins the actual bundled helper release bytes', () => {
    expect(
      stateHash(
        readFileSync(
          new URL('../../../runner-web/src/code_along.py', import.meta.url),
        ),
      ),
    ).toBe(HELPER_RELEASE.source_sha256);
  });
  it('captures live empty/deleted source rather than reseeding immutable starter text', async () => {
    const request = input(),
      hocuspocus = new Hocuspocus<ProductContext>({ quiet: true }),
      store = new MemoryStore(),
      room = new Document(`${documentId}:1`);
    hocuspocus.documents.set(room.name, room);
    try {
      const result = await captureRevision(request, {
        store,
        hocuspocus,
        invalidate: () => undefined,
      });
      expect(result.manifest.files[0]?.source).toBe('');
      expect(store.states.size).toBe(0);
      expect(result.manifest.helper_release).toEqual(HELPER_RELEASE);
    } finally {
      room.destroy();
    }
  });
  it('loads cold binaries, sorts a complete capture and binds helper identity in its hash', async () => {
    const request = input(),
      hocuspocus = new Hocuspocus<ProductContext>({ quiet: true }),
      store = new MemoryStore();
    const result = await captureRevision(request, {
      store,
      hocuspocus,
      invalidate: () => undefined,
    });
    expect(result.manifest.files[0]?.source).toBe(
      request.files[0]!.initial_source,
    );
    expect(result.manifest.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(() =>
      parseCapture({
        ...request,
        helper_release: { ...HELPER_RELEASE, source_sha256: '0'.repeat(64) },
      }),
    ).toThrow();
  });
});

it('accepts the full decoded source budget even when JSON escaping expands sixfold', () => {
  const request = input();
  const source = '\u0001'.repeat(128 * 1024);
  request.files = Array.from({ length: 8 }, (_, i) => ({
    file_id: i === 0 ? request.entrypoint_file_id : randomUUID(),
    document_id: randomUUID(),
    generation: 1,
    path: `file_${i}.py`,
    initial_source: source,
    initial_sha256: stateHash(Buffer.from(source)),
  }));
  const wire = JSON.stringify(request);
  expect(Buffer.byteLength(wire)).toBeGreaterThan(6 * 1024 * 1024);
  expect(Buffer.byteLength(wire)).toBeLessThan(LIMITS.controlBytes);
  expect(parseCapture(JSON.parse(wire)).files).toHaveLength(8);
});
