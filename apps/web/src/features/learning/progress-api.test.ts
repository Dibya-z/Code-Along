import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  progressApi,
  validateOwnProgress,
  validateProgressPage,
  progressVersionOptions,
} from './progress-api.ts';
const assignment = '11111111-1111-4111-8111-111111111111',
  version = '22222222-2222-4222-8222-222222222222',
  user = '33333333-3333-4333-8333-333333333333';
const submission = {
  id: '44444444-4444-4444-8444-444444444444',
  number: 1,
  submitted_at: '2026-11-14T12:00:00Z',
  source_manifest_sha256: 'a'.repeat(64),
};
const base = {
  assignment_id: assignment,
  assignment_version_id: version,
  user_id: user,
  state: 'submitted',
  eligibility_state: 'eligible',
  latest_submission: submission,
  latest_assessment: null,
};
const assessment = {
  publication_id: '55555555-5555-4555-8555-555555555555',
  assessment_status: 'complete',
  assessment_kind: 'manual',
  published_at: '2026-11-14T12:00:00Z',
};
afterEach(() => vi.unstubAllGlobals());
describe('read-only version-scoped progress boundary', () => {
  it('keeps chosen A explicit when another versions page or current B does not contain it', () => {
    const a = { id: version, number: 1, title: 'A' },
      b = { id: assignment, number: 2, title: 'B' };
    expect(progressVersionOptions(a, [b])).toEqual([a, b]);
    expect(progressVersionOptions(a, [a, b])).toEqual([a, b]);
    expect(progressVersionOptions(a, [])).toEqual([a]);
  });
  it('keeps manual historical assessment separate from withdrawn/unavailable new-write eligibility', () => {
    const value = validateOwnProgress(
      {
        ...base,
        state: 'complete',
        eligibility_state: 'withdrawn',
        latest_assessment: assessment,
        can_submit: false,
      },
      assignment,
      version,
      user,
    );
    expect(value.state).toBe('complete');
    expect(value.eligibility_state).toBe('withdrawn');
    expect(value.can_submit).toBe(false);
  });
  it('accepts a retained pinned A without guessing the current published version', () => {
    expect(
      validateOwnProgress(
        { ...base, can_submit: false },
        assignment,
        version,
        user,
      ).assignment_version_id,
    ).toBe(version);
    expect(() =>
      validateOwnProgress(
        { ...base, assignment_version_id: assignment, can_submit: false },
        assignment,
        version,
        user,
      ),
    ).toThrow();
  });
  it('does not accept assessment progress without a selected latest submission or infer complete from practice', () => {
    for (const patch of [
      { state: 'complete' },
      { state: 'succeeded' },
      {
        state: 'complete',
        latest_submission: null,
        latest_assessment: assessment,
      },
      { state: 'submitted', latest_assessment: assessment },
      { state: 'reviewed', latest_assessment: assessment },
      { state: 'not_started' },
      { practice: { status: 'succeeded' } },
    ])
      expect(() =>
        validateOwnProgress(
          { ...base, can_submit: false, ...patch },
          assignment,
          version,
          user,
        ),
      ).toThrow();
  });
  it('only exposes own actor new-submit advisory and rejects coercions/foreign-account rows', () => {
    for (const patch of [
      { can_submit: 1 },
      { user_id: assignment },
      { state: ['submitted'] },
      { eligibility_state: ['eligible'] },
      {
        latest_submission: {
          ...submission,
          source_manifest_sha256: 'a'.repeat(64) + '\n',
        },
      },
      { latest_submission: { ...submission, number: 0 } },
      {
        latest_submission: {
          ...submission,
          submitted_at: submission.submitted_at + '\n',
        },
      },
    ])
      expect(() =>
        validateOwnProgress(
          { ...base, can_submit: false, ...patch },
          assignment,
          version,
          user,
        ),
      ).toThrow();
  });
  it('teacher rows contain safe identities and no Source grant/write/draft/email fields', () => {
    const row = { ...base, user: { id: user, display_name: 'River 🐍' } };
    expect(
      validateProgressPage({ items: [row], count: 1 }, assignment, version)
        .items,
    ).toHaveLength(1);
    for (const patch of [
      { can_submit: false },
      { project_id: assignment },
      { draft_comments: 'private' },
      {
        user: {
          id: user,
          display_name: 'River',
          email: 'private@example.test',
        },
      },
      { user: { id: assignment, display_name: 'Other' } },
    ])
      expect(() =>
        validateProgressPage(
          { items: [{ ...row, ...patch }], count: 1 },
          assignment,
          version,
        ),
      ).toThrow();
    expect(() =>
      validateProgressPage(
        { items: [row, row], count: 2 },
        assignment,
        version,
      ),
    ).toThrow();
  });
  it('owns all nested history/user fields instead of retaining a mutable raw response', () => {
    const raw = {
      ...base,
      latest_submission: { ...submission },
      user: { id: user, display_name: 'River' },
    };
    const value = validateProgressPage(
      { items: [raw], count: 1 },
      assignment,
      version,
    );
    raw.latest_submission.number = 8;
    raw.user.display_name = 'changed';
    expect(value.items[0]?.latest_submission?.number).toBe(1);
    expect(value.items[0]?.user.display_name).toBe('River');
    expect(Object.isFrozen(value.items[0]?.user)).toBe(true);
  });
  it('uses only bounded GET routes with exact version and never a user/source selector', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(JSON.stringify({ ...base, can_submit: false }), {
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetch);
    await progressApi.own(assignment, version, user);
    expect(fetch.mock.calls[0]?.[0]).toBe(
      `/api/v1/assignments/${assignment}/progress/?assignment_version_id=${version}`,
    );
  });
});
