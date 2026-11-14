import { useEffect, useId, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { Button, Dialog, Field, Notice } from '@code-along/design-system';
import { Failure } from '../../api/feedback.tsx';
import { participationApi } from './participation-api.ts';
import { useLearningCommand } from './command.tsx';
import { RosterReferences, rosterMemberLabel } from './roster-identity.tsx';
import {
  participationConflict,
  sameProposalScope,
  workProposal,
  type WorkProposal,
} from './work-model.ts';
import type { Assignment } from './types.ts';
import type {
  AssignmentTeam,
  AssignmentWork,
  Participation,
  WorkRequest,
} from './participation-types.ts';

export function CreateAssignmentWork({
  assignment,
  accountId,
  participation,
  team,
  paused,
  active,
  onRefresh,
}: {
  assignment: Assignment;
  accountId: string;
  participation: Participation | null;
  team: AssignmentTeam | null;
  paused: boolean;
  active: boolean;
  onRefresh: () => Promise<unknown>;
}) {
  const [name, setName] = useState(''),
    [preview, setPreview] = useState<WorkProposal | null>(null),
    [open, setOpen] = useState(false),
    [error, setError] = useState('');
  const triggerId = useId();
  useEffect(() => {
    if (!active) setOpen(false);
  }, [active]);
  const command = useLearningCommand<WorkRequest, AssignmentWork>(
    accountId,
    `${assignment.id}:create-work`,
    (request) => participationApi.createWork(assignment.id, request),
    onRefresh,
  );
  const version = assignment.current_version;
  const teamMode = version?.submission_mode === 'team';
  const accepted = participation?.effective_state === 'accepted';
  const eligible =
    accepted &&
    (!teamMode ||
      Boolean(
        team?.consent_ready &&
        team.version_eligibility?.assignment_version_id === version?.id &&
        team.version_eligibility.eligible,
      ));
  const locked =
    paused ||
    command.busy ||
    Boolean(command.pending) ||
    Boolean(command.refreshError);
  function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (locked || !participation) return;
    try {
      setPreview(
        workProposal(
          assignment,
          participation,
          team,
          accountId,
          name,
          crypto.randomUUID(),
        ),
      );
      setError('');
      setOpen(true);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Review current participation and the published version first.',
      );
    }
  }
  const currentPreview =
    preview && sameProposalScope(preview, assignment, participation, team);
  const users =
    preview?.roster.map((member) => ({
      id: member.id,
      display_name: member.display_name,
    })) ?? [];
  return (
    <section className="content-section" aria-labelledby="new-work-heading">
      <h2 id="new-work-heading">Start from the published starter</h2>
      {!version ? (
        <p>No version has been published yet.</p>
      ) : (
        <>
          <p>
            New work uses published version {version.number}: {version.title}.
            You will own a new project. Existing work on other versions stays
            available separately.
          </p>
          {version.due_at && (
            <p className="muted">
              The pinned due date governs later submissions. Starting or running
              practice does not permit a late submission.
            </p>
          )}
          {teamMode && (
            <p className="muted">
              Only the approved teammates listed in your review can edit the new
              project. Existing projects keep their current sharing.
            </p>
          )}
          {!accepted && (
            <Notice>
              Accept your own participation offer before starting work.
            </Notice>
          )}
          {accepted && teamMode && !eligible && (
            <Notice>
              The exact team roster needs every current member’s consent and
              teacher approval, and must fit this published version. Existing
              eligible work on a different pinned version remains separate.
            </Notice>
          )}
          <form className="form-stack compact-form" onSubmit={review}>
            <Field
              label="New work project name"
              value={name}
              required
              disabled={locked || assignment.archived}
              onChange={(event) => setName(event.target.value)}
            />
            <Button
              id={triggerId}
              type="submit"
              aria-haspopup="dialog"
              aria-expanded={open}
              disabled={locked || !eligible || assignment.archived}
            >
              {teamMode
                ? 'Review team work creation'
                : 'Review individual work creation'}
            </Button>
          </form>
          <Dialog
            open={active && open}
            onOpenChange={setOpen}
            title={
              preview?.request.sharing === 'approved_team_editors'
                ? 'Create team work?'
                : 'Start individual work?'
            }
            description={
              preview?.request.sharing === 'approved_team_editors'
                ? `You will own a new project. These approved, consenting team members will receive editor access: ${preview.roster
                    .filter((member) => member.role === 'editor')
                    .map((member) =>
                      rosterMemberLabel(member, accountId, users),
                    )
                    .join(', ')}. This does not share any existing project.`
                : 'You will own a new private project from this frozen published starter. This does not share or replace any existing project.'
            }
            trigger={<span hidden />}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              const trigger = document.getElementById(triggerId);
              if (
                trigger &&
                !trigger.matches(':disabled') &&
                !trigger.closest('[hidden]')
              )
                trigger.focus();
              else
                document
                  .querySelector<HTMLElement>('.learning-view:not([hidden])')
                  ?.focus();
            }}
          >
            {preview && (
              <>
                <p>
                  <strong>{preview.request.project_name}</strong> · Published
                  version {preview.version.number}
                </p>
                <p>
                  {preview.request.sharing === 'private'
                    ? 'Private individual work'
                    : 'These teammates can edit the new project'}
                </p>
                <ul className="learning-roster">
                  {preview.roster.map((member) => (
                    <li key={member.id}>
                      <span>{rosterMemberLabel(member, accountId, users)}</span>
                      <strong>
                        {member.role === 'owner'
                          ? 'Project owner'
                          : 'Editor access'}
                      </strong>
                    </li>
                  ))}
                </ul>
                <RosterReferences users={users} accountId={accountId} />
                {preview.request.sharing === 'approved_team_editors' && (
                  <p>
                    You own the new project. Every other listed teammate can
                    edit it. This does not change access to existing projects.
                  </p>
                )}
                {!currentPreview && (
                  <Notice>
                    Participation, publication or roster changed. Close this
                    review and refresh before making a new request.
                  </Notice>
                )}
                <Button
                  busy={command.busy}
                  disabled={locked || !currentPreview}
                  onClick={() => {
                    if (!currentPreview) return;
                    command.run(preview.request);
                    setOpen(false);
                  }}
                >
                  {preview.request.sharing === 'private'
                    ? 'Start individual work'
                    : 'Create team work'}
                </Button>
              </>
            )}
          </Dialog>
        </>
      )}
      {command.mutation.isPending && (
        <p role="status">Checking the current account and requesting work…</p>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      {command.mutation.error && (
        <>
          {participationConflict(command.mutation.error) ? (
            <Notice tone="error">
              {participationConflict(command.mutation.error)}
            </Notice>
          ) : (
            <Failure error={command.mutation.error} />
          )}
          <p>
            We could not confirm whether work was created. Retrying checks the
            same request without creating another copy or changing its sharing.
          </p>
        </>
      )}
      {command.pending && !command.busy && (
        <div className="actions">
          <Button disabled={paused} onClick={command.retry}>
            Retry same work request
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              command.review();
              setPreview(null);
              void onRefresh().catch(() => undefined);
            }}
          >
            Review before new work request
          </Button>
        </div>
      )}
      {Boolean(command.refreshError) && (
        <>
          <Notice tone="error">
            Work is confirmed, but the current list could not be refreshed.
          </Notice>
          <Button
            type="button"
            variant="secondary"
            disabled={paused || command.busy}
            onClick={() => {
              void onRefresh()
                .then(() => command.review())
                .catch(() => undefined);
            }}
          >
            Recheck My work
          </Button>
        </>
      )}
      {command.mutation.isSuccess && command.mutation.data && (
        <Notice tone="success">
          Work confirmed.{' '}
          <Link
            to={`/assignments/${assignment.id}/works/${command.mutation.data.id}`}
          >
            {command.mutation.data.can_continue ? 'Continue work' : 'View work'}
          </Link>
        </Notice>
      )}
    </section>
  );
}
