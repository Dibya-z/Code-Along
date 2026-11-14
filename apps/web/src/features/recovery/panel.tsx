import { useEffect, useId, useState, useSyncExternalStore } from 'react';
import { Button, Dialog, Notice } from '@code-along/design-system';
import {
  downloadArchive,
  downloadSourceFile,
  recoveryArchive,
  workspaceArchive,
} from '../project-tools/archive.ts';
import type { RecoveryController } from './controller.ts';
import './styles.css';
import { useNavigate } from 'react-router';
import { createLocalDraft } from '../project-tools/local-draft.ts';
export function RecoveryPanel({
  model,
  name,
  selectedId,
  attention = false,
}: {
  model: RecoveryController;
  name: string;
  selectedId: string;
  attention?: boolean;
}) {
  const navigate = useNavigate();
  const [copying, setCopying] = useState(false);
  const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (attention || ['found', 'error', 'conflict'].includes(snapshot.phase))
      setExpanded(true);
  }, [attention, snapshot.phase]);
  const structure = useSyncExternalStore(
    model.workspace.subscribe,
    model.workspace.getSnapshot,
  );
  const [error, setError] = useState(''),
    [replaceOpen, setReplaceOpen] = useState(false);
  const exportId = useId();
  const complete =
    structure.files.length > 0 && structure.files.every((file) => file.loaded);
  const selected = model.workspace.file(selectedId);
  const labels = {
    loading: 'Checking local recovery…',
    ready: snapshot.updatedAt
      ? `Local recovery updated ${new Date(snapshot.updatedAt).toLocaleTimeString()}`
      : 'Local recovery ready',
    pending: 'Local recovery pending…',
    saving: 'Writing local recovery…',
    found: 'A local recovery copy is available.',
    error: 'Local recovery needs attention.',
    conflict: 'Local recovery paused: another tab changed it.',
  };
  const exportCurrent = () => {
    try {
      downloadArchive(workspaceArchive(model.workspace, name));
      setError('');
    } catch {
      setError('Load every project file before exporting your current code.');
    }
  };
  return (
    <section className="local-recovery" aria-label="Local recovery">
      <details
        open={expanded}
        onToggle={(event) => setExpanded(event.currentTarget.open)}
      >
        <summary>
          <span className="recovery-title">Local recovery &amp; export</span>
          <span className="recovery-status" role="status">
            {!complete &&
            snapshot.phase !== 'loading' &&
            snapshot.phase !== 'found'
              ? 'Local recovery is waiting for every project file.'
              : labels[snapshot.phase]}
          </span>
        </summary>
        <div className="recovery-content">
          <p className="muted">
            {model.workspace.canonical
              ? 'This device copy is unencrypted and supplements server checkpoints. Export important work before leaving a shared computer.'
              : 'Drafts are stored unencrypted in this browser. They are independent of server projects.'}
          </p>
          {(snapshot.error || error) && (
            <Notice tone="error">{snapshot.error || error}</Notice>
          )}
          <div className="actions">
            <Button
              variant="secondary"
              id={exportId}
              disabled={!complete}
              onClick={exportCurrent}
            >
              Export current code
            </Button>
            <Button
              variant="secondary"
              disabled={!selected?.loaded}
              onClick={() => {
                try {
                  downloadSourceFile(
                    selected!.metadata.path,
                    selected!.text.toString(),
                  );
                  setError('');
                } catch {
                  setError('The open file could not be exported.');
                }
              }}
            >
              Download open file
            </Button>
            {model.workspace.sourceKind === 'project' && (
              <Button
                variant="secondary"
                disabled={!complete}
                busy={copying}
                onClick={() => {
                  setCopying(true);
                  try {
                    const copy = workspaceArchive(model.workspace, name);
                    void createLocalDraft(model.workspace.accountId, copy)
                      .then((id) => {
                        void navigate(`/drafts/${id}`);
                      })
                      .catch(() =>
                        setError(
                          'A local copy could not be stored. Export your current code instead.',
                        ),
                      )
                      .finally(() => setCopying(false));
                  } catch {
                    setCopying(false);
                    setError('Load every file before opening a local copy.');
                  }
                }}
              >
                Open local copy
              </Button>
            )}
            {snapshot.found && (
              <>
                {model.workspace.canonical &&
                  snapshot.found.data.origin === 'm2-local' && (
                    <Button
                      variant="secondary"
                      busy={copying}
                      onClick={() => {
                        setCopying(true);
                        void createLocalDraft(
                          model.workspace.accountId,
                          recoveryArchive(snapshot.found!),
                        )
                          .then((id) => {
                            void navigate(`/drafts/${id}`);
                          })
                          .catch(() =>
                            setError(
                              'The stored copy could not be opened. Export it instead.',
                            ),
                          )
                          .finally(() => setCopying(false));
                      }}
                    >
                      Open stored local copy
                    </Button>
                  )}
                <Button
                  disabled={!structure.writable || !model.canRestore()}
                  onClick={() => model.restore()}
                >
                  Restore local changes
                </Button>
                <Button
                  variant="secondary"
                  onClick={() =>
                    downloadArchive(recoveryArchive(snapshot.found!))
                  }
                >
                  Export stored recovery
                </Button>
                <Dialog
                  open={replaceOpen}
                  onOpenChange={setReplaceOpen}
                  title="Use this tab's code?"
                  description="This removes the stored local copy. Export that recovery first if you need to keep it."
                  trigger={
                    <Button variant="secondary">Use this tab's code</Button>
                  }
                >
                  <Button
                    variant="danger"
                    onClick={() => {
                      void model.keepThisTab().then(() => {
                        setReplaceOpen(false);
                        requestAnimationFrame(() =>
                          document.getElementById(exportId)?.focus(),
                        );
                      });
                    }}
                  >
                    Replace local recovery
                  </Button>
                </Dialog>
              </>
            )}
            {(snapshot.phase === 'error' || snapshot.phase === 'conflict') && (
              <Button variant="secondary" onClick={() => model.retry()}>
                {snapshot.phase === 'conflict'
                  ? 'Review newer recovery'
                  : 'Retry local recovery'}
              </Button>
            )}
          </div>
          {snapshot.found && (
            <p>
              {model.workspace.canonical
                ? snapshot.found.data.origin === 'm2-local'
                  ? 'This older recovery has independent local history. Open it as a new local draft; it cannot be merged into this server project. '
                  : 'Restoring merges this canonical recovery with the same server document generations. Export the current code first if you need it. '
                : 'Restoring replaces this tab’s text. Export the current code first if you need it. '}
              {!model.canRestore() &&
                'Restoring requires the same writable file identities and generations; this stored copy can still be exported.'}
            </p>
          )}
          <label className="recovery-policy">
            <input
              type="checkbox"
              checked={snapshot.retain}
              disabled={snapshot.phase === 'loading'}
              aria-disabled={snapshot.policyPending}
              aria-busy={snapshot.policyPending}
              onChange={(event) => {
                void model.setRetention(event.target.checked);
              }}
            />
            Keep my local drafts after sign out on this device.
          </label>
          {snapshot.policyPending && (
            <p role="status">Updating device preference…</p>
          )}
          <p className="muted">
            After editing, wait for “Local recovery updated” before refreshing
            or closing this tab.
          </p>
          <p className="muted">
            Default: clear this account’s local drafts on sign out. Export
            important work before leaving a shared computer.
          </p>
        </div>
      </details>
    </section>
  );
}
