import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, Dialog, Notice } from '@code-along/design-system';
import { productApi } from '../../api/product.ts';
import { Failure } from '../../api/feedback.tsx';
import { queryClient } from '../../app/providers.tsx';
import { Pagination } from '../../components/pagination.tsx';
import { CommandFeedback, useLearningCommand } from './command.tsx';
import { participationApi } from './participation-api.ts';
import type { LearningUser, Participation } from './participation-types.ts';
import { formatPublicationTime } from './presentation.ts';
import {
  matchingRosterNames,
  RosterReferences,
  rosterMemberLabel,
} from './roster-identity.tsx';
import type { Assignment } from './types.ts';
import { AssignmentWorkList } from './work-list.tsx';
import { OLD_WORK_NOTICE } from './work-model.ts';

type OfferRequest = Readonly<{
  kind: 'offer';
  recipientId: string;
  label: string;
  expectedRevision?: number;
}>;
type RosterRequest =
  | OfferRequest
  | Readonly<{
      kind: 'revoke';
      participationId: string;
      revision: number;
      label: string;
    }>;
interface ReviewSnapshot {
  request: RosterRequest;
  references: readonly LearningUser[];
}
type TeachingRosterProps = {
  assignment: Assignment;
  accountId: string;
  active: boolean;
  paused: boolean;
  onRefreshAssignment: () => Promise<unknown>;
};

export function TeachingRoster(props: TeachingRosterProps) {
  return props.assignment.can_author ? (
    <ScopedTeachingRoster
      key={`${props.accountId}:${props.assignment.id}`}
      {...props}
    />
  ) : null;
}

