import { sha256, sourceBytes } from '@code-along/contracts/execution';
import { EditorWorkspace } from '../editor/model/workspace.ts';
import type { EditorProject } from '../projects/types.ts';
import { captureRecovery, type ValidatedRecovery } from '../recovery/codec.ts';
import { recoveryStore, type RecoveryStore } from '../recovery/store.ts';
import { validateArchive, type SourceArchive } from './archive.ts';

export function localDraftProject(recovery: ValidatedRecovery): EditorProject {
  const data = recovery.data;
  if (data.kind !== 'local_draft')
    throw new Error('Open project recovery as a separate local copy.');
  return {
    id: data.project_id,
    name: data.name,
    metadata_version: data.metadata_version,
    entrypoint_file_id: data.entrypoint_file_id,
    runtime_id: data.runtime_id,
    role: 'owner',
    archived: false,
    workspace_archived: false,
  };
}

/** Source-only fork: fresh identities/history, no server mutation or copied authorization. */
export async function createLocalDraft(
  accountId: string,
  input: SourceArchive,
  store: Pick<RecoveryStore, 'read' | 'save'> = recoveryStore(),
): Promise<string> {
  const archive = validateArchive(input),
    projectId = crypto.randomUUID();
  const files = await Promise.all(
    archive.files.map(async (file) => ({
      id: crypto.randomUUID(),
      document_id: crypto.randomUUID(),
      generation: 1,
      path: file.path,
      kind: 'python' as const,
      initial_source: file.source,
      initial_sha256: await sha256(sourceBytes(file.source)),
    })),
  );
  const workspace = new EditorWorkspace(accountId, projectId, 'local_draft');
  try {
    workspace.reconcile(
      {
        id: projectId,
        name: archive.name,
        metadata_version: 1,
        runtime_id: archive.runtime_id,
        entrypoint_file_id: files.find(
          (file) => file.path === archive.entrypoint,
        )!.id,
        role: 'owner',
        archived: false,
        workspace_archived: false,
      },
      files,
    );
    await Promise.all(files.map((file) => workspace.loadSource(file)));
    const recovery = await captureRecovery(workspace, archive.name);
    const scope = await store.read(accountId, projectId);
    await store.save(accountId, projectId, scope.policy.epoch, 0, recovery);
    return projectId;
  } finally {
    workspace.destroy();
  }
}
