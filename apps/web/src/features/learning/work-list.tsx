import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Button, Notice } from '@code-along/design-system';
import { Failure } from '../../api/feedback.tsx';
import { Pagination } from '../../components/pagination.tsx';
import { participationApi } from './participation-api.ts';
import { formatPublicationTime } from './presentation.ts';
import { OLD_WORK_NOTICE } from './work-model.ts';
import type { AssignmentWork } from './participation-types.ts';
import type { VersionSummary } from './types.ts';

export function WorkCard({
  work,
  version,
}: {
  work: AssignmentWork;
  version?: VersionSummary;
}) {
  const versionLabel = version
    ? `version ${version.number}`
    : 'its pinned published version';
  return (
    <div className="list-row learning-work-row">
      <div>
        <h3>
          {work.subject_kind === 'team' ? 'Team work' : 'Individual work'} ·{' '}
          {versionLabel}
        </h3>
        <p>
          {work.state === 'retired' ? 'Retained former work' : 'Current work'} ·{' '}
          <time dateTime={work.created_at}>
            {formatPublicationTime(work.created_at)}
          </time>
        </p>
        {work.retired_reason && (
          <p>
            Learning eligibility ended:{' '}
            {work.retired_reason.replaceAll('_', ' ')}.
          </p>
        )}
        {work.project ? (
          <p>
            Project: {work.project.name} · Your access: {work.project.role}
          </p>
        ) : (
          <p className="muted">
            This account does not currently have access to the source project.
          </p>
        )}
      </div>
      <div className="actions">
        <Link
          className="button secondary"
          to={`/assignments/${work.assignment_id}/works/${work.id}`}
        >
          {work.can_continue ? `Continue ${versionLabel}` : 'Read pinned work'}
        </Link>
        {!work.can_continue && work.project && (
          <Link
            className="button secondary"
            to={`/projects/${work.project.id}`}
          >
            Open retained source project
          </Link>
        )}
      </div>
    </div>
  );
}
export function AssignmentWorkList({
  assignmentId,
  accountId,
  active,
  mine = true,
}: {
  assignmentId: string;
  accountId: string;
  active: boolean;
  mine?: boolean;
}) {
  const [retired, setRetired] = useState(false),
    [offset, setOffset] = useState(0);
  const query = useQuery({
    queryKey: [
      'assignment-works',
      accountId,
      assignmentId,
      mine,
      retired,
      offset,
    ],
    queryFn: ({ signal }) =>
      participationApi.works(assignmentId, mine, retired, offset, signal),
    enabled: active,
  });
  const versions = useQuery({
    queryKey: ['assignment-versions', accountId, assignmentId, 'work-context'],
    queryFn: ({ signal }) =>
      participationApi.versionSummaries(assignmentId, signal),
    enabled: active,
  });
  return (
    <section
      className="content-section"
      aria-label={mine ? 'My assignment work' : 'Teaching work records'}
    >
      <div className="section-head">
        <h2>{mine ? 'My work records' : 'Learning work records'}</h2>
        <Button
          variant="secondary"
          busy={query.isFetching}
          onClick={() => {
            void query.refetch();
            void versions.refetch();
          }}
        >
          Refresh work records
        </Button>
      </div>
      <p>
        {mine
          ? 'Each project keeps the assignment version it started with. Publishing a new version does not change existing work.'
          : 'Review participation and work here. Teaching access does not give you access to a learner’s source project.'}
      </p>
      <label className="checkbox-field">
        <input
          type="checkbox"
          checked={retired}
          onChange={(event) => {
            setRetired(event.target.checked);
            setOffset(0);
          }}
        />
        Include retained former work
      </label>
      {query.error && <Failure error={query.error} />}{' '}
      {versions.error && <Failure error={versions.error} />}{' '}
      {query.isFetching && <Notice>Loading work records…</Notice>}
      <div className="list">
        {query.data?.items.map((work) => (
          <WorkCard
            key={work.id}
            work={work}
            {...(versions.data?.items.find(
              (version) => version.id === work.assignment_version_id,
            )
              ? {
                  version: versions.data.items.find(
                    (version) => version.id === work.assignment_version_id,
                  )!,
                }
              : {})}
          />
        ))}
      </div>
      {query.data?.count === 0 && (
        <p>No {retired ? '' : 'current '}work records to show.</p>
      )}
      <Pagination
        offset={offset}
        count={query.data?.count ?? 0}
        limit={20}
        onChange={setOffset}
      />
      {retired && <p className="muted">{OLD_WORK_NOTICE}</p>}
    </section>
  );
}
