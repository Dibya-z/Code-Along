import { useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { Button, Notice } from '@code-along/design-system';
import { Failure } from '../../api/feedback.tsx';
import { SignedIn } from '../auth/guard.tsx';
import { useIdentity, type Identity } from '../auth/session.ts';
import { queryClient } from '../../app/providers.tsx';
import { RevisionViewer } from '../history/viewer.tsx';
import { formatPublicationTime } from '../learning/presentation.ts';
import { submissionsApi, readSubmissionEntry } from './api.ts';
import { isRunnerId } from '@code-along/contracts/execution';

export function SubmissionPage() {
  return (
    <SignedIn>
      <ScopedSubmission />
    </SignedIn>
  );
}
function ScopedSubmission() {
  const { assignmentId, submissionId } = useParams();
  const identity = useIdentity().data;
  const location = useLocation();
  return identity && isRunnerId(assignmentId) && isRunnerId(submissionId) ? (
    <FrozenSubmission
      key={`${identity.id}:${assignmentId}:${submissionId}:${location.key}`}
      accountId={identity.id}
      assignmentId={assignmentId}
      submissionId={submissionId}
    />
  ) : (
    <div className="page">
      <h1>Submission unavailable</h1>
      <p>This submission address is incomplete.</p>
    </div>
  );
}
function FrozenSubmission({
  accountId,
  assignmentId,
  submissionId,
}: {
  accountId: string;
  assignmentId: string;
  submissionId: string;
}) {
  const [value, setValue] = useState<Awaited<
      ReturnType<typeof submissionsApi.detail>
    > | null>(null),
    [error, setError] = useState<unknown>(null),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    const current = () =>
      !abort.signal.aborted &&
      queryClient.getQueryData<Identity | null>(['me'])?.id === accountId;
    setValue(null);
    setError(null);
    void readSubmissionEntry(
      accountId,
      assignmentId,
      submissionId,
      abort.signal,
      current,
    )
      .then((result) => {
        if (current() && result) setValue(result);
      })
      .catch((cause) => {
        if (current()) setError(cause);
      });
    return () => abort.abort();
  }, [accountId, assignmentId, submissionId, revision]);
  return (
    <div className="page">
      <Link to={`/assignments/${assignmentId}`}>← Assignment</Link>
      {!value && !error && <Notice>Checking private submission access…</Notice>}
      {Boolean(error) && (
        <>
          <h1>Submission unavailable</h1>
          <Failure error={error} />
          <Button
            type="button"
            variant="secondary"
            onClick={() => setRevision((n) => n + 1)}
          >
            Recheck submission access
          </Button>
        </>
      )}
      {value && (
        <>
          <p className="eyebrow">
            SUBMITTED CODE · VERSION {value.detail.published_version.number}
          </p>
          <h1>Submission {value.detail.assignment_submission_number}</h1>
          <p>
            {value.detail.author.display_name} ·{' '}
            <time dateTime={value.detail.submitted_at}>
              {formatPublicationTime(value.detail.submitted_at)}
            </time>
          </p>
          <p>
            This frozen code is separate from the live project.{' '}
            {value.detail.practice
              ? 'Its attached browser practice result is untrusted and is not a grade.'
              : 'No runtime result was attached.'}
          </p>
          <RevisionViewer
            manifest={value.revision}
            name={value.detail.published_version.title}
            provenance="submission"
          />
          <details className="revision-provenance">
            <summary>Submission receipt</summary>
            <dl>
              <dt>Source manifest SHA-256</dt>
              <dd>{value.detail.source_manifest_sha256}</dd>
              <dt>Artifact manifest SHA-256</dt>
              <dd>{value.detail.artifact_manifest_sha256}</dd>
              <dt>Participants at submission</dt>
              <dd>
                {value.detail.participants
                  .map((person) => person.display_name)
                  .join(', ')}
              </dd>
              <dt>Practice result</dt>
              <dd>
                {value.detail.practice
                  ? `${value.detail.practice.kind} · ${value.detail.practice.status}`
                  : 'None attached'}
              </dd>
            </dl>
          </details>
        </>
      )}
    </div>
  );
}
