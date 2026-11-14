import { useEffect, useId, useState, type ComponentProps } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, Dialog, Notice } from '@code-along/design-system';
import { Failure } from '../../api/feedback.tsx';
import { queryClient } from '../../app/providers.tsx';
import { participationApi } from './participation-api.ts';
import { CommandFeedback, useLearningCommand } from './command.tsx';
import { formatPublicationTime } from './presentation.ts';
import { TeamRoster } from './team-roster.tsx';
import { AssignmentWorkList } from './work-list.tsx';
import { CreateAssignmentWork } from './work-create.tsx';
import { OLD_WORK_NOTICE } from './work-model.ts';
import type { Assignment } from './types.ts';
import type {
  AssignmentTeam,
  ParticipationAction,
} from './participation-types.ts';

type SelfRequest = Readonly<
  | { kind: 'participation'; action: ParticipationAction; revision: number }
  | {
      kind: 'consent';
      revision: number;
      teamId: string;
      rosterRevision: number;
    }
  | {
      kind: 'leave-team';
      revision: number;
      teamId: string;
      teamRevision: number;
      participationId: string;
    }
>;
function InViewDialog({
  active,
  ...props
}: ComponentProps<typeof Dialog> & { active: boolean }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!active) setOpen(false);
  }, [active]);
  return <Dialog {...props} open={active && open} onOpenChange={setOpen} />;
}
export function MyAssignmentWork({
  assignment,
  accountId,
  active,
  paused,
  onRefreshAssignment,
}: {
  assignment: Assignment;
  accountId: string;
  active: boolean;
  paused: boolean;
  onRefreshAssignment: () => Promise<unknown>;
}) {
  const own = useQuery({
    queryKey: ['assignment-participation', accountId, assignment.id],
    queryFn: ({ signal }) => participationApi.own(assignment.id, signal),
    enabled: active,
  });
  const participation = own.data;
  const teamId = participation?.team_offer?.team_id;
  const team = useQuery({
    queryKey: [
      'assignment-team',
      accountId,
      assignment.id,
      teamId,
      assignment.current_version?.id,
    ],
    queryFn: ({ signal }) =>
      participationApi.team(
        assignment.id,
        teamId!,
        assignment.current_version?.id,
        signal,
      ),
    enabled: active && Boolean(teamId),
  });
  const [consentPreview, setConsentPreview] = useState<AssignmentTeam | null>(
    null,
  );
  const [consentRevision, setConsentRevision] = useState<number | null>(null);
  const [selfPreview, setSelfPreview] = useState<Extract<
    SelfRequest,
    { kind: 'participation' }
  > | null>(null);
  const [leavePreview, setLeavePreview] = useState<{
    team: AssignmentTeam;
    request: Extract<SelfRequest, { kind: 'leave-team' }>;
  } | null>(null);
  const [rechecking, setRechecking] = useState(false),
    [checkError, setCheckError] = useState<unknown>(null);
  const acceptTrigger = useId(),
    declineTrigger = useId(),
    withdrawTrigger = useId(),
    consentTrigger = useId(),
    leaveTrigger = useId();
  async function refresh() {
    setRechecking(true);
    setCheckError(null);
    try {
      await onRefreshAssignment();
      const latest = await own.refetch({ throwOnError: true });
      if (latest.data?.team_offer?.team_id === teamId && teamId)
        await team.refetch({ throwOnError: true });
      await Promise.all(
        [
          'assignment-works',
          'assignment-work',
          'assignment-teams',
          'assignment-participations',
          'assignment-team-participations',
        ].map((prefix) =>
          queryClient.invalidateQueries(
            { queryKey: [prefix, accountId, assignment.id] },
            { throwOnError: true },
          ),
        ),
      );
    } catch (error) {
      setCheckError(error);
      throw error;
    } finally {
      setRechecking(false);
    }
  }
  const command = useLearningCommand<SelfRequest, unknown>(
    accountId,
    `${assignment.id}:self`,
    (request) => {
      if (request.kind === 'participation')
        return participationApi.self(
          assignment.id,
          request.action,
          request.revision,
        );
      if (request.kind === 'consent')
        return participationApi.consent(assignment.id, {
          expected_revision: request.revision,
          team_id: request.teamId,
          roster_revision: request.rosterRevision,
        });
      return participationApi.removeTeam(
        assignment.id,
        request.teamId,
        request.participationId,
        request.teamRevision,
        request.revision,
      );
    },
    refresh,
  );
  const locked =
    paused ||
    rechecking ||
    Boolean(checkError) ||
    Boolean(own.error) ||
    own.isFetching ||
    command.busy ||
    Boolean(command.pending) ||
    Boolean(command.refreshError);
  const teamLocked = locked || Boolean(team.error) || team.isFetching;
  const closeFocus = (id: string) => (event: Event) => {
    const trigger = document.getElementById(id);
    if (
      !trigger ||
      trigger.matches(':disabled') ||
      trigger.closest('[hidden]')
    ) {
      event.preventDefault();
      document
        .querySelector<HTMLElement>('.learning-view:not([hidden])')
        ?.focus();
    }
  };
  const hasConsent =
    participation?.team_offer &&
    team.data &&
    participation.team_offer.consented_revision === team.data.roster_revision;
  const canAccept = !assignment.archived && Boolean(participation?.can_accept);
  const currentSelfPreview = (action: ParticipationAction) =>
    selfPreview?.action === action &&
    selfPreview.revision === participation?.revision &&
    (action === 'accept'
      ? canAccept
      : action === 'withdraw'
        ? Boolean(participation?.can_withdraw)
        : participation?.state === 'invited');
  function previewSelf(action: ParticipationAction) {
    if (locked || !participation) return;
    setSelfPreview(
      Object.freeze({
        kind: 'participation',
        action,
        revision: participation.revision,
      }),
    );
  }
  function confirmSelf(action: ParticipationAction) {
    if (!locked && selfPreview && currentSelfPreview(action))
      command.run(selfPreview);
  }
  const currentConsentPreview = Boolean(
    consentPreview &&
    !assignment.archived &&
    !team.data?.archived &&
    participation?.effective_state === 'accepted' &&
    participation.revision === consentRevision &&
    participation.team_offer?.team_id === consentPreview.id &&
    team.data?.id === consentPreview.id &&
    consentPreview.roster_revision === team.data.roster_revision,
  );
  const currentLeavePreview = Boolean(
    leavePreview &&
    participation?.revision === leavePreview.request.revision &&
    participation.id === leavePreview.request.participationId &&
    participation.team_offer?.team_id === leavePreview.request.teamId &&
    team.data?.id === leavePreview.request.teamId &&
    team.data.revision === leavePreview.request.teamRevision,
  );
  return (
    <>
      <section
        className="content-section"
        aria-labelledby="my-participation-heading"
      >
        <div className="section-head">
          <h2 id="my-participation-heading">My participation</h2>
          <Button
            variant="secondary"
            busy={rechecking || own.isFetching || team.isFetching}
            onClick={() => {
              void refresh()
                .then(() => {
                  if (command.refreshError && !command.pending)
                    command.review();
                })
                .catch(() => undefined);
            }}
          >
            Refresh my work
          </Button>
        </div>
        <p>
          Reading this assignment is not enrollment. Only you can accept your
          participation offer or consent to an exact team roster.
        </p>
        {own.error && <Failure error={own.error} />}{' '}
        {Boolean(checkError) && <Failure error={checkError} />}
        {own.isFetching && <Notice>Checking your participation…</Notice>}
        {own.isSuccess && participation === null && (
          <p>
            No participation offer is available for this account. Ask a
            workspace teacher if you should take part.
          </p>
        )}
        {participation && (
          <>
            <p className="badge">
              {participation.effective_state === 'expired'
                ? 'Offer expired'
                : participation.effective_state[0]!.toUpperCase() +
                  participation.effective_state.slice(1)}
            </p>
            {participation.state === 'invited' && (
              <p>
                Offer expiry:{' '}
                <time dateTime={participation.invite_expires_at}>
                  {formatPublicationTime(participation.invite_expires_at)}
                </time>
              </p>
            )}
            {participation.state === 'accepted' &&
              participation.accepted_at && (
                <p>
                  Accepted{' '}
                  <time dateTime={participation.accepted_at}>
                    {formatPublicationTime(participation.accepted_at)}
                  </time>
                  . An accepted participation does not expire when its original
                  offer date passes.
                </p>
              )}
            <div className="actions">
              {participation.can_accept && (
                <InViewDialog
                  active={active}
                  title="Accept this participation offer?"
                  description="You will become an accepted participant in this assignment. This does not consent to any team roster or share an existing source project."
                  trigger={
                    <Button
                      id={acceptTrigger}
                      disabled={locked || !canAccept}
                      onClick={() => previewSelf('accept')}
                    >
                      Accept participation
                    </Button>
                  }
                  onCloseAutoFocus={closeFocus(acceptTrigger)}
                >
                  {selfPreview && !currentSelfPreview('accept') && (
                    <Notice>
                      This offer changed. Close this review and refresh before
                      accepting it.
                    </Notice>
                  )}
                  <Button
                    disabled={locked || !currentSelfPreview('accept')}
                    busy={command.busy}
                    onClick={() => confirmSelf('accept')}
                  >
                    Confirm participation acceptance
                  </Button>
                </InViewDialog>
              )}
              {participation.state === 'invited' && (
                <InViewDialog
                  active={active}
                  title="Decline this participation offer?"
                  description="You can read the published assignment while you remain a workspace member. Taking part later will require a new teacher offer."
                  trigger={
                    <Button
                      id={declineTrigger}
                      variant="secondary"
                      disabled={locked}
                      onClick={() => previewSelf('decline')}
                    >
                      Decline participation
                    </Button>
                  }
                  onCloseAutoFocus={closeFocus(declineTrigger)}
                >
                  {selfPreview && !currentSelfPreview('decline') && (
                    <Notice>
                      This offer changed. Close this review and refresh before
                      declining it.
                    </Notice>
                  )}
                  <Button
                    variant="secondary"
                    disabled={locked || !currentSelfPreview('decline')}
                    onClick={() => confirmSelf('decline')}
                  >
                    Confirm participation decline
                  </Button>
                </InViewDialog>
              )}
              {participation.can_withdraw && (
                <InViewDialog
                  active={active}
                  title="Withdraw from this assignment?"
                  description={`This ends current assignment eligibility, removes your team offer and retires affected learning work. ${OLD_WORK_NOTICE}`}
                  trigger={
                    <Button
                      id={withdrawTrigger}
                      variant="secondary"
                      disabled={locked}
                      onClick={() => previewSelf('withdraw')}
                    >
                      Withdraw participation
                    </Button>
                  }
                  onCloseAutoFocus={closeFocus(withdrawTrigger)}
                >
                  {selfPreview && !currentSelfPreview('withdraw') && (
                    <Notice>
                      Your participation changed. Close this review and refresh
                      before withdrawing.
                    </Notice>
                  )}
                  <Button
                    variant="danger"
                    disabled={locked || !currentSelfPreview('withdraw')}
                    onClick={() => confirmSelf('withdraw')}
                  >
                    Confirm participation withdrawal
                  </Button>
                </InViewDialog>
              )}
            </div>
            {['declined', 'withdrawn', 'revoked'].includes(
              participation.state,
            ) && (
              <p>
                A new teacher offer and your fresh acceptance are required
                before taking part again. Existing project access remains
                separate.
              </p>
            )}
          </>
        )}
        <CommandFeedback
          error={command.mutation.error}
          refreshError={command.refreshError}
          pending={Boolean(command.pending)}
          busy={command.busy}
          {...(command.mutation.isSuccess
            ? { confirmed: 'Your participation action is confirmed.' }
            : {})}
          onRetry={command.retry}
          onReview={() => {
            command.review();
            void refresh().catch(() => undefined);
          }}
        />
      </section>
      {participation?.team_offer && (
        <section className="content-section" aria-label="My offered team">
          <h2>My team roster</h2>
          <p>
            Accepting participation and consenting to this exact roster are
            separate decisions. No existing project is shared by accepting an
            offer.
          </p>
          {team.error && <Failure error={team.error} />}{' '}
          {team.isFetching && <Notice>Checking the offered roster…</Notice>}
          {team.data && (
            <>
              <TeamRoster
                team={team.data}
                accountId={accountId}
                {...(assignment.current_version
                  ? { versionNumber: assignment.current_version.number }
                  : {})}
              />
              {hasConsent ? (
                <p>
                  Your consent covers this exact roster revision. Its original
                  offer expiry does not end accepted current consent.
                </p>
              ) : (
                <p>
                  New consent offer expiry:{' '}
                  <time dateTime={participation.team_offer.expires_at}>
                    {formatPublicationTime(participation.team_offer.expires_at)}
                  </time>
                </p>
              )}
              <div className="actions">
                {!hasConsent && (
                  <InViewDialog
                    active={active}
                    title="Consent to this exact team roster?"
                    description="Review every account below. Consent applies only to this roster revision; changing its members requires fresh consent. This action does not share any source project."
                    trigger={
                      <Button
                        id={consentTrigger}
                        disabled={
                          teamLocked ||
                          assignment.archived ||
                          team.data.archived ||
                          participation.effective_state !== 'accepted'
                        }
                        onClick={() => {
                          setConsentPreview(structuredClone(team.data!));
                          setConsentRevision(participation.revision);
                        }}
                      >
                        Review team consent
                      </Button>
                    }
                    onCloseAutoFocus={closeFocus(consentTrigger)}
                  >
                    {consentPreview && (
                      <TeamRoster team={consentPreview} accountId={accountId} />
                    )}
                    {consentPreview && !currentConsentPreview && (
                      <Notice>
                        Your participation or team changed. Close this review
                        and refresh before consenting.
                      </Notice>
                    )}
                    <Button
                      disabled={teamLocked || !currentConsentPreview}
                      onClick={() => {
                        if (
                          teamLocked ||
                          !currentConsentPreview ||
                          !consentPreview
                        )
                          return;
                        command.run(
                          Object.freeze({
                            kind: 'consent',
                            revision: consentRevision!,
                            teamId: consentPreview.id,
                            rosterRevision: consentPreview.roster_revision,
                          }),
                        );
                      }}
                    >
                      Consent to this exact roster
                    </Button>
                  </InViewDialog>
                )}
                <InViewDialog
                  active={active}
                  title="Leave this team roster?"
                  description={`Your accepted assignment participation stays in place. The changed roster will need fresh consent and approval. ${OLD_WORK_NOTICE}`}
                  trigger={
                    <Button
                      id={leaveTrigger}
                      variant="secondary"
                      disabled={teamLocked}
                      onClick={() => {
                        if (teamLocked || !team.data) return;
                        setLeavePreview({
                          team: structuredClone(team.data),
                          request: Object.freeze({
                            kind: 'leave-team',
                            revision: participation.revision,
                            teamId: team.data.id,
                            teamRevision: team.data.revision,
                            participationId: participation.id,
                          }),
                        });
                      }}
                    >
                      Leave team
                    </Button>
                  }
                  onCloseAutoFocus={closeFocus(leaveTrigger)}
                >
                  {leavePreview && (
                    <TeamRoster
                      team={leavePreview.team}
                      accountId={accountId}
                    />
                  )}
                  {leavePreview && !currentLeavePreview && (
                    <Notice>
                      Your participation or team changed. Close this review and
                      refresh before leaving a team.
                    </Notice>
                  )}
                  <Button
                    variant="danger"
                    disabled={teamLocked || !currentLeavePreview}
                    onClick={() => {
                      if (!teamLocked && currentLeavePreview && leavePreview)
                        command.run(leavePreview.request);
                    }}
                  >
                    Confirm leave team
                  </Button>
                </InViewDialog>
              </div>
            </>
          )}
        </section>
      )}
      <CreateAssignmentWork
        assignment={assignment}
        accountId={accountId}
        participation={participation ?? null}
        team={team.data ?? null}
        paused={locked || Boolean(teamId && (team.error || team.isFetching))}
        active={active}
        onRefresh={refresh}
      />
      <AssignmentWorkList
        assignmentId={assignment.id}
        accountId={accountId}
        active={active}
      />
    </>
  );
}
