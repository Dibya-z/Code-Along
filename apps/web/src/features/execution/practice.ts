import {
  capturePracticeManifest,
  REVIEWED_HELPER_RELEASE,
  type PracticeManifest,
  type PracticeSnapshot,
} from '@code-along/contracts/execution/practice';
import {
  reviewedRuntime,
  type RuntimeIdentity,
} from '@code-along/contracts/execution/profiles';
import type { EditorWorkspace } from '../editor/model/workspace.ts';
import type { CapturedRun } from '../editor/model/snapshot.ts';
import { captureWorkspaceRun } from '../editor/model/snapshot.ts';
import { isRunnerId, sourceBytes } from '@code-along/contracts/execution';
import { CHAT_BLANK_CODEPOINTS } from '@code-along/contracts/events';
import { PRACTICE_CHECK_BYTES } from '@code-along/contracts/execution/practice';

/** Verified Work context; practice still carries no assessment authority. */
export interface WorkExecutionContext {
  readonly project_id: string;
  readonly assignment_id: string;
  readonly assignment_version_id: string;
  readonly assignment_content_sha256: string;
  readonly runtime: RuntimeIdentity;
  readonly helper_release: PracticeSnapshot['helper_release'];
}
export interface WorkPracticeContext extends WorkExecutionContext {
  readonly published_checks_sha256: string;
}
export interface WorkPracticeInput extends WorkPracticeContext {
  readonly checks_source: string;
  readonly check_origin: PracticeSnapshot['check_origin'];
}
export interface CapturedPractice {
  readonly captured: CapturedRun;
  readonly practice: PracticeManifest;
  readonly task: WorkExecutionContext;
}
const blanks = new Set<number>(CHAT_BLANK_CODEPOINTS);
export function checksCopyError(source: string): string | null {
  try {
    if (sourceBytes(source).length > PRACTICE_CHECK_BYTES)
      return 'Keep the practice copy within 16 KiB of UTF-8 text.';
    if (
      ![...source].some((character) => !blanks.has(character.codePointAt(0)!))
    )
      return 'Add some Python before running these checks.';
    return null;
  } catch {
    return 'Use valid Unicode text without NUL characters.';
  }
}
function sameRuntime(left: RuntimeIdentity, right: RuntimeIdentity) {
  return Object.keys(left).every(
    (key) =>
      left[key as keyof RuntimeIdentity] ===
      right[key as keyof RuntimeIdentity],
  );
}
export function workExecutionConflict(
  workspace: EditorWorkspace,
  context: WorkExecutionContext,
): string | null {
  if (
    workspace.sourceKind !== 'project' ||
    workspace.projectId !== context.project_id
  )
    return 'This task belongs to a different work project. Reopen the pinned task.';
  const current = workspace.defaultRuntime();
  if (
    !reviewedRuntime(context.runtime) ||
    !current ||
    !sameRuntime(context.runtime, current)
  )
    return 'This project and its pinned task use different Python environments. Recheck work access before running this task.';
  if (
    context.helper_release.release_id !== REVIEWED_HELPER_RELEASE.release_id ||
    context.helper_release.source_sha256 !==
      REVIEWED_HELPER_RELEASE.source_sha256
  )
    return 'The pinned task helper is unavailable in this app version.';
  return null;
}
function frozenTask(
  workspace: EditorWorkspace,
  input: WorkExecutionContext,
): WorkExecutionContext {
  const conflict = workExecutionConflict(workspace, input);
  if (conflict) throw new Error(conflict);
  if (
    ![input.assignment_id, input.assignment_version_id].every(isRunnerId) ||
    !/^[a-f0-9]{64}$/.test(input.assignment_content_sha256)
  )
    throw new Error('The pinned task could not be verified. Reopen this work.');
  return Object.freeze({
    project_id: input.project_id,
    assignment_id: input.assignment_id,
    assignment_version_id: input.assignment_version_id,
    assignment_content_sha256: input.assignment_content_sha256,
    runtime: Object.freeze({ ...input.runtime }),
    helper_release: Object.freeze({
      release_id: input.helper_release.release_id,
      source_sha256: input.helper_release.source_sha256,
    }),
  });
}
export function captureWorkspaceWorkRun(
  workspace: EditorWorkspace,
  input: WorkExecutionContext,
  mode: 'batch' | 'interactive',
  requestedRuntime?: RuntimeIdentity,
) {
  const task = frozenTask(workspace, input);
  if (
    requestedRuntime &&
    (!reviewedRuntime(requestedRuntime) ||
      !sameRuntime(requestedRuntime, task.runtime))
  )
    throw new Error(
      'Task runs use the Python environment in their published version.',
    );
  const pending = captureWorkspaceRun(workspace, mode, task.runtime);
  return pending.then((captured) =>
    Object.freeze({ captured, task, practice: null }),
  );
}
export function captureWorkspacePractice(
  workspace: EditorWorkspace,
  input: WorkPracticeInput,
  mode: 'batch' | 'interactive',
): Promise<CapturedPractice> {
  const task = frozenTask(workspace, input);
  const sourceRevision = workspace.sourceRevision;
  // The contract copies source, checks and context in this turn, before any hash await.
  const pending = capturePracticeManifest({
    assignment_id: task.assignment_id,
    assignment_version_id: task.assignment_version_id,
    assignment_content_sha256: task.assignment_content_sha256,
    source: workspace.snapshotInput(mode, task.runtime),
    helper_release: task.helper_release,
    published_checks_sha256: input.published_checks_sha256,
    checks_source: input.checks_source,
    check_origin: input.check_origin,
  });
  return pending.then((practice) =>
    Object.freeze({
      captured: Object.freeze({ manifest: practice.source, sourceRevision }),
      practice,
      task,
    }),
  );
}
