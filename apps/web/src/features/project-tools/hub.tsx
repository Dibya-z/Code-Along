import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Button, Dialog, Notice } from '@code-along/design-system';
import { RUN_LIMITS, sourceBytes } from '@code-along/contracts/execution';
import { runtimeProfile } from '@code-along/contracts/execution/profiles';
import { SignedIn } from '../auth/guard.tsx';
import { useIdentity } from '../auth/session.ts';
import { recoveryStore, type StoredRecovery } from '../recovery/store.ts';
import { validateRecovery, type ValidatedRecovery } from '../recovery/codec.ts';
import {
  ARCHIVE_BYTES,
  decodeArchive,
  downloadArchive,
  recoveryArchive,
  type SourceArchive,
} from './archive.ts';
import { createLocalDraft } from './local-draft.ts';
import { TEMPLATES } from './templates.ts';
import './styles.css';

interface DraftRow {
  record: StoredRecovery;
  recovery: ValidatedRecovery | null;
}
async function localRows(account: string): Promise<DraftRow[]> {
  const rows = await recoveryStore().list(account);
  const result: DraftRow[] = [];
  for (const record of rows) {
    try {
      const recovery = await validateRecovery(record.data);
      if (
        recovery.data.account_id !== account ||
        recovery.data.project_id !== record.project_id
      )
        throw new Error('scope');
      result.push({ record, recovery });
    } catch {
      result.push({ record, recovery: null });
    }
  }
  return result.sort((a, b) => b.record.updated_at - a.record.updated_at);
}

