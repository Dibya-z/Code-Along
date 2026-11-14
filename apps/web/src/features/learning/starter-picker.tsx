import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Button, Field, Notice } from '@code-along/design-system';
import { productApi } from '../../api/product.ts';
import { Failure } from '../../api/feedback.tsx';
import { Pagination } from '../../components/pagination.tsx';
import { revisionApi, type RevisionRequest } from '../history/api.ts';
import { RevisionViewer } from '../history/viewer.tsx';
import { learningApi } from './api.ts';

export function StarterPicker({
  assignmentId,
  workspaceId,
  accountId,
  disabled,
  onSelect,
  onSelecting,
}: {
  assignmentId: string;
  workspaceId: string;
  accountId: string;
  disabled: boolean;
  onSelect: (id: string, label: string) => void;
  onSelecting: (token: string, pending: boolean) => void;
}) {
  const [mode, setMode] = useState<'published' | 'owned' | null>(null);
  return (
    <div className="form-stack">
      <div className="actions">
        <Button
          type="button"
          variant="secondary"
          disabled={disabled}
          onClick={() => setMode('published')}
        >
          Choose a published starter
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={disabled}
          onClick={() => setMode('owned')}
        >
          Choose a new starter from my project
        </Button>
      </div>
      {mode === 'published' && (
        <PublishedStarters
          assignmentId={assignmentId}
          accountId={accountId}
          disabled={disabled}
          onSelect={onSelect}
          onSelecting={onSelecting}
        />
      )}
      {mode === 'owned' && (
        <OwnedStarters
          workspaceId={workspaceId}
          accountId={accountId}
          disabled={disabled}
          onSelect={onSelect}
        />
      )}
    </div>
  );
}
function PublishedStarters({
  assignmentId,
  accountId,
  disabled,
  onSelect,
  onSelecting,
}: {
  assignmentId: string;
  accountId: string;
  disabled: boolean;
  onSelect: (id: string, label: string) => void;
  onSelecting: (token: string, pending: boolean) => void;
}) {
  const [offset, setOffset] = useState(0),
    [selected, setSelected] = useState('');
  const [interrupted, setInterrupted] = useState(false);
  const live = useRef(true),
    allowed = useRef(!disabled),
    current = useRef('');
  allowed.current = !disabled;
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const versions = useQuery({
    queryKey: ['assignment-versions', accountId, assignmentId, offset],
    queryFn: ({ signal }) => learningApi.versions(assignmentId, offset, signal),
  });
  const choose = useMutation({
    mutationFn: ({ versionId }: { versionId: string; token: string }) =>
      learningApi.version(assignmentId, versionId),
    onMutate: ({ token }) => {
      current.current = token;
      setInterrupted(false);
      onSelecting(token, true);
    },
    onSuccess: (version, request) => {
      if (!live.current || current.current !== request.token) return;
      if (!allowed.current) {
        setInterrupted(true);
        return;
      }
      onSelect(
        version.starter.revision_id,
        `Published starter — version ${version.number}`,
      );
      setSelected(version.id);
    },
    onSettled: (_data, _error, request) => onSelecting(request.token, false),
  });
  return (
    <section aria-label="Published starter choices">
      <p>
        Reuse source already published to this assignment. This does not open
        its private source project.
      </p>
      {versions.error && <Failure error={versions.error} />}
      {versions.isFetching && (
        <Notice>Loading published starter choices…</Notice>
      )}
      {versions.data?.count === 0 && (
        <p>No starter has been published to this assignment yet.</p>
      )}
      <div className="list">
        {versions.data?.items.map((version) => (
          <div className="list-row" key={version.id}>
            <span>Published starter — version {version.number}</span>
            <Button
              type="button"
              variant="secondary"
              disabled={disabled}
              busy={choose.isPending}
              aria-pressed={selected === version.id}
              onClick={() => {
                if (!allowed.current || choose.isPending) return;
                choose.mutate({
                  versionId: version.id,
                  token: crypto.randomUUID(),
                });
              }}
            >
              Use starter from version {version.number}
            </Button>
          </div>
        ))}
      </div>
      {choose.error && <Failure error={choose.error} />}
      {interrupted && (
        <Notice>
          The starter choice was paused because assignment access changed.
          Recheck access, then choose it again.
        </Notice>
      )}
      <Pagination
        offset={offset}
        count={versions.data?.count ?? 0}
        limit={20}
        onChange={setOffset}
      />
    </section>
  );
}
function OwnedStarters({
  workspaceId,
  accountId,
  disabled,
  onSelect,
}: {
  workspaceId: string;
  accountId: string;
  disabled: boolean;
  onSelect: (id: string, label: string) => void;
}) {
  const [offset, setOffset] = useState(0),
    [selected, setSelected] = useState('');
  const projects = useQuery({
    queryKey: ['starter-projects', accountId, workspaceId, offset],
    queryFn: () => productApi.projects(workspaceId, offset),
  });
  const owned = projects.data?.items.filter(
    (project) => project.role === 'owner',
  );
  return (
    <section aria-label="Owned project starter choices">
      <p>
        Only a project you own in this workspace can disclose a new private
        revision. Wait for Saved in its workbench before capturing your latest
        edits.
      </p>
      {projects.error && <Failure error={projects.error} />}
      {projects.isFetching && <Notice>Loading projects you own…</Notice>}
      <label htmlFor="starter-project">Starter source project</label>
      <select
        id="starter-project"
        value={selected}
        disabled={disabled}
        onChange={(event) => setSelected(event.target.value)}
      >
        <option value="">Choose your project</option>
        {owned?.map((project) => (
          <option key={project.id} value={project.id}>
            {project.name}
            {project.archived ? ' (archived)' : ''}
          </option>
        ))}
      </select>
      {owned?.length === 0 && (
        <p>
          No projects you own on this page. Create a project or continue through
          the project pages.
        </p>
      )}
      <Pagination
        offset={offset}
        count={projects.data?.count ?? 0}
        limit={50}
        onChange={setOffset}
      />
      {selected && (
        <OwnedRevisions
          key={selected}
          projectId={selected}
          accountId={accountId}
          disabled={disabled}
          onSelect={onSelect}
        />
      )}
    </section>
  );
}
function OwnedRevisions({
  projectId,
  accountId,
  disabled,
  onSelect,
}: {
  projectId: string;
  accountId: string;
  disabled: boolean;
  onSelect: (id: string, label: string) => void;
}) {
  const [offset, setOffset] = useState(0),
    [selected, setSelected] = useState('');
  const [pending, setPending] = useState<RevisionRequest | null>(null);
  const [captureName, setCaptureName] = useState('');
  const project = useQuery({
    queryKey: ['starter-project', accountId, projectId],
    queryFn: () => productApi.project(projectId),
  });
  const revisions = useQuery({
    queryKey: ['starter-revisions', accountId, projectId, offset],
    queryFn: () => revisionApi.list(projectId, offset),
    enabled: project.data?.role === 'owner',
  });
  const detail = useQuery({
    queryKey: ['starter-revision', accountId, projectId, selected],
    queryFn: ({ signal }) => revisionApi.detail(projectId, selected, signal),
    enabled: Boolean(selected) && project.data?.role === 'owner',
  });
  const capture = useMutation({
    mutationFn: (request: RevisionRequest) =>
      revisionApi.create(projectId, request),
    onSuccess: (revision) => {
      setPending(null);
      setSelected(revision.id);
      void revisions.refetch();
    },
  });
  function create() {
    if (!project.data || !captureName) return;
    const request = Object.freeze({
      name: captureName,
      expected_version: project.data.metadata_version,
      client_request_id: crypto.randomUUID(),
    });
    setPending(request);
    capture.mutate(request);
  }
  return (
    <div className="content-section">
      {project.error && <Failure error={project.error} />}
      {project.data?.role !== undefined && project.data.role !== 'owner' && (
        <Notice tone="error">
          Current source ownership is required to choose a new private starter.
        </Notice>
      )}
      {revisions.error && <Failure error={revisions.error} />}
      <div className="list">
        {revisions.data?.items.map((revision) => (
          <div className="list-row" key={revision.id}>
            <span>{revision.name}</span>
            <Button
              type="button"
              variant="secondary"
              disabled={disabled}
              aria-pressed={selected === revision.id}
              onClick={() => setSelected(revision.id)}
            >
              Inspect revision {revision.name}
            </Button>
          </div>
        ))}
      </div>
      <Pagination
        offset={offset}
        count={revisions.data?.count ?? 0}
        limit={20}
        onChange={setOffset}
      />
      {project.data?.role === 'owner' &&
        !project.data.archived &&
        !project.data.workspace_archived && (
          <div className="form-stack compact-form">
            <Field
              label="New starter revision name"
              value={captureName}
              onChange={(event) => setCaptureName(event.target.value)}
              maxLength={120}
              disabled={disabled || Boolean(pending)}
            />
            <p className="muted">
              Captures the shared room at the server point. Wait for Saved in
              the project first.
            </p>
            {!pending && (
              <Button
                type="button"
                variant="secondary"
                disabled={disabled || !captureName}
                busy={capture.isPending}
                onClick={create}
              >
                Capture frozen starter revision
              </Button>
            )}
            {pending && !capture.isPending && (
              <Button
                type="button"
                variant="secondary"
                disabled={disabled}
                onClick={() => capture.mutate(pending)}
              >
                Retry same starter capture
              </Button>
            )}
            {capture.error && <Failure error={capture.error} />}
          </div>
        )}
      {detail.isFetching && <Notice>Verifying frozen revision…</Notice>}
      {detail.error && <Failure error={detail.error} />}{' '}
      {detail.data && !detail.error && (
        <>
          <RevisionViewer
            manifest={detail.data.manifest}
            name={detail.data.name}
          />
          <Button
            type="button"
            disabled={disabled}
            onClick={() =>
              onSelect(
                detail.data.id,
                `Owned project revision: ${detail.data.name}`,
              )
            }
          >
            Use this frozen starter
          </Button>
        </>
      )}
    </div>
  );
}
