import { useState, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router';
import { Button, Notice } from '@code-along/design-system';
import type { EditorWorkspace } from './model/workspace.ts';
import {
  downloadArchive,
  downloadSourceFile,
  workspaceArchive,
} from '../project-tools/archive.ts';
import { createLocalDraft } from '../project-tools/local-draft.ts';

/** Capability pages expose deliberate source copies without automatic recovery or authorization storage. */
export function SharedSourceActions({
  workspace,
  name,
  selectedId,
}: {
  workspace: EditorWorkspace;
  name: string;
  selectedId: string;
}) {
  const snapshot = useSyncExternalStore(
    workspace.subscribe,
    workspace.getSnapshot,
  );
  const [error, setError] = useState(''),
    [copying, setCopying] = useState(false);
  const navigate = useNavigate();
  const complete =
    snapshot.files.length > 0 && snapshot.files.every((file) => file.loaded);
  const selected = workspace.file(selectedId);
  return (
    <section className="local-recovery" aria-label="Shared source copies">
      <h2>Keep your own copy</h2>
      <p className="muted">
        This shared link has no automatic local recovery. Export important work
        before closing this tab. A local copy gets fresh identities and does not
        keep access to the shared room.
      </p>
      {error && <Notice tone="error">{error}</Notice>}
      <div className="actions">
        <Button
          variant="secondary"
          disabled={!complete}
          onClick={() => {
            try {
              downloadArchive(workspaceArchive(workspace, name));
              setError('');
            } catch {
              setError('Load every file before exporting the current code.');
            }
          }}
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
              setError('The open file could not be downloaded.');
            }
          }}
        >
          Download open file
        </Button>
        <Button
          variant="secondary"
          disabled={!complete}
          busy={copying}
          onClick={() => {
            setCopying(true);
            try {
              void createLocalDraft(
                workspace.accountId,
                workspaceArchive(workspace, name),
              )
                .then((id) => {
                  void navigate(`/drafts/${id}`);
                })
                .catch(() =>
                  setError(
                    'A local copy could not be stored. Export your code instead.',
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
      </div>
    </section>
  );
}
