import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Button, Dialog, Field, Notice } from '@code-along/design-system';
import {
  isRunnerId,
  RUN_LIMITS,
  sha256,
  sourceBytes,
} from '@code-along/contracts/execution';
import { validatePythonPaths } from '@code-along/contracts/execution/project';
import { SignedIn } from '../auth/guard.tsx';
import { useIdentity } from '../auth/session.ts';
import { EditorWorkbench } from '../editor/workbench.tsx';
import type { FileMetadata } from '../editor/model/document.ts';
import { recoveryStore } from '../recovery/store.ts';
import { validateRecovery, type ValidatedRecovery } from '../recovery/codec.ts';
import { localDraftProject } from './local-draft.ts';
import './styles.css';

export function LocalDraftPage() {
  return (
    <SignedIn>
      <DraftLoader />
    </SignedIn>
  );
}
function DraftLoader() {
  const { draftId = '' } = useParams(),
    actor = useIdentity().data!.id;
  const query = useQuery({
    queryKey: ['local-draft', actor, draftId],
    enabled: isRunnerId(draftId),
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const scope = await recoveryStore().read(actor, draftId);
      if (!scope.record) throw new Error('missing');
      const recovery = await validateRecovery(scope.record.data);
      if (
        recovery.data.kind !== 'local_draft' ||
        recovery.data.account_id !== actor ||
        recovery.data.project_id !== draftId
      )
        throw new Error('scope');
      return recovery;
    },
  });
  if (!isRunnerId(draftId) || query.error)
    return (
      <div className="page">
        <Link to="/drafts">← Local drafts</Link>
        <h1>Local draft unavailable.</h1>
        <Notice tone="error">
          This draft could not be opened for your account on this device. Your
          other copies have not changed.
        </Notice>
        <Button
          variant="secondary"
          onClick={() => {
            void query.refetch();
          }}
        >
          Retry local draft
        </Button>
      </div>
    );
  if (!query.data)
    return (
      <div className="page">
        <Notice>Opening your local draft…</Notice>
      </div>
    );
  return (
    <DraftEditor
      key={`${actor}:${draftId}`}
      actor={actor}
      initial={query.data}
    />
  );
}

