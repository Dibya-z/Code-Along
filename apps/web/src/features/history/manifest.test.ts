import { describe, expect, it } from 'vitest';
import { CORE_RUNTIME } from '@code-along/contracts/execution/profiles';
import { sha256, sourceBytes } from '@code-along/contracts/execution';
import {
  revisionArchive,
  REVISION_HELPERS,
  validateRevisionManifest,
} from './manifest.ts';

// Independently hashed by Python and Node; keep exact CRLF/scalar Unicode/JSON escaping.
const golden = {
  protocol: 'code-along.revision',
  version: 1,
  project_id: '10000000-0000-4000-8000-000000000001',
  metadata_version: 7,
  entrypoint_file_id: '10000000-0000-4000-8000-000000000002',
  runtime: CORE_RUNTIME,
  helper_release: REVISION_HELPERS,
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
  sha256: '1077932e6691b1bdba48761ea561850b54c148993917bfe705a8cd0ced437721',
};
describe('verified immutable revisions', () => {
  it('agrees with the independent golden digest and freezes exact source without normalization', async () => {
    const manifest = await validateRevisionManifest(golden);
    expect(manifest).toEqual(golden);
    expect(Object.isFrozen(manifest.files[0])).toBe(true);
    expect(revisionArchive(manifest, 'Shared lesson')).toEqual({
      version: 1,
      name: 'Shared lesson',
      runtime_id: CORE_RUNTIME.runtime_id,
      entrypoint: 'main.py',
      files: golden.files.map(({ path, source }) => ({ path, source })),
    });
    expect(JSON.stringify(revisionArchive(manifest, 'Copy'))).not.toMatch(
      /file_id|document_id|generation|project_id|share_token|role|access/,
    );
  });
  it('rejects changed bytes, Unicode normalization, unknown helpers/runtime and digest mismatch', async () => {
    for (const value of [
      { ...golden, sha256: '0'.repeat(64) },
      {
        ...golden,
        files: [{ ...golden.files[0], source: 'changed' }, golden.files[1]],
      },
      {
        ...golden,
        files: [
          golden.files[0],
          {
            ...golden.files[1],
            source: golden.files[1]!.source.normalize('NFC'),
          },
        ],
      },
      {
        ...golden,
        helper_release: { ...REVISION_HELPERS, source_sha256: '0'.repeat(64) },
      },
      { ...golden, runtime: { ...CORE_RUNTIME, python_version: 'unreviewed' } },
      { ...golden, share_token: 'forbidden' },
    ])
      await expect(validateRevisionManifest(value)).rejects.toThrow();
  });
  it('rejects duplicate identities, wrong entrypoint, unsorted/traversal paths and malformed Unicode', async () => {
    for (const value of [
      { ...golden, entrypoint_file_id: '10000000-0000-4000-8000-000000000099' },
      {
        ...golden,
        files: [
          golden.files[0],
          { ...golden.files[1], file_id: golden.files[0]!.file_id },
        ],
      },
      {
        ...golden,
        files: [
          golden.files[0],
          { ...golden.files[1], document_id: golden.files[0]!.document_id },
        ],
      },
      { ...golden, files: [...golden.files].reverse() },
      {
        ...golden,
        files: [{ ...golden.files[0], path: '../main.py' }, golden.files[1]],
      },
      ...['\u0000', '\ud800', 'x'.repeat(128 * 1024 + 1)].map((source) => ({
        ...golden,
        files: [{ ...golden.files[0], source, sha256: '0'.repeat(64) }],
      })),
    ])
      await expect(validateRevisionManifest(value)).rejects.toThrow();
  });
  it('bounds complete decoded source before manifest hashing or opening copies', async () => {
    const source = 'x'.repeat(128 * 1024),
      hash = await sha256(sourceBytes(source));
    const files = Array.from({ length: 9 }, (_, n) => ({
      file_id: `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
      document_id: `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
      generation: 1,
      path: `file${n}.py`,
      source,
      sha256: hash,
    }));
    await expect(
      validateRevisionManifest({
        ...golden,
        entrypoint_file_id: files[0]!.file_id,
        files,
      }),
    ).rejects.toThrow();
  });
});
