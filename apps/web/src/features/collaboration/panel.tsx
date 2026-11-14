import { useEffect, useSyncExternalStore } from 'react';
import { Button, Notice } from '@code-along/design-system';
import { downloadSourceFile } from '../project-tools/archive.ts';
import type { ProjectCollaboration } from './controller.ts';
import './styles.css';

const saveLabels = {
  connecting: 'Connecting to server…',
  read_only: 'Read only',
  pending: 'Changes pending',
  saving: 'Saving…',
  saved: 'Saved',
  error: 'Not saved',
};
export function CollaborationPanel({
  model,
  selectedId,
  accountId,
  following,
  onFollow,
  compact = false,
}: {
  model: ProjectCollaboration;
  selectedId: string;
  accountId: string;
  following: number | null;
  onFollow: (clientId: number | null) => void;
  compact?: boolean;
}) {
  const status = useSyncExternalStore(model.subscribe, model.getSnapshot);
  const members = status.members[selectedId] ?? [];
  useEffect(() => {
    if (
      following !== null &&
      !members.some((member) => member.clientId === following)
    )
      onFollow(null);
  }, [following, members, onFollow]);
  const users = new Map<
    string,
    { name: string; color: string; clients: number[] }
  >();
  for (const member of members) {
    const group = users.get(member.userId) ?? {
      name: member.name,
      color: member.color,
      clients: [],
    };
    group.clients.push(member.clientId);
    users.set(member.userId, group);
  }
  return (
    <section
      className={`collaboration-panel${compact ? ' collaboration-compact' : ''}`}
      aria-label="Collaboration"
    >
      <div className="section-head">
        <h2>Working together</h2>
        <p className="collaboration-status" role="status">
          {status.phase === 'blocked'
            ? 'Editing paused · Not saved'
            : status.phase === 'offline'
              ? 'Offline · Server saving paused'
              : saveLabels[status.save]}
        </p>
      </div>
      <details className="collaboration-details">
        <summary>
          People &amp; saving <span aria-hidden="true">({users.size})</span>
        </summary>
        <div className="collaboration-actions">
          <ul
            className="collaboration-presence"
            aria-label="People in this file"
          >
            {[...users].map(([userId, member]) => (
              <li key={userId}>
                <span
                  className="participant-mark"
                  aria-hidden="true"
                  style={{ borderColor: member.color }}
                />
                {member.name}
                {userId === accountId ? ' (you)' : ''}
                {member.clients.length > 1
                  ? ` · ${member.clients.length} tabs`
                  : ''}
                {userId !== accountId &&
                  (following !== null && member.clients.includes(following) ? (
                    <Button variant="secondary" onClick={() => onFollow(null)}>
                      Stop following
                    </Button>
                  ) : (
                    <Button
                      variant="secondary"
                      onClick={() => onFollow(member.clients[0]!)}
                      disabled={status.phase !== 'connected'}
                    >
                      Follow {member.name}
                    </Button>
                  ))}
              </li>
            ))}
          </ul>
          <Button
            variant="secondary"
            onClick={model.save}
            disabled={
              status.phase !== 'connected' ||
              ['connecting', 'read_only', 'error'].includes(status.save)
            }
          >
            Save code now
          </Button>
        </div>
      </details>
      {status.phase !== 'connected' && (
        <Button variant="secondary" onClick={model.retry}>
          {status.phase === 'blocked' ? 'Recheck access' : 'Reconnect'}
        </Button>
      )}
      {status.error && <Notice tone="error">{status.error}</Notice>}
      {following !== null && (
        <p role="status">
          Following this participant’s cursor in the open file. Press Escape or
          Stop following to leave follow mode.
        </p>
      )}
      {status.phase === 'blocked' && (
        <p>
          Keep this tab open. Export current code or open a local copy below
          before refreshing project access.
        </p>
      )}
      {status.rescued.length > 0 && (
        <div>
          <Notice>
            A file was removed or replaced while it had unconfirmed changes.
            Download the preserved text before leaving this project.
          </Notice>
          <div className="actions">
            {status.rescued.map((file, index) => (
              <Button
                key={index}
                variant="secondary"
                onClick={() => downloadSourceFile(file.path, file.source)}
              >
                Download preserved {file.path}
              </Button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
