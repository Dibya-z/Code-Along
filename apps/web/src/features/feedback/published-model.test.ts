import { describe, expect, it, vi } from 'vitest';
import {
  PublishedFeedbackModel,
  type PublishedFeedbackIO,
} from './published-model.ts';
import type { FeedbackPublication, FeedbackScope } from './types.ts';
import { feedbackHash, validatePublication } from './validation.ts';
const scope: FeedbackScope = {
  accountId: '11111111-1111-4111-8111-111111111111',
  assignmentId: '22222222-2222-4222-8222-222222222222',
  submissionId: '33333333-3333-4333-8333-333333333333',
  versionId: '44444444-4444-4444-8444-444444444444',
};
async function publication(number: number) {
  return validatePublication(
    {
      id: `55555555-5555-4555-8555-${String(number).padStart(12, '0')}`,
      assignment_id: scope.assignmentId,
      assignment_version_id: scope.versionId,
      submission_id: scope.submissionId,
      publisher: { id: scope.accountId, display_name: 'Teacher' },
      published_at: '2026-11-14T12:00:00Z',
      number,
      comments: `Review ${number}`,
      assessment_kind: 'manual',
      assessment_status: 'reviewed',
      content_sha256: await feedbackHash(
        scope.submissionId,
        scope.versionId,
        number,
        'reviewed',
        `Review ${number}`,
      ),
    },
    scope,
  );
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture(overrides: Partial<PublishedFeedbackIO> = {}) {
  let active = true;
  const io = {
    authorize: vi.fn<PublishedFeedbackIO['authorize']>(
      overrides.authorize ?? (async () => {}),
    ),
    latest: vi.fn<PublishedFeedbackIO['latest']>(
      overrides.latest ?? (async () => null),
    ),
    history: vi.fn<PublishedFeedbackIO['history']>(
      overrides.history ?? (async () => []),
    ),
  };
  return {
    model: new PublishedFeedbackModel(scope, () => active, io),
    io,
    leave: () => {
      active = false;
    },
  };
}
describe('published feedback notification reads', () => {
  it('does not fetch history or any draft implicitly', async () => {
    const f = fixture();
    await f.model.latest();
    expect(f.io.history).not.toHaveBeenCalled();
    expect(f.model.getSnapshot()).toMatchObject({
      latest: null,
      ready: true,
      history: null,
    });
  });
  it('aborts an older initial read and it cannot overwrite a later anchored refresh', async () => {
    const old = deferred<FeedbackPublication | null>();
    const f = fixture();
    f.io.latest
      .mockImplementationOnce(() => old.promise)
      .mockResolvedValueOnce(await publication(2));
    const first = f.model.latest().catch((error) => error);
    await Promise.resolve();
    const refresh = f.model.latest();
    await refresh;
    expect(f.io.latest.mock.calls[0]?.[0].aborted).toBe(true);
    old.resolve(null);
    expect(await first).toBeInstanceOf(DOMException);
    expect(f.model.getSnapshot().latest?.number).toBe(2);
  });
  it('a direct committed receipt cannot be erased by a pre-publication null/older latest read or a later failure', async () => {
    const read = deferred<FeedbackPublication | null>();
    const f = fixture({ latest: () => read.promise });
    const pending = f.model.latest();
    await Promise.resolve();
    f.model.acceptConfirmed(await publication(2));
    read.resolve(await publication(1));
    await pending;
    expect(f.model.getSnapshot().latest?.number).toBe(2);
    f.io.latest.mockRejectedValueOnce(new Error('HTTP503'));
    await expect(f.model.latest()).rejects.toThrow('HTTP503');
    expect(f.model.getSnapshot().latest?.number).toBe(2);
  });
  it('keeps immutable history while rejecting read failures and does not infer a publication command confirmation', async () => {
    const f = fixture();
    f.io.history
      .mockResolvedValueOnce([await publication(2), await publication(1)])
      .mockResolvedValueOnce([await publication(1)]);
    await f.model.history();
    await f.model.history();
    expect(f.model.getSnapshot().history?.map((v) => v.number)).toEqual([2, 1]);
    expect(f.model.getSnapshot().latest).toBeNull();
    f.io.history.mockRejectedValueOnce(new Error('history429'));
    await expect(f.model.history()).rejects.toThrow('history429');
    expect(f.model.getSnapshot().history).toHaveLength(2);
  });
  it('a changed account after auth cannot issue a private read or publish a late error/data', async () => {
    const auth = deferred<void>();
    const f = fixture({ authorize: () => auth.promise });
    const pending = f.model.latest().catch((error) => error);
    f.leave();
    auth.resolve();
    await pending;
    expect(f.io.latest).not.toHaveBeenCalled();
    const late = deferred<FeedbackPublication | null>();
    const other = fixture({ latest: () => late.promise });
    const reading = other.model.latest().catch((error) => error);
    await Promise.resolve();
    other.leave();
    const before = other.model.getSnapshot();
    late.reject(new Error('private late error'));
    await reading;
    expect(other.model.getSnapshot()).toBe(before);
  });
  it('parent observer abort actually reaches the HTTP read and never creates a successful refresh', async () => {
    const raw = deferred<FeedbackPublication | null>();
    const f = fixture({ latest: () => raw.promise });
    const abort = new AbortController();
    const pending = f.model.latest(abort.signal).catch((error) => error);
    await Promise.resolve();
    abort.abort();
    expect(f.io.latest.mock.calls[0]?.[0].aborted).toBe(true);
    raw.resolve(null);
    expect(await pending).toBeInstanceOf(DOMException);
    expect(f.model.getSnapshot().ready).toBe(false);
    f.model.destroy();
  });
});
