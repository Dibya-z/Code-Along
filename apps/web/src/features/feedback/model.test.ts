import { describe, expect, it, vi } from 'vitest';
import { FeedbackModel, type FeedbackIO } from './model.ts';
import {
  draftProblem,
  feedbackHash,
  validateDraft,
  validatePublication,
  validComments,
} from './validation.ts';
import type { FeedbackDraft, FeedbackScope } from './types.ts';

const scope: FeedbackScope = {
  accountId: '11111111-1111-4111-8111-111111111111',
  assignmentId: '22222222-2222-4222-8222-222222222222',
  submissionId: '33333333-3333-4333-8333-333333333333',
  versionId: '44444444-4444-4444-8444-444444444444',
};
const actor = { id: scope.accountId, display_name: 'Teacher 🐍' };
const time = '2026-11-14T12:00:00.123456Z';
function draft(
  revision = 1,
  comments = 'Try a smaller example.',
): FeedbackDraft {
  return {
    submission_id: scope.submissionId,
    revision,
    comments,
    assessment_status: revision ? 'reviewed' : null,
    last_edited_by: revision ? actor : null,
    updated_at: revision ? time : null,
  };
}
async function publication(comments = 'Try a smaller example.', number = 1) {
  return {
    id: '55555555-5555-4555-8555-555555555555',
    submission_id: scope.submissionId,
    assignment_id: scope.assignmentId,
    assignment_version_id: scope.versionId,
    number,
    comments,
    assessment_status: 'reviewed',
    publisher: actor,
    published_at: time,
    content_sha256: await feedbackHash(
      scope.submissionId,
      scope.versionId,
      number,
      'reviewed',
      comments,
    ),
    assessment_kind: 'manual',
  };
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
function fixture(overrides: Partial<FeedbackIO> = {}) {
  let active = true;
  const io = {
    authorize: vi.fn<FeedbackIO['authorize']>(
      overrides.authorize ?? (async () => {}),
    ),
    draft: vi.fn<FeedbackIO['draft']>(overrides.draft ?? (async () => draft())),
    save: vi.fn<FeedbackIO['save']>(overrides.save ?? (async () => draft(2))),
    publish: vi.fn<FeedbackIO['publish']>(
      overrides.publish ?? (async () => publication()),
    ),
  };
  const model = new FeedbackModel(scope, () => active, io);
  return {
    model,
    io,
    leave: () => {
      active = false;
    },
  };
}

describe('exact manual feedback validation', () => {
  it('owns the complete publication and nested publisher before asynchronous hashing', async () => {
    const raw = { ...(await publication()), publisher: { ...actor } };
    const expected = structuredClone(raw);
    const pending = validatePublication(raw, scope);
    raw.comments = 'Changed while hashing';
    raw.publisher.id = scope.assignmentId;
    raw.publisher.display_name = 'Changed';
    raw.assessment_status = 'complete';
    const result = await pending;
    expect(result).toEqual(expected);
    expect(Object.isFrozen(result.publisher)).toBe(true);
    expect(result).not.toBe(raw);
  });
  it('owns draft scalars and the last editor without freezing caller data', () => {
    const raw = { ...draft(), last_edited_by: { ...actor } };
    const result = validateDraft(raw, scope.submissionId);
    raw.comments = 'Changed';
    raw.last_edited_by.display_name = 'Other';
    expect(result.comments).toBe(draft().comments);
    expect(result.last_edited_by?.display_name).toBe(actor.display_name);
    expect(Object.isFrozen(result.last_edited_by)).toBe(true);
  });
  it('matches the independent Python compact JSON golden without normalization', async () => {
    expect(
      await feedbackHash(
        '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
        7,
        'needs_changes',
        '\uFEFF  शिक्षक <b>text only</b> café e\u0301\r\n  ',
      ),
    ).toBe('9681a45efb0ea755dc4e6a02f319180afd62407dd2c9a34dac3550cb504a40a8');
  });
  it('preserves Unicode, CRLF, leading BOM, spaces and literal markup', async () => {
    const text = '\uFEFF  <b>π🐍</b>\r\ncafé café  \n';
    const value = await publication(text);
    expect((await validatePublication(value, scope)).comments).toBe(text);
    expect(validateDraft(draft(1, text), scope.submissionId).comments).toBe(
      text,
    );
  });
  it('enforces the exact UTF-8 cap, scalar text and shared blank-codepoint rules without trimming', () => {
    expect(validComments('🐍'.repeat(2048))).toBe(true);
    expect(validComments('🐍'.repeat(2048) + 'x')).toBe(false);
    expect(validComments('\ud800')).toBe(false);
    expect(validComments('a\0b')).toBe(false);
    for (const blank of ['', '\uFEFF', '\u0085\u001c\u0020']) {
      expect(draftProblem(blank, 'reviewed')).not.toBeNull();
      expect(draftProblem(blank, 'needs_changes', true)).not.toBeNull();
      expect(draftProblem(blank, null)).toBeNull();
      expect(draftProblem(blank, 'complete', true)).toBeNull();
    }
  });
  it('accepts no-write revision zero only in the exact absent-draft shape', () => {
    expect(validateDraft(draft(0, ''), scope.submissionId).revision).toBe(0);
    for (const patch of [
      { comments: 'hidden' },
      { last_edited_by: actor },
      { assessment_status: 'complete' },
      { updated_at: time },
      { revision: -1 },
      { revision: 0.5 },
      { extra: true },
    ])
      expect(() =>
        validateDraft({ ...draft(0, ''), ...patch }, scope.submissionId),
      ).toThrow();
  });
  it('rejects coerced enums, other scopes, tampered hashes and extra grade fields', async () => {
    const value = await publication();
    for (const patch of [
      { assessment_status: ['reviewed'] },
      { assessment_status: { toString: () => 'reviewed' } },
      { assessment_kind: ['manual'] },
      { submission_id: scope.assignmentId },
      { assignment_id: scope.submissionId },
      { assignment_version_id: scope.assignmentId },
      { number: 0 },
      { number: 21 },
      { comments: value.comments + '!' },
      { content_sha256: '0'.repeat(64) },
      { score: 100 },
      { publisher: { ...actor, display_name: 'bad\u0000name' } },
    ])
      await expect(
        validatePublication({ ...value, ...patch }, scope),
      ).rejects.toThrow();
    expect(() =>
      validateDraft(
        { ...draft(), assessment_status: ['reviewed'] },
        scope.submissionId,
      ),
    ).toThrow();
  });
});

describe('feedback draft and original publication lifetime', () => {
  it('does no I/O on construction and loads a draft only on explicit request', async () => {
    const f = fixture();
    expect(f.io.draft).not.toHaveBeenCalled();
    await f.model.load();
    expect(f.io.authorize).toHaveBeenCalledOnce();
    expect(f.model.getSnapshot().saved?.revision).toBe(1);
  });
  it('snapshots a full replacement before awaiting auth and prevents synchronous duplicate saves', async () => {
    const auth = deferred<void>();
    const save = vi.fn<FeedbackIO['save']>(async () => ({
      ...draft(2, ' exact\r\n '),
      assessment_status: null,
    }));
    const f = fixture({ save });
    await f.model.load();
    f.io.authorize.mockImplementationOnce(() => auth.promise);
    f.model.edit(' exact\r\n ', null);
    const pending = f.model.save();
    void f.model.save();
    f.model.edit('replacement', 'complete');
    expect(save).not.toHaveBeenCalled();
    auth.resolve();
    await pending;
    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0]?.[0]).toEqual({
      expected_revision: 1,
      comments: ' exact\r\n ',
      assessment_status: null,
    });
    expect(f.model.getSnapshot().saved?.comments).toBe(' exact\r\n ');
  });
  it('retains local text on CAS and transport errors, requiring an explicit reload before another save', async () => {
    const f = fixture({
      save: vi.fn(async () => {
        throw new Error('revision conflict');
      }),
    });
    await f.model.load();
    f.model.edit('Unsaved co-teacher notes', 'needs_changes');
    await f.model.save();
    expect(f.model.getSnapshot()).toMatchObject({
      comments: 'Unsaved co-teacher notes',
      reloadRequired: true,
      saved: { revision: 1 },
    });
    await f.model.save();
    expect(f.io.save).toHaveBeenCalledOnce();
    await f.model.load();
    expect(f.model.getSnapshot().comments).toBe('Unsaved co-teacher notes');
    await f.model.load(true);
    expect(f.model.getSnapshot().comments).toBe(draft().comments);
    expect(f.model.getSnapshot().error).toBeNull();
  });
  it('rejects a malformed save receipt without claiming the local text is saved', async () => {
    const f = fixture({ save: async () => draft(2, 'different') });
    await f.model.load();
    f.model.edit('Chosen', 'reviewed');
    await f.model.save();
    expect(f.model.getSnapshot()).toMatchObject({
      comments: 'Chosen',
      saved: { revision: 1 },
      reloadRequired: true,
    });
    expect(f.model.getSnapshot().error).toBeInstanceOf(Error);
  });
  it('requires a saved complete choice; current local edits cannot silently publish an older draft', async () => {
    const f = fixture();
    await f.model.load();
    f.model.edit('Not saved', 'complete');
    await f.model.publish();
    expect(f.io.publish).not.toHaveBeenCalled();
    const empty = fixture({ draft: async () => draft(0, '') });
    await empty.model.load();
    await empty.model.publish();
    expect(empty.io.publish).not.toHaveBeenCalled();
  });
  it('retains the original body and text across lost reply, newer draft save/reload and manual auth retry', async () => {
    const send = vi
      .fn<FeedbackIO['publish']>()
      .mockRejectedValueOnce(new Error('lost reply'))
      .mockResolvedValueOnce(await publication());
    const f = fixture({
      publish: send,
      save: async () => draft(2, 'Newer draft'),
    });
    await f.model.load();
    await f.model.publish();
    const attempt = f.model.getSnapshot().attempt!;
    expect(Object.isFrozen(attempt.body)).toBe(true);
    f.model.edit('Newer draft', 'reviewed');
    await f.model.save();
    await f.model.load(true);
    expect(f.model.getSnapshot().attempt).toBe(attempt);
    await f.model.publish();
    expect(send.mock.calls[1]?.[0]).toBe(send.mock.calls[0]?.[0]);
    expect(f.model.getSnapshot()).toMatchObject({
      phase: 'confirmed',
      receipt: { comments: draft().comments },
      reloadRequired: true,
    });
    expect(f.io.authorize).toHaveBeenCalledTimes(5);
  });
  it('double publish before the first auth settles sends only one original request', async () => {
    const f = fixture();
    await f.model.load();
    const auth = deferred<void>();
    f.io.authorize.mockImplementationOnce(() => auth.promise);
    const first = f.model.publish();
    void f.model.publish();
    expect(f.model.getSnapshot().attempt?.body.expected_revision).toBe(1);
    auth.resolve();
    await first;
    expect(f.io.publish).toHaveBeenCalledOnce();
  });
  it('does not confirm unreadable/mismatched receipts or infer success from a later draft read', async () => {
    for (const value of [
      null,
      {
        ...(await publication()),
        publisher: { ...actor, id: scope.assignmentId },
      },
      await publication('A different saved draft'),
    ]) {
      const f = fixture({ publish: async () => value });
      await f.model.load();
      await f.model.publish();
      expect(f.model.getSnapshot()).toMatchObject({
        phase: 'uncertain',
        receipt: null,
      });
      const attempt = f.model.getSnapshot().attempt;
      await f.model.load(true);
      expect(f.model.getSnapshot().attempt).toBe(attempt);
      expect(f.model.getSnapshot().receipt).toBeNull();
    }
  });
  it('permits original confirmation after later draft access denial and never automatically replays it', async () => {
    const send = vi
      .fn<FeedbackIO['publish']>()
      .mockRejectedValueOnce(new Error('lost reply'))
      .mockResolvedValueOnce(await publication());
    const f = fixture({ publish: send });
    await f.model.load();
    await f.model.publish();
    const attempt = f.model.getSnapshot().attempt;
    f.io.draft.mockRejectedValueOnce(new Error('access unavailable'));
    await f.model.load(true);
    expect(send).toHaveBeenCalledOnce();
    expect(f.model.getSnapshot().attempt).toBe(attempt);
    await f.model.publish();
    expect(f.model.getSnapshot().phase).toBe('confirmed');
  });
  it('a replaced account cannot issue a command after auth or apply a late receipt/error', async () => {
    const auth = deferred<void>();
    const f = fixture();
    await f.model.load();
    f.io.authorize.mockImplementationOnce(() => auth.promise);
    const first = f.model.publish();
    f.leave();
    auth.resolve();
    await first;
    expect(f.io.publish).not.toHaveBeenCalled();
    const response = deferred<unknown>();
    const second = fixture({ publish: () => response.promise });
    await second.model.load();
    const sending = second.model.publish();
    await Promise.resolve();
    const snapshot = second.model.getSnapshot();
    second.leave();
    response.resolve(await publication());
    await sending;
    expect(second.model.getSnapshot()).toBe(snapshot);
  });
  it('destroy aborts owned I/O and a late draft/error cannot populate another page lifetime', async () => {
    const response = deferred<FeedbackDraft>();
    const read = vi.fn<FeedbackIO['draft']>(() => response.promise);
    const f = fixture({ draft: read });
    const loading = f.model.load();
    await Promise.resolve();
    const snapshot = f.model.getSnapshot();
    f.model.destroy();
    expect(read.mock.calls[0]?.[0].aborted).toBe(true);
    response.reject(new Error('late private draft'));
    await loading;
    expect(f.model.getSnapshot()).toBe(snapshot);
  });
});
