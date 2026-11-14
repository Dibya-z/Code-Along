import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Button, Notice } from '@code-along/design-system';
import { Failure } from '../../api/feedback.tsx';
import { queryClient } from '../../app/providers.tsx';
import type { Identity } from '../auth/session.ts';
import { formatPublicationTime } from '../learning/presentation.ts';
import { authorizeFeedback, feedbackApi } from './api.ts';
import { FeedbackModel } from './model.ts';
import { draftProblem, FEEDBACK_COMMENT_BYTES } from './validation.ts';
import type {
  Assessment,
  FeedbackPublication,
  FeedbackScope,
} from './types.ts';
import './styles.css';

export const assessmentLabel = (status: Assessment) =>
  ({
    reviewed: 'Reviewed',
    needs_changes: 'Needs changes',
    complete: 'Complete',
  })[status];

function Publication({ value }: { value: FeedbackPublication }) {
  return (
    <article
      aria-label={`Published feedback ${value.number}`}
      className="content-section"
    >
      <h3>{assessmentLabel(value.assessment_status)}</h3>
      <p className="muted">
        Manual assessment by {value.publisher.display_name} ·{' '}
        <time dateTime={value.published_at}>
          {formatPublicationTime(value.published_at)}
        </time>
      </p>
      {value.comments ? (
        <p className="feedback-plaintext">{value.comments}</p>
      ) : (
        <p>No comment was included.</p>
      )}
      <details className="revision-provenance">
        <summary>Feedback publication details</summary>
        <dl>
          <dt>Publication</dt>
          <dd>{value.number}</dd>
          <dt>Content SHA-256</dt>
          <dd>{value.content_sha256}</dd>
          <dt>Assignment version</dt>
          <dd>{value.assignment_version_id}</dd>
        </dl>
      </details>
    </article>
  );
}

export function FeedbackPanel({
  scope,
  canReview,
}: {
  scope: FeedbackScope;
  canReview: boolean;
}) {
  const [latest, setLatest] = useState<FeedbackPublication | null>(null),
    [ready, setReady] = useState(false),
    [error, setError] = useState<unknown>(null),
    [revision, setRevision] = useState(0),
    [historyOpen, setHistoryOpen] = useState(false),
    [history, setHistory] = useState<readonly FeedbackPublication[] | null>(
      null,
    ),
    [historyError, setHistoryError] = useState<unknown>(null);
  const { accountId, assignmentId, submissionId, versionId } = scope;
  useEffect(() => {
    const abort = new AbortController();
    const current = () =>
      !abort.signal.aborted &&
      queryClient.getQueryData<Identity | null>(['me'])?.id === accountId;
    setError(null);
    void authorizeFeedback(scope, abort.signal, current)
      .then(() => {
        if (!current()) throw new Error('Feedback access changed.');
        return feedbackApi.latest(scope, abort.signal);
      })
      .then((value) => {
        if (current()) {
          setLatest(value);
          setReady(true);
        }
      })
      .catch((cause: unknown) => {
        if (current()) setError(cause);
      });
    return () => abort.abort();
  }, [accountId, assignmentId, submissionId, versionId, revision, scope]);
  useEffect(() => {
    if (!historyOpen) return;
    const abort = new AbortController();
    const current = () =>
      !abort.signal.aborted &&
      queryClient.getQueryData<Identity | null>(['me'])?.id === accountId;
    setHistoryError(null);
    void authorizeFeedback(scope, abort.signal, current)
      .then(() => {
        if (!current()) throw new Error('Feedback access changed.');
        return feedbackApi.history(scope, abort.signal);
      })
      .then((items) => {
        if (current()) setHistory(items);
      })
      .catch((cause: unknown) => {
        if (current()) setHistoryError(cause);
      });
    return () => abort.abort();
  }, [
    accountId,
    assignmentId,
    submissionId,
    versionId,
    historyOpen,
    revision,
    scope,
  ]);
  return (
    <section
      aria-labelledby="feedback-heading"
      className="feedback-panel content-section"
    >
      <h2 id="feedback-heading">Instructor feedback</h2>
      <p>
        Feedback applies to this submitted code. It is a manual assessment, not
        an automated grade.
      </p>
      {!ready && !error && <Notice>Checking published feedback…</Notice>}
      {Boolean(error) && <Failure error={error} />}
      {latest ? (
        <Publication value={latest} />
      ) : (
        ready && <p>No feedback has been published for this submission.</p>
      )}
      <Button
        type="button"
        variant="secondary"
        onClick={() => setRevision((value) => value + 1)}
      >
        Refresh published feedback
      </Button>
      <details
        className="task-disclosure"
        open={historyOpen}
        onToggle={(event) => setHistoryOpen(event.currentTarget.open)}
      >
        <summary>Published feedback history</summary>
        {Boolean(historyError) && <Failure error={historyError} />}
        {!history && !historyError && (
          <p>Loading published feedback history…</p>
        )}
        {history?.length === 0 && <p>No publications yet.</p>}
        {history?.map((item) => (
          <Publication key={item.id} value={item} />
        ))}
      </details>
      {canReview && (
        <FeedbackEditor
          scope={scope}
          onConfirmed={() => setRevision((value) => value + 1)}
        />
      )}
    </section>
  );
}

