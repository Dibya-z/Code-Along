import {
  captureProjectManifest,
  type ProjectRunManifest,
  type ProjectSnapshot,
} from '@code-along/contracts/execution/project';
import { type RuntimeIdentity } from '@code-along/contracts/execution/profiles';
import type { EditorWorkspace } from './workspace.ts';

export interface CapturedRun {
  readonly manifest: ProjectRunManifest;
  readonly sourceRevision: number;
}
export async function captureWorkspaceRun(
  workspace: EditorWorkspace,
  stdinMode: ProjectSnapshot['stdin_mode'] = 'batch',
  runtime?: RuntimeIdentity,
): Promise<CapturedRun> {
  const sourceRevision = workspace.sourceRevision;
  // No await may separate these model reads from the manifest's own byte copy.
  const pending = captureProjectManifest(
    workspace.snapshotInput(stdinMode, runtime),
  );
  return Object.freeze({ sourceRevision, manifest: await pending });
}
export function isCurrentRun(
  workspace: EditorWorkspace,
  captured: CapturedRun,
): boolean {
  return workspace.matchesSnapshot(captured.manifest, captured.sourceRevision);
}
