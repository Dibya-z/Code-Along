import { useState, type FormEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { Button, Field, Notice } from '@code-along/design-system';
import { Failure } from '../../api/feedback.tsx';
import { ApiError } from '../../api/client.ts';
import { queryClient } from '../../app/providers.tsx';
import { Pagination } from '../../components/pagination.tsx';
import type { Project } from '../projects/types.ts';
import { revisionApi, type RevisionRequest } from './api.ts';
import { RevisionViewer } from './viewer.tsx';

export function ProjectHistory({
  project,
  accountId,
  paused,
}: {
  project: Project;
  accountId: string;
  paused: boolean;
}) {
  const [offset, setOffset] = useState(0),
    [selected, setSelected] = useState('');
  const [pending, setPending] = useState<RevisionRequest | null>(null);
  const navigate = useNavigate();
  const key = ['revisions', accountId, project.id];
  const list = useQuery({
    queryKey: [...key, offset],
    queryFn: () => revisionApi.list(project.id, offset),
  });
  const detail = useQuery({
    queryKey: ['revision', accountId, project.id, selected],
    queryFn: ({ signal }) => revisionApi.detail(project.id, selected, signal),
    enabled: Boolean(selected),
  });
  const create = useMutation({
    mutationFn: (request: RevisionRequest) =>
      revisionApi.create(project.id, request),
    onSuccess: async (revision) => {
      setPending(null);
      setSelected(revision.id);
      setOffset(0);
      await queryClient.invalidateQueries({ queryKey: key });
    },
  });
  const copy = useMutation({
    mutationFn: (name: string) => revisionApi.copy(project.id, selected, name),
    onSuccess: (created) => {
      void navigate(`/projects/${created.id}`);
    },
  });
  const canCapture =
    !paused &&
    project.role !== 'viewer' &&
    !project.archived &&
    !project.workspace_archived;
  function capture(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const request = Object.freeze({
      name: String(new FormData(event.currentTarget).get('name')),
      expected_version: project.metadata_version,
      client_request_id: crypto.randomUUID(),
    });
    setPending(request);
    create.mutate(request);
  }
  return (
    <section
      className="content-section history-panel"
      aria-labelledby="history-heading"
    >
      <div className="section-head">
        <div>
          <h2 id="history-heading">History</h2>
          <p className="muted">
            Name a shared revision to keep an immutable copy of every file.
          </p>
        </div>
        <Button
          variant="secondary"
          busy={list.isFetching}
          onClick={() => {
            void list.refetch();
          }}
        >
          Refresh history
        </Button>
      </div>
      <p className="muted">
        A revision captures the shared room at the server capture point. Wait
        for Saved before capturing if you want your latest edits included. It
        does not replace the live room.
      </p>
      {canCapture && (
        <form className="form-stack compact-form" onSubmit={capture}>
          <Field
            label="Revision name"
            name="name"
            required
            maxLength={120}
            disabled={Boolean(pending)}
            placeholder="Before refactoring"
          />
          {!pending && (
            <Button type="submit" busy={create.isPending}>
              Capture shared revision
            </Button>
          )}
        </form>
      )}
      {create.isPending && <p role="status">Capturing the shared room…</p>}
      {create.error && (
        <>
          <Failure error={create.error} />
          <Notice>
            {create.error instanceof ApiError && create.error.status === 409
              ? 'Project metadata changed or this request conflicts. Refresh the project before starting a new capture.'
              : 'The capture is not confirmed. Retry the same request to avoid creating a duplicate revision.'}
          </Notice>
        </>
      )}
      {pending && !create.isPending && (
        <div className="actions">
          <Button disabled={!canCapture} onClick={() => create.mutate(pending)}>
            Retry same capture
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              setPending(null);
              create.reset();
            }}
          >
            Start a new capture
          </Button>
        </div>
      )}
      {list.error && <Failure error={list.error} />}
      {list.isPending && <Notice>Loading shared revisions…</Notice>}
      {list.data?.count === 0 && <p>No named revisions yet.</p>}
      <div className="list">
        {list.data?.items.map((revision) => (
          <div className="list-row" key={revision.id}>
            <div>
              <strong>{revision.name}</strong>
              <p>
                {revision.author.display_name} ·{' '}
                {new Date(revision.created_at).toLocaleString()}
              </p>
            </div>
            <Button
              variant="secondary"
              aria-pressed={selected === revision.id}
              onClick={() => {
                setSelected(revision.id);
                copy.reset();
              }}
            >
              View revision {revision.name}
            </Button>
          </div>
        ))}
      </div>
      <Pagination
        offset={offset}
        count={list.data?.count ?? 0}
        limit={20}
        onChange={setOffset}
      />
      {detail.isFetching && selected && (
        <Notice>Verifying frozen source…</Notice>
      )}
      {detail.error && <Failure error={detail.error} />}
      {detail.data && !detail.error && (
        <>
          <RevisionViewer
            key={detail.data.id}
            manifest={detail.data.manifest}
            name={detail.data.name}
          />
          <form
            className="form-stack compact-form"
            onSubmit={(event) => {
              event.preventDefault();
              copy.mutate(
                String(new FormData(event.currentTarget).get('name')),
              );
            }}
          >
            <p className="muted">
              Copying creates a new server project with fresh file identities.
              This shared room stays as it is.
            </p>
            <Field
              label="Copied project name"
              name="name"
              key={detail.data.id}
              defaultValue={`${detail.data.name.slice(0, 110)} copy`}
              required
              maxLength={120}
            />
            {copy.error && <Failure error={copy.error} />}
            <Button
              type="submit"
              variant="secondary"
              busy={copy.isPending}
              disabled={paused || project.workspace_archived}
            >
              Copy revision to new project
            </Button>
          </form>
        </>
      )}
    </section>
  );
}
