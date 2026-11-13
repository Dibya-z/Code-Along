import { describe, expect, it } from 'vitest';
import {
  CORE_RUNTIME,
  SCIENTIFIC_RUNTIME,
} from '@code-along/contracts/execution/profiles';
import { sha256, sourceBytes } from '@code-along/contracts/execution';
import type { Project } from '../../projects/types.ts';
import { EditorWorkspace } from './workspace.ts';
import { captureWorkspaceRun, isCurrentRun } from './snapshot.ts';
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
async function fixture() {
  const files = await Promise.all(
    ['main.py', 'helper.py'].map(async (path, n) => ({
      id: id(n + 1),
      document_id: id(n + 101),
      generation: 1,
      kind: 'python' as const,
      path,
      initial_source: 'print("initial")\n',
      initial_sha256: await sha256(sourceBytes('print("initial")\n')),
    })),
  );
  const project: Project = {
    id: id(99),
    owner_id: id(98),
    workspace_id: id(97),
    role: 'owner',
    archived: false,
    workspace_archived: false,
    name: 'Snapshot',
    metadata_version: 1,
    acl_version: '1',
    entrypoint_file_id: id(1),
    entrypoint_path: 'main.py',
    runtime_profile_id: id(96),
    runtime_id: CORE_RUNTIME.runtime_id,
  };
  const workspace = new EditorWorkspace(project.owner_id, project.id);
  workspace.reconcile(project, files);
  return { workspace, project, files };
}
describe('complete editor snapshot capture', () => {
  it('captures an explicit local runtime choice without changing the project default', async () => {
    const { workspace, files } = await fixture();
    await Promise.all(files.map((file) => workspace.loadSource(file)));
    const captured = await captureWorkspaceRun(
      workspace,
      'batch',
      SCIENTIFIC_RUNTIME,
    );
    expect(captured.manifest.runtime).toEqual(SCIENTIFIC_RUNTIME);
    expect(workspace.defaultRuntime()).toEqual(CORE_RUNTIME);
    expect(isCurrentRun(workspace, captured)).toBe(true);
    workspace.destroy();
  });
  it('refuses missing files instead of silently running a partial project', async () => {
    const { workspace, files } = await fixture();
    await workspace.loadSource(files[0]!);
    await expect(captureWorkspaceRun(workspace)).rejects.toThrow(
      'every project file',
    );
    workspace.destroy();
  });
  it('captures inactive file edits before async hashing; later edits/rename do not change that run', async () => {
    const { workspace, files, project } = await fixture();
    await Promise.all(files.map((file) => workspace.loadSource(file)));
    workspace.replaceSource(id(2), 'answer = "雪"\r\n');
    const pending = captureWorkspaceRun(workspace);
    workspace.replaceSource(id(2), 'answer = "later"\n');
    workspace.reconcile({ ...project, metadata_version: 2 }, [
      files[0]!,
      { ...files[1]!, path: 'renamed.py' },
    ]);
    const captured = await pending;
    expect(
      captured.manifest.files.find((file) => file.file_id === id(2)),
    ).toMatchObject({
      source: 'answer = "雪"\r\n',
      path: 'helper.py',
      generation: 1,
    });
    expect(captured.manifest.metadata_version).toBe(1);
    expect(isCurrentRun(workspace, captured)).toBe(false);
    workspace.destroy();
  });
  it('allows a viewer to run the complete read-only copy and identifies structural changes', async () => {
    const { workspace, files, project } = await fixture();
    await Promise.all(files.map((file) => workspace.loadSource(file)));
    workspace.reconcile({ ...project, role: 'viewer' }, files);
    const captured = await captureWorkspaceRun(workspace);
    expect(isCurrentRun(workspace, captured)).toBe(true);
    workspace.reconcile(
      {
        ...project,
        role: 'viewer',
        metadata_version: 2,
        entrypoint_file_id: id(2),
        entrypoint_path: 'helper.py',
      },
      files,
    );
    expect(isCurrentRun(workspace, captured)).toBe(false);
    workspace.destroy();
    await expect(captureWorkspaceRun(workspace)).rejects.toThrow(
      'complete project',
    );
  });
});
