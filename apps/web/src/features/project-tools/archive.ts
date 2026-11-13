import { sourceBytes, RUN_LIMITS } from '@code-along/contracts/execution';
import { validatePythonPaths } from '@code-along/contracts/execution/project';
import { CORE_RUNTIME } from '@code-along/contracts/execution/profiles';
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
export function encodeArchive(archive: SourceArchive): string {
  validatePythonPaths(archive.files.map((file) => file.path));
  if (!archive.files.some((file) => file.path === archive.entrypoint))
    throw new Error('The source backup is missing its entrypoint.');
  for (const file of archive.files)
    if (sourceBytes(file.source).length > RUN_LIMITS.fileBytes)
      throw new Error('A source file exceeds the backup limit.');
  const text = JSON.stringify(archive, null, 2);
  if (new TextEncoder().encode(text).length > ARCHIVE_BYTES)
    throw new Error('The source backup exceeds 16 MiB.');
  return text;
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
