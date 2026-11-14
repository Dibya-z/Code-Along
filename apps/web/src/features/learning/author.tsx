import { useState, type FormEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Button, Dialog, Field, Notice } from '@code-along/design-system';
import { ApiError } from '../../api/client.ts';
import { Failure } from '../../api/feedback.tsx';
import { queryClient } from '../../app/providers.tsx';
import { capacityMessage, learningApi, type PublishRequest } from './api.ts';
import { draftErrors, nonblank } from './validation.ts';
import { StarterPicker } from './starter-picker.tsx';
import type { Assignment, AssignmentDraft, DraftFields } from './types.ts';

export const PUBLICATION_AUDIENCE =
  "Active members of this workspace can read the frozen assignment content and starter. Reading is not enrollment and grants no access to the source project's live code.";
export function draftFields(draft: AssignmentDraft): DraftFields {
  return {
    title: draft.title,
    instructions: draft.instructions,
    hints: draft.hints.map((hint) => ({ ...hint })),
    public_checks_source: draft.public_checks_source,
    starter_revision_id: draft.starter_revision_id,
    submission_mode: draft.submission_mode,
    max_attempts: draft.max_attempts,
    max_team_size: draft.max_team_size,
    due_at: draft.due_at,
  };
}
export function AssignmentAuthor({
  assignment,
  accountId,
  active,
  paused,
}: {
  assignment: Assignment;
  accountId: string;
  active: boolean;
  paused: boolean;
}) {
  const query = useQuery({
    queryKey: ['assignment-draft', accountId, assignment.id],
    queryFn: ({ signal }) => learningApi.draft(assignment.id, signal),
    enabled: active && assignment.can_author,
  });
  return (
    <>
      {query.error && <Failure error={query.error} />}{' '}
      {query.error && (
        <Button
          variant="secondary"
          busy={query.isFetching}
          onClick={() => {
            void query.refetch();
          }}
        >
          Recheck draft access
        </Button>
      )}
      {query.data ? (
        <DraftEditor
          initial={query.data}
          assignment={assignment}
          accountId={accountId}
          paused={paused || Boolean(query.error)}
        />
      ) : (
        <Notice>Loading assignment draft…</Notice>
      )}
    </>
  );
}
function DraftEditor({
  initial,
  assignment,
  accountId,
  paused,
}: {
  initial: AssignmentDraft;
  assignment: Assignment;
  accountId: string;
  paused: boolean;
}) {
  const [saved, setSaved] = useState(initial),
    [form, setForm] = useState(() => draftFields(initial));
  const [errors, setErrors] = useState<string[]>([]),
    [publishOpen, setPublishOpen] = useState(false);
  const [pending, setPending] = useState<PublishRequest | null>(null);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [selection, setSelection] = useState<string | null>(null);
  const [starterLabel, setStarterLabel] = useState(
    initial.starter_origin?.kind === 'published_assignment'
      ? `Published starter — version ${initial.starter_origin.number}`
      : initial.starter_revision_id
        ? 'Selected owned-project frozen revision'
        : 'No frozen starter selected',
  );
  const dirty = JSON.stringify(form) !== JSON.stringify(draftFields(saved));
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: ['assignment', accountId, assignment.id],
      }),
      queryClient.invalidateQueries({
        queryKey: ['assignment-versions', accountId, assignment.id],
      }),
      queryClient.invalidateQueries({
        queryKey: ['assignments', accountId, assignment.workspace_id],
      }),
    ]);
  };
  const save = useMutation({
    mutationFn: () => learningApi.save(assignment.id, saved.revision, form),
    onSuccess: (draft) => {
      setSaved(draft);
      setForm(draftFields(draft));
      void refresh();
    },
  });
  const reload = useMutation({
    mutationFn: () => learningApi.draft(assignment.id),
    onSuccess: (draft) => {
      setSaved(draft);
      setForm(draftFields(draft));
      setErrors([]);
      setNeedsRefresh(false);
      setStarterLabel(
        draft.starter_origin?.kind === 'published_assignment'
          ? `Published starter — version ${draft.starter_origin.number}`
          : draft.starter_revision_id
            ? 'Selected owned-project frozen revision'
            : 'No frozen starter selected',
      );
      save.reset();
    },
  });
  const publish = useMutation({
    mutationFn: (request: PublishRequest) =>
      learningApi.publish(assignment.id, request),
    onSuccess: () => {
      setPending(null);
      setPublishOpen(false);
      setNeedsRefresh(true);
      // The immutable publication is committed proof even if this later read fails.
      reload.mutate();
      void refresh();
    },
    onError: () => setPublishOpen(false),
  });
  const archive = useMutation({
    mutationFn: () =>
      learningApi.archive(assignment.id, saved.revision, !assignment.archived),
    onSuccess: () => {
      setNeedsRefresh(true);
      reload.mutate();
      void refresh();
    },
  });
  const mutationBusy =
    save.isPending ||
    publish.isPending ||
    reload.isPending ||
    archive.isPending;
  const busy = mutationBusy || Boolean(selection);
  const pickerDisabled =
    mutationBusy ||
    paused ||
    needsRefresh ||
    assignment.archived ||
    !assignment.can_author ||
    Boolean(pending);
  const disabled =
    busy ||
    paused ||
    needsRefresh ||
    assignment.archived ||
    !assignment.can_author ||
    Boolean(pending);
  function change<K extends keyof DraftFields>(key: K, value: DraftFields[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled) return;
    const issues = draftErrors(form);
    setErrors(issues);
    if (!issues.length) save.mutate();
  }
  const publishable =
    !dirty &&
    !disabled &&
    Boolean(form.starter_revision_id) &&
    nonblank(form.instructions) &&
    !draftErrors(form).length;
  const stale =
    save.error instanceof ApiError &&
    save.error.status === 409 &&
    !capacityMessage(save.error);
  return (
    <section className="assignment-author" aria-labelledby="draft-heading">
      <div className="section-head">
        <div>
          <h2 id="draft-heading">Assignment draft</h2>
          <p className="muted">
            Editing this draft never changes an already-published version.
          </p>
        </div>
        <span className="badge" role="status">
          {dirty
            ? 'Unsaved draft changes'
            : `Draft saved · revision ${saved.revision}`}
        </span>
      </div>
      {needsRefresh && reload.error && (
        <Notice tone="error">
          The previous action is confirmed, but the latest draft revision could
          not be loaded. Your current form is retained.{' '}
          <Button
            type="button"
            variant="secondary"
            onClick={() => reload.mutate()}
          >
            Reload confirmed draft
          </Button>
        </Notice>
      )}
      <form className="form-stack" onSubmit={submit}>
        <fieldset disabled={disabled}>
          <legend>Content</legend>
          <div className="form-stack">
            <Field
              label="Assignment title"
              value={form.title}
              onChange={(event) => change('title', event.target.value)}
              required
            />
            <label htmlFor="assignment-instructions">Instructions</label>
            <textarea
              id="assignment-instructions"
              value={form.instructions}
              onChange={(event) => change('instructions', event.target.value)}
            />
            <p className="muted">
              Plain text, up to 32 KiB. Instructions must be nonblank before
              publication.
            </p>
            <details className="task-disclosure">
              <summary>Hints ({form.hints.length} of 8)</summary>
              <p>Hints are published plaintext that members can inspect.</p>
              {form.hints.map((hint, index) => (
                <div className="hint-editor form-stack" key={hint.id}>
                  <Field
                    label={`Hint ${index + 1} title`}
                    value={hint.title}
                    onChange={(event) =>
                      change(
                        'hints',
                        form.hints.map((item) =>
                          item.id === hint.id
                            ? { ...item, title: event.target.value }
                            : item,
                        ),
                      )
                    }
                  />
                  <label htmlFor={`hint-${hint.id}`}>
                    Hint {index + 1} body
                  </label>
                  <textarea
                    id={`hint-${hint.id}`}
                    value={hint.body}
                    onChange={(event) =>
                      change(
                        'hints',
                        form.hints.map((item) =>
                          item.id === hint.id
                            ? { ...item, body: event.target.value }
                            : item,
                        ),
                      )
                    }
                  />
                  <div className="actions">
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={index === 0}
                      onClick={() => {
                        const next = [...form.hints];
                        [next[index - 1], next[index]] = [
                          next[index]!,
                          next[index - 1]!,
                        ];
                        change('hints', next);
                      }}
                    >
                      Move hint {index + 1} up
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={index === form.hints.length - 1}
                      onClick={() => {
                        const next = [...form.hints];
                        [next[index], next[index + 1]] = [
                          next[index + 1]!,
                          next[index]!,
                        ];
                        change('hints', next);
                      }}
                    >
                      Move hint {index + 1} down
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() =>
                        change(
                          'hints',
                          form.hints.filter((item) => item.id !== hint.id),
                        )
                      }
                    >
                      Remove hint {index + 1}
                    </Button>
                  </div>
                </div>
              ))}
              <Button
                type="button"
                variant="secondary"
                disabled={form.hints.length >= 8}
                onClick={() =>
                  change('hints', [
                    ...form.hints,
                    { id: crypto.randomUUID(), title: '', body: '' },
                  ])
                }
              >
                Add hint
              </Button>
            </details>
            <details className="task-disclosure">
              <summary>Visible Python checks</summary>
              <label className="checkbox-field">
                <input
                  type="checkbox"
                  checked={form.public_checks_source !== null}
                  onChange={(event) =>
                    change(
                      'public_checks_source',
                      event.target.checked ? '' : null,
                    )
                  }
                />{' '}
                Include inspectable practice checks
              </label>
              {form.public_checks_source !== null && (
                <>
                  <label htmlFor="assignment-checks">
                    Visible Python check source
                  </label>
                  <textarea
                    className="source-input"
                    id="assignment-checks"
                    spellCheck={false}
                    value={form.public_checks_source}
                    onChange={(event) =>
                      change('public_checks_source', event.target.value)
                    }
                  />
                  <p className="muted">
                    Nonblank Python within 16 KiB. These checks are public
                    practice input, not a trusted score. Publishing does not run
                    them.
                  </p>
                </>
              )}
            </details>
          </div>
        </fieldset>
        <fieldset disabled={disabled}>
          <legend>Starter</legend>
          <p role="status">{starterLabel}</p>
          <StarterPicker
            assignmentId={assignment.id}
            workspaceId={assignment.workspace_id}
            accountId={accountId}
            disabled={pickerDisabled}
            onSelecting={(token, pending) =>
              setSelection((current) =>
                pending ? token : current === token ? null : current,
              )
            }
            onSelect={(id, label) => {
              change('starter_revision_id', id);
              setStarterLabel(label);
            }}
          />
          {form.starter_revision_id && (
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                change('starter_revision_id', null);
                setStarterLabel('No frozen starter selected');
              }}
            >
              Clear starter selection
            </Button>
          )}
        </fieldset>
        <fieldset disabled={disabled}>
          <legend>Submission rules</legend>
          <div className="rule-grid">
            <div className="form-stack">
              <label htmlFor="submission-mode">Work mode</label>
              <select
                id="submission-mode"
                value={form.submission_mode}
                onChange={(event) => {
                  change(
                    'submission_mode',
                    event.target.value as 'individual' | 'team',
                  );
                  change(
                    'max_team_size',
                    event.target.value === 'individual' ? 1 : 2,
                  );
                }}
              >
                <option value="individual">Individual</option>
                <option value="team">Team</option>
              </select>
            </div>
            <Field
              label="Maximum attempts"
              type="number"
              min={1}
              max={100}
              value={form.max_attempts}
              onChange={(event) =>
                change('max_attempts', Number(event.target.value))
              }
            />
            {form.submission_mode === 'team' && (
              <Field
                label="Maximum team size"
                type="number"
                min={2}
                max={6}
                value={form.max_team_size}
                onChange={(event) =>
                  change('max_team_size', Number(event.target.value))
                }
              />
            )}
            <Field
              label="Due date and time (UTC, optional)"
              type="datetime-local"
              value={form.due_at?.slice(0, 16) ?? ''}
              onChange={(event) =>
                change(
                  'due_at',
                  event.target.value ? `${event.target.value}:00Z` : null,
                )
              }
            />
          </div>
          <p className="muted">
            Late submissions will be rejected. Reading a publication does not
            enroll a learner.
          </p>
        </fieldset>
        {errors.length > 0 && (
          <Notice tone="error">
            <ul>
              {errors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          </Notice>
        )}
        {save.error && <Failure error={save.error} />}
        {stale && (
          <Notice>
            Your displayed draft revision is out of date. Your text is still
            here. Review it before choosing to reload the server draft.
          </Notice>
        )}
        <div className="actions">
          <Button
            type="submit"
            busy={save.isPending}
            disabled={disabled || !dirty}
          >
            Save draft
          </Button>
          {!pending && (
            <Dialog
              title="Reload the server draft?"
              description="This replaces your unsaved form with the current server draft. Copy any text you want to keep first."
              trigger={
                <Button
                  type="button"
                  variant="secondary"
                  disabled={busy || paused}
                >
                  Review and reload draft
                </Button>
              }
            >
              <Button
                variant="secondary"
                busy={reload.isPending}
                onClick={() => reload.mutate()}
              >
                Replace form with server draft
              </Button>
              {reload.error && <Failure error={reload.error} />}
            </Dialog>
          )}
        </div>
      </form>
      <div className="content-section">
        <h3>Publish a saved draft</h3>
        <p>
          Save changes first. A publication freezes its instructions, hints,
          checks, starter and rules.
        </p>
        <Dialog
          open={publishOpen}
          onOpenChange={setPublishOpen}
          title="Publish this saved draft?"
          description={PUBLICATION_AUDIENCE}
          trigger={<Button disabled={!publishable}>Review publication</Button>}
        >
          <p>
            <strong>{saved.title}</strong>
          </p>
          <p>{starterLabel}</p>
          <p>
            {saved.submission_mode === 'individual'
              ? 'Individual work'
              : `Teams of up to ${saved.max_team_size}`}{' '}
            · Up to {saved.max_attempts} attempts
          </p>
          <Button
            busy={publish.isPending}
            disabled={Boolean(pending) || !publishable}
            onClick={() => {
              if (!publishable) return;
              const request = Object.freeze({
                expected_revision: saved.revision,
                client_request_id: crypto.randomUUID(),
              });
              setPending(request);
              publish.mutate(request);
            }}
          >
            Publish saved draft
          </Button>
        </Dialog>
        {publish.error && (
          <>
            <Failure error={publish.error} />
            <Notice tone={capacityMessage(publish.error) ? 'error' : 'info'}>
              {capacityMessage(publish.error) ??
                (publish.error instanceof ApiError &&
                publish.error.status === 409
                  ? 'The draft changed or this publish request conflicts. Reload and review the current draft before a new publication.'
                  : 'Publication is not confirmed. Retrying the same request checks for the original immutable version.')}
            </Notice>
          </>
        )}
        {pending && !publish.isPending && (
          <div className="actions">
            <Button
              disabled={!assignment.can_author || paused}
              onClick={() => {
                if (assignment.can_author && !paused && !busy)
                  publish.mutate(pending);
              }}
            >
              Retry same publication
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setPending(null);
                setPublishOpen(false);
                publish.reset();
              }}
            >
              Review draft before a new request
            </Button>
          </div>
        )}
        {publish.isSuccess && (
          <Notice tone="success">
            Published version {publish.data?.number} is confirmed.
          </Notice>
        )}
      </div>
      <details className="task-disclosure">
        <summary>Assignment administration</summary>
        <Dialog
          title={
            assignment.archived
              ? 'Restore this assignment?'
              : 'Archive this assignment?'
          }
          description="Published records remain readable. Archiving does not release assignment or publication capacity."
          trigger={
            <Button
              variant="secondary"
              disabled={busy || paused || dirty || Boolean(pending)}
            >
              {assignment.archived
                ? 'Restore assignment'
                : 'Archive assignment'}
            </Button>
          }
        >
          <Button
            variant="secondary"
            busy={archive.isPending}
            onClick={() => archive.mutate()}
          >
            {assignment.archived
              ? 'Confirm restore assignment'
              : 'Confirm archive assignment'}
          </Button>
          {archive.error && <Failure error={archive.error} />}
        </Dialog>
      </details>
    </section>
  );
}
