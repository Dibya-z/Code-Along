import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as Y from 'yjs';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Hocuspocus, Document } from '@hocuspocus/server';
import { CORE_RUNTIME } from '@code-along/contracts/execution/profiles';
import {
  captureRevision,
  HELPER_RELEASE,
  parseCapture,
  revisionHash,
  handleControl,
} from '../../src/product/control.ts';
import { LIMITS } from '../../src/product/limits.ts';
import {
  CheckpointStoreError,
  stateHash,
} from '../../src/persistence/binary-state.ts';
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

// Shared cross-language vector: backend revision_contract.py and browser history
// validation use these exact bytes/digests. Expected values were independently
// calculated with Python hashlib and ensure_ascii=False compact JSON.
const GOLDEN_REVISION = {
  protocol: 'code-along.revision' as const,
  version: 1 as const,
  project_id: '10000000-0000-4000-8000-000000000001',
  metadata_version: 7,
  entrypoint_file_id: '10000000-0000-4000-8000-000000000002',
  runtime: CORE_RUNTIME,
  helper_release: HELPER_RELEASE,
  files: [
    {
      file_id: '10000000-0000-4000-8000-000000000002',
      document_id: '10000000-0000-4000-8000-000000000003',
      generation: 1,
      path: 'main.py',
      source:
        'print("π 🐍")\r\n# quote=" slash=\\ tab=\t ctrl=\u0001 sep=\u2028\u2029\n',
      sha256:
        'f4a2dc099c1c32042362d3005144f19606c6e684ebffc4da37f6c3e2a0090304',
    },
    {
      file_id: '10000000-0000-4000-8000-000000000004',
      document_id: '10000000-0000-4000-8000-000000000005',
      generation: 7,
      path: 'pkg/helper.py',
      source: '# café e\u0301\nvalue = "\\\\path"\n',
      sha256:
        'fdcf236aeb9c492234a330cb6cafb636818f17603d377b62b76f0df549ac1a12',
    },
  ],
};
it('matches the independently calculated Python revision digest for exact Unicode, CRLF, controls and escapes', () => {
  for (const file of GOLDEN_REVISION.files)
    expect(stateHash(Buffer.from(file.source, 'utf8'))).toBe(file.sha256);
  expect(revisionHash(GOLDEN_REVISION)).toBe(
    '1077932e6691b1bdba48761ea561850b54c148993917bfe705a8cd0ced437721',
  );
  expect(revisionHash({ ...GOLDEN_REVISION, metadata_version: 8 })).not.toBe(
    revisionHash(GOLDEN_REVISION),
  );
  expect(
    revisionHash({
      ...GOLDEN_REVISION,
      files: GOLDEN_REVISION.files.map((file) => ({
        ...file,
        source: file.source.normalize('NFC'),
      })),
    }),
  ).not.toBe(revisionHash(GOLDEN_REVISION));
});
it('captures complete cold binary histories without plaintext reseeding and passes every metadata binding to storage', async () => {
  const request = input(),
    hocuspocus = new Hocuspocus<ProductContext>({ quiet: true }),
    store = new MemoryStore();
  request.files = [
    ...request.files.map((file) => ({ ...file, path: 'z_last.py' })),
    {
      file_id: randomUUID(),
      document_id: randomUUID(),
      generation: 3,
      path: 'a_first.py',
      initial_source: 'original immutable starter',
      initial_sha256: stateHash(Buffer.from('original immutable starter')),
    },
  ];
  const docs: Y.Doc[] = [];
  for (const [index, file] of request.files.entries()) {
    const doc = new Y.Doc();
    docs.push(doc);
    doc
      .getText('source')
      .insert(0, index === 0 ? 'deleted durable history' : 'latest π\r\n');
    await store.initialize(
      { document_id: file.document_id, generation: file.generation },
      Y.encodeStateAsUpdate(doc),
    );
    if (index === 0) {
      doc.getText('source').delete(0, doc.getText('source').length);
      await store.saveState(
        { document_id: file.document_id, generation: file.generation },
        Y.encodeStateAsUpdate(doc),
      );
    }
  }
  const initialize = vi.spyOn(store, 'initialize'),
    release = vi.fn(),
    verify = vi.fn();
  const pinRooms = vi.fn(() => ({ release, verify }));
  try {
    const result = await captureRevision(request, {
      store,
      hocuspocus,
      invalidate: () => undefined,
      pinRooms,
    });
    expect(
      result.manifest.files.map((file) => [file.path, file.source]),
    ).toEqual([
      ['a_first.py', 'latest π\r\n'],
      ['z_last.py', ''],
    ]);
    expect(
      result.manifest.files.every(
        (file) => file.sha256 === stateHash(Buffer.from(file.source)),
      ),
    ).toBe(true);
    expect(result.manifest.runtime).toEqual(CORE_RUNTIME);
    expect(result.manifest.helper_release).toEqual(HELPER_RELEASE);
    for (const file of request.files)
      expect(initialize).toHaveBeenCalledWith(
        {
          document_id: file.document_id,
          generation: file.generation,
          project_id: request.project_id,
          file_id: file.file_id,
          initial_sha256: file.initial_sha256,
        },
        expect.any(Uint8Array),
      );
    expect(pinRooms).toHaveBeenCalledWith(
      request.files.map((file) => `${file.document_id}:${file.generation}`),
    );
    expect(pinRooms.mock.invocationCallOrder[0]).toBeLessThan(
      initialize.mock.invocationCallOrder[0]!,
    );
    expect(verify).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledOnce();
  } finally {
    for (const doc of docs) doc.destroy();
  }
});
it('copies all participating live source in one synchronous turn', async () => {
  const request = input(),
    hocuspocus = new Hocuspocus<ProductContext>({ quiet: true }),
    store = new MemoryStore();
  const second = {
    file_id: randomUUID(),
    document_id: randomUUID(),
    generation: 1,
    path: 'other.py',
    initial_source: 'immutable second',
    initial_sha256: stateHash(Buffer.from('immutable second')),
  };
  request.files.push(second);
  const a = new Document(`${request.files[0]!.document_id}:1`),
    b = new Document(`${second.document_id}:1`);
  a.getText('source').insert(0, 'first at capture');
  b.getText('source').insert(0, 'second at capture');
  hocuspocus.documents.set(a.name, a);
  hocuspocus.documents.set(b.name, b);
  const first = a.getText('source').toString();
  const text = a.getText('source'),
    original = text.toString.bind(text);
  text.toString = () => {
    text.toString = original;
    queueMicrotask(() => b.getText('source').insert(0, 'later '));
    return first;
  };
  try {
    const result = await captureRevision(request, {
      store,
      hocuspocus,
      invalidate: () => undefined,
    });
    expect(result.manifest.files.map((file) => file.source)).toEqual([
      'first at capture',
      'second at capture',
    ]);
    expect(b.getText('source').toString()).toBe('later second at capture');
    expect(store.states.size).toBe(0);
  } finally {
    a.destroy();
    b.destroy();
  }
});
it('releases every pin and returns no captured source when a later cold metadata check fails', async () => {
  const request = input(),
    hocuspocus = new Hocuspocus<ProductContext>({ quiet: true }),
    room = new Document(`${documentId}:1`);
  room.getText('source').insert(0, 'PRIVATE_CAPTURE_SHOULD_NOT_LEAVE_FAILURE');
  hocuspocus.documents.set(room.name, room);
  request.files.push({
    file_id: randomUUID(),
    document_id: randomUUID(),
    generation: 1,
    path: 'changed.py',
    initial_source: 'starter',
    initial_sha256: stateHash(Buffer.from('starter')),
  });
  const release = vi.fn(),
    initialize = vi.fn(async () => {
      throw new CheckpointStoreError('generation_mismatch');
    });
  const req = Readable.from([
    Buffer.from(JSON.stringify(request)),
  ]) as unknown as IncomingMessage;
  req.url = '/internal/v1/captures/';
  req.headers = { 'content-type': 'application/json' };
  const writeHead = vi.fn(),
    end = vi.fn(),
    response = { writeHead, end } as unknown as ServerResponse;
  try {
    await handleControl(req, response, {
      store: { initialize },
      hocuspocus,
      invalidate: () => undefined,
      pinRooms: () => ({ release, verify: () => undefined }),
    });
    expect(release).toHaveBeenCalledOnce();
    expect(writeHead).toHaveBeenCalledWith(503, {
      'Content-Type': 'application/json',
    });
    expect(end).toHaveBeenCalledWith('{"version":1,"error":"unavailable"}');
    expect(end.mock.calls.flat().join('')).not.toContain('PRIVATE_CAPTURE');
  } finally {
    room.destroy();
  }
});
it('rejects invalid capture metadata and complete-file descriptors before accessing storage', async () => {
  const valid = input();
  for (const request of [
    { ...valid, runtime: { ...valid.runtime, engine_version: 'unreviewed' } },
    {
      ...valid,
      helper_release: { ...HELPER_RELEASE, source_sha256: '0'.repeat(64) },
    },
    { ...valid, entrypoint_file_id: randomUUID() },
    { ...valid, files: [...valid.files, ...valid.files] },
    {
      ...valid,
      files: valid.files.map((file) => ({
        ...file,
        initial_sha256: '0'.repeat(64),
      })),
    },
    {
      ...valid,
      files: valid.files.map((file) => ({
        ...file,
        initial_source: 'unsafe\0',
        initial_sha256: stateHash(Buffer.from('unsafe\0')),
      })),
    },
    { ...valid, metadata_version: 0 },
  ])
    expect(() => parseCapture(request)).toThrow();
});
