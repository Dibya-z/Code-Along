import type { components } from '@code-along/api-client';
import { isLearningId } from '@code-along/contracts/learning-events';
import { api } from '../../api/client.ts';
import { nonblank } from './validation.ts';

export type OwnProgress = components['schemas']['OwnProgress'];
export type LearnerProgress = components['schemas']['LearnerProgressRow'];
export type ProgressPage = components['schemas']['LearnerProgressPage'];
export type ProgressState = components['schemas']['LearningProgressState'];
export type EligibilityState =
  components['schemas']['LearningEligibilityState'];
export const PROGRESS_LABELS = {
  not_started: 'Not started',
  in_progress: 'In progress',
  submitted: 'Submitted',
  reviewed: 'Reviewed by an instructor',
  needs_changes: 'Changes requested by an instructor',
  complete: 'Marked complete by an instructor',
} satisfies Record<ProgressState, string>;
export const ELIGIBILITY_LABELS = {
  not_offered: 'No participation offer',
  invited: 'Participation offer awaiting your decision',
  expired: 'Offer expired',
  declined: 'Participation declined',
  withdrawn: 'Participation withdrawn',
  revoked: 'Participation revoked',
  unavailable: 'Participation unavailable',
  team_pending: 'Team consent or approval needed',
  policy_ineligible: 'Current team does not meet this version’s rules',
  eligible: 'Participation eligible',
  archived: 'Assignment or workspace archived',
} satisfies Record<EligibilityState, string>;
const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const utc = (value: unknown) =>
  typeof value === 'string' &&
  (value.endsWith('Z') || value.endsWith('+00:00')) &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(Date.parse(value)).toISOString().slice(0, 19) === value.slice(0, 19);
export type ProgressVersionChoice = Pick<
  components['schemas']['AssignmentVersionSummary'],
  'id' | 'number' | 'title'
>;
export function progressVersionOptions(
  selected: ProgressVersionChoice,
  items: readonly ProgressVersionChoice[],
): readonly ProgressVersionChoice[] {
  return items.some((item) => item.id === selected.id)
    ? items
    : [selected, ...items];
}
function invalid(): never {
  throw new Error('This learning progress response could not be verified.');
}
function history(
  value: Record<string, unknown>,
  assignmentId: string,
  versionId: string,
) {
  if (
    value['assignment_id'] !== assignmentId ||
    value['assignment_version_id'] !== versionId ||
    !isLearningId(value['user_id']) ||
    typeof value['state'] !== 'string' ||
    !Object.hasOwn(PROGRESS_LABELS, value['state']) ||
    typeof value['eligibility_state'] !== 'string' ||
    !Object.hasOwn(ELIGIBILITY_LABELS, value['eligibility_state'])
  )
    invalid();
  const submission = value['latest_submission'],
    assessment = value['latest_assessment'];
  if (
    submission !== null &&
    (!object(submission) ||
      !exact(submission, [
        'id',
        'number',
        'submitted_at',
        'source_manifest_sha256',
      ]) ||
      !isLearningId(submission['id']) ||
      typeof submission['number'] !== 'number' ||
      !Number.isInteger(submission['number']) ||
      submission['number'] < 1 ||
      submission['number'] > 256 ||
      !utc(submission['submitted_at']) ||
      typeof submission['source_manifest_sha256'] !== 'string' ||
      submission['source_manifest_sha256'].length !== 64 ||
      !/^[a-f0-9]{64}$/.test(submission['source_manifest_sha256']))
  )
    invalid();
  if (
    assessment !== null &&
    (!object(assessment) ||
      !exact(assessment, [
        'publication_id',
        'assessment_status',
        'published_at',
        'assessment_kind',
      ]) ||
      !isLearningId(assessment['publication_id']) ||
      typeof assessment['assessment_status'] !== 'string' ||
      !['reviewed', 'needs_changes', 'complete'].includes(
        assessment['assessment_status'],
      ) ||
      assessment['assessment_kind'] !== 'manual' ||
      !utc(assessment['published_at']))
  )
    invalid();
  if (
    ['not_started', 'in_progress'].includes(value['state'])
      ? submission !== null || assessment !== null
      : value['state'] === 'submitted'
        ? submission === null || assessment !== null
        : submission === null ||
          !object(assessment) ||
          assessment['assessment_status'] !== value['state']
  )
    invalid();
}
const fields = [
  'assignment_id',
  'assignment_version_id',
  'user_id',
  'state',
  'eligibility_state',
  'latest_submission',
  'latest_assessment',
];
function owned<T>(value: unknown): T {
  const copy = structuredClone(value) as T;
  const freeze = (item: unknown) => {
    if (item && typeof item === 'object') {
      for (const child of Object.values(item)) freeze(child);
      Object.freeze(item);
    }
  };
  freeze(copy);
  return copy;
}
export function validateOwnProgress(
  value: unknown,
  assignmentId: string,
  versionId: string,
  accountId: string,
): OwnProgress {
  if (
    !object(value) ||
    !exact(value, [...fields, 'can_submit']) ||
    value['user_id'] !== accountId ||
    typeof value['can_submit'] !== 'boolean'
  )
    invalid();
  history(value, assignmentId, versionId);
  return owned<OwnProgress>(value);
}
export function validateProgressPage(
  value: unknown,
  assignmentId: string,
  versionId: string,
): ProgressPage {
  if (
    !object(value) ||
    !exact(value, ['items', 'count']) ||
    !Array.isArray(value['items']) ||
    value['items'].length > 100 ||
    typeof value['count'] !== 'number' ||
    !Number.isInteger(value['count']) ||
    value['count'] < value['items'].length ||
    value['count'] > 100
  )
    invalid();
  const seen = new Set<string>();
  for (const row of value['items']) {
    if (
      !object(row) ||
      !exact(row, [...fields, 'user']) ||
      !object(row['user']) ||
      !exact(row['user'], ['id', 'display_name']) ||
      row['user']['id'] !== row['user_id'] ||
      typeof row['user']['display_name'] !== 'string' ||
      !nonblank(row['user']['display_name']) ||
      [...row['user']['display_name']].length > 80 ||
      /[\p{Cc}\p{Cf}\p{Cs}]/u.test(row['user']['display_name'])
    )
      invalid();
    history(row, assignmentId, versionId);
    if (seen.has(row['user_id'] as string)) invalid();
    seen.add(row['user_id'] as string);
  }
  return owned<ProgressPage>(value);
}
export const progressApi = {
  async own(
    assignmentId: string,
    versionId: string,
    accountId: string,
    signal?: AbortSignal,
  ) {
    return validateOwnProgress(
      await api<unknown>(
        `/api/v1/assignments/${assignmentId}/progress/?assignment_version_id=${versionId}`,
        signal ? { signal } : {},
      ),
      assignmentId,
      versionId,
      accountId,
    );
  },
  async learners(
    assignmentId: string,
    versionId: string,
    offset: number,
    signal?: AbortSignal,
  ) {
    return validateProgressPage(
      await api<unknown>(
        `/api/v1/assignments/${assignmentId}/progress/learners/?assignment_version_id=${versionId}&offset=${offset}&limit=20`,
        signal ? { signal } : {},
      ),
      assignmentId,
      versionId,
    );
  },
};
