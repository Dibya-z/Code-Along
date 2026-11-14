import { CHAT_BLANK_CODEPOINTS } from '@code-along/contracts/events';
import {
  isRunnerId,
  sha256,
  sourceBytes,
} from '@code-along/contracts/execution';
import { reviewedRuntime } from '@code-along/contracts/execution/profiles';
import { verifyPublicChecksManifest } from '@code-along/contracts/execution/practice';
import {
  REVISION_HELPERS,
  type RevisionManifest,
} from '../history/manifest.ts';
import type {
  AssignmentVersion,
  DraftFields,
  Hint,
  PublicChecks,
} from './types.ts';

const blanks = new Set<number>(CHAT_BLANK_CODEPOINTS);
export function nonblank(value: string): boolean {
  return [...value].some((character) => !blanks.has(character.codePointAt(0)!));
}
function text(value: string, max: number, required = false) {
  try {
    return sourceBytes(value).length <= max && (!required || nonblank(value));
  } catch {
    return false;
  }
}
export function safeLabel(value: string, max: number): boolean {
  return (
    [...value].length <= max &&
    !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value) &&
    text(value, max * 4, true)
  );
}
function hintsValid(hints: readonly Hint[]): boolean {
  return (
    hints.length <= 8 &&
    new Set(hints.map((hint) => hint.id)).size === hints.length &&
    hints.every(
      (hint) =>
        isRunnerId(hint.id) &&
        safeLabel(hint.title, 80) &&
        text(hint.body, 4096, true),
    ) &&
    hints.reduce((sum, hint) => sum + sourceBytes(hint.body).length, 0) <= 16384
  );
}
export function draftErrors(draft: DraftFields): string[] {
  const errors: string[] = [];
  if (!safeLabel(draft.title, 120))
    errors.push(
      'Use a nonblank title of at most 120 characters, without control characters.',
    );
  if (!text(draft.instructions, 32768))
    errors.push('Instructions must be valid text within 32 KiB.');
  if (!hintsValid(draft.hints))
    errors.push(
      'Use up to 8 hints, each with a title within 80 characters and nonblank body within 4096 UTF-8 bytes; all hint bodies together must fit 16 KiB.',
    );
  if (
    draft.public_checks_source !== null &&
    !text(draft.public_checks_source, 16384, true)
  )
    errors.push('Visible Python checks must be nonblank and within 16 KiB.');
  if (
    draft.starter_revision_id !== null &&
    !isRunnerId(draft.starter_revision_id)
  )
    errors.push('Choose a valid frozen starter.');
  if (
    !Number.isInteger(draft.max_attempts) ||
    draft.max_attempts < 1 ||
    draft.max_attempts > 100
  )
    errors.push('Allow between 1 and 100 attempts.');
  if (
    !Number.isInteger(draft.max_team_size) ||
    (draft.submission_mode === 'individual'
      ? draft.max_team_size !== 1
      : draft.max_team_size < 2 || draft.max_team_size > 6)
  )
    errors.push('Individual work has one learner; teams have 2 to 6 learners.');
  if (draft.due_at !== null && !utc(draft.due_at))
    errors.push('Use a valid due date in UTC.');
  return errors;
}
const digest = /^[0-9a-f]{64}$/;
const utc = (value: string) =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value) &&
  Number.isFinite(Date.parse(value));
const hash = (value: unknown) => sha256(sourceBytes(JSON.stringify(value)));
export async function verifyPublicChecks(
  checks: PublicChecks | null,
): Promise<void> {
  if (checks === null) return;
  if (!(await verifyPublicChecksManifest(checks)))
    throw new Error('The visible checks could not be verified.');
}
/** These checks supplement scoped API authority; they never grant access. */
export async function verifyAssignmentVersion(
  version: AssignmentVersion,
  assignmentId: string,
  versionId: string,
): Promise<AssignmentVersion> {
  const policy = version.submission_policy;
  if (
    version.assignment_id !== assignmentId ||
    version.id !== versionId ||
    !isRunnerId(version.workspace_id) ||
    !Number.isInteger(version.number) ||
    version.number < 1 ||
    version.number > 50 ||
    !utc(version.published_at) ||
    !isRunnerId(version.publisher.id) ||
    !safeLabel(version.publisher.display_name, 80) ||
    !isRunnerId(version.starter.revision_id) ||
    !digest.test(version.starter.manifest_sha256) ||
    !reviewedRuntime(version.runtime) ||
    version.helper_release.release_id !== REVISION_HELPERS.release_id ||
    version.helper_release.source_sha256 !== REVISION_HELPERS.source_sha256 ||
    policy.late_policy !== 'reject' ||
    !['individual', 'team'].includes(policy.mode) ||
    draftErrors({
      title: version.title,
      instructions: version.instructions,
      hints: version.hints,
      public_checks_source: version.public_checks?.source ?? null,
      starter_revision_id: version.starter.revision_id,
      submission_mode: policy.mode,
      max_attempts: policy.max_attempts,
      max_team_size: policy.max_team_size,
      due_at: policy.due_at,
    }).length ||
    !nonblank(version.instructions)
  )
    throw new Error('This published assignment could not be verified.');
  await verifyPublicChecks(version.public_checks);
  const runtime = version.runtime,
    helper = version.helper_release;
  const expected = await hash([
    'code-along.assignment-version',
    1,
    assignmentId,
    version.number,
    version.title,
    version.instructions,
    version.hints.map((hint) => [hint.id, hint.title, hint.body]),
    version.starter.revision_id,
    version.starter.manifest_sha256,
    runtime.runtime_id,
    runtime.manifest_sha256,
    runtime.engine,
    runtime.engine_version,
    runtime.python_version,
    helper.release_id,
    helper.source_sha256,
    version.public_checks?.sha256 ?? null,
    policy.mode,
    policy.max_attempts,
    policy.max_team_size,
    policy.due_at,
    'reject',
  ]);
  if (expected !== version.content_sha256)
    throw new Error(
      'The published assignment content does not match its digest.',
    );
  return version;
}
export function verifyStarter(
  version: AssignmentVersion,
  manifest: RevisionManifest,
): RevisionManifest {
  if (
    manifest.sha256 !== version.starter.manifest_sha256 ||
    manifest.runtime.runtime_id !== version.runtime.runtime_id ||
    manifest.runtime.manifest_sha256 !== version.runtime.manifest_sha256 ||
    manifest.runtime.engine !== version.runtime.engine ||
    manifest.runtime.engine_version !== version.runtime.engine_version ||
    manifest.runtime.python_version !== version.runtime.python_version ||
    manifest.helper_release.release_id !== version.helper_release.release_id ||
    manifest.helper_release.source_sha256 !==
      version.helper_release.source_sha256
  )
    throw new Error(
      'The frozen starter does not match this assignment version.',
    );
  return manifest;
}
