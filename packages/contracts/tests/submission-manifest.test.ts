import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  captureProjectManifest,
  isProjectRunManifest,
  verifyProjectManifest,
  type ProjectRunManifest,
} from '../execution/project-manifest.ts';
import { REVIEWED_HELPER_RELEASE } from '../execution/helper-release.ts';
import { sha256, sourceBytes } from '../execution/runner.ts';

interface Recipe {
  prefix: string;
  unit: string;
  repeat: number;
  suffix: string;
}
interface Golden {
  name: string;
  wire_valid: boolean;
  submission_valid: boolean;
  manifest: ProjectRunManifest;
  source_bytes: number;
  source_recipes?: Record<string, Recipe>;
  raw_manifest_json?: string;
  canonical_json?: string;
  artifact_manifest_sha256?: string;
}
interface Rejection {
  name: string;
  path: (string | number)[];
  value?: unknown;
  value_json?: string;
  wire_valid: false;
  submission_valid: false;
}
const corpus = JSON.parse(
  await readFile(
    new URL('../fixtures/submission-manifests.json', import.meta.url),
    'utf8',
  ),
) as {
  protocol: string;
  version: number;
  cases: Golden[];
  rejections: Rejection[];
};
function vector(name: string): Golden {
  return corpus.cases.find((item) => item.name === name)!;
}
function materialize(item: Golden): ProjectRunManifest {
  if (item.raw_manifest_json) return JSON.parse(item.raw_manifest_json);
  return {
    ...structuredClone(item.manifest),
    files: item.manifest.files.map((file) => {
      const recipe = item.source_recipes?.[file.path];
      return {
        ...file,
        source: recipe
          ? recipe.prefix + recipe.unit.repeat(recipe.repeat) + recipe.suffix
          : file.source,
      };
    }),
  };
}

/** Independent test-only encoding of the documented revision-v1 array.
 * Its static expectations came from the existing Python revision encoder,
 * while production Python submission mapping delegates that existing codec.
 */
async function artifactHash(manifest: ProjectRunManifest): Promise<string> {
  const runtime = manifest.runtime;
  return sha256(
    sourceBytes(
      JSON.stringify([
        'code-along.revision',
        1,
        manifest.project_id,
        manifest.metadata_version,
        manifest.entrypoint_file_id,
        runtime.runtime_id,
        runtime.manifest_sha256,
        runtime.engine,
        runtime.engine_version,
        runtime.python_version,
        REVIEWED_HELPER_RELEASE.release_id,
        REVIEWED_HELPER_RELEASE.source_sha256,
        manifest.files.map((file) => [
          file.file_id,
          file.document_id,
          file.generation,
          file.path,
          file.sha256,
          file.source,
        ]),
      ]),
    ),
  );
}

async function rehashAdversarial(
  input: ProjectRunManifest,
): Promise<ProjectRunManifest> {
  // Match the static canonical-byte example's order. This helper constructs
  // self-consistent attacks; it does not validate or become production code.
  const template = JSON.parse(vector('empty').canonical_json!) as Record<
    string,
    unknown
  >;
  const files = await Promise.all(
    input.files.map(async (file) => ({
      ...file,
      sha256: await sha256(new TextEncoder().encode(file.source)),
    })),
  );
  const data = { ...input, files };
  const canonical = Object.fromEntries(
    Object.keys(template).map((key) => {
      const value = data[key as keyof ProjectRunManifest];
      return [
        key,
        key === 'runtime'
          ? Object.fromEntries(
              Object.keys(template['runtime'] as object).map((field) => [
                field,
                data.runtime[field as keyof typeof data.runtime],
              ]),
            )
          : key === 'files'
            ? files.map((file) =>
                Object.fromEntries(
                  Object.keys((template['files'] as object[])[0]!).map(
                    (field) => [field, file[field as keyof typeof file]],
                  ),
                ),
              )
            : value,
      ];
    }),
  );
  return {
    ...data,
    sha256: await sha256(new TextEncoder().encode(JSON.stringify(canonical))),
  };
}

