import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Button, Notice } from '@code-along/design-system';
import { runtimeProfile } from '@code-along/contracts/execution/profiles';
import { Failure } from '../../api/feedback.tsx';
import { SignedIn } from '../auth/guard.tsx';
import { useIdentity } from '../auth/session.ts';
import { ProjectDiscussion } from '../discussion/panel.tsx';
import { loadEditorProject } from '../editor/api.ts';
import { EditorWorkbench, type WorkbenchPane } from '../editor/workbench.tsx';
import { learningApi } from './api.ts';
import { participationApi } from './participation-api.ts';
import { formatPublicationTime } from './presentation.ts';
import { OLD_WORK_NOTICE } from './work-model.ts';
import { workSourceAccess } from './work-source.ts';
import type { AssignmentVersion } from './types.ts';
import type { AssignmentWork } from './participation-types.ts';
import './styles.css';

export function AssignmentWorkPage() {
  return (
    <SignedIn>
      <ScopedWork />
    </SignedIn>
  );
}

function ScopedWork() {
  const { assignmentId, workId } = useParams();
  const accountId = useIdentity().data?.id;
  return accountId && assignmentId && workId ? (
    <WorkDetail
      key={`${accountId}:${assignmentId}:${workId}`}
      assignmentId={assignmentId}
      workId={workId}
      accountId={accountId}
    />
  ) : null;
}

function WorkDetail({
  assignmentId,
  workId,
  accountId,
}: {
  assignmentId: string;
  workId: string;
  accountId: string;
}) {
  const work = useQuery({
    queryKey: ['assignment-work', accountId, assignmentId, workId],
    queryFn: ({ signal }) =>
      participationApi.work(assignmentId, workId, signal),
  });
  const [opened, setOpened] = useState<{
    projectId: string;
    versionId: string;
  } | null>(null);
  const versionId = opened?.versionId ?? work.data?.assignment_version_id;
  const version = useQuery({
    queryKey: ['assignment-version', accountId, assignmentId, versionId],
    queryFn: ({ signal }) =>
      learningApi.version(assignmentId, versionId!, signal),
    enabled: Boolean(versionId),
  });
  const source = workSourceAccess(work.data, opened?.projectId ?? null);
  useEffect(() => {
    if (
      !opened &&
      !work.error &&
      !version.error &&
      work.data &&
      version.data &&
      source.projectId
    )
      setOpened({
        projectId: source.projectId,
        versionId: work.data.assignment_version_id,
      });
  }, [
    opened,
    work.data,
    work.error,
    version.data,
    version.error,
    source.projectId,
  ]);
  const workPaused = Boolean(
    work.error ||
    version.error ||
    !source.authorized ||
    (opened && work.data?.assignment_version_id !== opened.versionId),
  );
  async function recheck() {
    await work.refetch({ throwOnError: true });
    if (versionId) await version.refetch({ throwOnError: true });
  }
  return (
    <div className="page project-page">
      <Link to={`/assignments/${assignmentId}#my-work`}>
        ← Assignment and My work
      </Link>
      {work.data && !work.data.can_continue && (
        <Notice>
          This work is no longer eligible for learning actions. Any project
          access you still have is separate. {OLD_WORK_NOTICE}
        </Notice>
      )}
      {work.error && <Failure error={work.error} />}
      {version.error && <Failure error={version.error} />}
      {(work.error || version.error) && (
        <Notice>
          Work access could not be checked. Your open code remains available for
          export; editing is paused until access is checked again.
        </Notice>
      )}
      {!opened && (
        <Button
          type="button"
          variant="secondary"
          busy={work.isFetching || version.isFetching}
          onClick={() => {
            void recheck().catch(() => undefined);
          }}
        >
          Refresh work access
        </Button>
      )}
      {opened && version.data ? (
        <WorkSource
          key={opened.projectId}
          accountId={accountId}
          projectId={opened.projectId}
          work={work.data}
          version={version.data}
          paused={workPaused}
          rechecking={work.isFetching || version.isFetching}
          onRecheckWork={recheck}
        />
      ) : work.data?.project === null ? (
        <section className="content-section">
          <h1>Assignment work</h1>
          <p>
            This work belongs to published version {version.data?.number ?? '…'}
            . This account does not currently have access to its source project.
            No source project has been opened.
          </p>
          {version.data && <TaskGuide version={version.data} />}
        </section>
      ) : !work.error && !version.error ? (
        <Notice>Verifying work and its published task…</Notice>
      ) : null}
    </div>
  );
}

