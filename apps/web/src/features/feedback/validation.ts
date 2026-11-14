import {
  isRunnerId,
  sha256,
  sourceBytes,
} from '@code-along/contracts/execution';
import type {
  Assessment,
  FeedbackDraft,
  FeedbackPublication,
  FeedbackScope,
} from './types.ts';
import { nonblank } from '../learning/validation.ts';

export const FEEDBACK_COMMENT_BYTES = 8192;
const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length &&
  Object.keys(value).every((key) => keys.includes(key));
const integer = (value: unknown, minimum: number) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
const utc = (value: unknown) =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(
    value,
  ) &&
  Number.isFinite(Date.parse(value));
const person = (value: unknown) =>
  object(value) &&
  exact(value, ['id', 'display_name']) &&
  isRunnerId(value['id']) &&
  typeof value['display_name'] === 'string' &&
  nonblank(value['display_name']) &&
  [...value['display_name']].length <= 80 &&
  !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value['display_name']);
export const isAssessment = (value: unknown): value is Assessment =>
  typeof value === 'string' &&
  ['reviewed', 'needs_changes', 'complete'].includes(value);

export function validComments(value: unknown): value is string {
  if (typeof value !== 'string' || value.includes('\0')) return false;
  try {
    return sourceBytes(value).length <= FEEDBACK_COMMENT_BYTES;
  } catch {
    return false;
  }
}
export function draftProblem(
  comments: string,
  assessment: Assessment | null,
  publish = false,
): string | null {
  if (assessment !== null && !isAssessment(assessment))
    return 'Choose a supported manual assessment.';
  if (!validComments(comments))
    return 'Use valid plaintext comments within 8,192 UTF-8 bytes.';
  if (publish && assessment === null)
    return 'Choose a manual assessment before publishing.';
  if (
    (assessment === 'reviewed' || assessment === 'needs_changes') &&
    !nonblank(comments)
  )
    return 'Add a comment for this assessment, or save an incomplete draft without an assessment.';
  return null;
}
function invalid(): never {
  throw new Error(
    'This feedback response could not be verified. Publication has not been confirmed.',
  );
}
export function validateDraft(
  value: unknown,
  submissionId: string,
): FeedbackDraft {
  if (
    !object(value) ||
    !exact(value, [
      'submission_id',
      'revision',
      'comments',
      'assessment_status',
      'last_edited_by',
      'updated_at',
    ]) ||
    value['submission_id'] !== submissionId ||
    !integer(value['revision'], 0) ||
    !validComments(value['comments']) ||
    (value['assessment_status'] !== null &&
      !isAssessment(value['assessment_status'])) ||
    (value['revision'] === 0
      ? value['comments'] !== '' ||
        value['assessment_status'] !== null ||
        value['last_edited_by'] !== null ||
        value['updated_at'] !== null
      : !person(value['last_edited_by']) || !utc(value['updated_at'])) ||
    draftProblem(
      value['comments'] as string,
      value['assessment_status'] as Assessment | null,
    )
  )
    invalid();
  return Object.freeze({
    submission_id: value['submission_id'],
    revision: value['revision'],
    comments: value['comments'],
    assessment_status: value['assessment_status'],
    updated_at: value['updated_at'],
    last_edited_by:
      value['last_edited_by'] === null
        ? null
        : Object.freeze({
            id: (value['last_edited_by'] as Record<string, unknown>)['id'],
            display_name: (value['last_edited_by'] as Record<string, unknown>)[
              'display_name'
            ],
          }),
  }) as FeedbackDraft;
}
export async function feedbackHash(
  submissionId: string,
  versionId: string,
  number: number,
  assessment: Assessment,
  comments: string,
) {
  return sha256(
    sourceBytes(
      JSON.stringify([
        'code-along.manual-feedback',
        1,
        submissionId,
        versionId,
        number,
        assessment,
        comments,
      ]),
    ),
  );
}
export async function validatePublication(
  value: unknown,
  scope: FeedbackScope,
): Promise<FeedbackPublication> {
  if (
    !object(value) ||
    !exact(value, [
      'id',
      'submission_id',
      'assignment_id',
      'assignment_version_id',
      'number',
      'comments',
      'assessment_status',
      'publisher',
      'published_at',
      'content_sha256',
      'assessment_kind',
    ]) ||
    !isRunnerId(value['id']) ||
    value['submission_id'] !== scope.submissionId ||
    value['assignment_id'] !== scope.assignmentId ||
    value['assignment_version_id'] !== scope.versionId ||
    !integer(value['number'], 1) ||
    (value['number'] as number) > 20 ||
    !validComments(value['comments']) ||
    !isAssessment(value['assessment_status']) ||
    !person(value['publisher']) ||
    !utc(value['published_at']) ||
    value['assessment_kind'] !== 'manual' ||
    typeof value['content_sha256'] !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value['content_sha256']) ||
    draftProblem(
      value['comments'] as string,
      value['assessment_status'] as Assessment,
      true,
    )
  )
    invalid();
  const snapshot = Object.freeze({
    id: value['id'],
    submission_id: value['submission_id'],
    assignment_id: value['assignment_id'],
    assignment_version_id: value['assignment_version_id'],
    number: value['number'],
    comments: value['comments'],
    assessment_status: value['assessment_status'],
    publisher: Object.freeze({
      id: (value['publisher'] as Record<string, unknown>)['id'],
      display_name: (value['publisher'] as Record<string, unknown>)[
        'display_name'
      ],
    }),
    published_at: value['published_at'],
    content_sha256: value['content_sha256'],
    assessment_kind: value['assessment_kind'],
  }) as FeedbackPublication;
  if (
    (await feedbackHash(
      snapshot.submission_id,
      snapshot.assignment_version_id,
      snapshot.number,
      snapshot.assessment_status,
      snapshot.comments,
    )) !== snapshot.content_sha256
  )
    invalid();
  return snapshot;
}
