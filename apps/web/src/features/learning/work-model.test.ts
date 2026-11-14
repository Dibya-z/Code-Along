import { describe, expect, it } from 'vitest';
import type { Assignment, VersionSummary } from './types.ts';
import type {
  AssignmentTeam,
  AssignmentWork,
  Participation,
} from './participation-types.ts';
import { sameProposalScope, verifyWork, workProposal } from './work-model.ts';

const id = (value: number) =>
  `10000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const ids = {
  assignment: id(1),
  workspace: id(2),
  version: id(3),
  actor: id(4),
  peer: id(5),
  participation: id(6),
  peerParticipation: id(7),
  team: id(8),
  nonce: id(9),
  work: id(10),
  project: id(11),
};
const time = '2026-11-14T12:30:01.123456Z';

function fixture(mode: 'individual' | 'team' = 'team') {
  const version: VersionSummary = {
    id: ids.version,
    number: 2,
    title: 'Frozen assignment A',
    submission_mode: mode,
    max_team_size: mode === 'team' ? 4 : 1,
    max_attempts: 3,
    due_at: '2027-02-01T12:30:01.123456Z',
    published_at: time,
    content_sha256: 'a'.repeat(64),
    starter_manifest_sha256: 'b'.repeat(64),
  };
  const assignment: Assignment = {
    id: ids.assignment,
    workspace_id: ids.workspace,
    title: 'Current draft title',
    archived: false,
    can_author: false,
    published: true,
    current_version: version,
  };
  const participant: Participation = {
    id: ids.participation,
    assignment_id: ids.assignment,
    user: { id: ids.actor, display_name: 'River' },
    revision: 7,
    state: 'accepted',
    effective_state: 'accepted',
    invited_at: time,
    invite_expires_at: '2026-11-21T12:30:01Z',
    accepted_at: time,
    ended_at: null,
    can_accept: false,
    can_withdraw: true,
    team_offer: {
      team_id: ids.team,
      name: 'Pair',
      roster_revision: 5,
      consented_revision: 5,
      consented_at: time,
      expires_at: '2026-11-21T12:30:01Z',
    },
  };
  const team: AssignmentTeam = {
    id: ids.team,
    assignment_id: ids.assignment,
    name: 'Pair',
    revision: 9,
    roster_revision: 5,
    approved_roster_revision: 5,
    archived: false,
    consent_ready: true,
    version_eligibility: {
      assignment_version_id: ids.version,
      submission_mode: mode,
      member_count: 2,
      max_team_size: version.max_team_size,
      eligible: mode === 'team',
      reason: mode === 'team' ? null : 'mode_mismatch',
    },
    // The creating actor deliberately appears second: list position confers no ownership.
    members: [
      {
        participation_id: ids.peerParticipation,
        user: { id: ids.peer, display_name: 'Mira' },
        consented: true,
      },
      {
        participation_id: participant.id,
        user: participant.user,
        consented: true,
      },
    ],
    created_at: time,
    updated_at: time,
  };
  return { assignment, version, participant, team };
}
const propose = ({
  assignment,
  participant,
  team,
}: ReturnType<typeof fixture>) =>
  workProposal(
    assignment,
    participant,
    team,
    ids.actor,
    'My exact new project',
    ids.nonce,
  );

describe('explicit frozen work creation proposals', () => {
  it('freezes only the accepted request contract and derives owner/editor display intent from the exact roster', () => {
    const f = fixture(),
      proposal = propose(f);
    expect(proposal.request).toStrictEqual({
      client_request_id: ids.nonce,
      assignment_version_id: ids.version,
      expected_participation_revision: 7,
      expected_team_roster_revision: 5,
      project_name: 'My exact new project',
      sharing: 'approved_team_editors',
    });
    expect(proposal.roster).toStrictEqual([
      { id: ids.peer, display_name: 'Mira', role: 'editor' },
      { id: ids.actor, display_name: 'River', role: 'owner' },
    ]);
    expect(proposal.version).toStrictEqual(f.version);
    for (const value of [
      proposal,
      proposal.request,
      proposal.version,
      proposal.roster,
      ...proposal.roster,
    ])
      expect(Object.isFrozen(value)).toBe(true);

    // Later refresh objects cannot rewrite the exact request or its displayed sharing intent.
    f.version.title = 'Newer title';
    f.version.due_at = null;
    f.participant.user.display_name = 'Changed name';
    f.participant.revision++;
    f.team.members.reverse();
    expect(proposal.version.title).toBe('Frozen assignment A');
    expect(proposal.version.due_at).toBe('2027-02-01T12:30:01.123456Z');
    expect(proposal.roster[1]).toStrictEqual({
      id: ids.actor,
      display_name: 'River',
      role: 'owner',
    });
    expect(proposal.request.expected_participation_revision).toBe(7);
    expect(Reflect.set(proposal.request, 'project_name', 'Changed')).toBe(
      false,
    );
    expect(proposal.request.project_name).toBe('My exact new project');
  });

  it('keeps individual work private even when the learner has a team offer', () => {
    const f = fixture('individual'),
      proposal = propose(f);
    expect(f.participant.team_offer).not.toBeNull();
    expect(proposal.request.sharing).toBe('private');
    expect(proposal.request.expected_team_roster_revision).toBeNull();
    expect(proposal.roster).toStrictEqual([
      { id: ids.actor, display_name: 'River', role: 'owner' },
    ]);
    expect(
      workProposal(
        f.assignment,
        f.participant,
        null,
        ids.actor,
        'Another private project',
        ids.nonce,
      ).request.sharing,
    ).toBe('private');
  });

  it('retains accepted current consent after its original offer expiry and does not treat a submission deadline as a practice ban', () => {
    const f = fixture();
    f.participant.team_offer!.expires_at = '2020-01-01T00:00:00Z';
    f.version.due_at = '2020-02-01T12:30:01.123456Z';
    const proposal = propose(f);
    expect(proposal.request.sharing).toBe('approved_team_editors');
    expect(proposal.version.due_at).toBe('2020-02-01T12:30:01.123456Z');
  });

  const invalid: [string, (value: ReturnType<typeof fixture>) => void][] = [
    [
      'unpublished assignment',
      (f) => {
        f.assignment.current_version = null;
      },
    ],
    [
      'archived assignment',
      (f) => {
        f.assignment.archived = true;
      },
    ],
    [
      'foreign assignment participation',
      (f) => {
        f.participant.assignment_id = id(50);
      },
    ],
    [
      'different account participation',
      (f) => {
        f.participant.user = { ...f.participant.user, id: id(50) };
      },
    ],
    [
      'invitation without acceptance',
      (f) => {
        f.participant.effective_state = 'invited';
      },
    ],
    [
      'foreign team',
      (f) => {
        f.team.assignment_id = id(50);
      },
    ],
    [
      'team that was not offered',
      (f) => {
        f.participant.team_offer!.team_id = id(50);
      },
    ],
    [
      'archived team',
      (f) => {
        f.team.archived = true;
      },
    ],
    [
      'server reports missing consent readiness',
      (f) => {
        f.team.consent_ready = false;
      },
    ],
    [
      'one missing member consent despite a stale ready flag',
      (f) => {
        f.team.members[0]!.consented = false;
      },
    ],
    [
      'stale actor consent',
      (f) => {
        f.participant.team_offer!.consented_revision = 4;
      },
    ],
    [
      'stale offered roster',
      (f) => {
        f.participant.team_offer!.roster_revision = 4;
      },
    ],
    [
      'stale teacher approval',
      (f) => {
        f.team.approved_roster_revision = 4;
      },
    ],
    [
      'eligibility for another selected version',
      (f) => {
        f.team.version_eligibility!.assignment_version_id = id(50);
      },
    ],
    [
      'missing selected-version eligibility',
      (f) => {
        f.team.version_eligibility = null;
      },
    ],
    [
      'version-specific size denial',
      (f) => {
        f.team.version_eligibility!.eligible = false;
      },
    ],
    [
      'actor absent from exact roster',
      (f) => {
        f.team.members[1]!.participation_id = id(50);
      },
    ],
    [
      'two roster entries for one account',
      (f) => {
        f.team.members[0]!.user = { ...f.participant.user };
      },
    ],
    [
      'roster exceeds selected version size',
      (f) => {
        f.version.max_team_size = 1;
      },
    ],
  ];
  it.each(invalid)(
    'rejects %s before offering source-sharing creation',
    (_, change) => {
      const f = fixture();
      change(f);
      expect(() => propose(f)).toThrow();
    },
  );
  it('rejects a malformed request identity and a blank project label', () => {
    const f = fixture();
    expect(() =>
      workProposal(
        f.assignment,
        f.participant,
        f.team,
        ids.actor,
        'A project',
        'not-a-uuid',
      ),
    ).toThrow();
    expect(() =>
      workProposal(
        f.assignment,
        f.participant,
        f.team,
        ids.actor,
        ' \uFEFF ',
        ids.nonce,
      ),
    ).toThrow();
  });
});

describe('proposal review after a fresh REST snapshot', () => {
  it('accepts equivalent new snapshot objects but invalidates changed version, participation, roster or readiness', () => {
    const f = fixture(),
      proposal = propose(f),
      fresh = structuredClone(f);
    expect(
      sameProposalScope(
        proposal,
        fresh.assignment,
        fresh.participant,
        fresh.team,
      ),
    ).toBe(true);
    expect(
      sameProposalScope(
        proposal,
        { ...f.assignment, current_version: { ...f.version, id: id(50) } },
        f.participant,
        f.team,
      ),
    ).toBe(false);
    expect(
      sameProposalScope(
        proposal,
        f.assignment,
        { ...f.participant, revision: 8 },
        f.team,
      ),
    ).toBe(false);
    expect(
      sameProposalScope(proposal, f.assignment, f.participant, {
        ...f.team,
        roster_revision: 6,
      }),
    ).toBe(false);
    expect(
      sameProposalScope(proposal, f.assignment, f.participant, {
        ...f.team,
        consent_ready: false,
      }),
    ).toBe(false);
    expect(sameProposalScope(proposal, f.assignment, null, f.team)).toBe(false);
    expect(sameProposalScope(proposal, f.assignment, f.participant, null)).toBe(
      false,
    );
  });
  it('invalidates an open creation review when the assignment becomes archived without changing its published version', () => {
    const f = fixture(),
      proposal = propose(f);
    expect(
      sameProposalScope(
        proposal,
        { ...f.assignment, archived: true },
        f.participant,
        f.team,
      ),
    ).toBe(false);
  });
});

function work(): AssignmentWork {
  return {
    id: ids.work,
    assignment_id: ids.assignment,
    assignment_version_id: ids.version,
    subject_kind: 'team',
    team_id: ids.team,
    team_roster_revision: 5,
    state: 'active',
    retired_reason: null,
    created_at: time,
    can_continue: true,
    project: {
      id: ids.project,
      name: 'Ordinarily authorized project',
      role: 'editor',
    },
  };
}
describe('bounded work projection before opening source', () => {
  it('requires both the assignment and requested work identity to match', () => {
    const value = work();
    expect(verifyWork(value, ids.assignment, ids.work)).toBe(value);
    expect(() => verifyWork(value, id(50), ids.work)).toThrow();
    expect(() => verifyWork(value, ids.assignment, id(50))).toThrow();
  });
  it('retains redacted metadata without inventing project access and rejects inconsistent continuation proof', () => {
    const redacted = { ...work(), can_continue: false, project: null };
    expect(verifyWork(redacted, ids.assignment).project).toBeNull();
    expect(
      verifyWork(
        { ...redacted, state: 'retired', retired_reason: 'roster_changed' },
        ids.assignment,
      ).project,
    ).toBeNull();
    expect(() =>
      verifyWork({ ...redacted, can_continue: true }, ids.assignment),
    ).toThrow();
    expect(() =>
      verifyWork(
        { ...work(), state: 'retired', retired_reason: 'roster_changed' },
        ids.assignment,
      ),
    ).toThrow();
  });
  it('preserves the pinned version and current authorized projection without requiring a newer publication', () => {
    const value = work();
    const result = verifyWork(value, ids.assignment);
    expect(result.assignment_version_id).toBe(ids.version);
    expect(result.project).toBe(value.project);
    expect(result.can_continue).toBe(true);
  });
  it('rejects malformed subject pairing or project identity instead of repairing it', () => {
    expect(() =>
      verifyWork({ ...work(), subject_kind: 'individual' }, ids.assignment),
    ).toThrow();
    expect(() =>
      verifyWork({ ...work(), team_roster_revision: 0 }, ids.assignment),
    ).toThrow();
    expect(() =>
      verifyWork(
        {
          ...work(),
          project: { id: 'invalid', name: 'No source', role: 'editor' },
        },
        ids.assignment,
      ),
    ).toThrow();
  });
});
