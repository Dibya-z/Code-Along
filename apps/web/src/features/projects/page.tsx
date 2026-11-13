import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Button, Dialog, Field, Notice } from '@code-along/design-system';
import { api } from '../../api/client.ts';
import { Failure } from '../../api/feedback.tsx';
import { queryClient } from '../../app/providers.tsx';
import { SignedIn } from '../auth/guard.tsx';
import type { Page } from '../workspaces/types.ts';
import type { Project, ProjectFile } from './types.ts';
import { ProjectSharing } from './sharing.tsx';
export function ProjectPage() {
  return (
    <SignedIn>
      <ProjectDetails />
    </SignedIn>
  );
}
function ProjectDetails() {
  const { projectId } = useParams();
  const base = `/api/v1/projects/${projectId}/`;
  const [selected, setSelected] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const query = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api<Project>(base),
  });
  const project = query.data;
  const files = useQuery({
    queryKey: ['files', projectId],
    queryFn: () => api<Page<ProjectFile>>(base + 'files/'),
    enabled: Boolean(project),
  });
  const selectedId = selected || project?.entrypoint_file_id;
  const source = useQuery({
    queryKey: ['starter-source', projectId, selectedId],
    queryFn: () => api<ProjectFile>(base + `files/${selectedId}/`),
    enabled: Boolean(project && selectedId),
  });
  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['project', projectId] }),
      queryClient.invalidateQueries({ queryKey: ['files', projectId] }),
      queryClient.invalidateQueries({
        queryKey: ['starter-source', projectId],
      }),
      queryClient.invalidateQueries({ queryKey: ['projects'] }),
    ]);
  }
  const change = useMutation({
    mutationFn: ({
      suffix = '',
      method = 'PATCH',
      body = {},
    }: {
      suffix?: string;
      method?: string;
      body?: Record<string, unknown>;
    }) =>
      api<unknown>(base + suffix, {
        method,
        body: { ...body, expected_version: project?.metadata_version },
      }),
    onSuccess: async (_data, job) => {
      if (job.method === 'DELETE') setSelected('');
      await refresh();
      if (job.method !== 'DELETE' && job.suffix?.startsWith('files/'))
        setRenameOpen(false);
    },
  });
  const add = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<ProjectFile>(base + 'files/', {
        method: 'POST',
        body: { ...body, expected_version: project?.metadata_version },
      }),
    onSuccess: async (file) => {
      await refresh();
      setSelected(file.id);
      setAddOpen(false);
    },
  });
  if (query.isPending)
    return (
      <div className="page">
        <Notice>Loading project…</Notice>
      </div>
    );
  if (query.error || !project)
    return (
      <div className="page">
        <Link to="/workspaces">← Your workspaces</Link>
        <h1>Project unavailable.</h1>
        <Failure error={query.error} />
      </div>
    );
  const canEdit =
    project.role !== 'viewer' &&
    !project.archived &&
    !project.workspace_archived;
  function addFile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    add.mutate({
      path: String(form.get('path')),
      initial_source: String(form.get('initial_source') ?? ''),
    });
  }
  function renameFile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    change.mutate({
      suffix: `files/${selectedId}/`,
      body: { path: String(new FormData(event.currentTarget).get('path')) },
    });
  }
  function renameProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    change.mutate({
      body: { name: String(new FormData(event.currentTarget).get('name')) },
    });
  }
  return (
    <div className="page">
      <Link to={`/workspaces/${project.workspace_id}`}>← Workspace</Link>
      <div className="section-head content-section">
        <div>
          <p className="eyebrow">
            PYTHON PROJECT · {project.role.toUpperCase()}
          </p>
          <h1>{project.name}</h1>
          <p className="muted">
            {project.runtime_id} · Entrypoint {project.entrypoint_path}
          </p>
        </div>
        <span className="badge">
          {project.archived ? 'Archived' : 'Starter source'}
        </span>
      </div>
      {change.error && <Failure error={change.error} />}
      {project.workspace_archived && (
        <Notice>
          This workspace is archived. Ask its owner to restore it before making
          changes.
        </Notice>
      )}
      {project.archived && (
        <Notice>
          This project is archived. Its files remain available to its members.
        </Notice>
      )}
      <div className="project-workbench content-section">
        <aside aria-label="Project files">
          <div className="section-head">
            <h2>Files</h2>
            {canEdit && (
              <Dialog
                open={addOpen}
                onOpenChange={setAddOpen}
                title="Add a Python file"
                description="Use a relative module path. The starter source is kept with the new file."
                trigger={
                  <Button
                    variant="secondary"
                    disabled={add.isPending || change.isPending}
                  >
                    Add file
                  </Button>
                }
              >
                <form className="form-stack" onSubmit={addFile}>
                  <Field
                    label="File path"
                    name="path"
                    required
                    maxLength={160}
                    placeholder="lessons/example.py"
                  />
                  <label htmlFor="initial-source">
                    Starter source (optional)
                  </label>
                  <textarea
                    id="initial-source"
                    name="initial_source"
                    rows={8}
                    maxLength={128 * 1024}
                    spellCheck={false}
                  />
                  {add.error && <Failure error={add.error} />}
                  <Button type="submit" busy={add.isPending}>
                    Add Python file
                  </Button>
                </form>
              </Dialog>
            )}
          </div>
          {files.error && <Failure error={files.error} />}
          <div className="file-list">
            {files.data?.items.map((file) => (
              <button
                type="button"
                key={file.id}
                className="file-button"
                aria-pressed={selectedId === file.id}
                onClick={() => setSelected(file.id)}
              >
                {file.path}
                {file.id === project.entrypoint_file_id && (
                  <span className="muted"> · entry</span>
                )}
              </button>
            ))}
          </div>
        </aside>
        <section aria-label="Starter source">
          <div className="section-head">
            <h2>{source.data?.path ?? 'Starter source'}</h2>
            <span className="badge">Read-only preview</span>
          </div>
          {source.error ? (
            <Failure error={source.error} />
          ) : source.isPending ? (
            <Notice>Loading starter source…</Notice>
          ) : (
            <pre
              className="code-preview"
              tabIndex={0}
              aria-label="Python starter source"
            >
              <code>
                {source.data?.initial_source ||
                  '# This file has no starter source.'}
              </code>
            </pre>
          )}
          {canEdit && source.data && (
            <div className="actions">
              <Dialog
                open={renameOpen}
                onOpenChange={setRenameOpen}
                title="Rename file"
                description="The file keeps its identity and starter source."
                trigger={
                  <Button
                    variant="secondary"
                    disabled={add.isPending || change.isPending}
                  >
                    Rename file
                  </Button>
                }
              >
                <form className="form-stack" onSubmit={renameFile}>
                  <Field
                    label="New file path"
                    name="path"
                    defaultValue={source.data.path}
                    required
                    maxLength={160}
                  />
                  {change.error && <Failure error={change.error} />}
                  <Button type="submit" busy={change.isPending}>
                    Save file path
                  </Button>
                </form>
              </Dialog>
              {selectedId !== project.entrypoint_file_id && (
                <>
                  <Button
                    variant="secondary"
                    busy={change.isPending}
                    onClick={() =>
                      change.mutate({
                        body: { entrypoint_file_id: selectedId },
                      })
                    }
                  >
                    Set as entrypoint
                  </Button>
                  <Dialog
                    title="Remove this file?"
                    description="The file leaves the active project tree. Its record is preserved."
                    trigger={<Button variant="secondary">Remove file</Button>}
                  >
                    {change.error && <Failure error={change.error} />}
                    <Button
                      variant="danger"
                      busy={change.isPending}
                      onClick={() =>
                        change.mutate({
                          suffix: `files/${selectedId}/`,
                          method: 'DELETE',
                        })
                      }
                    >
                      Confirm file removal
                    </Button>
                  </Dialog>
                </>
              )}
            </div>
          )}
        </section>
      </div>
      {project.role === 'owner' && (
        <>
          <section className="content-section">
            <h2>Project settings</h2>
            <form className="form-stack compact-form" onSubmit={renameProject}>
              <Field
                key={project.name}
                label="Project name"
                name="name"
                defaultValue={project.name}
                required
                maxLength={120}
              />
              <Button type="submit" variant="secondary" busy={change.isPending}>
                Save project name
              </Button>
            </form>
            <div className="content-section">
              {project.archived ? (
                <Button
                  variant="secondary"
                  busy={change.isPending}
                  onClick={() => change.mutate({ body: { archived: false } })}
                >
                  Restore project
                </Button>
              ) : (
                <Dialog
                  title="Archive this project?"
                  description="Files stay available to its members. The owner can restore it later."
                  trigger={<Button variant="secondary">Archive project</Button>}
                >
                  {change.error && <Failure error={change.error} />}
                  <Button
                    variant="danger"
                    busy={change.isPending}
                    onClick={() => change.mutate({ body: { archived: true } })}
                  >
                    Confirm project archive
                  </Button>
                </Dialog>
              )}
            </div>
          </section>
          <ProjectSharing project={project} />
        </>
      )}
    </div>
  );
}