export function LocalDraftsPage() {
  return (
    <SignedIn>
      <DraftHub />
    </SignedIn>
  );
}
function DraftHub() {
  const actor = useIdentity().data!.id,
    navigate = useNavigate();
  const [preview, setPreview] = useState<SourceArchive | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [reading, setReading] = useState(false),
    [restoreListFocus, setRestoreListFocus] = useState(false);
  const readVersion = useRef(0);
  const query = useQuery({
    queryKey: ['local-drafts', actor],
    staleTime: 0,
    gcTime: 0,
    queryFn: () => localRows(actor),
  });
  useEffect(() => {
    if (restoreListFocus && !query.isFetching) {
      document.getElementById('refresh-local-list')?.focus();
      setRestoreListFocus(false);
    }
  }, [restoreListFocus, query.isFetching]);
  async function create(archive: SourceArchive) {
    setBusy(true);
    setError('');
    try {
      const id = await createLocalDraft(actor, archive);
      await navigate(`/drafts/${id}`);
    } catch {
      setError(
        'The local draft could not be stored. Export important work and remove an older local copy if storage is full.',
      );
    } finally {
      setBusy(false);
    }
  }
  async function read(file: File | undefined) {
    const version = ++readVersion.current;
    setPreview(null);
    setError('');
    if (!file) return;
    setReading(true);
    try {
      if (file.size > ARCHIVE_BYTES)
        throw new Error('Choose a source backup no larger than 16 MiB.');
      const archive = decodeArchive(new Uint8Array(await file.arrayBuffer()));
      if (readVersion.current === version) setPreview(archive);
    } catch (failure) {
      if (readVersion.current === version)
        setError(
          failure instanceof Error
            ? failure.message
            : 'This backup could not be read.',
        );
    } finally {
      if (readVersion.current === version) setReading(false);
    }
  }
  return (
    <div className="page">
      <p className="eyebrow">YOUR DEVICE · YOUR PRACTICE</p>
      <h1>Local drafts</h1>
      <p className="lead">
        Start small. Try an idea, open a source backup or keep a separate copy
        of your project.
      </p>
      <Notice>
        These drafts live unencrypted in this browser. They are not shared or
        saved to the server. Sign-out clears them by default; the workbench
        offers an optional retention setting.
      </Notice>
      {error && <Notice tone="error">{error}</Notice>}
      <section className="content-section" aria-label="Stored local copies">
        <div className="section-head">
          <h2>On this device</h2>
          <Button
            id="refresh-local-list"
            variant="secondary"
            busy={query.isFetching}
            onClick={() => {
              void query.refetch();
            }}
          >
            Refresh local list
          </Button>
        </div>
        {query.isPending && <p role="status">Checking local drafts…</p>}
        {query.error && (
          <Notice tone="error">
            Local storage is unavailable. Your open editor can still export its
            code.
          </Notice>
        )}
        {query.data?.length === 0 && (
          <p className="muted">
            No local copies yet. Open Start a draft below to preview a template
            or choose a backup.
          </p>
        )}
        <ul className="plain-list">
          {query.data?.map((row) => (
            <li
              className="list-row local-draft-row"
              key={row.record.project_id}
            >
              <div>
                <h3>{row.recovery?.data.name ?? 'Unrecognized local copy'}</h3>
                <p className="muted">
                  {row.recovery?.data.kind === 'local_draft'
                    ? 'Local draft'
                    : 'Project recovery'}{' '}
                  · {new Date(row.record.updated_at).toLocaleString()}
                </p>
              </div>
              <div className="actions">
                {row.recovery && (
                  <>
                    {row.recovery.data.kind === 'local_draft' ? (
                      <Link
                        className="button secondary"
                        to={`/drafts/${row.record.project_id}`}
                      >
                        Open draft
                      </Link>
                    ) : (
                      <Button
                        variant="secondary"
                        disabled={busy}
                        onClick={() => {
                          void create(recoveryArchive(row.recovery!));
                        }}
                      >
                        Open as local copy
                      </Button>
                    )}
                    <Button
                      variant="secondary"
                      onClick={() =>
                        downloadArchive(recoveryArchive(row.recovery!))
                      }
                    >
                      Export copy
                    </Button>
                  </>
                )}
                <DeleteCopy
                  actor={actor}
                  row={row.record}
                  onDeleted={() => {
                    void query.refetch();
                  }}
                  onDeletedDialogClosed={() => setRestoreListFocus(true)}
                  onError={setError}
                />
              </div>
            </li>
          ))}
        </ul>
      </section>
      <details className="content-section task-disclosure">
        <summary>Start a draft</summary>
        <section className="content-section" aria-label="Python templates">
          <h2>Choose a Python template</h2>
          <div className="template-list">
            {TEMPLATES.map((template) => (
              <article className="template-row" key={template.id}>
                <div>
                  <h3>{template.title}</h3>
                  <p>{template.description}</p>
                  <span className="muted">
                    {template.archive.files.length}{' '}
                    {template.archive.files.length === 1 ? 'file' : 'files'} ·{' '}
                    {runtimeProfile(template.archive.runtime_id)?.name}
                  </span>
                </div>
                <Button
                  variant="secondary"
                  disabled={busy || reading}
                  onClick={() => {
                    readVersion.current++;
                    setPreview(template.archive);
                    setError('');
                  }}
                >
                  Preview {template.title}
                </Button>
              </article>
            ))}
          </div>
        </section>
        <section
          className="content-section import-section"
          aria-label="Import a source backup"
        >
          <h2>Import a source backup</h2>
          <label className="field">
            <span>Code Along source backup</span>
            <input
              type="file"
              accept=".codealong.json,.json,application/json"
              disabled={busy || reading}
              onChange={(event) => {
                void read(event.target.files?.[0]);
              }}
            />
          </label>
          <p className="muted">
            Choose a .codealong.json file, up to 16 MiB and 20 Python files.
            Import opens a separate local copy and never runs it automatically.
          </p>
          {reading && <p role="status">Reading and validating source…</p>}
          {preview && (
            <ArchivePreview
              archive={preview}
              busy={busy}
              onCreate={() => {
                void create(preview);
              }}
            />
          )}
        </section>
      </details>
    </div>
  );
}
function ArchivePreview({
  archive,
  busy,
  onCreate,
}: {
  archive: SourceArchive;
  busy: boolean;
  onCreate: () => void;
}) {
  const [selected, setSelected] = useState(archive.entrypoint);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), [archive]);
  const file =
    archive.files.find((item) => item.path === selected) ?? archive.files[0]!;
  const total = archive.files.reduce(
    (sum, item) => sum + sourceBytes(item.source).length,
    0,
  );
  return (
    <section className="archive-preview" aria-label="Source preview">
      <div className="section-head">
        <div>
          <h3 ref={heading} tabIndex={-1}>
            {archive.name}
          </h3>
          <p>
            {archive.files.length} files · Entrypoint {archive.entrypoint} ·{' '}
            {runtimeProfile(archive.runtime_id)?.name}
          </p>
        </div>
        <Button busy={busy} onClick={onCreate}>
          Create local draft
        </Button>
      </div>
      {total > RUN_LIMITS.totalBytes && (
        <Notice>
          This complete backup exceeds Run’s 1 MiB source budget. You can keep
          and edit every file; reduce the combined source before running.
        </Notice>
      )}
      <label className="field">
        <span>Preview file</span>
        <select
          value={file.path}
          onChange={(event) => setSelected(event.target.value)}
        >
          {archive.files.map((item) => (
            <option key={item.path} value={item.path}>
              {item.path}
            </option>
          ))}
        </select>
      </label>
      <pre tabIndex={0} aria-label={`Source preview for ${file.path}`}>
        <code>{file.source || '# Empty Python file'}</code>
      </pre>
    </section>
  );
}
function DeleteCopy({
  actor,
  row,
  onDeleted,
  onDeletedDialogClosed,
  onError,
}: {
  actor: string;
  row: StoredRecovery;
  onDeleted: () => void;
  onDeletedDialogClosed: () => void;
  onError: (message: string) => void;
}) {
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false);
  const deleted = useRef(false),
    closeObserved = useRef(false);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next && busy) return;
        if (next) {
          deleted.current = false;
          closeObserved.current = false;
        }
        setOpen(next);
      }}
      onCloseAutoFocus={(event) => {
        closeObserved.current = true;
        if (deleted.current) {
          // The deleted row's trigger is gone; return after real dialog cleanup.
          event.preventDefault();
          onDeletedDialogClosed();
        }
      }}
      title="Delete this local copy?"
      description="Export it first if you need a backup. This removes only the stored copy on this device."
      trigger={<Button variant="secondary">Delete copy</Button>}
    >
      <Button
        variant="danger"
        busy={busy}
        onClick={() => {
          setBusy(true);
          void (async () => {
            const scope = await recoveryStore().read(actor, row.project_id);
            await recoveryStore().remove(
              actor,
              row.project_id,
              scope.policy.epoch,
              row.revision,
            );
            deleted.current = true;
            setOpen(false);
            onDeleted();
            // Escape/Close can finish before the storage transaction does.
            if (closeObserved.current) onDeletedDialogClosed();
          })()
            .catch(() => {
              setOpen(false);
              onError(
                'The local copy changed or could not be deleted. Refresh the list before trying again.',
              );
            })
            .finally(() => setBusy(false));
        }}
      >
        Delete local copy
      </Button>
    </Dialog>
  );
}
