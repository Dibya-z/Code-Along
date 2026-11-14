import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Link } from 'react-router';
import { Button, Notice } from '@code-along/design-system';
import { ApiError } from '../../api/client.ts';
import { productApi } from '../../api/product.ts';
import { Failure } from '../../api/feedback.tsx';
import { queryClient } from '../../app/providers.tsx';
import type { Identity } from '../auth/session.ts';
import type { SourceActions } from '../execution/source-actions.ts';
import type { RevisionManifest } from '../history/manifest.ts';
import { RevisionViewer } from '../history/viewer.tsx';
import { SubmissionModel } from './model.ts';
import { submissionsApi } from './api.ts';
import { submissionRevision } from './validation.ts';
import { SubmissionList } from './list.tsx';

export function submissionMessage(error: unknown): string | null {
  if (
    !(error instanceof ApiError) ||
    !error.body ||
    typeof error.body !== 'object' ||
    !('code' in error.body)
  )
    return null;
  switch (error.body.code) {
    case 'submission_structure_changed':
      return 'The project’s files or structure changed. Your chosen code is retained. Export it, then explicitly choose new code if you want to try again.';
    case 'submission_runtime_changed':
      return 'The project environment no longer matches this task. Your chosen code is retained for export.';
    case 'submission_nonce_conflict':
      return 'This request belongs to a different submission choice. Keep the original code and check your submission history before choosing again.';
    case 'submission_deadline_passed':
      return 'The due date has passed. No new submission was accepted.';
    case 'submission_attempt_limit':
      return 'This work’s participants have reached the submission attempt limit.';
    case 'assignment_submission_capacity':
    case 'workspace_submission_capacity':
    case 'assignment_submission_storage_capacity':
    case 'workspace_submission_storage_capacity':
      return 'Submission storage is full. Your chosen code remains available for export.';
    case 'submission_work_unavailable':
    case 'submission_participation_unavailable':
    case 'submission_roster_changed':
    case 'submission_source_unavailable':
      return 'This work is not currently eligible for a new submission. Your chosen code is retained. You can still retry confirmation of the original request.';
    default:
      return null;
  }
}
export function SubmissionPanel({
  accountId,
  assignmentId,
  workId,
  versionNumber,
  eligible,
  actions,
}: {
  accountId: string;
  assignmentId: string;
  workId: string;
  versionNumber: number;
  eligible: boolean;
  actions: SourceActions;
}) {
  const [open, setOpen] = useState(false);
  const live = useRef(true);
  const [resource] = useState(() => ({
    model: new SubmissionModel(
      accountId,
      workId,
      () =>
        live.current &&
        queryClient.getQueryData<Identity | null>(['me'])?.id === accountId,
      () => productApi.me(),
      (body) => submissionsApi.send(assignmentId, workId, body),
    ),
    leases: 0,
  }));
  useEffect(() => {
    live.current = true;
    resource.leases++;
    return () => {
      live.current = false;
      resource.leases--;
      queueMicrotask(() => {
        if (resource.leases === 0) resource.model.destroy();
      });
    };
  }, [resource]);
  const model = resource.model;
  const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot);
  const [preview, setPreview] = useState<{
    sourceHash: string;
    manifest: RevisionManifest;
  } | null>(null);
  const [previewError, setPreviewError] = useState<unknown>(null);
  useEffect(() => {
    let active = true;
    setPreview(null);
    setPreviewError(null);
    const sourceHash = snapshot.candidate?.captured.manifest.sha256;
    if (snapshot.candidate && sourceHash)
      void submissionRevision(snapshot.candidate.captured.manifest)
        .then((value) => {
          if (active) setPreview({ sourceHash, manifest: value });
        })
        .catch((error) => {
          if (active) setPreviewError(error);
        });
    return () => {
      active = false;
    };
  }, [snapshot.candidate]);
  const busy = snapshot.phase === 'preparing' || snapshot.phase === 'sending';
  return (
    <details
      className="task-disclosure"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Submit code</summary>
      <p>
        Submit an exact copy for published version {versionNumber}. Later edits
        stay in your project. Practice results are untrusted and are not a
        grade.
      </p>
      {!snapshot.body && (
        <div className="actions">
          <Button
            type="button"
            variant="secondary"
            busy={snapshot.phase === 'preparing'}
            disabled={!eligible || !actions.canCapture || busy}
            onClick={() => {
              if (eligible && actions.canCapture)
                void model.prepare(actions.captureCurrent);
            }}
          >
            Choose current code
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={!eligible || !actions.retained || busy}
            onClick={() => {
              const candidate = actions.retained;
              if (eligible && candidate) void model.prepare(() => candidate);
            }}
          >
            Choose code from this run
          </Button>
          {actions.retainedEarlier && (
            <p className="muted">
              The run used earlier source. Choosing it keeps that exact code.
            </p>
          )}
          {!eligible && (
            <p className="muted">
              New code choices are paused while work access or eligibility is
              unavailable. Your existing choice can still be exported or its
              original submission retried.
            </p>
          )}
        </div>
      )}
      {actions.conflict && <Notice tone="error">{actions.conflict}</Notice>}
      {snapshot.candidate && (
        <>
          <p role="status">
            {snapshot.candidate.practice
              ? `Chosen code includes an untrusted ${snapshot.candidate.practice.kind === 'run' ? 'run' : 'visible-check'} result: ${snapshot.candidate.practice.status.replaceAll('_', ' ')}.`
              : 'Chosen code has no confirmed runtime result attached.'}
          </p>
          {preview?.sourceHash ===
            snapshot.candidate.captured.manifest.sha256 && (
            <details className="task-disclosure">
              <summary>Preview chosen code</summary>
              <RevisionViewer
                key={preview.sourceHash}
                manifest={preview.manifest}
                name={`Chosen code · version ${versionNumber}`}
                provenance="candidate"
              />
            </details>
          )}
          {previewError && <Failure error={previewError} />}
        </>
      )}
      {Boolean(snapshot.error) && (
        <>
          {submissionMessage(snapshot.error) ? (
            <Notice tone="error">{submissionMessage(snapshot.error)}</Notice>
          ) : (
            <Failure error={snapshot.error} />
          )}
          <p>
            Your original code choice is retained. Retrying confirms the same
            request; it does not capture newer edits or create another copy of a
            committed submission.
          </p>
        </>
      )}
      {snapshot.receipt && (
        <Notice tone="success">
          Submission {snapshot.receipt.assignment_submission_number} confirmed.{' '}
          <Link
            to={`/assignments/${assignmentId}/submissions/${snapshot.receipt.id}`}
          >
            View submitted code
          </Link>
        </Notice>
      )}
      {snapshot.body && (
        <div className="actions">
          <p className="muted">
            This choice is kept in this tab. Reloading or leaving this work
            clears an unconfirmed request.
          </p>
          {snapshot.phase !== 'confirmed' && (
            <Button
              type="button"
              busy={snapshot.phase === 'sending'}
              disabled={busy}
              onClick={() => {
                void model.submit();
              }}
            >
              {snapshot.phase === 'uncertain'
                ? 'Retry same submission'
                : 'Submit chosen code'}
            </Button>
          )}
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={() => model.clear()}
          >
            Choose different code
          </Button>
          {snapshot.phase === 'uncertain' && (
            <p className="muted">
              Choosing different code starts a new request. First check whether
              the original submission was saved.
            </p>
          )}
        </div>
      )}
      <SubmissionList
        accountId={accountId}
        assignmentId={assignmentId}
        workId={workId}
        active={open}
        confirmed={snapshot.receipt?.id ?? ''}
      />
    </details>
  );
}
