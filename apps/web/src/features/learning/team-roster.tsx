import { Notice } from '@code-along/design-system';
import type { AssignmentTeam } from './participation-types.ts';
import { RosterReferences, rosterMemberLabel } from './roster-identity.tsx';

export function TeamRoster({
  team,
  accountId,
  versionNumber,
}: {
  team: AssignmentTeam;
  accountId: string;
  versionNumber?: number;
}) {
  const users = team.members.map((member) => member.user);
  return (
    <section aria-label={`Exact roster for ${team.name}`}>
      <h3>{team.name}</h3>
      <p>
        Roster revision {team.roster_revision} ·{' '}
        {team.archived
          ? 'Archived team'
          : team.approved_roster_revision === team.roster_revision
            ? 'Teacher approved this exact roster'
            : 'Teacher approval needed for this roster'}
      </p>
      <ul className="learning-roster">
        {team.members.map((member) => (
          <li key={member.participation_id}>
            <strong>{rosterMemberLabel(member.user, accountId, users)}</strong>
            <span>
              {member.consented ? 'Consented to this roster' : 'Consent needed'}
            </span>
          </li>
        ))}
      </ul>
      <RosterReferences users={users} accountId={accountId} />
      {team.members.length === 0 && (
        <p>No accepted participants have been offered this team yet.</p>
      )}
      <p>
        {team.consent_ready
          ? 'The exact roster has current member consent and teacher approval.'
          : 'The roster is not ready: every member must accept participation and consent to this exact roster, with current teacher approval.'}
      </p>
      {team.version_eligibility && !team.version_eligibility.eligible && (
        <Notice>
          {versionNumber
            ? `Published version ${versionNumber}`
            : 'The selected version'}{' '}
          {team.version_eligibility.reason === 'mode_mismatch'
            ? 'uses a different work mode.'
            : `allows at most ${team.version_eligibility.max_team_size} team members.`}{' '}
          This does not invalidate consent or an existing work record pinned to
          a different eligible version.
        </Notice>
      )}
    </section>
  );
}
