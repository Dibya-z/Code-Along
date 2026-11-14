import { describe, expect, it } from 'vitest';
import type { AssignmentWork } from './participation-types.ts';
import { workSourceAccess } from './work-source.ts';

const id = (suffix: number) =>
  `10000000-0000-4000-8000-${suffix.toString().padStart(12, '0')}`;
const projectId = id(4);
const work = (): AssignmentWork => ({
  id: id(1),
  assignment_id: id(2),
  assignment_version_id: id(3),
  subject_kind: 'individual',
  team_id: null,
  team_roster_revision: null,
  state: 'active',
  retired_reason: null,
  created_at: '2026-11-14T12:00:00Z',
  can_continue: true,
  project: { id: projectId, name: 'My work', role: 'owner' },
});

describe('work source authority and retained buffers', () => {
  it('does not invent a source target before an authorized projection arrives', () => {
    expect(workSourceAccess(undefined, null)).toEqual({
      projectId: null,
      authorized: false,
    });
    expect(workSourceAccess({ ...work(), project: null }, null)).toEqual({
      projectId: null,
      authorized: false,
    });
  });

  it('opens only the explicitly returned source project', () => {
    expect(workSourceAccess(work(), null)).toEqual({
      projectId,
      authorized: true,
    });
  });

  it('keeps independently authorized source available when learning eligibility ends', () => {
    const retired: AssignmentWork = {
      ...work(),
      state: 'retired',
      can_continue: false,
      retired_reason: 'participation_ended',
    };
    expect(workSourceAccess(retired, projectId)).toEqual({
      projectId,
      authorized: true,
    });
  });

  it('retains the opened room for export while a missing or redacted projection denies source authority', () => {
    for (const current of [undefined, { ...work(), project: null }])
      expect(workSourceAccess(current, projectId)).toEqual({
        projectId,
        authorized: false,
      });
  });

  it('never switches an opened editor to a different project from a later response', () => {
    const original = work();
    const foreign = {
      ...original,
      project: { ...original.project!, id: id(50) },
    };
    expect(workSourceAccess(foreign, projectId)).toEqual({
      projectId,
      authorized: false,
    });
  });

  it('can resume the same retained room after an explicit fresh read restores source access', () => {
    const denied = workSourceAccess({ ...work(), project: null }, projectId);
    expect(denied.authorized).toBe(false);
    expect(workSourceAccess(work(), denied.projectId)).toEqual({
      projectId,
      authorized: true,
    });
  });
});
