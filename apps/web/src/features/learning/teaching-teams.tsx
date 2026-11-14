import { useEffect, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, Dialog, Field, Notice } from '@code-along/design-system';
import { Failure } from '../../api/feedback.tsx';
import { queryClient } from '../../app/providers.tsx';
import { Pagination } from '../../components/pagination.tsx';
import { CommandFeedback, useLearningCommand } from './command.tsx';
import { participationApi } from './participation-api.ts';
import type { AssignmentTeam, Participation } from './participation-types.ts';
import type { Assignment } from './types.ts';
import { safeLabel } from './validation.ts';
import { OLD_WORK_NOTICE } from './work-model.ts';
import { RosterReferences, rosterMemberLabel } from './roster-identity.tsx';

type TeamCommand = Readonly<
  { description: string } & (
    | { kind: 'create'; name: string }
    | { kind: 'rename'; teamId: string; revision: number; name: string }
    | { kind: 'archive'; teamId: string; revision: number; archived: boolean }
    | {
        kind: 'offer' | 'remove';
        teamId: string;
        revision: number;
        participationId: string;
        participationRevision: number;
      }
    | {
        kind: 'approve';
        teamId: string;
        revision: number;
        rosterRevision: number;
      }
  )
>;
interface Review {
  accountId: string;
  request: TeamCommand;
  roster: readonly { id: string; name: string; consented: boolean }[];
}
type TeamsProps = {
  assignment: Assignment;
  accountId: string;
  active: boolean;
  paused: boolean;
};

export function TeachingTeams(props: TeamsProps) {
  return (
    <ScopedTeachingTeams
      key={`${props.accountId}:${props.assignment.id}`}
      {...props}
    />
  );
}

