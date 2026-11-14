import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Button, Notice } from '@code-along/design-system';
import { Failure } from '../../api/feedback.tsx';
import { Pagination } from '../../components/pagination.tsx';
import { formatPublicationTime } from '../learning/presentation.ts';
import { submissionsApi } from './api.ts';
import { useLearningQuery } from '../learning-events/provider.tsx';
import { learningApi } from '../learning/api.ts';
import type { WorkSubmissionPage } from './types.ts';

export function SubmissionList({
  accountId,
  assignmentId,
  workId,
  active,
  confirmed = '',
}: {
  accountId: string;
  assignmentId: string;
  workId?: string;
  active: boolean;
  confirmed?: string;
}) {
  const [offset, setOffset] = useState(0),
    [versionId, setVersionId] = useState(''),
    [versionOffset, setVersionOffset] = useState(0);
  const versions = useQuery({
    queryKey: ['submission-versions', accountId, assignmentId, versionOffset],
    queryFn: ({ signal }) =>
      learningApi.versions(assignmentId, versionOffset, signal),
    enabled: active && !workId,
  });
  const query = useQuery({
    queryKey: [
      'submissions',
      accountId,
      assignmentId,
      workId ?? 'teaching',
      versionId,
      offset,
      confirmed,
    ],
    queryFn: ({ signal }) =>
      workId
        ? submissionsApi.work(assignmentId, workId, offset, signal)
        : submissionsApi.assignment(assignmentId, versionId, offset, signal),
    enabled: active,
  });
  useLearningQuery(
    ['submission-versions', accountId, assignmentId, versionOffset],
    versions,
    active && !workId,
  );
  useLearningQuery(
    [
      'submissions',
      accountId,
      assignmentId,
      workId ?? 'teaching',
      versionId,
      offset,
      confirmed,
    ],
    query,
    active,
  );
  const availability = workId
    ? (query.data as WorkSubmissionPage | undefined)?.availability
    : undefined;
  return (
    <section
      className="content-section"
      aria-label={workId ? 'Work submissions' : 'Assignment submissions'}
    >
      <div className="section-head">
        <h2>{workId ? 'Your submissions' : 'Submissions'}</h2>
        <Button
          type="button"
          variant="secondary"
          busy={query.isFetching}
          onClick={() => {
            void query.refetch();
          }}
        >
          Refresh submissions
        </Button>
      </div>
      {!workId && (
        <p className="muted">
          Open a frozen submission to review its code. This list does not open
          anyone’s live project.
        </p>
      )}
      {!workId && (
        <div>
          <label>
            Published version
            <select
              value={versionId}
              onChange={(event) => {
                setVersionId(event.target.value);
                setOffset(0);
              }}
            >
              <option value="">All published versions</option>
              {versions.data?.items.map((version) => (
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
              setVersionId('');
              setOffset(0);
            }}
          />
          {versions.error && <Failure error={versions.error} />}
        </div>
      )}
      {query.isFetching && <Notice>Loading submissions…</Notice>}
      {query.error && <Failure error={query.error} />}
      {availability && (
        <p role="status">
          {availability.can_submit
            ? 'New submissions are currently available. The server checks your final code and task rules when you submit.'
            : 'The latest task check did not allow a new submission. The server checks your chosen code; confirmation of an existing request can still be retried.'}
        </p>
      )}
      {query.data?.count === 0 && (
        <p>No submissions are visible to this account yet.</p>
      )}
      <div className="list">
        {query.data?.items.map((item) => (
          <div className="list-row" key={item.id}>
            <div>
              <strong>Submission {item.assignment_submission_number}</strong>
              <p>
                {item.author.display_name} ·{' '}
                <time dateTime={item.submitted_at}>
                  {formatPublicationTime(item.submitted_at)}
                </time>
              </p>
            </div>
            <Link
              className="button secondary"
              to={`/assignments/${assignmentId}/submissions/${item.id}`}
            >
              View submitted code
            </Link>
          </div>
        ))}
      </div>
      <Pagination
        offset={offset}
        count={query.data?.count ?? 0}
        limit={20}
        onChange={setOffset}
      />
    </section>
  );
}
