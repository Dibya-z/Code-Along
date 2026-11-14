import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, Notice } from '@code-along/design-system';
import { Failure } from '../../api/feedback.tsx';
import { RevisionViewer } from '../history/viewer.tsx';
import { learningApi } from './api.ts';
import { formatPublicationTime } from './presentation.ts';
import type { AssignmentVersion } from './types.ts';

export function PublishedVersion({
  assignmentId,
  versionId,
  accountId,
  active,
}: {
  assignmentId: string;
  versionId: string;
  accountId: string;
  active: boolean;
}) {
  const detail = useQuery({
    queryKey: ['assignment-version', accountId, assignmentId, versionId],
    queryFn: ({ signal }) =>
      learningApi.version(assignmentId, versionId, signal),
    enabled: active,
  });
  if (detail.error) return <Failure error={detail.error} />;
  return detail.data ? (
    <VersionContent
      version={detail.data}
      accountId={accountId}
      active={active}
    />
  ) : (
    <Notice>Verifying published assignment…</Notice>
  );
}
function VersionContent({
  version,
  accountId,
  active,
}: {
  version: AssignmentVersion;
  accountId: string;
  active: boolean;
}) {
  const [showStarter, setShowStarter] = useState(false);
  const starter = useQuery({
    queryKey: [
      'assignment-starter',
      accountId,
      version.assignment_id,
      version.id,
    ],
    queryFn: ({ signal }) => learningApi.starter(version, signal),
    enabled: active && showStarter,
  });
  const policy = version.submission_policy;
  return (
    <article
      className="assignment-reading"
      aria-label={`Published version ${version.number}`}
    >
      <div className="section-head">
        <div>
          <h2>{version.title}</h2>
          <p className="muted">
            Published version {version.number} ·{' '}
            <time dateTime={version.published_at}>
              {formatPublicationTime(version.published_at)}
            </time>{' '}
            · {version.publisher.display_name}
          </p>
        </div>
        <span className="badge">Immutable</span>
      </div>
      <div className="assignment-prose">{version.instructions}</div>
      <h3>Submission rules</h3>
      <p>
        {policy.mode === 'individual'
          ? 'Individual work'
          : `Teams of up to ${policy.max_team_size}`}{' '}
        · Up to {policy.max_attempts} attempts.{' '}
        {policy.due_at
          ? `Due ${policy.due_at.replace('T', ' ').replace('Z', ' UTC')}. Late submissions are rejected.`
          : 'No due date.'}
      </p>
      <p className="muted">
        Reading this assignment does not enroll you or grant access to its
        source project.
      </p>
      {version.hints.length > 0 && (
        <section aria-label="Published hints">
          <h3>Hints</h3>
          {version.hints.map((hint, index) => (
            <details className="task-disclosure" key={hint.id}>
              <summary>
                Hint {index + 1}: {hint.title}
              </summary>
              <div className="assignment-prose">{hint.body}</div>
            </details>
          ))}
        </section>
      )}
      {version.public_checks && (
        <details className="task-disclosure">
          <summary>Visible Python checks</summary>
          <p>
            These inspectable checks are practice input. They are not an
            assessment score.
          </p>
          <pre
            className="learning-source"
            tabIndex={0}
            aria-label="Published visible Python checks"
          >
            <code>{version.public_checks.source}</code>
          </pre>
        </details>
      )}
      <section
        className="content-section"
        aria-label="Frozen assignment starter"
      >
        <h3>Frozen starter</h3>
        <p>
          This version keeps the same source and Python environment even when
          the author’s project changes.
        </p>
        <Button
          variant="secondary"
          onClick={() => setShowStarter(true)}
          disabled={showStarter}
        >
          View frozen starter
        </Button>
        {starter.isFetching && <Notice>Verifying frozen starter…</Notice>}
        {starter.error && <Failure error={starter.error} />}
        {starter.data && !starter.error && (
          <RevisionViewer
            key={version.id}
            manifest={starter.data}
            name={`Assignment version ${version.number} starter`}
          />
        )}
      </section>
      <details className="task-disclosure">
        <summary>Publication provenance</summary>
        <dl>
          <dt>Content SHA-256</dt>
          <dd>{version.content_sha256}</dd>
          <dt>Starter manifest SHA-256</dt>
          <dd>{version.starter.manifest_sha256}</dd>
          <dt>Runtime</dt>
          <dd>{version.runtime.runtime_id}</dd>
          <dt>Helper release</dt>
          <dd>{version.helper_release.release_id}</dd>
        </dl>
      </details>
    </article>
  );
}