function FeedbackEditor({
  scope,
  onConfirmed,
}: {
  scope: FeedbackScope;
  onConfirmed: () => void;
}) {
  const live = useRef(true);
  const [open, setOpen] = useState(false);
  const [resource] = useState(() => {
    const current = () =>
      live.current &&
      queryClient.getQueryData<Identity | null>(['me'])?.id === scope.accountId;
    return {
      model: new FeedbackModel(scope, current, {
        authorize: (signal) => authorizeFeedback(scope, signal, current),
        draft: (signal) => feedbackApi.draft(scope, signal),
        save: (body, signal) => feedbackApi.save(scope, body, signal),
        publish: (body, signal) => feedbackApi.publish(scope, body, signal),
      }),
      leases: 0,
    };
  });
  const model = resource.model;
  const value = useSyncExternalStore(model.subscribe, model.getSnapshot);
  useEffect(() => {
    live.current = true;
    resource.leases++;
    return () => {
      live.current = false;
      resource.leases--;
      queueMicrotask(() => {
        if (resource.leases === 0) model.destroy();
      });
    };
  }, [resource, model]);
  useEffect(() => {
    if (open && !value.saved && !value.reading && !value.loadError)
      void model.load();
  }, [open, value.saved, value.reading, value.loadError, model]);
  const notified = useRef<string | null>(null);
  useEffect(() => {
    if (value.receipt && notified.current !== value.receipt.id) {
      notified.current = value.receipt.id;
      onConfirmed();
    }
  }, [value.receipt, onConfirmed]);
  const busy =
    value.reading || value.phase === 'saving' || value.phase === 'publishing';
  const dirty = Boolean(
    value.saved &&
    (value.comments !== value.saved.comments ||
      value.assessment !== value.saved.assessment_status),
  );
  const retainedOnlyHere = dirty || Boolean(value.attempt);
  useEffect(() => {
    if (!retainedOnlyHere) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [retainedOnlyHere]);
  const problem = draftProblem(value.comments, value.assessment);
  const publishProblem = value.saved
    ? draftProblem(value.saved.comments, value.saved.assessment_status, true)
    : null;
  const needsSave = dirty || value.saved?.revision === 0;
  return (
    <details
      className="feedback-editor task-disclosure"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Review this submission</summary>
      <p>
        Draft changes stay private to eligible instructors until you publish.
        Submitted participants can read every publication; corrections keep
        earlier publications.
      </p>
      {value.reading && <Notice>Checking private draft access…</Notice>}
      {Boolean(value.loadError) && <Failure error={value.loadError} />}
      {value.saved && (
        <>
          <label htmlFor="feedback-comments">Feedback comments</label>
          <textarea
            id="feedback-comments"
            rows={6}
            value={value.comments}
            disabled={busy}
            aria-describedby="feedback-comment-help"
            aria-invalid={Boolean(problem)}
            onChange={(event) =>
              model.edit(event.target.value, value.assessment)
            }
          />
          <p id="feedback-comment-help" className="muted">
            Plaintext, up to {FEEDBACK_COMMENT_BYTES.toLocaleString('en-GB')}{' '}
            UTF-8 bytes. This draft is kept in this tab until saved.
          </p>
          <label htmlFor="feedback-assessment">Manual assessment</label>
          <select
            id="feedback-assessment"
            value={value.assessment ?? ''}
            disabled={busy}
            onChange={(event) =>
              model.edit(
                value.comments,
                event.target.value ? (event.target.value as Assessment) : null,
              )
            }
          >
            <option value="">No assessment yet — incomplete draft</option>
            <option value="reviewed">Reviewed</option>
            <option value="needs_changes">Needs changes</option>
            <option value="complete">Complete</option>
          </select>
          <p className="muted">
            Complete is your manual decision. Running visible checks never marks
            a submission complete.
          </p>
          {problem && <p role="status">{problem}</p>}
          <p role="status">
            {dirty
              ? 'Unsaved feedback changes.'
              : value.saved.revision === 0
                ? 'No saved draft yet.'
                : `Saved draft revision ${value.saved.revision}.`}
          </p>
          {value.saved.updated_at && (
            <p className="muted">
              Last saved by {value.saved.last_edited_by?.display_name} ·{' '}
              <time dateTime={value.saved.updated_at}>
                {formatPublicationTime(value.saved.updated_at)}
              </time>
            </p>
          )}
          {value.reloadRequired && (
            <Notice>
              Reload the saved draft before preparing another change. Your text
              and any original publication attempt are retained.
            </Notice>
          )}
          <div className="actions">
            <Button
              type="button"
              variant={needsSave ? 'primary' : 'secondary'}
              busy={value.phase === 'saving'}
              disabled={busy || value.reloadRequired || Boolean(problem)}
              onClick={() => void model.save()}
            >
              Save feedback draft
            </Button>
            <Button
              type="button"
              variant={!needsSave && !publishProblem ? 'primary' : 'secondary'}
              busy={value.phase === 'publishing'}
              disabled={
                busy ||
                value.phase === 'confirmed' ||
                Boolean(value.attempt) ||
                value.reloadRequired ||
                dirty ||
                Boolean(publishProblem)
              }
              onClick={() => void model.publish()}
            >
              Publish saved feedback
            </Button>
          </div>
        </>
      )}
      {retainedOnlyHere && (
        <p className="muted">
          Unsaved changes and an unconfirmed publication choice stay only in
          this tab. Leaving or reloading this page clears them.
        </p>
      )}
      {Boolean(value.error) && <Failure error={value.error} />}
      {value.attempt && value.phase !== 'confirmed' && (
        <>
          <Notice>
            The original publication is not confirmed. Retrying publishes only
            its saved draft, even if you edit or reload a newer draft.
          </Notice>
          <details className="revision-provenance">
            <summary>Original publication choice</summary>
            <p>
              {value.attempt.draft.assessment_status
                ? assessmentLabel(value.attempt.draft.assessment_status)
                : 'No assessment'}
            </p>
            <p className="feedback-plaintext">{value.attempt.draft.comments}</p>
          </details>
          <div className="actions">
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={() => void model.publish()}
            >
              Retry original feedback publication
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={() => model.setAside()}
            >
              Set aside this publication attempt
            </Button>
          </div>
          <p className="muted">
            Setting it aside does not undo a publication that may already be
            saved. Check published feedback before choosing another.
          </p>
        </>
      )}
      {value.phase === 'confirmed' && value.receipt && (
        <Notice tone="success">
          Feedback publication {value.receipt.number} confirmed.
        </Notice>
      )}
      <Button
        type="button"
        variant="secondary"
        disabled={busy}
        onClick={() => void model.load(true)}
      >
        Reload saved feedback draft
      </Button>
      <p className="muted">
        Reloading replaces unsaved form text with the saved draft. An original
        publication attempt remains unchanged.
      </p>
      {value.phase === 'confirmed' && (
        <Button
          type="button"
          variant="secondary"
          disabled={busy || value.reloadRequired}
          onClick={() => model.setAside()}
        >
          Prepare a correction
        </Button>
      )}
    </details>
  );
}
