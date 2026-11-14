import {
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type CSSProperties,
} from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Button, Dialog, Field, Notice } from '@code-along/design-system';
import { api } from '../../api/client.ts';
import { Failure } from '../../api/feedback.tsx';
import { queryClient } from '../../app/providers.tsx';
import { SignedIn } from '../auth/guard.tsx';
import { useIdentity } from '../auth/session.ts';
import { loadEditorProject } from '../editor/api.ts';
import { EditorWorkbench } from '../editor/workbench.tsx';
import type { ProjectFile } from './types.ts';
import { ProjectSharing } from './sharing.tsx';
import { ProjectHistory } from '../history/panel.tsx';
import { ProjectShares } from '../shares/management.tsx';
import { ProjectDiscussion } from '../discussion/panel.tsx';
import { runtimeProfile } from '@code-along/contracts/execution/profiles';

const projectSections = [
  'code',
  'discussion',
  'history',
  'sharing',
  'settings',
] as const;
type ProjectSection = (typeof projectSections)[number];
export function ProjectPage() {
  return (
    <SignedIn>
      <ProjectDetails />
    </SignedIn>
  );
}
function ProjectDetails() {
  const { projectId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const focusSection = useRef(false);
  const sectionFocus = useRef<{ section: string; target: HTMLElement } | null>(
    null,
  );
  const [runToolbar, setRunToolbar] = useState<HTMLDivElement | null>(null);
  const [commandBar, setCommandBar] = useState<HTMLDivElement | null>(null);
  const [commandHeight, setCommandHeight] = useState(0);
  const [collaborationTarget, setCollaborationTarget] =
    useState<HTMLDivElement | null>(null);
  const [recoveryTarget, setRecoveryTarget] = useState<HTMLDivElement | null>(
    null,
  );
  useLayoutEffect(() => {
    if (!commandBar) return;
    const measure = () =>
      setCommandHeight(Math.ceil(commandBar.getBoundingClientRect().height));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(commandBar);
    return () => observer.disconnect();
  }, [commandBar]);
  const base = `/api/v1/projects/${projectId}/`;
  const identity = useIdentity();
  const [selected, setSelected] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const query = useQuery({
    queryKey: ['project', projectId, identity.data?.id],
    queryFn: ({ signal }) =>
      loadEditorProject(projectId ?? '', undefined, signal),
    enabled: Boolean(identity.data),
  });
  const project = query.data?.project;
  const requestedSection = location.hash.slice(1);
  const section: ProjectSection =
    projectSections.includes(requestedSection as ProjectSection) &&
    (!['sharing', 'settings'].includes(requestedSection) ||
      project?.role === 'owner')
      ? (requestedSection as ProjectSection)
      : 'code';
  useLayoutEffect(() => {
    const previous = sectionFocus.current;
    if (
      !focusSection.current &&
      !(
        previous &&
        previous.section !== section &&
        (document.activeElement === document.body ||
          previous.target.closest('[hidden]'))
      )
    )
      return;
    focusSection.current = false;
    document.getElementById(section)?.focus();
  }, [section, location.key]);
  const files = query.data?.files;
  const selectedId =
    selected === ''
      ? ''
      : files?.items.some((file) => file.id === selected)
        ? (selected ?? '')
        : (project?.entrypoint_file_id ?? '');
  const selectedFile = files?.items.find((file) => file.id === selectedId);
  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['project', projectId] }),
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
      api<unknown>(
        base +
          suffix +
          (method === 'DELETE'
            ? `?expected_version=${project?.metadata_version}`
            : ''),
        {
          method,
          ...(method === 'DELETE'
            ? {}
            : {
                body: { ...body, expected_version: project?.metadata_version },
              }),
        },
      ),
    onSuccess: async (_data, job) => {
      if (job.method === 'DELETE') setSelected(null);
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
  if (!project || !files || !identity.data)
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
    !project.workspace_archived &&
    !query.error;
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
    <div
      className="page project-page"
      style={
        {
          '--project-command-height': `${commandHeight + 8}px`,
        } as CSSProperties
      }
      onFocusCapture={(event) => {
        const scope = event.target.closest<HTMLElement>(
          '[data-project-section]',
        );
        sectionFocus.current = scope
          ? { section: scope.dataset.projectSection!, target: event.target }
          : event.target.closest('[role="dialog"]')
            ? { section, target: event.target }
            : null;
      }}
    >
      <Link to={`/workspaces/${project.workspace_id}`}>← Workspace</Link>
      <div className="section-head project-heading">
        <div>
          <h1>{project.name}</h1>
          <p className="muted">
            {runtimeProfile(project.runtime_id)?.name ?? 'Python'} · Entrypoint{' '}
            {project.entrypoint_path}
          </p>
        </div>
        <div className="actions">
          <span className="badge">
            {project.archived
              ? 'Archived'
              : project.role[0]!.toUpperCase() + project.role.slice(1)}
          </span>
          <Button
            variant="secondary"
            busy={query.isFetching}
            onClick={() => {
              void query.refetch();
            }}
          >
            Refresh project
          </Button>
        </div>
      </div>
      <nav className="project-section-nav" aria-label="Project sections">
        {projectSections
          .filter(
            (item) =>
              project.role === 'owner' ||
              !['sharing', 'settings'].includes(item),
          )
          .map((item) => (
            <Link
              key={item}
              to={{ hash: `#${item}` }}
              preventScrollReset
              aria-current={section === item ? 'page' : undefined}
              onClick={(event) => {
                if (
                  event.button !== 0 ||
                  event.metaKey ||
                  event.ctrlKey ||
                  event.shiftKey ||
                  event.altKey
                )
                  return;
                if (section === item) {
                  event.preventDefault();
                  focusSection.current = false;
                  document.getElementById(item)?.focus();
                  return;
                }
                focusSection.current = true;
              }}
            >
              {item[0]!.toUpperCase() + item.slice(1)}
            </Link>
          ))}
      </nav>
      {change.error && <Failure error={change.error} />}
      {query.error && (
        <>
          <Failure error={query.error} />
          <Notice>
            Editing is paused until project access and metadata can be checked.
            Your open draft is still here.{' '}
          </Notice>
        </>
      )}
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
      <div ref={setCommandBar} className="project-command-bar">
        <div ref={setRunToolbar} className="project-run-toolbar" />
        <div ref={setCollaborationTarget} className="project-collaboration" />
      </div>
      <div ref={setRecoveryTarget} className="project-recovery" />
      <div
        id="code"
        data-project-section="code"
        tabIndex={-1}
        hidden={section !== 'code'}
        className="project-section"
      >
        <EditorWorkbench
          accountId={identity.data.id}
          project={project}
          files={files.items}
          count={files.count}
          selectedId={selectedId}
          onSelect={setSelected}
          paused={Boolean(query.error)}
          targets={{
            runToolbar,
            collaboration: collaborationTarget,
            recovery: recoveryTarget,
          }}
          onRun={() => {
            void navigate(
              { hash: '#code' },
              { replace: true, preventScrollReset: true },
            );
          }}
          addControl={
            canEdit && (
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
            )
          }
          fileActions={
            canEdit &&
            selectedFile && (
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
                      defaultValue={selectedFile.path}
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
            )
          }
        />
      </div>
      <div hidden={section !== 'discussion'} data-project-section="discussion">
        <ProjectDiscussion
          project={project}
          accountId={identity.data.id}
          paused={Boolean(query.error)}
          active={section === 'discussion'}
        />
      </div>
      <div
        id="history"
        data-project-section="history"
        tabIndex={-1}
        hidden={section !== 'history'}
        className="project-section"
      >
        <ProjectHistory
          project={project}
          accountId={identity.data.id}
          paused={Boolean(query.error)}
          active={section === 'history'}
        />
      </div>
      {project.role === 'owner' && (
        <>
          <div
            id="sharing"
            data-project-section="sharing"
            tabIndex={-1}
            hidden={section !== 'sharing'}
            className="project-section"
          >
            <ProjectShares
              project={project}
              accountId={identity.data.id}
              paused={Boolean(query.error)}
              active={section === 'sharing'}
            />
            <ProjectSharing project={project} active={section === 'sharing'} />
          </div>
          <div
            id="settings"
            data-project-section="settings"
            tabIndex={-1}
            hidden={section !== 'settings'}
            className="project-section"
          >
            <section className="content-section">
              <h2>Project settings</h2>
              <form
                className="form-stack compact-form"
                onSubmit={renameProject}
              >
                <Field
                  key={project.name}
                  label="Project name"
                  name="name"
                  defaultValue={project.name}
                  required
                  maxLength={120}
                />
                <Button
                  type="submit"
                  variant="secondary"
                  busy={change.isPending}
                >
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
                    trigger={
                      <Button variant="secondary">Archive project</Button>
                    }
                  >
                    {change.error && <Failure error={change.error} />}
                    <Button
                      variant="danger"
                      busy={change.isPending}
                      onClick={() =>
                        change.mutate({ body: { archived: true } })
                      }
                    >
                      Confirm project archive
                    </Button>
                  </Dialog>
                )}
              </div>
            </section>
          </div>
        </>
      )}
    </div>
  );
}
