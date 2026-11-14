import { api } from '../../api/client.ts';
import { productApi } from '../../api/product.ts';
import type { FeedbackPublish, FeedbackSave, FeedbackScope } from './types.ts';
import { validateDraft, validatePublication } from './validation.ts';

const base = (scope: FeedbackScope) =>
  `/api/v1/assignments/${scope.assignmentId}/submissions/${scope.submissionId}/feedback/`;
export const feedbackApi = {
  async draft(scope: FeedbackScope, signal: AbortSignal) {
    return validateDraft(
      await api<unknown>(`${base(scope)}draft/`, { signal }),
      scope.submissionId,
    );
  },
  save: (scope: FeedbackScope, body: FeedbackSave, signal: AbortSignal) =>
    api<unknown>(`${base(scope)}draft/`, { method: 'PATCH', body, signal }),
  publish: (scope: FeedbackScope, body: FeedbackPublish, signal: AbortSignal) =>
    api<unknown>(`${base(scope)}publications/`, {
      method: 'POST',
      body,
      signal,
    }),
  async latest(scope: FeedbackScope, signal: AbortSignal) {
    const value = await api<unknown>(base(scope), { signal });
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).length !== 1 ||
      !('latest' in value)
    )
      throw new Error('Published feedback could not be verified.');
    return value.latest === null
      ? null
      : validatePublication(value.latest, scope);
  },
  async history(scope: FeedbackScope, signal: AbortSignal) {
    const value = await api<unknown>(
      `${base(scope)}publications/?offset=0&limit=20`,
      { signal },
    );
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).length !== 2 ||
      !('items' in value) ||
      !('count' in value) ||
      !Array.isArray(value.items) ||
      value.items.length > 20 ||
      typeof value.count !== 'number' ||
      !Number.isInteger(value.count) ||
      value.count !== value.items.length
    )
      throw new Error('Published feedback history could not be verified.');
    const items = await Promise.all(
      value.items.map((item: unknown) => validatePublication(item, scope)),
    );
    if (
      new Set(items.map((item) => item.id)).size !== items.length ||
      new Set(items.map((item) => item.number)).size !== items.length
    )
      throw new Error('Published feedback history could not be verified.');
    return items;
  },
};

/** All reads and explicit commands recheck the actual account; cache replacement also tears down results. */
export async function authorizeFeedback(
  scope: FeedbackScope,
  signal: AbortSignal,
  current: () => boolean,
) {
  if (!current() || signal.aborted)
    throw new Error('Reopen this submission to check feedback access.');
  const identity = await productApi.me(signal);
  if (!current() || signal.aborted || identity.id !== scope.accountId)
    throw new Error(
      'Your account changed. Reopen this submission to check feedback access.',
    );
}