function WorkSource({
  accountId,
  projectId,
  work,
  version,
  paused,
  rechecking,
  onRecheckWork,
}: {
  accountId: string;
  projectId: string;
  work: AssignmentWork | undefined;
  version: AssignmentVersion;
  paused: boolean;
  rechecking: boolean;
  onRecheckWork: () => Promise<unknown>;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const metadata = useQuery({
    // This exact key is the ordinary project event controller's mandatory refresh target.
    queryKey: ['project', projectId, accountId],
    queryFn: ({ signal }) => loadEditorProject(projectId, undefined, signal),
  });
  const valid =
    metadata.data?.project.id === projectId &&
    metadata.data.project.runtime_id === version.runtime.runtime_id;
  const lastVerified = useRef<typeof metadata.data>(undefined);
  useLayoutEffect(() => {
    if (valid) lastVerified.current = metadata.data;
  }, [valid, metadata.data]);
  const snapshot = valid ? metadata.data : lastVerified.current;
  const [selected, setSelected] = useState<string | null>(null);
  const [runToolbar, setRunToolbar] = useState<HTMLDivElement | null>(null);
  const [collaboration, setCollaboration] = useState<HTMLDivElement | null>(
    null,
  );
  const [recovery, setRecovery] = useState<HTMLDivElement | null>(null);
  const [commandBar, setCommandBar] = useState<HTMLDivElement | null>(null);
  const [commandHeight, setCommandHeight] = useState(0);
  const [discussionOpen, setDiscussionOpen] = useState(false);
  useLayoutEffect(() => {
    if (!commandBar) return;
    const measure = () =>
      setCommandHeight(Math.ceil(commandBar.getBoundingClientRect().height));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(commandBar);
    return () => observer.disconnect();
  }, [commandBar]);
  const requested = location.hash.slice(1);
  const pane: WorkbenchPane =
    requested === 'task'
      ? 'guide'
      : requested === 'output'
        ? 'console'
        : 'editor';
  function selectPane(next: WorkbenchPane) {
    void navigate(
      {
        hash: `#${next === 'guide' ? 'task' : next === 'console' ? 'output' : 'code'}`,
      },
      { preventScrollReset: true },
    );
  }
  const sourcePaused = paused || Boolean(metadata.error) || !valid;
  const project = snapshot?.project;
  const files = snapshot?.files;
  const selectedId = files?.items.some((file) => file.id === selected)
    ? selected!
    : (project?.entrypoint_file_id ?? '');
  function refreshAccess() {
    return Promise.all([
      onRecheckWork(),
      metadata.refetch({ throwOnError: true }),
    ]);
  }
  if (!project || !files)
    return (
      <section className="content-section">
        <h1>Assignment work</h1>
        {metadata.error ? (
          <Failure error={metadata.error} />
        ) : metadata.data && !valid ? (
          <Notice tone="error">
            The project environment does not match this published task. No
            editor or runner has been opened.
          </Notice>
        ) : (
          <Notice>Checking current source access…</Notice>
        )}
        <Button
          type="button"
          variant="secondary"
          busy={rechecking || metadata.isFetching}
          onClick={() => {
            void refreshAccess().catch(() => undefined);
          }}
        >
          Refresh work access
        </Button>
      </section>
    );
  return (
    <div
      style={
        {
          '--project-command-height': `${commandHeight + 8}px`,
        } as CSSProperties
      }
    >
      <div className="section-head project-heading">
        <div>
          <p className="eyebrow">ASSIGNMENT WORK · VERSION {version.number}</p>
          <h1>{project.name}</h1>
        </div>
      </div>
      {(sourcePaused || project.archived || project.workspace_archived) && (
        <Notice>
          {sourcePaused
            ? 'Editing is paused until project access is checked. You can still export your code.'
            : 'This project or workspace is archived. Your code remains available; editing is paused.'}
        </Notice>
      )}
      {metadata.error && <Failure error={metadata.error} />}
      <div className="actions">
        <Button
          type="button"
          variant="secondary"
          busy={rechecking || metadata.isFetching}
          onClick={() => {
            void refreshAccess().catch(() => undefined);
          }}
        >
          Refresh work access
        </Button>
        {!work?.can_continue && <span className="badge">Learning paused</span>}
      </div>
      <div ref={setCommandBar} className="project-command-bar">
        <div ref={setRunToolbar} className="project-run-toolbar" />
        <div ref={setCollaboration} className="project-collaboration" />
      </div>
      <div ref={setRecovery} className="project-recovery" />
      <EditorWorkbench
        accountId={accountId}
        project={project}
        files={files.items}
        count={files.count}
        selectedId={selectedId}
        onSelect={setSelected}
        paused={sourcePaused}
        addControl={null}
        fileActions={null}
        targets={{ runToolbar, collaboration, recovery }}
        guide={{
          label: 'Task',
          pane,
          onPaneChange: selectPane,
          render: (visible) => (
            <>
              <TaskGuide version={version} projectId={project.id} />
              <details
                className="task-disclosure"
                open={discussionOpen}
                onToggle={(event) =>
                  setDiscussionOpen(event.currentTarget.open)
                }
              >
                <summary>Project discussion</summary>
                <ProjectDiscussion
                  project={project}
                  accountId={accountId}
                  paused={sourcePaused}
                  active={visible && discussionOpen}
                />
              </details>
            </>
          ),
        }}
      />
    </div>
  );
}

function TaskGuide({
  version,
  projectId,
}: {
  version: AssignmentVersion;
  projectId?: string;
}) {
  const environment = runtimeProfile(version.runtime.runtime_id);
  const policy = version.submission_policy;
  return (
    <article className="assignment-reading" aria-label="Pinned work task">
      <h2>{version.title}</h2>
      <p className="muted">
        Published version {version.number}. New publications do not replace this
        task or project.
      </p>
      <div className="assignment-prose">{version.instructions}</div>
      {version.hints.map((hint, index) => (
        <details className="task-disclosure" key={hint.id}>
          <summary>
            Hint {index + 1}: {hint.title}
          </summary>
          <div className="assignment-prose">{hint.body}</div>
        </details>
      ))}
      <details className="task-disclosure">
        <summary>Task rules and environment</summary>
        <p>
          {policy.mode === 'individual'
            ? 'Individual work'
            : `Teams of up to ${policy.max_team_size}`}{' '}
          · Up to {policy.max_attempts} submission attempts.
        </p>
        <p>
          {policy.due_at ? (
            <>
              Due{' '}
              <time dateTime={policy.due_at}>
                {formatPublicationTime(policy.due_at)}
              </time>
              . Late submissions are rejected; practice remains available.
            </>
          ) : (
            'No due date.'
          )}
        </p>
        <p>{environment?.name ?? 'Reviewed Python environment'}</p>
      </details>
      {projectId && (
        <details className="task-disclosure">
          <summary>Project tools</summary>
          <p>
            Open your source project to manage its files and sharing with your
            current project permissions.
          </p>
          <Link to={`/projects/${projectId}`}>Open source project</Link>
        </details>
      )}
      {version.public_checks && (
        <details className="task-disclosure">
          <summary>Published visible checks</summary>
          <p>These inspectable checks are practice input, not a grade.</p>
          <pre
            className="learning-source"
            tabIndex={0}
            aria-label="Pinned visible Python checks"
          >
            <code>{version.public_checks.source}</code>
          </pre>
        </details>
      )}
    </article>
  );
}
