import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type CSSProperties,
} from 'react';
import { useQueries } from '@tanstack/react-query';
import { Button, Notice } from '@code-along/design-system';
import { productApi } from '../../api/product.ts';
import type {
  LiveEditorProject,
  OrdinaryEditorProject,
} from '../projects/types.ts';
import { EditorWorkspace } from './model/workspace.ts';
import type { FileMetadata } from './model/document.ts';
import { CodeEditor } from './components/code-editor.tsx';
import { FileTabs } from './components/file-tabs.tsx';
import { FileTree } from './components/file-tree.tsx';
import { ExecutionPanel, type PracticeAction } from '../execution/panel.tsx';
import type { WorkExecutionContext } from '../execution/practice.ts';
import './styles.css';
import { RecoveryController } from '../recovery/controller.ts';
import { recoveryStore } from '../recovery/store.ts';
import { RecoveryPanel } from '../recovery/panel.tsx';
import type { ValidatedRecovery } from '../recovery/codec.ts';
import { ProjectCollaboration } from '../collaboration/controller.ts';
import { CollaborationPanel } from '../collaboration/panel.tsx';
import type { TicketLoader } from '../collaboration/api.ts';
import type { FileSource } from './model/workspace.ts';
import { SharedSourceActions } from './source-actions.tsx';
import { createPortal } from 'react-dom';

const noSubscription = () => () => {};
const noCollaboration = () => null;
const noCompactGuide = () => false;
const compactGuideQuery = '(max-width: 79.99rem)';
const compactGuideSnapshot = () => window.matchMedia(compactGuideQuery).matches;
function subscribeGuideViewport(changed: () => void) {
  const media = window.matchMedia(compactGuideQuery);
  media.addEventListener('change', changed);
  return () => media.removeEventListener('change', changed);
}

export type WorkbenchPane = 'guide' | 'editor' | 'console';

interface WorkbenchProps {
  accountId: string;
  files: readonly FileMetadata[];
  count: number;
  selectedId: string;
  onSelect: (id: string) => void;
  paused: boolean;
  guide?: {
    label: string;
    render: (visible: boolean) => ReactNode;
    pane: WorkbenchPane;
    onPaneChange: (pane: WorkbenchPane) => void;
  };
  targets?: {
    readonly runToolbar: HTMLElement | null;
    readonly collaboration: HTMLElement | null;
    readonly recovery: HTMLElement | null;
  };
  onRun?: () => void;
}
type Props = WorkbenchProps &
  (
    | {
        project: OrdinaryEditorProject;
        addControl: ReactNode;
        fileActions: ReactNode;
        local?: ValidatedRecovery;
        localSources?: ReadonlyMap<string, string>;
        task?: WorkExecutionContext;
        practice?: PracticeAction;
        executionConflict?: string | null;
        capability?: never;
      }
    | {
        project: LiveEditorProject;
        addControl?: never;
        fileActions?: never;
        local?: never;
        localSources?: never;
        task?: never;
        practice?: never;
        executionConflict?: never;
        capability: {
          readonly kind: 'live_share';
          readonly shareId: string;
          readonly baselines: readonly FileSource[];
          readonly ticket: TicketLoader;
        };
      }
  );
