import {
  isRunnerId,
  RUN_LIMITS,
  sha256,
  sourceBytes,
} from '@code-along/contracts/execution';
import { validatePythonPaths } from '@code-along/contracts/execution/project';
import {
  reviewedRuntime,
  type RuntimeIdentity,
} from '@code-along/contracts/execution/profiles';
import type { SourceArchive } from '../project-tools/archive.ts';
import type { components } from '@code-along/api-client';

export const REVISION_HELPERS = Object.freeze({
  release_id: 'code-along-python-helpers-v1',
  source_sha256:
    '4b1ccdc64d339bad3c96154b465214f94e414b8b230cd50e59a478ca7fce51b1',
} satisfies components['schemas']['RevisionHelper']);
type PublicManifest = components['schemas']['RevisionManifest'];
export type RevisionManifest = Readonly<
  Omit<PublicManifest, 'version' | 'runtime' | 'helper_release' | 'files'>
> & {
  readonly version: 1;
  readonly runtime: RuntimeIdentity & PublicManifest['runtime'];
  readonly helper_release: typeof REVISION_HELPERS &
    PublicManifest['helper_release'];
  readonly files: readonly Readonly<PublicManifest['files'][number]>[];
};
const digest = /^[0-9a-f]{64}$/;
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, fields: readonly string[]) {
  return (
    Object.keys(value).length === fields.length &&
    Object.keys(value).every((key) => fields.includes(key))
  );
}
function invalid(): never {
  throw new Error(
    'This revision could not be verified. Its source has not been opened or copied.',
  );
}
/** Integrity is checked in addition to, never instead of, the API's scoped authorization. */
export async function validateRevisionManifest(
  value: unknown,
): Promise<RevisionManifest> {
  if (
    !object(value) ||
    !exact(value, [
      'protocol',
      'version',
      'project_id',
      'metadata_version',
      'entrypoint_file_id',
      'runtime',
      'helper_release',
      'files',
      'sha256',
    ]) ||
    value['protocol'] !== 'code-along.revision' ||
    value['version'] !== 1 ||
    !isRunnerId(value['project_id']) ||
    !isRunnerId(value['entrypoint_file_id']) ||
    !Number.isSafeInteger(value['metadata_version']) ||
    Number(value['metadata_version']) < 1 ||
    !reviewedRuntime(value['runtime']) ||
    !object(value['helper_release']) ||
    !exact(value['helper_release'], ['release_id', 'source_sha256']) ||
    value['helper_release']['release_id'] !== REVISION_HELPERS.release_id ||
    value['helper_release']['source_sha256'] !==
      REVISION_HELPERS.source_sha256 ||
    !Array.isArray(value['files']) ||
    value['files'].length < 1 ||
    value['files'].length > RUN_LIMITS.files ||
    typeof value['sha256'] !== 'string' ||
    !digest.test(value['sha256'])
  )
    invalid();
  const ids = new Set<string>(),
    documents = new Set<string>();
  let total = 0,
    previous = '';
  const files: RevisionManifest['files'][number][] = [];
  for (const file of value['files']) {
    if (
      !object(file) ||
      !exact(file, [
        'file_id',
        'document_id',
        'generation',
        'path',
        'source',
        'sha256',
      ]) ||
      !isRunnerId(file['file_id']) ||
      !isRunnerId(file['document_id']) ||
      !Number.isSafeInteger(file['generation']) ||
      Number(file['generation']) < 1 ||
      typeof file['path'] !== 'string' ||
      typeof file['source'] !== 'string' ||
      typeof file['sha256'] !== 'string' ||
      !digest.test(file['sha256']) ||
      ids.has(file['file_id']) ||
      documents.has(file['document_id']) ||
      file['path'] <= previous
    )
      invalid();
    let bytes: Uint8Array;
    try {
      bytes = sourceBytes(file['source']);
    } catch {
      invalid();
    }
    total += bytes.length;
    if (
      bytes.length > RUN_LIMITS.fileBytes ||
      total > RUN_LIMITS.totalBytes ||
      (await sha256(bytes)) !== file['sha256']
    )
      invalid();
    ids.add(file['file_id']);
    documents.add(file['document_id']);
    previous = file['path'];
    files.push(
      Object.freeze({
        file_id: file['file_id'],
        document_id: file['document_id'],
        generation: Number(file['generation']),
        path: file['path'],
        source: file['source'],
        sha256: file['sha256'],
      }),
    );
  }
  try {
    validatePythonPaths(files.map((file) => file.path));
  } catch {
    invalid();
  }
  if (!ids.has(value['entrypoint_file_id'])) invalid();
  const runtime = Object.freeze({ ...value['runtime'] });
  const expected = await sha256(
    sourceBytes(
      JSON.stringify([
        'code-along.revision',
        1,
        value['project_id'],
        value['metadata_version'],
        value['entrypoint_file_id'],
        runtime.runtime_id,
        runtime.manifest_sha256,
        runtime.engine,
        runtime.engine_version,
        runtime.python_version,
        REVISION_HELPERS.release_id,
        REVISION_HELPERS.source_sha256,
        files.map((file) => [
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
  if (expected !== value['sha256']) invalid();
  return Object.freeze({
    protocol: 'code-along.revision',
    version: 1,
    project_id: value['project_id'],
    metadata_version: Number(value['metadata_version']),
    entrypoint_file_id: value['entrypoint_file_id'],
    runtime,
    helper_release: REVISION_HELPERS,
    files: Object.freeze(files),
    sha256: expected,
  });
}
export function revisionArchive(
  manifest: RevisionManifest,
  name: string,
): SourceArchive {
  return {
    version: 1,
    name,
    runtime_id: manifest.runtime.runtime_id,
    entrypoint: manifest.files.find(
      (file) => file.file_id === manifest.entrypoint_file_id,
    )!.path,
    files: manifest.files.map(({ path, source }) => ({ path, source })),
  };
}
