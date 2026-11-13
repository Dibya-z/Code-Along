import { useId, useState, useSyncExternalStore } from 'react';
import { Button, Dialog, Notice } from '@code-along/design-system';
import {
  downloadArchive,
  downloadSourceFile,
  recoveryArchive,
  workspaceArchive,
} from '../project-tools/archive.ts';
import type { RecoveryController } from './controller.ts';
import './styles.css';
export function RecoveryPanel({
  model,
  name,
  selectedId,
}: {
  model: RecoveryController;
  name: string;
  selectedId: string;
}) {
  const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot);
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
      <div className="section-head">
        <h2>Local recovery</h2>
        <p className="recovery-status" role="status">
          {!complete &&
          snapshot.phase !== 'loading' &&
          snapshot.phase !== 'found'
            ? 'Local recovery is waiting for every project file.'
            : labels[snapshot.phase]}
        </p>
      </div>
      <p className="muted">
        Drafts are stored unencrypted in this browser. Server saving is not
        connected yet.
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
        {snapshot.found && (
          <>
            <Button
              disabled={!structure.writable || !model.canRestore()}
              onClick={() => model.restore()}
            >
              Restore local changes
            </Button>
            <Button
              variant="secondary"
              onClick={() => downloadArchive(recoveryArchive(snapshot.found!))}
            >
              Export stored recovery
            </Button>
            <Dialog
              open={replaceOpen}
              onOpenChange={setReplaceOpen}
              title="Use this tab's code?"
              description="This removes the stored local copy. Export that recovery first if you need to keep it."
              trigger={<Button variant="secondary">Use this tab's code</Button>}
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
          Restoring replaces this tab’s text. Export the current code first if
          you need it.{' '}
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
        After editing, wait for “Local recovery updated” before refreshing or
        closing this tab.
      </p>
      <p className="muted">
        Default: clear this account’s local drafts on sign out. Export important
        work before leaving a shared computer.
      </p>
    </section>
  );
}
