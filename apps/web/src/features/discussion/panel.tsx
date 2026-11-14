import {
  useEffect,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from 'react';
import { Button, Notice } from '@code-along/design-system';
import { validChatBody } from '@code-along/contracts/events';
import { queryClient } from '../../app/providers.tsx';
import type { Project } from '../projects/types.ts';
import { discussionApi } from './api.ts';
import { DiscussionController, type RefreshKind } from './controller.ts';
import './styles.css';
import { useDiscussionReading } from './reading.ts';

export function ProjectDiscussion(props: {
  project: Project;
  accountId: string;
  paused: boolean;
  active?: boolean;
}) {
  return (
    <DiscussionPanel
      key={`${props.accountId}:${props.project.id}`}
      {...props}
    />
  );
}
function DiscussionPanel({
  project,
  accountId,
  paused,
  active = true,
}: {
  project: Project;
  accountId: string;
  paused: boolean;
  active?: boolean;
}) {
  const [resource] = useState(() => {
    async function refresh(kind: RefreshKind) {
      if (kind !== 'revision') {
        // A successful forced ordinary metadata read is required before advancing a bootstrap/access cursor.
        await queryClient.invalidateQueries(
          { queryKey: ['project', project.id, accountId] },
          { throwOnError: true },
        );
        await queryClient.invalidateQueries({ queryKey: ['projects'] });
      }
      if (kind === 'revision' || kind === 'all')
        await queryClient.invalidateQueries({
          queryKey: ['revisions', accountId, project.id],
        });
      if (kind === 'access' || kind === 'all')
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: ['shares', accountId, project.id],
          }),
          queryClient.invalidateQueries({ queryKey: ['grants', project.id] }),
          queryClient.invalidateQueries({
            queryKey: ['project-invitations', project.id],
          }),
          queryClient.invalidateQueries({
            queryKey: ['members', project.workspace_id],
          }),
          queryClient.invalidateQueries({
            queryKey: ['share-recipients', accountId, project.workspace_id],
          }),
        ]);
    }
    return {
      model: new DiscussionController(
        accountId,
        project.id,
        discussionApi(accountId, project.id),
        refresh,
      ),
      leases: 0,
    };
  });
  const model = resource.model,
    snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot);
  const [body, setBody] = useState(''),
    [error, setError] = useState('');
  const writable =
    !paused &&
    ['owner', 'editor'].includes(project.role) &&
    !project.archived &&
    !project.workspace_archived;
  useEffect(() => {
    resource.leases++;
    model.start();
    return () => {
      resource.leases--;
      queueMicrotask(() => {
        if (!resource.leases) model.destroy();
      });
    };
  }, [resource, model]);
  useEffect(() => model.setWritable(writable), [model, writable]);
  const bytes = new TextEncoder().encode(body).length;
  const reading = useDiscussionReading(snapshot, accountId, active);
  const canRetry =
    writable &&
    snapshot.ready &&
    snapshot.canPost &&
    snapshot.phase !== 'offline';
  const canSend = canRetry && snapshot.pending.length < 20;
  function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (model.send(body)) {
      reading.ownSend(
        model.getSnapshot().pending.at(-1)?.request.client_message_id,
      );
      setBody('');
      setError('');
    } else
      setError(
        'Wait for discussion access and pending attempts, then send a nonblank message within 4096 UTF-8 bytes.',
      );
  }
  const phase = {
    loading: 'Loading discussion…',
    connected: 'Discussion is up to date.',
    reconnecting: 'Reconnecting live discussion…',
    offline: 'Discussion is offline.',
    blocked: 'Discussion access needs attention.',
  };
  return (
    <section
      id="discussion"
      tabIndex={-1}
      className="content-section discussion-panel"
      aria-labelledby="discussion-heading"
    >
      <div className="section-head">
        <div>
          <h2 id="discussion-heading">Discussion</h2>
          <p className="muted" id="discussion-scope">
            Visible to project members. Times are shown in UTC.
          </p>
        </div>
        <Button variant="secondary" onClick={() => model.recheck()}>
          Recheck discussion
        </Button>
      </div>
      <p role="status" className="discussion-status">
        {phase[snapshot.phase]}
      </p>
      {(snapshot.error || error) && (
        <Notice tone="error">{error || snapshot.error}</Notice>
      )}
      {snapshot.hasOlder && (
        <Button
          variant="secondary"
          busy={snapshot.loadingOlder}
          disabled={
            snapshot.phase === 'offline' || snapshot.phase === 'blocked'
          }
          onClick={() => {
            reading.beforeOlder();
            void model.older();
          }}
        >
          Load older messages
        </Button>
      )}
      {snapshot.ready &&
        snapshot.messages.length === 0 &&
        snapshot.pending.length === 0 && (
          <p>
            No messages yet. Start the discussion when you have something to
            share.
          </p>
        )}
      <ol
        ref={reading.log}
        onScroll={reading.onScroll}
        className="discussion-messages"
        aria-label="Project discussion messages"
        tabIndex={0}
      >
        {snapshot.messages.map((message) => (
          <li key={message.id} data-message-id={message.id}>
            <div className="discussion-message-head">
              <strong>
                {message.author.display_name}
                {message.author.id === accountId ? ' (you)' : ''}
              </strong>
              <time dateTime={message.created_at}>
                {new Intl.DateTimeFormat('en-GB', {
                  timeZone: 'UTC',
                  year: 'numeric',
                  month: 'short',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit',
                  hour12: false,
                }).format(new Date(message.created_at))}{' '}
                UTC
              </time>
            </div>
            <p className="discussion-body">
              {message.deleted ? 'Message removed.' : message.body}
            </p>
            <span className="discussion-delivery">
              {message.deleted ? 'Removed' : 'Sent'}
            </span>
          </li>
        ))}
        {snapshot.pending.map((pending) => (
          <li
            key={pending.request.client_message_id}
            className="discussion-pending"
          >
            <div className="discussion-message-head">
              <strong>You</strong>
              <span role="status">
                {pending.phase === 'sending' ? 'Sending…' : 'Not confirmed'}
              </span>
            </div>
            <p className="discussion-body">{pending.request.body}</p>
            {pending.phase === 'unconfirmed' && (
              <>
                <p className="muted">
                  We could not confirm this message was saved. Retrying checks
                  the same message without creating another copy.
                </p>
                <Button
                  variant="secondary"
                  disabled={!canRetry}
                  onClick={() => model.retry(pending.request.client_message_id)}
                >
                  Retry unconfirmed message
                </Button>
              </>
            )}
          </li>
        ))}
      </ol>
      {reading.unread > 0 && (
        <div className="discussion-unread">
          <p role="status" aria-live="polite">
            {reading.unread} new {reading.unread === 1 ? 'message' : 'messages'}{' '}
            loaded.
          </p>
          <Button variant="secondary" onClick={reading.jump}>
            Jump to latest
          </Button>
        </div>
      )}
      {!writable && (
        <p className="muted">
          Read only. Posting requires editor access and an open project and
          workspace.
        </p>
      )}
      {snapshot.pending.length >= 20 && (
        <p className="muted" role="status">
          You have {snapshot.pending.length} messages awaiting confirmation.
          Wait or retry an unconfirmed message before sending another.
        </p>
      )}
      <form className="form-stack" onSubmit={send}>
        <label htmlFor="discussion-message">Message to project</label>
        <textarea
          id="discussion-message"
          name="body"
          rows={3}
          maxLength={4096}
          value={body}
          disabled={!writable || !snapshot.canPost}
          aria-describedby="discussion-byte-count discussion-scope"
          onChange={(event) => setBody(event.target.value)}
        />
        <p
          id="discussion-byte-count"
          className={bytes > 4096 ? 'error-text' : 'muted'}
        >
          {bytes} / 4096 UTF-8 bytes. Plain text; no message is queued for later
          delivery while offline.
        </p>
        <div className="actions">
          <Button type="submit" disabled={!canSend || !validChatBody(body)}>
            Send message
          </Button>
        </div>
      </form>
    </section>
  );
}