function ScopedTeachingRoster({
  assignment,
  accountId,
  active,
  paused,
  onRefreshAssignment,
}: TeachingRosterProps) {
  const [offset, setOffset] = useState(0),
    [memberOffset, setMemberOffset] = useState(0);
  const [offerOpen, setOfferOpen] = useState(false),
    [workOpen, setWorkOpen] = useState(false);
  const [recipient, setRecipient] = useState<LearningUser | null>(null);
  const [rechecking, setRechecking] = useState(false),
    [readError, setReadError] = useState<unknown>(null);
  const roster = useQuery({
    queryKey: ['assignment-participations', accountId, assignment.id, offset],
    queryFn: ({ signal }) =>
      participationApi.roster(assignment.id, offset, signal),
    enabled: active,
  });
  const members = useQuery({
    queryKey: [
      'assignment-participation-members',
      accountId,
      assignment.workspace_id,
      memberOffset,
    ],
    queryFn: () => productApi.members(assignment.workspace_id, memberOffset),
    enabled: active && offerOpen,
  });
  async function refresh() {
    setRechecking(true);
    setReadError(null);
    try {
      await onRefreshAssignment();
      await Promise.all(
        [
          'assignment-participation',
          'assignment-participations',
          'assignment-teams',
          'assignment-team',
          'assignment-team-participations',
          'assignment-works',
          'assignment-work',
        ].map((prefix) =>
          queryClient.invalidateQueries({
            queryKey: [prefix, accountId, assignment.id],
            refetchType: 'none',
          }),
        ),
      );
      await Promise.all([
        roster.refetch({ throwOnError: true }),
        ...(offerOpen ? [members.refetch({ throwOnError: true })] : []),
        queryClient.refetchQueries(
          {
            queryKey: ['assignment-works', accountId, assignment.id],
            type: 'active',
          },
          { throwOnError: true },
        ),
      ]);
    } catch (error) {
      setReadError(error);
      throw error;
    } finally {
      setRechecking(false);
    }
  }
  const command = useLearningCommand<RosterRequest, Participation>(
    accountId,
    `${assignment.id}:teaching-roster`,
    (request) =>
      request.kind === 'offer'
        ? participationApi.offer(
            assignment.id,
            request.recipientId,
            request.expectedRevision,
          )
        : participationApi.revoke(
            assignment.id,
            request.participationId,
            request.revision,
          ),
    refresh,
  );
  const locked =
    !active ||
    paused ||
    rechecking ||
    command.busy ||
    Boolean(command.pending) ||
    Boolean(command.refreshError) ||
    Boolean(readError) ||
    Boolean(roster.error) ||
    !roster.data ||
    (offerOpen && Boolean(members.error));
  const canOffer = !locked && !assignment.archived;
  const rosterUsers = roster.data?.items.map((record) => record.user) ?? [];
  const chooserUsers = [
    ...new Map(
      [
        ...(recipient ? [recipient] : []),
        ...(members.data?.items.map((member) => ({
          id: member.user_id,
          display_name: member.display_name,
        })) ?? []),
      ].map((user) => [user.id, user]),
    ).values(),
  ];
  const selectedRecipient =
    chooserUsers.find((user) => user.id === recipient?.id) ?? null;
  const listed = new Set(rosterUsers.map((user) => user.id));
  const selectedHasRecord = recipient ? listed.has(recipient.id) : false;
  function snapshot(
    request: RosterRequest,
    user: LearningUser,
    users: readonly LearningUser[],
  ): ReviewSnapshot {
    return {
      request: Object.freeze(request),
      references: users
        .filter(
          (person) =>
            person.id === user.id || matchingRosterNames(user, [user, person]),
        )
        .map((person) => ({ ...person })),
    };
  }
  function run(request: RosterRequest) {
    if (!locked) command.run(request);
  }
  return (
    <section
      className="assignment-author"
      aria-labelledby="teaching-roster-heading"
    >
      <div className="section-head">
        <div>
          <h2
            id="teaching-roster-heading"
            className="learning-view"
            tabIndex={-1}
          >
            Participation
          </h2>
          <p className="muted">
            Offer a place to an existing workspace member. Only that recipient
            can accept; reading the assignment does not enroll them.
          </p>
        </div>
        <Button
          type="button"
          variant="secondary"
          busy={rechecking || roster.isFetching}
          disabled={!active || paused || command.busy}
          onClick={() => {
            void refresh()
              .then(() => {
                if (command.refreshError && !command.pending) command.review();
              })
              .catch(() => {});
          }}
        >
          Refresh participation
        </Button>
      </div>
      <p className="muted">{OLD_WORK_NOTICE}</p>
      {assignment.archived && (
        <Notice>
          This assignment is archived. New offers and re-offers are paused. You
          can still revoke current participation.
        </Notice>
      )}
      {roster.error && <Failure error={roster.error} />}
      {Boolean(readError) && !roster.error && !(offerOpen && members.error) && (
        <Failure error={readError} />
      )}
      {command.pending && (
        <Notice>
          {command.pending.kind === 'revoke'
            ? `Revocation requested for ${command.pending.label}.`
            : `Participation offer requested for ${command.pending.label}.`}{' '}
          The result is not confirmed until the action completes.
        </Notice>
      )}
      <fieldset disabled={!active || paused || rechecking}>
        <CommandFeedback
          error={command.mutation.error}
          refreshError={command.refreshError}
          pending={Boolean(command.pending)}
          busy={command.busy}
          {...(command.mutation.isSuccess
            ? { confirmed: 'Participation action confirmed.' }
            : {})}
          onRetry={command.retry}
          onReview={() => {
            command.review();
            void refresh().catch(() => {});
          }}
        />
      </fieldset>
      <details
        className="task-disclosure"
        open={offerOpen}
        onToggle={(event) => setOfferOpen(event.currentTarget.open)}
      >
        <summary>Offer participation</summary>
        <section
          className="form-stack compact-form"
          aria-label="Workspace member choices for participation"
        >
          <p>
            Choose an existing workspace member. They must accept their own
            offer before taking part. Existing records are re-offered from their
            participation row below.
          </p>
          {members.isFetching && <Notice>Loading workspace members…</Notice>}
          {members.error && <Failure error={members.error} />}
          <label htmlFor="participation-recipient">
            Participation recipient
          </label>
          <select
            id="participation-recipient"
            value={recipient?.id ?? ''}
            disabled={!canOffer || !members.data}
            onChange={(event) => {
              const member = members.data?.items.find(
                (person) => person.user_id === event.target.value,
              );
              setRecipient(
                member
                  ? { id: member.user_id, display_name: member.display_name }
                  : null,
              );
            }}
          >
            <option value="">Choose a workspace member</option>
            {recipient &&
              !members.data?.items.some(
                (member) => member.user_id === recipient.id,
              ) && (
                <option value={recipient.id}>
                  {rosterMemberLabel(recipient, accountId, chooserUsers)} —
                  selected from another page
                </option>
              )}
            {members.data?.items.map((member) => (
              <option
                key={member.user_id}
                value={member.user_id}
                disabled={listed.has(member.user_id)}
              >
                {rosterMemberLabel(
                  { id: member.user_id, display_name: member.display_name },
                  accountId,
                  chooserUsers,
                )}
                {listed.has(member.user_id)
                  ? ' — participation record below'
                  : ''}
              </option>
            ))}
          </select>
          <RosterReferences users={chooserUsers} accountId={accountId} />
          {selectedHasRecord && (
            <p>
              This member already has a participation record on this page.
              Review that row to re-offer or revoke participation.
            </p>
          )}
          <ParticipationDialog
            active={active}
            accountId={accountId}
            label="Review participation offer"
            title="Offer participation?"
            description="This sends a participation offer to the selected account. It does not accept for them, add them to a team or share any source project."
            disabled={!canOffer || !selectedRecipient || selectedHasRecord}
            prepare={() =>
              selectedRecipient
                ? snapshot(
                    {
                      kind: 'offer',
                      recipientId: selectedRecipient.id,
                      label: rosterMemberLabel(
                        selectedRecipient,
                        accountId,
                        chooserUsers,
                      ),
                    },
                    selectedRecipient,
                    chooserUsers,
                  )
                : null
            }
            onConfirm={run}
          />
          <Pagination
            offset={memberOffset}
            count={members.data?.count ?? 0}
            limit={100}
            onChange={setMemberOffset}
          />
        </section>
      </details>
      {roster.isFetching && <Notice>Loading participation records…</Notice>}
      <div className="list" aria-label="Assignment participation records">
        {roster.data?.items.map((record) => {
          const label = rosterMemberLabel(record.user, accountId, rosterUsers);
          const reoffer = [
            'expired',
            'declined',
            'withdrawn',
            'revoked',
          ].includes(record.effective_state);
          const revoke =
            record.effective_state === 'invited' ||
            record.effective_state === 'accepted';
          return (
            <section
              className="list-row"
              key={record.id}
              aria-label={`Participation: ${label}`}
            >
              <div>
                <h3>{label}</h3>
                <p>
                  Participation:{' '}
                  {record.effective_state[0]!.toUpperCase() +
                    record.effective_state.slice(1)}
                </p>
                {record.state === 'invited' && (
                  <p>
                    {record.effective_state === 'expired'
                      ? 'Offer expired'
                      : 'Offer expires'}{' '}
                    <time dateTime={record.invite_expires_at}>
                      {formatPublicationTime(record.invite_expires_at)}
                    </time>
                  </p>
                )}
                {record.team_offer && (
                  <p>
                    Team offer: {record.team_offer.name}.{' '}
                    {record.team_offer.consented_revision ===
                    record.team_offer.roster_revision
                      ? 'Consent is recorded for the current roster.'
                      : 'Consent is needed for the current roster.'}
                  </p>
                )}
              </div>
              <div className="actions">
                {reoffer && (
                  <ParticipationDialog
                    active={active}
                    accountId={accountId}
                    label="Re-offer participation"
                    title="Offer participation again?"
                    description="This creates a fresh offer on the existing record. The recipient must accept again; no previous team consent or learning eligibility is restored automatically."
                    disabled={!canOffer}
                    prepare={() =>
                      snapshot(
                        {
                          kind: 'offer',
                          recipientId: record.user.id,
                          expectedRevision: record.revision,
                          label,
                        },
                        record.user,
                        rosterUsers,
                      )
                    }
                    onConfirm={run}
                  />
                )}
                {revoke && (
                  <ParticipationDialog
                    active={active}
                    accountId={accountId}
                    label="Revoke participation"
                    title="Revoke this participation?"
                    description={`This ends current learning eligibility, removes any team offer and retires affected learning work. ${OLD_WORK_NOTICE}`}
                    disabled={locked}
                    prepare={() =>
                      snapshot(
                        {
                          kind: 'revoke',
                          participationId: record.id,
                          revision: record.revision,
                          label,
                        },
                        record.user,
                        rosterUsers,
                      )
                    }
                    onConfirm={run}
                  />
                )}
              </div>
            </section>
          );
        })}
      </div>
      <RosterReferences users={rosterUsers} accountId={accountId} />
      {roster.data?.count === 0 && <p>No participation records yet.</p>}
      <Pagination
        offset={offset}
        count={roster.data?.count ?? 0}
        limit={20}
        onChange={setOffset}
      />
      <details
        className="task-disclosure"
        open={workOpen}
        onToggle={(event) => setWorkOpen(event.currentTarget.open)}
      >
        <summary>Learning work records</summary>
        <AssignmentWorkList
          assignmentId={assignment.id}
          accountId={accountId}
          mine={false}
          active={active && workOpen}
        />
      </details>
    </section>
  );
}