function ScopedTeachingTeams({
  assignment,
  accountId,
  active,
  paused,
}: TeamsProps) {
  const [offset, setOffset] = useState(0),
    [selected, setSelected] = useState('');
  const [name, setName] = useState(''),
    [validation, setValidation] = useState('');
  const [rechecking, setRechecking] = useState(false),
    [checkError, setCheckError] = useState<unknown>(null);
  const version = assignment.current_version;
  const versionId = version?.id;
  const enabled = active && assignment.can_author;
  const teams = useQuery({
    queryKey: ['assignment-teams', accountId, assignment.id, versionId, offset],
    queryFn: ({ signal }) =>
      participationApi.teams(assignment.id, offset, versionId, signal),
    enabled,
  });
  const participations = useQuery({
    queryKey: ['assignment-team-participations', accountId, assignment.id],
    queryFn: ({ signal }) => participationApi.rosterAll(assignment.id, signal),
    enabled,
  });
  const detail = useQuery({
    queryKey: [
      'assignment-team',
      accountId,
      assignment.id,
      selected,
      versionId,
    ],
    queryFn: ({ signal }) =>
      participationApi.team(assignment.id, selected, versionId, signal),
    enabled: enabled && Boolean(selected),
  });
  async function refresh() {
    setRechecking(true);
    setCheckError(null);
    try {
      await Promise.all([
        teams.refetch({ throwOnError: true }),
        participations.refetch({ throwOnError: true }),
        ...(selected ? [detail.refetch({ throwOnError: true })] : []),
        ...[
          'assignment-teams',
          'assignment-team',
          'assignment-team-participations',
          'assignment-participation',
          'assignment-participations',
          'assignment-works',
          'assignment-work',
        ].map((prefix) =>
          queryClient.invalidateQueries({
            queryKey: [prefix, accountId, assignment.id],
            refetchType: 'none',
          }),
        ),
      ]);
    } catch (error) {
      setCheckError(error);
      throw error;
    } finally {
      setRechecking(false);
    }
  }
  const command = useLearningCommand<TeamCommand, { createdId?: string }>(
    accountId,
    `${assignment.id}:teaching-teams`,
    async (request) => {
      switch (request.kind) {
        case 'create': {
          const team = await participationApi.createTeam(
            assignment.id,
            request.name,
          );
          return { createdId: team.id };
        }
        case 'rename':
          await participationApi.updateTeam(assignment.id, request.teamId, {
            expected_revision: request.revision,
            name: request.name,
          });
          break;
        case 'archive':
          await participationApi.updateTeam(assignment.id, request.teamId, {
            expected_revision: request.revision,
            archived: request.archived,
          });
          break;
        case 'offer':
          await participationApi.offerTeam(assignment.id, request.teamId, {
            participation_id: request.participationId,
            expected_team_revision: request.revision,
            expected_participation_revision: request.participationRevision,
          });
          break;
        case 'remove':
          await participationApi.removeTeam(
            assignment.id,
            request.teamId,
            request.participationId,
            request.revision,
            request.participationRevision,
          );
          break;
        case 'approve':
          await participationApi.approve(assignment.id, request.teamId, {
            expected_revision: request.revision,
            roster_revision: request.rosterRevision,
          });
          break;
      }
      return {};
    },
    refresh,
  );
  useEffect(() => {
    if (command.mutation.data?.createdId)
      setSelected(command.mutation.data.createdId);
  }, [command.mutation.data]);
  const inaccessible = paused || !assignment.can_author;
  const locked =
    !active ||
    inaccessible ||
    command.busy ||
    rechecking ||
    Boolean(command.pending) ||
    Boolean(command.refreshError) ||
    Boolean(checkError) ||
    Boolean(teams.error) ||
    Boolean(participations.error) ||
    Boolean(detail.error);
  const mutable = !locked && !assignment.archived;
  function run(request: TeamCommand) {
    if (!locked) command.run(Object.freeze(request));
  }
  function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!safeLabel(name, 80)) {
      setValidation(
        'Use a nonblank team name within 80 characters, without control characters.',
      );
      return;
    }
    if (!mutable) return;
    setValidation('');
    run({ kind: 'create', name, description: `Create team “${name}”.` });
  }
  return (
    <section
      className="assignment-author"
      aria-labelledby="teaching-teams-heading"
    >
      <div className="section-head">
        <div>
          <h2
            id="teaching-teams-heading"
            className="learning-view"
            tabIndex={-1}
          >
            Teams
          </h2>
          <p className="muted">
            Offer accepted participants a team, then review and approve its
            exact roster. Each learner gives their own consent.
          </p>
        </div>
        <Button
          type="button"
          variant="secondary"
          busy={rechecking}
          disabled={!active || inaccessible || command.busy}
          onClick={() => {
            void refresh()
              .then(() => {
                if (command.refreshError) command.review();
              })
              .catch(() => {});
          }}
        >
          Refresh teams
        </Button>
      </div>
      <p>{OLD_WORK_NOTICE}</p>
      <p className="muted">
        Roster changes retire affected learning work bindings. They do not
        create source grants or change existing project ownership and sharing.
        These records update when you refresh.
      </p>
      {assignment.archived && (
        <Notice>
          Assignment archived. New teams, offers, approval and name changes are
          paused; removing a team offer remains available.
        </Notice>
      )}
      {teams.error && <Failure error={teams.error} />}
      {participations.error && <Failure error={participations.error} />}
      {Boolean(checkError) &&
        !teams.error &&
        !participations.error &&
        !detail.error && <Failure error={checkError} />}
      {command.pending && (
        <Notice>
          {command.pending.description}
          {command.pending.kind === 'create' &&
            ' Check the team list before retrying an unconfirmed create; another attempt may create another team.'}
        </Notice>
      )}
      <fieldset disabled={inaccessible || !active || rechecking}>
        <CommandFeedback
          error={command.mutation.error}
          refreshError={command.refreshError}
          pending={Boolean(command.pending)}
          busy={command.busy}
          {...(command.mutation.isSuccess
            ? { confirmed: 'Team action confirmed.' }
            : {})}
          onRetry={command.retry}
          onReview={() => {
            command.review();
            void refresh().catch(() => {});
          }}
        />
      </fieldset>
      <details className="task-disclosure">
        <summary>Create a team</summary>
        <form className="form-stack compact-form" onSubmit={create}>
          <Field
            label="New team name"
            value={name}
            maxLength={160}
            disabled={!mutable}
            onChange={(event) => setName(event.target.value)}
            required
          />
          <p className="muted">
            Up to 80 characters. A team starts with an empty roster and no
            source access.
          </p>
          {validation && <Notice tone="error">{validation}</Notice>}
          <Button type="submit" disabled={!mutable}>
            Create team
          </Button>
        </form>
      </details>
      {teams.isFetching && <Notice>Loading teams…</Notice>}
      <div className="list" aria-label="Assignment teams">
        {teams.data?.items.map((team) => (
          <div className="list-row" key={team.id}>
            <div>
              <strong>{team.name}</strong>
              <p>
                {team.archived ? 'Archived · ' : ''}
                {team.members.length}{' '}
                {team.members.length === 1 ? 'member' : 'members'}
              </p>
            </div>
            <Button
              type="button"
              variant="secondary"
              aria-pressed={selected === team.id}
              disabled={command.busy || Boolean(command.pending)}
              onClick={() => setSelected(team.id)}
            >
              Review team {team.name}
            </Button>
          </div>
        ))}
      </div>
      {teams.data?.count === 0 && <p>No teams yet.</p>}
      <Pagination
        offset={offset}
        count={teams.data?.count ?? 0}
        limit={20}
        onChange={setOffset}
      />
      {selected && detail.isFetching && (
        <Notice>Loading the selected roster…</Notice>
      )}
      {detail.error && <Failure error={detail.error} />}
      {detail.data && (
        <SelectedTeam
          key={detail.data.id}
          team={detail.data}
          accountId={accountId}
          participations={participations.data?.items ?? []}
          version={version}
          active={active}
          locked={locked || !participations.data}
          assignmentArchived={assignment.archived}
          onCommand={run}
        />
      )}
    </section>
  );
}