export function EditorWorkbench(props: Props) {
  return (
    <ScopedWorkbench
      key={`${props.accountId}:${props.local ? 'draft' : (props.capability?.shareId ?? 'project')}:${props.project.id}`}
      {...props}
    />
  );
}
function ScopedWorkbench({
  accountId,
  project,
  files,
  count,
  selectedId,
  onSelect,
  addControl,
  fileActions,
  paused,
  local,
  localSources,
  capability,
  targets,
  onRun,
  guide,
  task,
  practice,
  executionConflict,
}: Props) {
  const name = useRef(project.name);
  name.current = project.name;
  const [resource] = useState(() => {
    const model = new EditorWorkspace(
      accountId,
      project.id,
      local ? 'local_draft' : 'project',
      !local,
    );
    if (local) {
      model.reconcile(project, files, count);
      model.restoreFiles(local.data.files);
    }
    return {
      model,
      collaboration: local
        ? null
        : new ProjectCollaboration(model, capability?.ticket),
      recovery: capability
        ? null
        : new RecoveryController(
            model,
            () => name.current,
            recoveryStore(),
            undefined,
            local,
          ),
      leases: 0,
    };
  });
  const workspace = resource.model;
  const collaboration = useSyncExternalStore(
    resource.collaboration?.subscribe ?? noSubscription,
    resource.collaboration?.getEditingSnapshot ?? noCollaboration,
  );
  const summary = useSyncExternalStore(
    workspace.subscribe,
    workspace.getSnapshot,
  );
  const [open, setOpen] = useState<string[]>(selectedId ? [selectedId] : []);
  const [notice, setNotice] = useState('');
  const [following, setFollowing] = useState<number | null>(null);
  const [fontSize, setFontSize] = useState('1rem');
  const [localPane, setLocalPane] = useState<'editor' | 'console'>('editor');
  const [context, setContext] = useState<'guide' | 'files'>('guide');
  const compactGuide = useSyncExternalStore(
    guide ? subscribeGuideViewport : noSubscription,
    guide ? compactGuideSnapshot : noCompactGuide,
    noCompactGuide,
  );
  const pane = guide?.pane ?? localPane;
  const hasGuide = Boolean(guide);
  const root = useRef<HTMLDivElement>(null);
  const contextPanel = useRef<HTMLElement>(null);
  const editorPanel = useRef<HTMLElement>(null);
  const lastFocus = useRef<HTMLElement | null>(null);
  const selectedFocus = useRef<string | null>(null);
  const guideId = `workbench-guide-${project.id}`;
  const guideVisible = Boolean(
    guide && (compactGuide ? pane === 'guide' : context === 'guide'),
  );
  const [consoleWidth, setConsoleWidth] = useState('34');
  const [toolbar, setToolbar] = useState<HTMLDivElement | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [filesOpen, setFilesOpen] = useState(false);
  useEffect(() => {
    if (guide?.pane === 'guide') {
      setContext('guide');
      if (compactGuide) setFilesOpen(false);
    }
  }, [guide?.pane, compactGuide]);
  useLayoutEffect(() => {
    if (!hasGuide) return;
    if (
      selectedFocus.current !== null &&
      pane === 'editor' &&
      selectedFocus.current === selectedId
    ) {
      const tab = document.getElementById(`editor-tab-${selectedId}`);
      (tab ?? editorPanel.current)?.focus();
      selectedFocus.current = null;
      return;
    }
    const previous = lastFocus.current;
    if (
      previous &&
      (document.activeElement === document.body ||
        document.activeElement === previous) &&
      !previous.getClientRects().length
    ) {
      const destination = compactGuide
        ? root.current?.querySelector<HTMLElement>(
            `[data-workbench-pane="${pane}"]`,
          )
        : pane === 'guide'
          ? contextPanel.current
          : pane === 'console'
            ? root.current?.querySelector<HTMLElement>(
                '.execution-panel summary',
              )
            : editorPanel.current;
      destination?.focus();
    }
  }, [hasGuide, pane, compactGuide, context, selectedId, filesOpen]);
  function selectPane(next: WorkbenchPane) {
    if (guide) {
      if (next === 'guide') {
        setContext('guide');
        if (compactGuide) setFilesOpen(false);
      }
      if (guide.pane !== next) guide.onPaneChange(next);
    } else if (next !== 'guide') setLocalPane(next);
  }
  function selectFile(id: string) {
    if (guide && compactGuide) {
      if (filesOpen || guide.pane !== 'editor') selectedFocus.current = id;
      setFilesOpen(false);
    }
    if (guide && guide.pane !== 'editor') {
      guide.onPaneChange('editor');
    }
    onSelect(id);
  }
  useEffect(() => {
    resource.leases++;
    resource.collaboration?.start();
    resource.recovery?.start();
    return () => {
      resource.leases--;
      // React StrictMode replays effects; an actual unmount must still release all private buffers.
      queueMicrotask(() => {
        if (resource.leases === 0) {
          resource.recovery?.dispose();
          resource.collaboration?.destroy();
          resource.model.destroy();
        }
      });
    };
  }, [resource]);
  useEffect(() => {
    resource.collaboration?.setPaused(paused);
  }, [resource, paused]);
  useLayoutEffect(() => {
    workspace.reconcile(project, files, count);
    if (localSources)
      for (const file of files) {
        const initial_source = localSources.get(file.id);
        if (initial_source !== undefined && !workspace.file(file.id)?.loaded)
          void workspace
            .loadSource({ ...file, initial_source })
            .catch(() =>
              setNotice(
                'The new local file could not be verified. Export your existing files.',
              ),
            );
      }
  }, [workspace, project, files, count, localSources]);
  useLayoutEffect(() => {
    setFollowing(null);
    if (selectedId)
      setOpen((previous) =>
        previous.includes(selectedId) ? previous : [...previous, selectedId],
      );
    setNotice('');
  }, [selectedId]);
  useEffect(() => {
    if (following === null) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFollowing(null);
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [following]);
  const sources = useQueries({
    queries: (local || capability ? [] : files).map((file) => ({
      queryKey: [
        'editor-source',
        accountId,
        project.id,
        file.id,
        file.document_id,
        file.generation,
        file.initial_sha256,
      ],
      queryFn: () => productApi.file(project.id, file.id),
      staleTime: Infinity,
    })),
  });
  const sourceSignature = sources
    .map(
      (query, index) =>
        `${files[index]?.document_id}:${files[index]?.generation}:${query.dataUpdatedAt}:${query.status}`,
    )
    .join('|');
  useEffect(() => {
    let active = true;
    const baselines =
      capability?.baselines ??
      sources.flatMap((query) => (query.data ? [query.data] : []));
    for (const value of baselines) {
      void workspace.loadSource(value).catch((error) => {
        if (active)
          setErrors((previous) => ({
            ...previous,
            [value.id]:
              error instanceof Error
                ? error.message
                : 'Source could not be verified.',
          }));
      });
    }
    return () => {
      active = false;
    };
  }, [workspace, sourceSignature, capability?.baselines]);
  const active = workspace.file(selectedId);
  const sourceIndex = files.findIndex((file) => file.id === selectedId);
  const query = sources[sourceIndex];
  const sourceError =
    errors[selectedId] ||
    (query?.error instanceof Error ? query.error.message : '');
  const tabs = open
    .map((id) => summary.files.find((file) => file.id === id))
    .filter((file) => file !== undefined);
  function close(id: string) {
    const index = tabs.findIndex((file) => file.id === id);
    const next = tabs.filter((file) => file.id !== id);
    setOpen(next.map((file) => file.id));
    if (selectedId === id) {
      const target = next[Math.min(index, next.length - 1)];
      onSelect(target?.id ?? '');
      document
        .getElementById(
          target ? `editor-tab-${target.id}` : `editor-file-${files[0]?.id}`,
        )
        ?.focus();
    }
  }
  return (
    <div
      ref={root}
      className="editor-workbench content-section"
      data-pane={pane}
      data-guide={guide ? 'true' : undefined}
      data-guide-compact={guide ? String(compactGuide) : undefined}
      onFocusCapture={
        guide
          ? (event) => {
              if (root.current?.contains(event.target))
                lastFocus.current = event.target;
            }
          : undefined
      }
      data-collaboration={Boolean(
        resource.collaboration && !targets?.collaboration,
      )}
      style={
        {
          '--editor-font-size': fontSize,
          '--console-width': `${consoleWidth}%`,
        } as CSSProperties
      }
    >
      <div className="workbench-controls">
        <div ref={setToolbar} hidden={Boolean(targets?.runToolbar)} />
        <nav className="pane-switch" aria-label="Workbench panes">
          {guide ? (
            <>
              <Button
                type="button"
                variant="secondary"
                data-workbench-pane="guide"
                aria-pressed={pane === 'guide'}
                onClick={() => selectPane('guide')}
              >
                {guide.label}
              </Button>
              <Button
                type="button"
                variant="secondary"
                data-workbench-pane="editor"
                aria-pressed={pane === 'editor'}
                onClick={() => selectPane('editor')}
              >
                Code
              </Button>
              <Button
                type="button"
                variant="secondary"
                data-workbench-pane="console"
                aria-pressed={pane === 'console'}
                onClick={() => selectPane('console')}
              >
                Output
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="secondary"
                aria-pressed={pane === 'editor'}
                onClick={() => setLocalPane('editor')}
              >
                Editor
              </Button>
              <Button
                variant="secondary"
                aria-pressed={pane === 'console'}
                onClick={() => setLocalPane('console')}
              >
                Console
              </Button>
              <Button
                className="files-toggle"
                variant="secondary"
                aria-expanded={filesOpen}
                aria-label={filesOpen ? 'Hide files' : 'Show files'}
                aria-controls="project-file-list"
                onClick={() => setFilesOpen(!filesOpen)}
              >
                Files <span aria-hidden="true">{filesOpen ? '▴' : '▾'}</span>
              </Button>
            </>
          )}
        </nav>
        <label className="console-width">
          Console width{' '}
          <input
            type="range"
            min="28"
            max="44"
            value={consoleWidth}
            onChange={(event) => setConsoleWidth(event.target.value)}
          />
          {consoleWidth}%
        </label>
      </div>
      {resource.collaboration &&
        (() => {
          const panel = (
            <CollaborationPanel
              model={resource.collaboration}
              selectedId={selectedId}
              accountId={accountId}
              following={following}
              onFollow={setFollowing}
              compact={Boolean(targets?.collaboration)}
            />
          );
          return targets?.collaboration
            ? createPortal(panel, targets.collaboration)
            : panel;
        })()}
      <aside
        ref={contextPanel}
        className="editor-explorer"
        aria-label={guide ? `${guide.label} and files` : 'Project files'}
        data-open={guide ? true : filesOpen}
        hidden={Boolean(
          guide &&
          compactGuide &&
          pane !== 'guide' &&
          (pane !== 'editor' || !filesOpen),
        )}
        tabIndex={guide ? -1 : undefined}
      >
        {guide && (
          <>
            <nav
              className="workbench-context-switch"
              aria-label="Task and files"
              hidden={compactGuide}
            >
              <Button
                type="button"
                variant="secondary"
                aria-pressed={context === 'guide'}
                aria-controls={guideId}
                onClick={() => selectPane('guide')}
              >
                {guide.label}
              </Button>
              <Button
                type="button"
                variant="secondary"
                aria-pressed={context === 'files'}
                aria-controls="project-file-list"
                onClick={() => setContext('files')}
              >
                Files
              </Button>
            </nav>
            <div
              id={guideId}
              className="workbench-guide-content"
              hidden={compactGuide ? pane !== 'guide' : context !== 'guide'}
            >
              {guide.render(guideVisible)}
            </div>
          </>
        )}
        <div
          id="project-file-list"
          className="editor-files-content"
          hidden={Boolean(
            guide &&
            (compactGuide
              ? pane !== 'editor' || !filesOpen
              : context !== 'files'),
          )}
        >
          <div className="section-head">
            <h2>Files</h2>
            {addControl}
          </div>
          <FileTree
            files={summary.files}
            selectedId={selectedId}
            entrypoint={summary.entrypoint}
            onSelect={selectFile}
          />
          <p className="editor-scope-note">
            {local
              ? 'This local draft stays in this browser.'
              : capability
                ? 'This link grants source access only. Saved confirms your current code is stored in Code Along.'
                : 'Live edits are shared with project members. Saved confirms your current code is stored in Code Along.'}
          </p>
        </div>
      </aside>
      <section
        ref={editorPanel}
        className="editor-pane"
        aria-label="Python workbench"
        hidden={Boolean(guide && compactGuide && pane !== 'editor')}
        tabIndex={guide ? -1 : undefined}
      >
        <FileTabs
          files={tabs}
          selectedId={selectedId}
          onSelect={selectFile}
          onClose={close}
        />
        <div className="editor-pane-head">
          {guide && compactGuide && (
            <Button
              type="button"
              className="guide-files-toggle"
              variant="secondary"
              aria-expanded={filesOpen}
              aria-label={filesOpen ? 'Hide files' : 'Show files'}
              aria-controls="project-file-list"
              onClick={() => setFilesOpen((current) => !current)}
            >
              Files <span aria-hidden="true">{filesOpen ? '▴' : '▾'}</span>
            </Button>
          )}
          <details className="editor-options">
            <summary>Editor options</summary>
            <label className="editor-size">
              Code size
              <select
                aria-label="Editor text size"
                value={fontSize}
                onChange={(event) => setFontSize(event.target.value)}
              >
                <option value="1rem">16 px</option>
                <option value="1.125rem">18 px</option>
                <option value="1.25rem">20 px</option>
              </select>
            </label>
          </details>
          {!collaboration && (
            <span className="badge">
              {!summary.writable || paused
                ? 'Read only'
                : active?.dirty
                  ? 'Local draft'
                  : 'Ready to edit'}
            </span>
          )}
        </div>
        {notice && <Notice>{notice}</Notice>}
        <div
          id="editor-source-panel"
          role="tabpanel"
          aria-labelledby={
            active ? `editor-tab-${active.metadata.id}` : undefined
          }
        >
          {!active ? (
            <div className="editor-empty">
              <p>Choose a file to open its editor.</p>
            </div>
          ) : sourceError ? (
            <Notice tone="error">
              {sourceError}{' '}
              <Button
                variant="secondary"
                onClick={() => {
                  setErrors({});
                  void query?.refetch();
                }}
              >
                Retry file
              </Button>
            </Notice>
          ) : !active.loaded ? (
            <Notice>Loading and verifying Python source…</Notice>
          ) : (
            <CodeEditor
              key={`${active.metadata.id}:${active.metadata.document_id}:${active.metadata.generation}`}
              file={active}
              writable={
                summary.writable &&
                !paused &&
                (!collaboration ||
                  collaboration.offlineEditable ||
                  resource.collaboration?.canEdit(selectedId) === true)
              }
              followClientId={following}
              onStopFollowing={() => setFollowing(null)}
              onNotice={setNotice}
            />
          )}
        </div>
        <p className="editor-keyboard-help" id="editor-keyboard-help">
          Tab moves focus. Ctrl/Cmd + ] indents. Arrow keys switch file tabs;
          Delete closes a tab.
        </p>
        {fileActions}
      </section>
      <ExecutionPanel
        workspace={workspace}
        paused={paused}
        {...(task ? { task } : {})}
        {...(practice ? { practice } : {})}
        {...(executionConflict ? { conflict: executionConflict } : {})}
        toolbar={targets?.runToolbar ?? toolbar}
        onRun={() => {
          selectPane('console');
          onRun?.();
        }}
      />
      {resource.recovery ? (
        (() => {
          const panel = (
            <RecoveryPanel
              model={resource.recovery}
              name={project.name}
              selectedId={selectedId}
              attention={
                collaboration?.phase === 'blocked' || Boolean(sourceError)
              }
            />
          );
          return targets?.recovery
            ? createPortal(panel, targets.recovery)
            : panel;
        })()
      ) : (
        <SharedSourceActions
          workspace={workspace}
          name={project.name}
          selectedId={selectedId}
        />
      )}
    </div>
  );
}