function ParticipationDialog({
  active,
  accountId,
  label,
  title,
  description,
  disabled,
  prepare,
  onConfirm,
}: {
  active: boolean;
  accountId: string;
  label: string;
  title: string;
  description: string;
  disabled: boolean;
  prepare: () => ReviewSnapshot | null;
  onConfirm: (request: RosterRequest) => void;
}) {
  const [review, setReview] = useState<ReviewSnapshot | null>(null);
  useEffect(() => {
    if (!active) setReview(null);
  }, [active]);
  const action =
    review?.request.kind === 'revoke'
      ? 'Confirm participation revocation'
      : review?.request.expectedRevision === undefined
        ? 'Send participation offer'
        : 'Send fresh participation offer';
  return (
    <Dialog
      open={Boolean(review)}
      onOpenChange={(open) => setReview(open ? prepare() : null)}
      title={title}
      description={description}
      trigger={
        <Button
          type="button"
          variant="secondary"
          disabled={disabled || !active}
        >
          {label}
        </Button>
      }
      onCloseAutoFocus={(event) => {
        if (disabled || !active) {
          event.preventDefault();
          if (active)
            document.getElementById('teaching-roster-heading')?.focus();
        }
      }}
    >
      {review && (
        <>
          <p>
            <strong>{review.request.label}</strong>
          </p>
          <RosterReferences users={review.references} accountId={accountId} />
          {review.request.kind === 'revoke' && (
            <p>
              This removes current learning eligibility, not ordinary access to
              existing source projects.
            </p>
          )}
          <Button
            type="button"
            variant={review.request.kind === 'revoke' ? 'danger' : 'primary'}
            disabled={disabled || !active}
            onClick={() => {
              onConfirm(review.request);
              setReview(null);
            }}
          >
            {action}
          </Button>
        </>
      )}
    </Dialog>
  );
}