function SelectedTeam({
  team,
  accountId,
  participations,
  version,
  active,
  locked,
  assignmentArchived,
  onCommand,
}: {
  team: AssignmentTeam;
  accountId: string;
  participations: readonly Participation[];
  version: Assignment['current_version'];
  active: boolean;
  locked: boolean;
  assignmentArchived: boolean;
  onCommand: (request: TeamCommand) => void;
}) {
  const [name, setName] = useState(team.name),
    [error, setError] = useState('');
  const [nameBase, setNameBase] = useState({
    name: team.name,
    revision: team.revision,
  });
  useEffect(() => {
    // A pristine or confirmed name can follow refreshed metadata; unsaved text
    // retains the revision it was edited against rather than overwriting a peer.
    if (name !== nameBase.name && name !== team.name) return;
    if (nameBase.name === team.name && nameBase.revision === team.revision)
      return;
    setName(team.name);
    setNameBase({ name: team.name, revision: team.revision });
  }, [name, nameBase, team.name, team.revision]);
  const [selectedMember, setSelectedMember] = useState('');
  const candidates = participations.filter(
    (record) =>
      record.effective_state === 'accepted' &&
      record.team_offer?.team_id !== team.id,
  );
  const candidate = candidates.find((record) => record.id === selectedMember);
  const mutable = !locked && !assignmentArchived && !team.archived;
  const eligibility = team.version_eligibility;
  const users = team.members.map((member) => member.user);
  const acceptedUsers = participations
    .filter((record) => record.effective_state === 'accepted')
    .map((record) => record.user);
  const roster = () =>
    team.members.map((member) => ({
      id: member.user.id,
      name: member.user.display_name,
      consented: member.consented,
    }));
  const review = (request: TeamCommand): Review => ({
    accountId,
    request: Object.freeze(request),
    roster: roster(),
  });
  function rename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!safeLabel(name, 80)) {
      setError(
        'Use a nonblank team name within 80 characters, without control characters.',
      );
      return;
    }
    if (!mutable) return;
    setError('');
    onCommand({
      kind: 'rename',
      teamId: team.id,
      revision: nameBase.revision,
      name,
      description: `Rename team “${team.name}” to “${name}”.`,
    });
  }
  return (
    <section
      className="content-section"
      aria-label={`Selected team: ${team.name}`}
    >
      <h3>
        {team.name}
        {team.archived ? ' · Archived' : ''}
      </h3>
      <p>
        Roster revision {team.roster_revision}. Teacher approval:{' '}
        {team.approved_roster_revision === team.roster_revision
          ? 'approved for this roster'
          : 'not approved for this roster'}
        .
      </p>
      <p role="status">
        Consent and approval:{' '}
        {team.consent_ready
          ? 'ready for this exact roster'
          : 'not ready for this exact roster'}
        .
      </p>
      <p className="muted">
        Consent readiness is separate from a published version’s team-size and
        submission-mode rules.
      </p>
      {version && eligibility?.assignment_version_id === version.id ? (
        <p>
          Policy fit for published version {version.number}:{' '}
          {eligibility.eligible
            ? 'fits this version'
            : eligibility.reason === 'mode_mismatch'
              ? 'this version requires individual work'
              : `this roster does not fit the version’s team size (maximum ${eligibility.max_team_size})`}
          . Existing work stays pinned to its own version.
        </p>
      ) : (
        <p>No published version policy is selected for this roster.</p>
      )}
      {team.members.length ? (
        <ul aria-label={`Exact roster for ${team.name}`}>
          {team.members.map((member) => {
            const memberName = rosterMemberLabel(member.user, accountId, users);
            const participant = participations.find(
              (record) =>
                record.id === member.participation_id &&
                record.user.id === member.user.id &&
                record.effective_state === 'accepted' &&
                record.team_offer?.team_id === team.id,
            );
            return (
              <li key={member.participation_id}>
                <p>
                  <strong>{memberName}</strong> ·{' '}
                  {member.consented
                    ? `Consented to roster ${team.roster_revision}`
                    : 'Consent pending'}
                </p>
                <TeamReview
                  active={active}
                  label={`Remove ${memberName} from team`}
                  title="Remove this team offer?"
                  description="Assignment participation stays accepted. This changes the roster and retires its affected learning work; existing source ownership and sharing stay in place."
                  disabled={locked || !participant}
                  prepare={() =>
                    participant
                      ? review({
                          kind: 'remove',
                          teamId: team.id,
                          revision: team.revision,
                          participationId: participant.id,
                          participationRevision: participant.revision,
                          description: `Remove ${memberName} from “${team.name}”.`,
                        })
                      : null
                  }
                  onConfirm={onCommand}
                />
              </li>
            );
          })}
        </ul>
      ) : (
        <p>The roster is empty.</p>
      )}
      <RosterReferences users={users} accountId={accountId} />
      <TeamReview
        active={active}
        label="Review exact roster approval"
        title="Approve this exact roster?"
        description="Approval records only this roster revision. It does not consent for learners, create source access or make missing consents ready."
        disabled={
          !mutable ||
          team.members.length < 2 ||
          team.members.length > 6 ||
          team.approved_roster_revision === team.roster_revision
        }
        prepare={() =>
          review({
            kind: 'approve',
            teamId: team.id,
            revision: team.revision,
            rosterRevision: team.roster_revision,
            description: `Approve roster ${team.roster_revision} for “${team.name}”.`,
          })
        }
        onConfirm={onCommand}
      />
      <details className="task-disclosure">
        <summary>Offer or move a participant</summary>
        <p>
          Only accepted assignment participants can receive a team offer. Moving
          a participant changes both team rosters, clears their approvals and
          retires affected learning work. Everyone must consent to the changed
          roster.
        </p>
        <p>
          Offering the same team again also starts a new roster revision, clears
          every current consent and approval, and retires affected work. Current
          accepted consent does not need renewal merely because its original
          offer date has passed.
        </p>
        <label htmlFor={`team-participant-${team.id}`}>
          Accepted participant
        </label>
        <select
          id={`team-participant-${team.id}`}
          value={selectedMember}
          disabled={!mutable}
          onChange={(event) => setSelectedMember(event.target.value)}
        >
          <option value="">Choose an accepted participant</option>
          {selectedMember && !candidate && (
            <option value={selectedMember} disabled>
              Selection changed; review current participants
            </option>
          )}
          {candidates.map((record) => (
            <option key={record.id} value={record.id}>
              {rosterMemberLabel(record.user, accountId, acceptedUsers)}
              {record.team_offer
                ? record.team_offer.team_id === team.id
                  ? ' — renew current team offer'
                  : ` — move from ${record.team_offer.name}`
                : ' — no team'}
            </option>
          ))}
        </select>
        <TeamReview
          active={active}
          label={
            candidate?.team_offer?.team_id === team.id
              ? 'Review renewed team offer'
              : 'Review team offer'
          }
          title={
            candidate?.team_offer?.team_id === team.id
              ? 'Start a new offer for this same team?'
              : 'Offer this participant the team?'
          }
          description={
            candidate?.team_offer?.team_id === team.id
              ? 'This starts a new roster revision, clears every member’s consent and teacher approval, and retires affected learning work. Existing source ownership and grants remain unchanged.'
              : 'This offers a roster; the learner must give their own consent. No existing source project is shared.'
          }
          disabled={!mutable || !candidate}
          prepare={() =>
            candidate
              ? review({
                  kind: 'offer',
                  teamId: team.id,
                  revision: team.revision,
                  participationId: candidate.id,
                  participationRevision: candidate.revision,
                  description:
                    candidate.team_offer?.team_id === team.id
                      ? `Renew the offer for ${rosterMemberLabel(candidate.user, accountId, acceptedUsers)} in “${team.name}”, starting a new roster generation.`
                      : `${candidate.team_offer ? `Move ${rosterMemberLabel(candidate.user, accountId, acceptedUsers)} from “${candidate.team_offer.name}”` : `Offer ${rosterMemberLabel(candidate.user, accountId, acceptedUsers)}`} to “${team.name}”.`,
                })
              : null
          }
          onConfirm={onCommand}
        />
      </details>
      <details className="task-disclosure">
        <summary>Team administration</summary>
        <form className="form-stack compact-form" onSubmit={rename}>
          <Field
            label="Team name"
            value={name}
            maxLength={160}
            disabled={!mutable}
            onChange={(event) => setName(event.target.value)}
            required
          />
          {error && <Notice tone="error">{error}</Notice>}
          {nameBase.revision !== team.revision && (
            <Notice>
              The team changed while you edited its name. Your text is retained;
              review the current name before replacing it.
              <Button
                type="button"
                variant="secondary"
                disabled={locked}
                onClick={() => {
                  setName(team.name);
                  setNameBase({ name: team.name, revision: team.revision });
                  setError('');
                }}
              >
                Use current team name
              </Button>
            </Notice>
          )}
          <Button type="submit" disabled={!mutable || name === team.name}>
            Save team name
          </Button>
        </form>
        <TeamReview
          active={active}
          label={team.archived ? 'Restore team' : 'Archive team'}
          title={team.archived ? 'Restore this team?' : 'Archive this team?'}
          description="Archiving retires active learning work for this team. Existing source projects and their ownership and grants are retained; restoring the team does not revive retired work."
          disabled={locked || assignmentArchived}
          prepare={() =>
            review({
              kind: 'archive',
              teamId: team.id,
              revision: team.revision,
              archived: !team.archived,
              description: `${team.archived ? 'Restore' : 'Archive'} team “${team.name}”.`,
            })
          }
          onConfirm={onCommand}
        />
      </details>
    </section>
  );
}