function DraftEditor({
  actor,
  initial,
}: {
  actor: string;
  initial: ValidatedRecovery;
}) {
  const [state, setState] = useState(() => ({
    project: localDraftProject(initial),
    files: initial.data.files.map((file) => file.metadata),
    sources: new Map(
      initial.data.files.map((file) => [file.metadata.id, file.initial_source]),
    ),
  }));
  const [selectedId, setSelected] = useState(initial.data.entrypoint_file_id),
    [addOpen, setAddOpen] = useState(false),
    [renameOpen, setRenameOpen] = useState(false),
    [deleteOpen, setDeleteOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const selected = state.files.find((file) => file.id === selectedId);
  function update(
    files: readonly FileMetadata[],
    entrypoint = state.project.entrypoint_file_id,
    name = state.project.name,
    sources = state.sources,
  ) {
    validatePythonPaths(files.map((file) => file.path));
    if (
      files.length > RUN_LIMITS.files ||
      !files.some((file) => file.id === entrypoint)
    )
      throw new Error('Keep 1–20 files and choose an existing entrypoint.');
    if (!name.trim() || name.trim().length > 120)
      throw new Error('Use a project name between 1 and 120 characters.');
    const version = state.project.metadata_version + 1;
    if (!Number.isSafeInteger(version))
      throw new Error('Export this draft and open a fresh local copy.');
    setState({
      files: [...files],
      sources,
      project: {
        ...state.project,
        name: name.trim(),
        entrypoint_file_id: entrypoint,
        metadata_version: version,
      },
    });
    setError('');
  }
  function apply(action: () => void) {
    try {
      action();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'The local file change could not be applied.',
      );
    }
  }
  async function addFile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const path = String(new FormData(event.currentTarget).get('path') ?? '');
    setBusy(true);
    try {
      validatePythonPaths([...state.files.map((file) => file.path), path]);
      const file: FileMetadata = {
        id: crypto.randomUUID(),
        document_id: crypto.randomUUID(),
        generation: 1,
        kind: 'python',
        path,
        initial_sha256: await sha256(sourceBytes('')),
      };
      update(
        [...state.files, file],
        undefined,
        undefined,
        new Map([...state.sources, [file.id, '']]),
      );
      setSelected(file.id);
      setAddOpen(false);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'The file could not be added.',
      );
    } finally {
      setBusy(false);
    }
  }
  function renameFile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const path = String(new FormData(event.currentTarget).get('path') ?? '');
    apply(() => {
      update(
        state.files.map((file) =>
          file.id === selectedId ? { ...file, path } : file,
        ),
      );
      setRenameOpen(false);
    });
  }
  return (
    <div className="page">
      <Link to="/drafts">← Local drafts</Link>
      <div className="section-head content-section">
        <div>
          <p className="eyebrow">LOCAL DRAFT · THIS DEVICE</p>
          <h1>{state.project.name}</h1>
          <p className="muted">
            Entrypoint{' '}
            {
              state.files.find(
                (file) => file.id === state.project.entrypoint_file_id,
              )?.path
            }
          </p>
        </div>
        <span className="badge">Local only</span>
      </div>
      <Notice>
        This is a separate local draft. It does not change or save a shared
        project. Wait for “Local recovery updated” before refreshing; export
        important work.
      </Notice>
      {error && <Notice tone="error">{error}</Notice>}
      <EditorWorkbench
        accountId={actor}
        project={state.project}
        files={state.files}
        count={state.files.length}
        selectedId={selectedId}
        onSelect={setSelected}
        paused={false}
        local={initial}
        localSources={state.sources}
        addControl={
          <Dialog
            open={addOpen}
            onOpenChange={setAddOpen}
            title="Add a Python file"
            description="Choose a safe Python module path. The new file starts empty in this local draft."
            trigger={
              <Button
                variant="secondary"
                disabled={busy || state.files.length >= RUN_LIMITS.files}
              >
                Add file
              </Button>
            }
          >
            <form
              onSubmit={(event) => {
                void addFile(event);
              }}
              className="form-stack"
            >
              <Field
                label="File path"
                name="path"
                required
                maxLength={160}
                placeholder="helpers.py"
              />
              {error && <Notice tone="error">{error}</Notice>}
              <Button type="submit" busy={busy}>
                Add Python file
              </Button>
            </form>
          </Dialog>
        }
        fileActions={
          selected && (
            <div className="draft-file-actions">
              <Dialog
                open={renameOpen}
                onOpenChange={setRenameOpen}
                title="Rename a Python file"
                description="Renaming preserves this local file's identity and edits."
                trigger={
                  <Button variant="secondary" disabled={busy}>
                    Rename file
                  </Button>
                }
              >
                <form className="form-stack" onSubmit={renameFile}>
                  <Field
                    label="File path"
                    name="path"
                    key={selected.id + selected.path}
                    defaultValue={selected.path}
                    required
                    maxLength={160}
                  />
                  {error && <Notice tone="error">{error}</Notice>}
                  <Button type="submit">Rename Python file</Button>
                </form>
              </Dialog>
              <Button
                variant="secondary"
                disabled={
                  busy || selectedId === state.project.entrypoint_file_id
                }
                onClick={() => apply(() => update(state.files, selectedId))}
              >
                Use as entrypoint
              </Button>
              <Dialog
                open={deleteOpen}
                onOpenChange={setDeleteOpen}
                title="Delete this local file?"
                description="Export a backup first if you need it. The entrypoint cannot be deleted."
                trigger={
                  <Button
                    variant="secondary"
                    disabled={
                      busy || selectedId === state.project.entrypoint_file_id
                    }
                  >
                    Delete file
                  </Button>
                }
              >
                <Button
                  variant="danger"
                  onClick={() =>
                    apply(() => {
                      if (selectedId === state.project.entrypoint_file_id)
                        throw new Error('Choose another entrypoint first.');
                      const sources = new Map(state.sources);
                      sources.delete(selectedId);
                      update(
                        state.files.filter((file) => file.id !== selectedId),
                        undefined,
                        undefined,
                        sources,
                      );
                      setSelected(state.project.entrypoint_file_id);
                      setDeleteOpen(false);
                      requestAnimationFrame(() =>
                        document
                          .getElementById(
                            `editor-file-${state.project.entrypoint_file_id}`,
                          )
                          ?.focus(),
                      );
                    })
                  }
                >
                  Delete local file
                </Button>
              </Dialog>
            </div>
          )
        }
      />
      <section className="content-section">
        <h2>Draft name</h2>
        <form
          className="form-stack compact-form"
          onSubmit={(event) => {
            event.preventDefault();
            const name = String(
              new FormData(event.currentTarget).get('name') ?? '',
            );
            apply(() => update(state.files, undefined, name));
          }}
        >
          <Field
            label="Local draft name"
            name="name"
            required
            maxLength={120}
            defaultValue={state.project.name}
          />
          <Button type="submit" variant="secondary" disabled={busy}>
            Update draft name
          </Button>
        </form>
      </section>
    </div>
  );
}
