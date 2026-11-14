import { isRunnerId } from '@code-along/contracts/execution';
import { ApiError } from '../../api/client.ts';
import { safeLabel } from './validation.ts';
import type { Assignment, VersionSummary } from './types.ts';
import type {
  AssignmentTeam,
  AssignmentWork,
  Participation,
  WorkRequest,
} from './participation-types.ts';

export const OLD_WORK_NOTICE =
  'Existing projects keep their owner and sharing when participation ends or a team changes. Downloaded code cannot be recalled.';
export interface WorkProposal {
  readonly request: WorkRequest;
  readonly version: Readonly<VersionSummary>;
  readonly roster: readonly Readonly<{
    id: string;
    display_name: string;
    role: 'owner' | 'editor';
  }>[];
}
export function workProposal(
  assignment: Assignment,
  participant: Participation,
  team: AssignmentTeam | null,
  actorId: string,
  projectName: string,
  nonce: string,
): WorkProposal {
  const version = assignment.current_version;
  if (
    !version ||
    assignment.archived ||
    participant.assignment_id !== assignment.id ||
    participant.user.id !== actorId ||
    participant.effective_state !== 'accepted' ||
    !safeLabel(projectName, 120) ||
    !isRunnerId(nonce)
  )
    throw new Error(
      'Review current accepted participation, publication and project name before starting work.',
    );
  let roster: WorkProposal['roster'] = [{ ...participant.user, role: 'owner' }];
  if (version.submission_mode === 'team') {
    if (
      !team ||
      team.assignment_id !== assignment.id ||
      team.id !== participant.team_offer?.team_id ||
      team.archived ||
      !team.consent_ready ||
      team.version_eligibility?.assignment_version_id !== version.id ||
      !team.version_eligibility.eligible ||
      team.members.length < 2 ||
      team.members.length > version.max_team_size ||
      team.members.length > 6 ||
      !team.members.every((member) => member.consented) ||
      !team.members.some(
        (member) =>
          member.participation_id === participant.id &&
          member.user.id === actorId,
      ) ||
      participant.team_offer.consented_revision !== team.roster_revision ||
      participant.team_offer.roster_revision !== team.roster_revision ||
      team.approved_roster_revision !== team.roster_revision ||
      new Set(team.members.map((member) => member.user.id)).size !==
        team.members.length
    )
      throw new Error(
        'Review the exact current roster, every member’s consent and teacher approval before creating team work.',
      );
    roster = team.members.map((member) => ({
      ...member.user,
      role:
        member.user.id === actorId ? ('owner' as const) : ('editor' as const),
    }));
  }
  return Object.freeze({
    request: Object.freeze({
      client_request_id: nonce,
      assignment_version_id: version.id,
      expected_participation_revision: participant.revision,
      expected_team_roster_revision:
        version.submission_mode === 'team' ? team!.roster_revision : null,
      project_name: projectName,
      sharing:
        version.submission_mode === 'team'
          ? 'approved_team_editors'
          : 'private',
    }),
    version: Object.freeze({ ...version }),
    roster: Object.freeze(roster.map((member) => Object.freeze(member))),
  });
}
export function sameProposalScope(
  proposal: WorkProposal,
  assignment: Assignment,
  participation: Participation | null,
  team: AssignmentTeam | null,
): boolean {
  return (
    !assignment.archived &&
    assignment.current_version?.id === proposal.request.assignment_version_id &&
    participation?.revision ===
      proposal.request.expected_participation_revision &&
    (proposal.request.sharing === 'private' ||
      (team?.roster_revision ===
        proposal.request.expected_team_roster_revision &&
        team.consent_ready))
  );
}
/** A learning projection never invents source authority; a non-null project still needs its ordinary API checks. */
export function verifyWork(
  work: AssignmentWork,
  assignmentId: string,
  workId?: string,
): AssignmentWork {
  if (
    !isRunnerId(work.id) ||
    work.assignment_id !== assignmentId ||
    (workId !== undefined && work.id !== workId) ||
    !isRunnerId(work.assignment_version_id) ||
    !['individual', 'team'].includes(work.subject_kind) ||
    !['active', 'retired'].includes(work.state) ||
    typeof work.can_continue !== 'boolean' ||
    (work.subject_kind === 'individual'
      ? work.team_id !== null || work.team_roster_revision !== null
      : !isRunnerId(work.team_id) ||
        !Number.isSafeInteger(work.team_roster_revision) ||
        Number(work.team_roster_revision) < 1) ||
    (work.project !== null &&
      (!isRunnerId(work.project.id) ||
        typeof work.project.name !== 'string' ||
        !['owner', 'editor', 'viewer'].includes(work.project.role))) ||
    (work.can_continue && (work.project === null || work.state !== 'active'))
  )
    throw new Error(
      'This work record could not be verified. No source project was opened.',
    );
  return work;
}
export function participationConflict(error: unknown): string | null {
  if (
    !(error instanceof ApiError) ||
    error.status !== 409 ||
    !error.body ||
    typeof error.body !== 'object' ||
    !('code' in error.body)
  )
    return null;
  switch (error.body.code) {
    case 'participation_capacity':
      return 'This assignment has reached its lifetime limit of 100 participation records. Ending participation does not release this capacity.';
    case 'team_capacity':
      return 'This assignment has reached its lifetime limit of 50 teams. Archiving teams does not release this capacity.';
    case 'assignment_work_capacity':
      return 'This assignment has reached its lifetime limit of 200 work records. Retiring work does not release this capacity.';
    case 'work_already_exists':
      return 'Work already exists for this assignment version. Refresh My work to open it; no new project was created.';
    case 'version_changed':
      return 'A new version is available. Review it before starting new work. Existing projects keep their original task.';
    default:
      return null;
  }
}
