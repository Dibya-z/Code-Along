import {
  useEffect,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type CSSProperties,
} from 'react';
import { useQueries } from '@tanstack/react-query';
import { Button, Notice } from '@code-along/design-system';
import { productApi } from '../../api/product.ts';
import type { Project } from '../projects/types.ts';
import { EditorWorkspace } from './model/workspace.ts';
import type { FileMetadata } from './model/document.ts';
import { CodeEditor } from './components/code-editor.tsx';
import { FileTabs } from './components/file-tabs.tsx';
import { FileTree } from './components/file-tree.tsx';
import './styles.css';

interface Props {
  accountId: string;
  project: Project;
  files: readonly FileMetadata[];
  count: number;
  selectedId: string;
  onSelect: (id: string) => void;
  addControl: ReactNode;
  fileActions: ReactNode;
  paused: boolean;
}
export function EditorWorkbench(props: Props) {
  return (
    <ScopedWorkbench
      key={`${props.accountId}:${props.project.id}`}
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
}: Props) {
  const [resource] = useState(() => ({
    model: new EditorWorkspace(accountId, project.id),
    leases: 0,
  }));
  const workspace = resource.model;
  const summary = useSyncExternalStore(
    workspace.subscribe,
    workspace.getSnapshot,
  );
  const [open, setOpen] = useState<string[]>(selectedId ? [selectedId] : []);
  const [notice, setNotice] = useState('');
  const [fontSize, setFontSize] = useState('1rem');
  const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => {
    resource.leases++;
    return () => {
      resource.leases--;
      // React StrictMode replays effects; an actual unmount must still release all private buffers.
      queueMicrotask(() => {
        if (resource.leases === 0) resource.model.destroy();
      });
    };
  }, [resource]);
  useLayoutEffect(() => {
    workspace.reconcile(project, files, count);
  }, [workspace, project, files, count]);
  useLayoutEffect(() => {
    if (selectedId)
      setOpen((previous) =>
        previous.includes(selectedId) ? previous : [...previous, selectedId],
      );
    setNotice('');
  }, [selectedId]);
  const sources = useQueries({
    queries: files.map((file) => ({
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
    for (const query of sources)
      if (query.data) {
        const value = query.data;
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
  }, [workspace, sourceSignature]);
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
      className="editor-workbench content-section"
      style={{ '--editor-font-size': fontSize } as CSSProperties}
    >
      <aside className="editor-explorer" aria-label="Project files">
        <div className="section-head">
          <h2>Files</h2>
          {addControl}
        </div>
        <FileTree
          files={summary.files}
          selectedId={selectedId}
          entrypoint={summary.entrypoint}
          onSelect={onSelect}
        />
        <p className="editor-scope-note">
          Edits stay in this tab. They have not been saved to the server.
        </p>
      </aside>
      <section className="editor-pane" aria-label="Python workbench">
        <FileTabs
          files={tabs}
          selectedId={selectedId}
          onSelect={onSelect}
          onClose={close}
        />
        <div className="editor-pane-head">
          <h2>{active?.metadata.path ?? 'Your code'}</h2>
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
          <span className="badge">
            {!summary.writable || paused
              ? 'Read only'
              : active?.dirty
                ? 'Local draft'
                : 'Ready to edit'}
          </span>
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
              writable={summary.writable && !paused}
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
    </div>
  );
}
