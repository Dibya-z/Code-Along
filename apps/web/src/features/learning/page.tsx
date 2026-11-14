import { useState } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Button, Notice } from '@code-along/design-system';
import { Failure } from '../../api/feedback.tsx';
import { ApiError } from '../../api/client.ts';
import { Pagination } from '../../components/pagination.tsx';
import { SignedIn } from '../auth/guard.tsx';
import { useIdentity } from '../auth/session.ts';
import { learningApi } from './api.ts';
import { AssignmentAuthor } from './author.tsx';
import { TaskNavigation } from './navigation.tsx';
import { PublishedVersion } from './published.tsx';
import { formatPublicationTime } from './presentation.ts';
import { MyAssignmentWork } from './my-work.tsx';
import { TeachingRoster } from './teaching-roster.tsx';
import { TeachingTeams } from './teaching-teams.tsx';
import './styles.css';

export function AssignmentPage() {
  return (
    <SignedIn>
      <ScopedAssignment />
    </SignedIn>
  );
}
function ScopedAssignment() {
  const { assignmentId } = useParams();
  const accountId = useIdentity().data?.id;
  return accountId && assignmentId ? (
    <AssignmentDetail
      key={`${accountId}:${assignmentId}`}
      assignmentId={assignmentId}
      accountId={accountId}
    />
  ) : null;
}
function AssignmentDetail({
  assignmentId,
  accountId,
}: {
  assignmentId: string;
  accountId: string;
}) {
  const location = useLocation();
  const query = useQuery({
    queryKey: ['assignment', accountId, assignmentId],
    queryFn: ({ signal }) => learningApi.summary(assignmentId, signal),
  });
  const assignment = query.data;
  const hardDenial =
    query.error instanceof ApiError &&
    [401, 403, 404].includes(query.error.status);
  const sections = [
    { id: 'overview', label: 'Overview' },
    { id: 'my-work', label: 'My work' },
    ...(assignment?.can_author ? [{ id: 'draft', label: 'Edit draft' }] : []),
    { id: 'versions', label: 'Published versions' },
    ...(assignment?.can_author
      ? [
          { id: 'teaching-roster', label: 'Teaching roster' },
          { id: 'teaching-teams', label: 'Teams' },
        ]
      : []),
  ];
  const active = sections.some((section) => `#${section.id}` === location.hash)
    ? location.hash.slice(1)
    : 'overview';
  if (hardDenial || !assignment)
    return (
      <div className="page">
        {query.error ? (
          <>
            <h1>Assignment unavailable</h1>
            <Failure error={query.error} />
          </>
        ) : (
          <Notice>Loading assignment…</Notice>
        )}
      </div>
    );
  return (
    <div className="page">
      <Link to={`/workspaces/${assignment.workspace_id}#assignments`}>
        ← Workspace assignments
      </Link>
      <div className="section-head content-section">
        <div>
          <p className="eyebrow">
            ASSIGNMENT{assignment.can_author ? ' · TEACHING' : ''}
          </p>
          <h1>{assignment.current_version?.title ?? assignment.title}</h1>
        </div>
        {assignment.archived && <span className="badge">Archived</span>}
        <Button
          variant="secondary"
          busy={query.isFetching}
          onClick={() => {
            void query.refetch();
          }}
        >
          Refresh assignment
        </Button>
      </div>
      {assignment.archived && (
        <Notice>
          This assignment is archived. Published versions remain readable.
        </Notice>
      )}
      {query.error && (
        <>
          <Failure error={query.error} />
          <Notice>
            Assignment access could not be refreshed. Your draft is retained;
            changes are paused until access is checked again.
          </Notice>
          <Button
            variant="secondary"
            busy={query.isFetching}
            onClick={() => {
              void query.refetch();
            }}
          >
            Recheck assignment access
          </Button>
        </>
      )}
      <TaskNavigation
        label="Assignment sections"
        sections={sections}
        active={active}
      />
      <section
        className="content-section learning-view"
        id="overview"
        tabIndex={-1}
        hidden={active !== 'overview'}
        aria-label="Assignment overview"
      >
        {assignment.current_version ? (
          <PublishedVersion
            key={assignment.current_version.id}
            assignmentId={assignment.id}
            versionId={assignment.current_version.id}
            accountId={accountId}
            active={active === 'overview'}
          />
        ) : (
          <>
            <h2>Not published yet</h2>
            <p>
              Only workspace teachers can read this draft. Publish a saved draft
              to share its frozen content with active workspace members.
            </p>
            {assignment.can_author && (
              <Link to="#draft">Edit assignment draft</Link>
            )}
          </>
        )}
      </section>
      <section
        className="content-section learning-view"
        id="my-work"
        tabIndex={-1}
        hidden={active !== 'my-work'}
        aria-label="My assignment work"
      >
        <MyAssignmentWork
          assignment={assignment}
          accountId={accountId}
          active={active === 'my-work'}
          paused={Boolean(query.error)}
          onRefreshAssignment={() => query.refetch({ throwOnError: true })}
        />
      </section>
      {assignment.can_author && (
        <section
          className="content-section learning-view"
          id="draft"
          tabIndex={-1}
          hidden={active !== 'draft'}
          aria-label="Assignment draft editing"
        >
          <AssignmentAuthor
            assignment={assignment}
            accountId={accountId}
            active={active === 'draft'}
            paused={Boolean(query.error)}
          />
        </section>
      )}
      <section
        className="content-section learning-view"
        id="versions"
        tabIndex={-1}
        hidden={active !== 'versions'}
        aria-labelledby="versions-heading"
      >
        <Versions
          assignmentId={assignment.id}
          accountId={accountId}
          active={active === 'versions'}
        />
      </section>
      {assignment.can_author && (
        <>
          <section
            className="content-section learning-view"
            id="teaching-roster"
            tabIndex={-1}
            hidden={active !== 'teaching-roster'}
            aria-label="Assignment teaching roster"
          >
            <TeachingRoster
              assignment={assignment}
              accountId={accountId}
              active={active === 'teaching-roster'}
              paused={Boolean(query.error)}
              onRefreshAssignment={() => query.refetch({ throwOnError: true })}
            />
          </section>
          <section
            className="content-section learning-view"
            id="teaching-teams"
            tabIndex={-1}
            hidden={active !== 'teaching-teams'}
            aria-label="Assignment teams"
          >
            <TeachingTeams
              assignment={assignment}
              accountId={accountId}
              active={active === 'teaching-teams'}
              paused={Boolean(query.error)}
            />
          </section>
        </>
      )}
    </div>
  );
}
function Versions({
  assignmentId,
  accountId,
  active,
}: {
  assignmentId: string;
  accountId: string;
  active: boolean;
}) {
  const [offset, setOffset] = useState(0),
    [selected, setSelected] = useState('');
  const query = useQuery({
    queryKey: ['assignment-versions', accountId, assignmentId, offset],
    queryFn: ({ signal }) => learningApi.versions(assignmentId, offset, signal),
    enabled: active,
  });
  return (
    <>
      <div className="section-head">
        <h2 id="versions-heading">Published versions</h2>
        <Button
          variant="secondary"
          busy={query.isFetching}
          onClick={() => {
            void query.refetch();
          }}
        >
          Refresh versions
        </Button>
      </div>
      <p>
        Each publication keeps its own instructions, checks, starter and rules.
      </p>
      {query.isFetching && <Notice>Loading versions…</Notice>}
      {query.error && <Failure error={query.error} />}
      <div className="list">
        {query.data?.items.map((version) => (
          <div className="list-row" key={version.id}>
            <div>
              <strong>
                Version {version.number} · {version.title}
              </strong>
              <p>
                <time dateTime={version.published_at}>
                  {formatPublicationTime(version.published_at)}
                </time>
              </p>
            </div>
            <Button
              variant="secondary"
              aria-pressed={selected === version.id}
              onClick={() => setSelected(version.id)}
            >
              Read version {version.number}
            </Button>
          </div>
        ))}
      </div>
      {query.data?.count === 0 && <p>No published versions yet.</p>}
      <Pagination
        offset={offset}
        count={query.data?.count ?? 0}
        limit={20}
        onChange={setOffset}
      />
      {selected && (
        <PublishedVersion
          key={selected}
          assignmentId={assignmentId}
          versionId={selected}
          accountId={accountId}
          active={active}
        />
      )}
    </>
  );
}
