import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { RUN_LIMITS, sha256, sourceBytes } from '../execution/runner.ts';
import { CORE_RUNTIME } from '../execution/profiles.ts';
import {
  captureProjectManifest,
  isProjectRunManifest,
  verifyProjectManifest,
  validatePythonPaths,
  type ProjectSnapshot,
} from '../execution/project-manifest.ts';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function snapshot() {
  return {
    project_id: id(99),
    source_kind: 'project' as const,
    metadata_version: 1,
    entrypoint_file_id: id(1),
    runtime: { ...CORE_RUNTIME },
    stdin_mode: 'batch' as const,
    files: [
      {
        file_id: id(1),
        document_id: id(101),
        generation: 1,
        path: 'main.py',
        source: 'from helper import answer\r\nprint("雪🙂", answer)\r\n',
      },
      {
        file_id: id(2),
        document_id: id(102),
        generation: 1,
        path: 'helper.py',
        source: 'answer = 42\n',
      },
    ],
  } satisfies ProjectSnapshot;
}
describe('product run manifest v2', () => {
  it('copies the whole project synchronously, then freezes exact source and runtime provenance', async () => {
    const input = snapshot();
    const expected = input.files[0]!.source;
    const pending = captureProjectManifest(input);
    input.files[0]!.source = 'print("later")';
    input.files[1]!.generation = 3;
    input.runtime.python_version = 'later';
    input.metadata_version = 100;
    input.files.pop();
    const manifest = await pending;
    expect(manifest.files).toHaveLength(2);
    expect(manifest.files.find((file) => file.path === 'main.py')?.source).toBe(
      expected,
    );
    expect(manifest.files.find((file) => file.path === 'main.py')?.sha256).toBe(
      await sha256(sourceBytes(expected)),
    );
    expect(manifest.metadata_version).toBe(1);
    expect(manifest.runtime).toEqual(CORE_RUNTIME);
    expect(
      [manifest, manifest.files, manifest.files[0], manifest.runtime].every(
        Object.isFrozen,
      ),
    ).toBe(true);
    expect(await verifyProjectManifest(manifest)).toBe(true);
  });
  it('has one canonical hash regardless of source-list or object-key ordering', async () => {
    const a = snapshot(),
      b = snapshot();
    b.files.reverse();
    expect((await captureProjectManifest(a)).sha256).toBe(
      (await captureProjectManifest(b)).sha256,
    );
    const manifest = await captureProjectManifest(a);
    expect(manifest.files.map((file) => file.path)).toEqual([
      'helper.py',
      'main.py',
    ]);
    expect(
      await verifyProjectManifest({
        ...manifest,
        files: [...manifest.files].reverse(),
      }),
    ).toBe(false);
  });
  it('hashes file identity, generation, metadata, entrypoint, provenance and stdin mode', async () => {
    const base = await captureProjectManifest(snapshot());
    const mutations: ((input: ProjectSnapshot) => ProjectSnapshot)[] = [
      (input) => ({ ...input, project_id: id(98) }),
      (input) => ({ ...input, metadata_version: 2 }),
      (input) => ({ ...input, source_kind: 'local_draft' }),
      (input) => ({ ...input, stdin_mode: 'interactive' }),
      (input) => ({ ...input, entrypoint_file_id: id(2) }),
      (input) => ({
        ...input,
        files: input.files.map((file) => ({ ...file, generation: 2 })),
      }),
      (input) => ({
        ...input,
        files: input.files.map((file) => ({
          ...file,
          document_id: id(file.file_id === id(1) ? 201 : 202),
        })),
      }),
      (input) => ({
        ...input,
        files: input.files.map((file) => ({
          ...file,
          source: file.source.replaceAll('\r\n', '\n'),
        })),
      }),
    ];
    for (const mutate of mutations)
      expect(
        (await captureProjectManifest(mutate(snapshot()))).sha256,
      ).not.toBe(base.sha256);
  });
  it.each([
    ['../main.py'],
    ['/main.py'],
    ['a//main.py'],
    ['a-b.py'],
    ['a/2bad.py'],
    ['main.py', 'MAIN.py'],
    ['helpers.py', 'helpers/main.py'],
    ['main.py', 'main.py'],
    ['x'.repeat(158) + '.py'],
  ])('rejects unsafe or ambiguous Python paths %j', (...paths: string[]) => {
    expect(() => validatePythonPaths(paths)).toThrow();
  });
  it('allows package initializers without module/folder collisions', () => {
    expect(() =>
      validatePythonPaths(['lessons/__init__.py', 'lessons/main.py']),
    ).not.toThrow();
  });
  it.each(['\0', '\ud800', '雪'.repeat(RUN_LIMITS.fileBytes / 2)])(
    'rejects invalid encoding/NUL and UTF-8 byte overflow',
    async (source) => {
      const input = snapshot();
      input.files[0]!.source = source;
      await expect(captureProjectManifest(input)).rejects.toThrow(
        'invalid or oversized',
      );
    },
  );
  it('rejects incomplete entrypoints, duplicate identities and aggregate overflow', async () => {
    const input = snapshot();
    await expect(
      captureProjectManifest({ ...input, files: [] }),
    ).rejects.toThrow();
    await expect(
      captureProjectManifest({ ...input, entrypoint_file_id: id(9) }),
    ).rejects.toThrow();
    await expect(
      captureProjectManifest({
        ...input,
        files: input.files.map((file) => ({ ...file, document_id: id(1) })),
      }),
    ).rejects.toThrow();
    await expect(
      captureProjectManifest({
        ...input,
        files: Array.from({ length: 9 }, (_, n) => ({
          ...input.files[0]!,
          file_id: id(n + 1),
          document_id: id(n + 101),
          path: `file${n}.py`,
          source: 'x'.repeat(RUN_LIMITS.fileBytes),
        })),
      }),
    ).rejects.toThrow();
  });
  it('rejects extra fields, coerced enums, unknown runtimes and hash/source tampering', async () => {
    const manifest = await captureProjectManifest(snapshot());
    for (const value of [
      { ...manifest, api_command: 'fetch' },
      { ...manifest, stdin_mode: ['batch'] },
      { ...manifest, source_kind: ['project'] },
      {
        ...manifest,
        runtime: { ...manifest.runtime, manifest_sha256: '0'.repeat(64) },
      },
      {
        ...manifest,
        files: manifest.files.map((file) => ({ ...file, ignored: true })),
      },
    ])
      expect(isProjectRunManifest(value)).toBe(false);
    expect(
      await verifyProjectManifest({ ...manifest, sha256: '0'.repeat(64) }),
    ).toBe(false);
    expect(
      await verifyProjectManifest({
        ...manifest,
        files: manifest.files.map((file) => ({ ...file, source: 'pass' })),
      }),
    ).toBe(false);
  });
  it('pins the reviewed runtime inventory digest and actual Python version', async () => {
    const inventory = JSON.parse(
      await readFile(
        new URL(
          '../../../apps/runner-web/public/runtime-manifests/pyodide-core.json',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    const sorted = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(sorted)
        : value && typeof value === 'object'
          ? Object.fromEntries(
              Object.entries(value)
                .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
                .map(([key, entry]) => [key, sorted(entry)]),
            )
          : value;
    expect(await sha256(sourceBytes(JSON.stringify(sorted(inventory))))).toBe(
      CORE_RUNTIME.manifest_sha256,
    );
    const lock = JSON.parse(
      await readFile(
        new URL(
          '../../../apps/runner-web/node_modules/pyodide/pyodide-lock.json',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    expect(lock.info.python).toBe(CORE_RUNTIME.python_version);
    expect(inventory.version_pin).toBe(CORE_RUNTIME.engine_version);
  });
});
