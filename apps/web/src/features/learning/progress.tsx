import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Button, Notice } from '@code-along/design-system';
import { Failure } from '../../api/feedback.tsx';
import { Pagination } from '../../components/pagination.tsx';
import { useLearningQuery } from '../learning-events/provider.tsx';
import { learningApi } from './api.ts';
import {
  progressApi,
  progressVersionOptions,
  type ProgressVersionChoice,
  PROGRESS_LABELS,
  ELIGIBILITY_LABELS,
  type OwnProgress as OwnProgressData,
} from './progress-api.ts';
import { formatPublicationTime } from './presentation.ts';
import { rosterMemberLabel, RosterReferences } from './roster-identity.tsx';

function ProgressFacts({
  value,
}: {
  value: Omit<OwnProgressData, 'can_submit'>;
}) {
  return (
    <>
      <p>
        <strong>{PROGRESS_LABELS[value.state]}</strong>
      </p>
      <p className="muted">
        Current participation: {ELIGIBILITY_LABELS[value.eligibility_state]}.
        This is separate from the assessment of submitted code.
      </p>
      {value.latest_submission && (
        <p>
          <Link
            to={`/assignments/${value.assignment_id}/submissions/${value.latest_submission.id}`}
          >
            View latest submission {value.latest_submission.number}
          </Link>{' '}
          ·{' '}
          <time dateTime={value.latest_submission.submitted_at}>
            {formatPublicationTime(value.latest_submission.submitted_at)}
          </time>
        </p>
      )}
      {value.latest_assessment && (
        <p className="muted">
          Manual assessment published{' '}
          <time dateTime={value.latest_assessment.published_at}>
            {formatPublicationTime(value.latest_assessment.published_at)}
          </time>
          . Visible practice checks do not set this status.
        </p>
      )}
    </>
  );
}
export function OwnProgress({
  assignmentId,
  versionId,
  versionNumber,
  accountId,
  active = true,
}: {
  assignmentId: string;
  versionId: string;
  versionNumber: number;
  accountId: string;
  active?: boolean;
}) {
  const key = ['own-learning-progress', accountId, assignmentId, versionId];
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) =>
      progressApi.own(assignmentId, versionId, accountId, signal),
    enabled: active,
  });
  useLearningQuery(key, query, active);
  return (
    <section className="content-section" aria-label="Your learning progress">
      <div className="section-head">
        <h2>Your progress · version {versionNumber}</h2>
        <Button
          type="button"
          variant="secondary"
          busy={query.isFetching}
          onClick={() => {
            void query.refetch();
          }}
        >
          Refresh my progress
        </Button>
      </div>
      {!query.data && !query.error && (
        <Notice>Checking your learning records…</Notice>
      )}
      {query.error && <Failure error={query.error} />}
      {query.data && (
        <>
          <ProgressFacts value={query.data} />
          <p>
            {query.data.can_submit
              ? 'New submissions are currently available. Final code and task rules are checked when you submit.'
              : 'A new submission is not currently available. Your past submissions remain readable; confirmation of an original request can still be retried.'}
          </p>
        </>
      )}
    </section>
  );
}
export function TeachingProgress({
  assignmentId,
  initialVersion,
  accountId,
  active,
}: {
  assignmentId: string;
  initialVersion: ProgressVersionChoice;
  accountId: string;
  active: boolean;
}) {
  const [selectedVersion, setSelectedVersion] = useState(() => ({
      ...initialVersion,
    })),
    [offset, setOffset] = useState(0),
    [versionOffset, setVersionOffset] = useState(0);
  const versions = useQuery({
    queryKey: ['progress-versions', accountId, assignmentId, versionOffset],
    queryFn: ({ signal }) =>
      learningApi.versions(assignmentId, versionOffset, signal),
    enabled: active,
  });
  const versionId = selectedVersion.id;
  const options = progressVersionOptions(
    selectedVersion,
    versions.data?.items ?? [],
  );
  const key = [
    'teaching-learning-progress',
    accountId,
    assignmentId,
    versionId,
    offset,
  ];
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) =>
      progressApi.learners(assignmentId, versionId, offset, signal),
    enabled: active && Boolean(versionId),
  });
  useLearningQuery(
    ['progress-versions', accountId, assignmentId, versionOffset],
    versions,
    active,
  );
  useLearningQuery(key, query, active && Boolean(versionId));
  const users = query.data?.items.map((row) => row.user) ?? [];
  return (
    <section aria-labelledby="teaching-progress-heading">
      <div className="section-head">
        <h2 id="teaching-progress-heading">Learner progress</h2>
        <Button
          type="button"
          variant="secondary"
          busy={query.isFetching}
          disabled={!versionId}
          onClick={() => {
            void query.refetch();
          }}
        >
          Refresh learner progress
        </Button>
      </div>
      <p>
        Progress follows the latest submitted code for each learner in the
        selected published version. A newer submission waits for its own manual
        review. This view does not open live projects.
      </p>
      <label>
        Progress for published version
        <select
          value={versionId}
          onChange={(event) => {
            const choice = options.find(
              (version) => version.id === event.target.value,
            );
            if (choice) setSelectedVersion(choice);
            setOffset(0);
          }}
        >
          <option value="" disabled>
            Choose a version
          </option>
          {options.map((version) => (
            <option key={version.id} value={version.id}>
              Version {version.number} · {version.title}
            </option>
          ))}
        </select>
      </label>
      <Pagination
        offset={versionOffset}
        count={versions.data?.count ?? 0}
        limit={20}
        onChange={(next) => {
          setVersionOffset(next);
          setOffset(0);
        }}
      />
      {versions.error && <Failure error={versions.error} />}
      {query.error && <Failure error={query.error} />}
      {query.isFetching && <Notice>Checking learner progress…</Notice>}
      {query.data?.count === 0 && (
        <p>No lifetime participants are visible for this assignment.</p>
      )}
      <ul className="list">
        {query.data?.items.map((row) => (
          <li className="list-row" key={row.user_id}>
            <div>
              <h3>{rosterMemberLabel(row.user, accountId, users)}</h3>
              <ProgressFacts value={row} />
            </div>
          </li>
        ))}
      </ul>
      <RosterReferences users={users} accountId={accountId} />
      <Pagination
        offset={offset}
        count={query.data?.count ?? 0}
        limit={20}
        onChange={setOffset}
      />
    </section>
  );
}
