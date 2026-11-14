import { afterEach, describe, expect, it, vi } from 'vitest';
import { productApi } from '../../api/product.ts';
import { authorizeFeedback, feedbackApi } from './api.ts';
import type { FeedbackScope } from './types.ts';
import { feedbackHash } from './validation.ts';

const scope: FeedbackScope = {
  accountId: '11111111-1111-4111-8111-111111111111',
  assignmentId: '22222222-2222-4222-8222-222222222222',
  submissionId: '33333333-3333-4333-8333-333333333333',
  versionId: '44444444-4444-4444-8444-444444444444',
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe('feedback private boundary', () => {
  it('does not authorize an inactive lifetime and rejects an actual foreign identity', async () => {
    const me = vi.spyOn(productApi, 'me');
    await expect(
      authorizeFeedback(scope, new AbortController().signal, () => false),
    ).rejects.toThrow();
    expect(me).not.toHaveBeenCalled();
    me.mockResolvedValue({ id: scope.assignmentId } as Awaited<
      ReturnType<typeof productApi.me>
    >);
    await expect(
      authorizeFeedback(scope, new AbortController().signal, () => true),
    ).rejects.toThrow('account changed');
  });
  it('rechecks cached account and abort after the real auth request resolves', async () => {
    let resolve!: (value: Awaited<ReturnType<typeof productApi.me>>) => void;
    vi.spyOn(productApi, 'me').mockImplementation(
      () =>
        new Promise((yes) => {
          resolve = yes;
        }),
    );
    let active = true;
    const abort = new AbortController();
    const pending = authorizeFeedback(scope, abort.signal, () => active);
    active = false;
    abort.abort();
    resolve({ id: scope.accountId } as Awaited<
      ReturnType<typeof productApi.me>
    >);
    await expect(pending).rejects.toThrow('account changed');
  });
  it('latest uses only the private submission route and rejects extra draft hints', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(JSON.stringify({ latest: null }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetch);
    const signal = new AbortController().signal;
    expect(await feedbackApi.latest(scope, signal)).toBeNull();
    expect(fetch.mock.calls[0]?.[0]).toBe(
      `/api/v1/assignments/${scope.assignmentId}/submissions/${scope.submissionId}/feedback/`,
    );
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      signal,
      cache: 'no-store',
      credentials: 'same-origin',
    });
    fetch.mockResolvedValue(
      new Response(JSON.stringify({ latest: null, draft_revision: 7 })),
    );
    await expect(feedbackApi.latest(scope, signal)).rejects.toThrow();
  });
  it('history rejects duplicates and unscoped or malformed publications rather than exposing their text', async () => {
    const publication = {
      id: '55555555-5555-4555-8555-555555555555',
      assignment_id: scope.assignmentId,
      submission_id: scope.submissionId,
      assignment_version_id: scope.versionId,
      number: 1,
      assessment_status: 'complete',
      comments: '',
      assessment_kind: 'manual',
      publisher: { id: scope.accountId, display_name: 'Mira' },
      published_at: '2026-11-14T12:00:00Z',
      content_sha256: await feedbackHash(
        scope.submissionId,
        scope.versionId,
        1,
        'complete',
        '',
      ),
    };
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal('fetch', fetch);
    const signal = new AbortController().signal;
    fetch.mockResolvedValue(
      new Response(JSON.stringify({ items: [publication], count: 1 })),
    );
    expect(await feedbackApi.history(scope, signal)).toHaveLength(1);
    for (const value of [
      { items: [publication, publication], count: 2 },
      {
        items: [{ ...publication, assignment_id: scope.submissionId }],
        count: 1,
      },
      { items: [publication], count: 2 },
      { items: [], count: 0, private_draft: 'not allowed' },
    ]) {
      fetch.mockResolvedValue(new Response(JSON.stringify(value)));
      await expect(feedbackApi.history(scope, signal)).rejects.toThrow();
    }
  });
});