describe('shared Python/submission and existing TypeScript manifest goldens', () => {
  it.each(corpus.cases)(
    '$name preserves actual wire-v2 bytes and identities',
    async (item) => {
      const manifest = materialize(item);
      expect(isProjectRunManifest(manifest)).toBe(item.wire_valid);
      expect(await verifyProjectManifest(manifest)).toBe(item.wire_valid);
      const captured = await captureProjectManifest(manifest);
      expect(captured.sha256).toBe(item.manifest.sha256);
      expect(captured.files).toEqual(manifest.files);
      expect(
        manifest.files.reduce(
          (total, file) => total + sourceBytes(file.source).length,
          0,
        ),
      ).toBe(item.source_bytes);
      if (item.submission_valid) {
        expect(await artifactHash(manifest)).toBe(
          item.artifact_manifest_sha256,
        );
        expect(item.artifact_manifest_sha256).not.toBe(manifest.sha256);
      } else if (item.name === 'wire-local-draft-not-submission') {
        expect(manifest.source_kind).toBe('local_draft');
      } else {
        expect(item.name).toBe('wire-generation-above-db-not-submission');
        expect(manifest.files[0]!.generation).toBe(2147483648);
      }
      if (item.canonical_json)
        expect(await sha256(sourceBytes(item.canonical_json))).toBe(
          manifest.sha256,
        );
    },
  );

  it.each(corpus.rejections)(
    '$name is rejected by the unchanged wire verifier',
    async (item) => {
      const manifest = materialize(vector('empty'));
      let target = manifest as unknown as Record<string, unknown>;
      for (const part of item.path.slice(0, -1))
        target = target[String(part)] as Record<string, unknown>;
      target[String(item.path.at(-1))] = item.value_json
        ? JSON.parse(item.value_json)
        : structuredClone(item.value);
      expect(await verifyProjectManifest(manifest)).toBe(item.wire_valid);
    },
  );

  it('keeps integral JSON lexemes and both hash families compatible without changing the wire codec', async () => {
    const numeric = vector('integral-number-json-lexemes');
    expect(numeric.raw_manifest_json).toContain('"version":2.0');
    expect(numeric.raw_manifest_json).toContain('"metadata_version":1e3');
    expect(numeric.raw_manifest_json).toContain('"generation":1.0');
    expect(await verifyProjectManifest(materialize(numeric))).toBe(true);
    const batch = materialize(vector('empty'));
    const interactive = materialize(vector('empty-interactive'));
    expect(batch.sha256).not.toBe(interactive.sha256);
    expect(await artifactHash(batch)).toBe(await artifactHash(interactive));
    expect(vector('precomposed').manifest.sha256).not.toBe(
      vector('combining').manifest.sha256,
    );
  });

  it.each([NaN, Infinity, -Infinity])(
    'rejects nonfinite JavaScript numbers %s',
    async (number) => {
      const base = materialize(vector('empty'));
      for (const value of [
        { ...base, version: number },
        { ...base, metadata_version: number },
        {
          ...base,
          files: base.files.map((file) => ({ ...file, generation: number })),
        },
      ])
        expect(await verifyProjectManifest(value)).toBe(false);
    },
  );

  it('enforces UTF-8 file/aggregate limits even for self-consistent source hashes', async () => {
    for (const name of ['utf8-file-exact-limit', 'bom-file-exact-limit']) {
      const base = materialize(vector(name));
      const value = await rehashAdversarial({
        ...base,
        files: base.files.map((file) => ({
          ...file,
          source: file.source + 'x',
        })),
      });
      expect(await verifyProjectManifest(value)).toBe(false);
    }
    const aggregate = materialize(vector('aggregate-exact-limit'));
    const extra = {
      ...aggregate.files[0]!,
      file_id: '00000000-0000-4000-8000-000000000009',
      document_id: '00000000-0000-4000-8000-000000000109',
      path: 'm08.py',
      source: 'x',
    };
    expect(
      await verifyProjectManifest(
        await rehashAdversarial({
          ...aggregate,
          files: [...aggregate.files, extra],
        }),
      ),
    ).toBe(false);
  });

  it('rejects twenty-one files and a self-consistent reversed file array', async () => {
    const base = materialize(vector('twenty-source-files'));
    const extra = {
      ...base.files[0]!,
      file_id: '00000000-0000-4000-8000-000000000021',
      document_id: '00000000-0000-4000-8000-000000000121',
      path: 'm20.py',
      source: '',
    };
    for (const files of [[...base.files, extra], [...base.files].reverse()])
      expect(
        await verifyProjectManifest(
          await rehashAdversarial({ ...base, files }),
        ),
      ).toBe(false);
  });
});