function TeamReview({
  active,
  label,
  title,
  description,
  disabled,
  prepare,
  onConfirm,
}: {
  active: boolean;
  label: string;
  title: string;
  description: string;
  disabled: boolean;
  prepare: () => Review | null;
  onConfirm: (request: TeamCommand) => void;
}) {
  const [review, setReview] = useState<Review | null>(null);
  const users =
    review?.roster.map((member) => ({
      id: member.id,
      display_name: member.name,
    })) ?? [];
  useEffect(() => {
    if (!active) setReview(null);
  }, [active]);
  return (
    <Dialog
      title={title}
      description={description}
      open={Boolean(review)}
      onCloseAutoFocus={(event) => {
        if (disabled || !active) {
          event.preventDefault();
          if (active)
            document.getElementById('teaching-teams-heading')?.focus();
        }
      }}
      onOpenChange={(open) => setReview(open ? prepare() : null)}
      trigger={
        <Button
          type="button"
          variant="secondary"
          disabled={disabled || !active}
        >
          {label}
        </Button>
      }
    >
      {review && (
        <>
          <p>{review.request.description}</p>
          {review.roster.length > 0 && (
            <>
              <h3>Roster shown for this action</h3>
              <ul>
                {review.roster.map((member) => (
                  <li key={member.id}>
                    {rosterMemberLabel(
                      { id: member.id, display_name: member.name },
                      review.accountId,
                      users,
                    )}{' '}
                    · {member.consented ? 'consented' : 'consent pending'}
                  </li>
                ))}
              </ul>
              <RosterReferences users={users} accountId={review.accountId} />
            </>
          )}
          <Button
            type="button"
            disabled={disabled || !active}
            onClick={() => {
              onConfirm(review.request);
              setReview(null);
            }}
          >
            Confirm team action
          </Button>
        </>
      )}
    </Dialog>
  );
}
