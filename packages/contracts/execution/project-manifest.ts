import { isRunnerId, RUN_LIMITS, sha256, sourceBytes } from './runner.ts';
import { reviewedRuntime, type RuntimeIdentity } from './profiles.ts';

export interface ProjectSource {
  readonly file_id: string;
  readonly document_id: string;
  readonly generation: number;
  readonly path: string;
  readonly source: string;
}
export interface ProjectSnapshot {
  readonly project_id: string;
  readonly source_kind: 'project' | 'local_draft';
  readonly metadata_version: number;
  readonly entrypoint_file_id: string;
  readonly runtime: RuntimeIdentity;
  readonly stdin_mode: 'batch' | 'interactive';
  readonly files: readonly ProjectSource[];
}
/** Product v2 is separate from the immutable M0 v1 proof protocol. */
export interface ProjectRunManifest extends Omit<ProjectSnapshot, 'files'> {
  readonly version: 2;
  readonly files: readonly (ProjectSource & { readonly sha256: string })[];
  readonly sha256: string;
}
const digest = /^[a-f0-9]{64}$/;
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, expected: readonly string[]) {
  const actual = Object.keys(value);
  return (
    actual.length === expected.length &&
    actual.every((key) => expected.includes(key))
  );
}
/** Same bounded module/import-name policy as the product API. Never normalize source or paths. */
export function validatePythonPaths(paths: readonly string[]): void {
  if (paths.length < 1 || paths.length > RUN_LIMITS.files)
    throw new Error('A project needs 1–20 Python files.');
  const seen = new Set<string>(),
    modules = new Set<string>(),
    directories = new Set<string>();
  for (const path of paths) {
    if (
      typeof path !== 'string' ||
      path.length > 160 ||
      !/^[A-Za-z_][A-Za-z0-9_]*(\/[A-Za-z_][A-Za-z0-9_]*)*\.py$/.test(path)
    ) {
      throw new Error(
        'Use relative Python module paths without traversal or special characters.',
      );
    }
    const folded = path.toLowerCase();
    if (seen.has(folded))
      throw new Error(
        'Python file paths must be unique, including letter case.',
      );
    seen.add(folded);
    const parts = folded.slice(0, -3).split('/');
    for (let length = 1; length < parts.length; length++)
      directories.add(parts.slice(0, length).join('/'));
    if (parts.at(-1) !== '__init__') modules.add(parts.join('/'));
  }
  if ([...modules].some((name) => directories.has(name)))
    throw new Error(
      'A Python module and folder cannot use the same import name.',
    );
}
function validSnapshot(
  value: unknown,
  hashed: boolean,
): value is ProjectSnapshot {
  if (
    !record(value) ||
    !isRunnerId(value['project_id']) ||
    (value['source_kind'] !== 'project' &&
      value['source_kind'] !== 'local_draft') ||
    !Number.isSafeInteger(value['metadata_version']) ||
    Number(value['metadata_version']) < 1 ||
    !isRunnerId(value['entrypoint_file_id']) ||
    !reviewedRuntime(value['runtime']) ||
    (value['stdin_mode'] !== 'batch' &&
      value['stdin_mode'] !== 'interactive') ||
    !Array.isArray(value['files'])
  )
    return false;
  const files = value['files'];
  const ids = new Set<string>(),
    documents = new Set<string>();
  let total = 0;
  try {
    validatePythonPaths(files.map((file) => file?.path));
    for (const file of files) {
      if (
        !record(file) ||
        !keys(file, [
          'file_id',
          'document_id',
          'generation',
          'path',
          'source',
          ...(hashed ? ['sha256'] : []),
        ]) ||
        !isRunnerId(file['file_id']) ||
        !isRunnerId(file['document_id']) ||
        !Number.isSafeInteger(file['generation']) ||
        Number(file['generation']) < 1 ||
        typeof file['source'] !== 'string' ||
        file['source'].length > RUN_LIMITS.fileBytes ||
        ids.has(file['file_id']) ||
        documents.has(file['document_id']) ||
        (hashed &&
          (typeof file['sha256'] !== 'string' || !digest.test(file['sha256'])))
      )
        return false;
      ids.add(file['file_id']);
      documents.add(file['document_id']);
      const size = sourceBytes(file['source']).length;
      if (size > RUN_LIMITS.fileBytes) return false;
      total += size;
    }
  } catch {
    return false;
  }
  return total <= RUN_LIMITS.totalBytes && ids.has(value['entrypoint_file_id']);
}
function canonical(manifest: Omit<ProjectRunManifest, 'sha256'>): Uint8Array {
  return sourceBytes(
    JSON.stringify({
      version: 2,
      project_id: manifest.project_id,
      source_kind: manifest.source_kind,
      metadata_version: manifest.metadata_version,
      entrypoint_file_id: manifest.entrypoint_file_id,
      runtime: {
        runtime_id: manifest.runtime.runtime_id,
        manifest_sha256: manifest.runtime.manifest_sha256,
        engine: manifest.runtime.engine,
        engine_version: manifest.runtime.engine_version,
        python_version: manifest.runtime.python_version,
      },
      stdin_mode: manifest.stdin_mode,
      files: manifest.files.map((file) => ({
        file_id: file.file_id,
        document_id: file.document_id,
        generation: file.generation,
        path: file.path,
        source: file.source,
        sha256: file.sha256,
      })),
    }),
  );
}
/** Every live value is copied in this synchronous turn, before the first digest await. */
export async function captureProjectManifest(
  input: ProjectSnapshot,
): Promise<ProjectRunManifest> {
  const snapshot: ProjectSnapshot = {
    project_id: input.project_id,
    source_kind: input.source_kind,
    metadata_version: input.metadata_version,
    entrypoint_file_id: input.entrypoint_file_id,
    runtime: Object.freeze({ ...input.runtime }),
    stdin_mode: input.stdin_mode,
    files: input.files.map((file) =>
      Object.freeze({
        file_id: file.file_id,
        document_id: file.document_id,
        generation: file.generation,
        path: file.path,
        source: file.source,
      }),
    ),
  };
  if (!validSnapshot(snapshot, false))
    throw new Error(
      'Cannot run an incomplete, invalid or oversized project snapshot.',
    );
  const ordered = [...snapshot.files].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  const files = await Promise.all(
    ordered.map(async (file) =>
      Object.freeze({
        ...file,
        sha256: await sha256(sourceBytes(file.source)),
      }),
    ),
  );
  const manifest = Object.freeze({
    ...snapshot,
    version: 2 as const,
    files: Object.freeze(files),
  });
  return Object.freeze({
    ...manifest,
    sha256: await sha256(canonical(manifest)),
  });
}
export function isProjectRunManifest(
  value: unknown,
): value is ProjectRunManifest {
  return (
    record(value) &&
    keys(value, [
      'version',
      'project_id',
      'source_kind',
      'metadata_version',
      'entrypoint_file_id',
      'runtime',
      'stdin_mode',
      'files',
      'sha256',
    ]) &&
    value['version'] === 2 &&
    typeof value['sha256'] === 'string' &&
    digest.test(value['sha256']) &&
    validSnapshot(value, true)
  );
}
export async function verifyProjectManifest(value: unknown): Promise<boolean> {
  if (!isProjectRunManifest(value)) return false;
  const rebuilt = await captureProjectManifest(value);
  return (
    rebuilt.sha256 === value.sha256 &&
    rebuilt.files.every(
      (file, index) =>
        file.sha256 === value.files[index]?.sha256 &&
        file.path === value.files[index]?.path,
    )
  );
}
