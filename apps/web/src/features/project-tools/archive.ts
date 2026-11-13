import { sourceBytes, RUN_LIMITS } from '@code-along/contracts/execution';
import { validatePythonPaths } from '@code-along/contracts/execution/project';
import {
  CORE_RUNTIME,
  runtimeProfile,
} from '@code-along/contracts/execution/profiles';
import type { EditorWorkspace } from '../editor/model/workspace.ts';
import type { ValidatedRecovery } from '../recovery/codec.ts';
export interface SourceArchive {
  readonly version: 1;
  readonly name: string;
  readonly runtime_id: string;
  readonly entrypoint: string;
  readonly files: readonly { readonly path: string; readonly source: string }[];
}
export const ARCHIVE_BYTES = 16 * 1024 * 1024;
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function fields(value: Record<string, unknown>, expected: readonly string[]) {
  return (
    Object.keys(value).length === expected.length &&
    Object.keys(value).every((key) => expected.includes(key))
  );
}
export function validateArchive(value: unknown): SourceArchive {
  if (
    !object(value) ||
    !fields(value, ['version', 'name', 'runtime_id', 'entrypoint', 'files']) ||
    value['version'] !== 1 ||
    typeof value['name'] !== 'string' ||
    !value['name'].trim() ||
    value['name'].length > 120 ||
    !runtimeProfile(value['runtime_id']) ||
    typeof value['entrypoint'] !== 'string' ||
    !Array.isArray(value['files']) ||
    value['files'].length < 1 ||
    value['files'].length > RUN_LIMITS.files
  )
    throw new Error(
      'Choose a version 1 Code Along source backup with a name, reviewed runtime and 1–20 Python files.',
    );
  const files = value['files'].map((file: unknown) => {
    if (
      !object(file) ||
      !fields(file, ['path', 'source']) ||
      typeof file['path'] !== 'string' ||
      typeof file['source'] !== 'string'
    )
      throw new Error(
        'Each imported file needs only a Python path and source.',
      );
    if (sourceBytes(file['source']).length > RUN_LIMITS.fileBytes)
      throw new Error(
        'Keep each Python file within 128 KiB of valid UTF-8 without NUL characters.',
      );
    return Object.freeze({ path: file['path'], source: file['source'] });
  });
  validatePythonPaths(files.map((file) => file.path));
  if (!files.some((file) => file.path === value['entrypoint']))
    throw new Error('The source backup is missing its entrypoint.');
  return Object.freeze({
    version: 1,
    name: value['name'],
    runtime_id: String(value['runtime_id']),
    entrypoint: value['entrypoint'],
    files: Object.freeze(files),
  });
}
export function encodeArchive(archive: SourceArchive): string {
  const text = JSON.stringify(validateArchive(archive), null, 2);
  if (new TextEncoder().encode(text).length > ARCHIVE_BYTES)
    throw new Error('The source backup exceeds 16 MiB.');
  return text;
}
export function decodeArchive(bytes: Uint8Array): SourceArchive {
  if (
    !(bytes.buffer instanceof ArrayBuffer) ||
    bytes.length < 1 ||
    bytes.length > ARCHIVE_BYTES
  )
    throw new Error('Choose a source backup no larger than 16 MiB.');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('The source backup must be valid UTF-8.');
  }
  // Bound nesting before JSON.parse allocates an untrusted object tree. Python strings are skipped.
  let depth = 0,
    quoted = false,
    escaped = false;
  for (const char of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{' || char === '[') {
      if (++depth > 4)
        throw new Error('The source backup has excessive JSON nesting.');
    } else if (char === '}' || char === ']') depth--;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('The source backup is not valid JSON.');
  }
  return validateArchive(value);
}
export function workspaceArchive(
  workspace: EditorWorkspace,
  name: string,
): SourceArchive {
  const input = workspace.snapshotInput(
    'batch',
    workspace.defaultRuntime() ?? CORE_RUNTIME,
  );
  return {
    version: 1,
    name,
    runtime_id: input.runtime.runtime_id,
    entrypoint: input.files.find(
      (file) => file.file_id === input.entrypoint_file_id,
    )!.path,
    files: input.files.map(({ path, source }) => ({ path, source })),
  };
}
export function recoveryArchive(recovery: ValidatedRecovery): SourceArchive {
  const data = recovery.data;
  return {
    version: 1,
    name: data.name,
    runtime_id: data.runtime_id,
    entrypoint: data.files.find(
      (file) => file.metadata.id === data.entrypoint_file_id,
    )!.metadata.path,
    files: data.files.map((file) => ({
      path: file.metadata.path,
      source: recovery.sources.get(file.metadata.id)!,
    })),
  };
}
export function downloadArchive(archive: SourceArchive): void {
  const url = URL.createObjectURL(
    new Blob([encodeArchive(archive)], { type: 'application/json' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = `${archive.name.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 60) || 'code-along'}.codealong.json`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function downloadSourceFile(path: string, source: string): void {
  validatePythonPaths([path]);
  if (sourceBytes(source).length > RUN_LIMITS.fileBytes)
    throw new Error('This file exceeds the source backup limit.');
  const url = URL.createObjectURL(
    new Blob([source], { type: 'text/x-python;charset=utf-8' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = path.split('/').at(-1)!;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
