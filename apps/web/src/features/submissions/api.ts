import { api } from '../../api/client.ts';
import { productApi } from '../../api/product.ts';
import type {
  SubmissionPage,
  SubmissionRequest,
  WorkSubmissionPage,
} from './types.ts';
import {
  validSubmissionSummary,
  validateSubmissionDetail,
} from './validation.ts';

const base = (assignmentId: string) => `/api/v1/assignments/${assignmentId}/`;
function page<T extends SubmissionPage>(value: T, assignmentId: string): T {
  if (
    !value ||
    !Array.isArray(value.items) ||
    value.items.length > 100 ||
    !Number.isSafeInteger(value.count) ||
    value.count < value.items.length ||
    !value.items.every(
      (item) =>
        validSubmissionSummary(item) && item.assignment_id === assignmentId,
    )
  )
    throw new Error('The submission list could not be verified.');
  return value;
}
export const submissionsApi = {
  send: (assignmentId: string, workId: string, body: SubmissionRequest) =>
    api<unknown>(`${base(assignmentId)}works/${workId}/submissions/`, {
      method: 'POST',
      body,
    }),
  async work(
    assignmentId: string,
    workId: string,
    offset: number,
    signal?: AbortSignal,
  ) {
    const value = page(
      await api<WorkSubmissionPage>(
        `${base(assignmentId)}works/${workId}/submissions/?offset=${offset}&limit=20`,
        signal ? { signal } : {},
      ),
      assignmentId,
    );
    if (
      !value.items.every((item) => item.work_id === workId) ||
      !value.availability ||
      typeof value.availability.can_submit !== 'boolean' ||
      (value.availability.reason !== null &&
        typeof value.availability.reason !== 'string') ||
      typeof value.availability.checked_at !== 'string'
    )
      throw new Error('Current submission availability could not be verified.');
    return value;
  },
  async assignment(
    assignmentId: string,
    versionId: string,
    offset: number,
    signal?: AbortSignal,
  ) {
    return page(
      await api<SubmissionPage>(
        `${base(assignmentId)}submissions/?offset=${offset}&limit=20${versionId ? `&assignment_version_id=${versionId}` : ''}`,
        signal ? { signal } : {},
      ),
      assignmentId,
    );
  },
  async detail(
    assignmentId: string,
    submissionId: string,
    signal?: AbortSignal,
  ) {
    return validateSubmissionDetail(
      await api<unknown>(
        `${base(assignmentId)}submissions/${submissionId}/`,
        signal ? { signal } : {},
      ),
      assignmentId,
      submissionId,
    );
  },
};

type VerifiedSubmission = Awaited<ReturnType<typeof submissionsApi.detail>>;
interface SubmissionEntryIO {
  identity: (signal: AbortSignal) => Promise<{ id: string }>;
  detail: (
    assignmentId: string,
    submissionId: string,
    signal: AbortSignal,
  ) => Promise<VerifiedSubmission>;
}
/** A fresh private entry read; replaced accounts cannot publish late data or errors. */
export async function readSubmissionEntry(
  accountId: string,
  assignmentId: string,
  submissionId: string,
  signal: AbortSignal,
  activeAccount: () => boolean,
  io: SubmissionEntryIO = {
    identity: productApi.me,
    detail: submissionsApi.detail,
  },
): Promise<VerifiedSubmission | null> {
  const current = () => !signal.aborted && activeAccount();
  if (!current()) return null;
  try {
    const actor = await io.identity(signal);
    if (!current()) return null;
    if (actor.id !== accountId)
      throw new Error('Your account changed. Reopen this submission.');
    const result = await io.detail(assignmentId, submissionId, signal);
    return current() ? result : null;
  } catch (error) {
    if (!current()) return null;
    throw error;
  }
}
