import { useState, type FormEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Button, Field, Notice } from '@code-along/design-system';
import { api } from '../../api/client.ts';
import { Failure } from '../../api/feedback.tsx';
import { queryClient } from '../../app/providers.tsx';
import { Pagination } from '../../components/pagination.tsx';
import type { Project } from '../projects/types.ts';
import type { Member, Page } from '../workspaces/types.ts';
import { revisionApi } from '../history/api.ts';
import { safeShareUrl, shareApi, type ShareRequest } from './api.ts';

export function ProjectShares({
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
  const [kind, setKind] = useState<'live' | 'snapshot'>('live'),
    [offset, setOffset] = useState(0),
    [link, setLink] = useState('');
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState('');
  const key = ['shares', accountId, project.id];
  const list = useQuery({
    queryKey: [...key, offset],
    queryFn: () => shareApi.list(project.id, offset),
    enabled: active,
  });
  const revisions = useQuery({
    queryKey: ['revisions', accountId, project.id, 'share-picker'],
    queryFn: () => revisionApi.list(project.id, 0, 100),
    enabled: active,
  });
  const members = useQuery({
    enabled: active,
    queryKey: ['share-recipients', accountId, project.workspace_id],
    queryFn: () =>
      api<Page<Member>>(
        `/api/v1/workspaces/${project.workspace_id}/members/?limit=100`,
      ),
  });
  const blocked = paused || project.archived || project.workspace_archived;
  const create = useMutation({
    mutationFn: async (body: ShareRequest) => {
      // Never retain the one-time token-bearing response in the query/mutation cache.
      const result = await shareApi.create(project.id, body);
      setLink(safeShareUrl(result.share_url, window.location.origin));
      setCopied(false);
      setCopyError('');
    },
    onSuccess: async () => {
      setOffset(0);
      await queryClient.invalidateQueries({ queryKey: key });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => shareApi.revoke(project.id, id),
    onSuccess: async () => {
      setLink('');
      await queryClient.invalidateQueries({ queryKey: key });
    },
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setLink('');
    create.mutate({
      kind,
      scope:
        kind === 'snapshot'
          ? 'read'
          : (String(form.get('scope')) as 'read' | 'write'),
      revision_id: kind === 'snapshot' ? String(form.get('revision_id')) : null,
      recipient_id: String(form.get('recipient_id')) || null,
      expires_hours: Number(form.get('expires_hours')),
    });
  }
  return (
    <section
      className="content-section shares-panel"
      aria-labelledby="shares-heading"
    >
      <h2 id="shares-heading">Shared links</h2>
      <p className="muted">
        Live links open the current shared source for verified workspace
        members. Snapshot links reveal one frozen revision; anyone holding an
        unbound snapshot link can read it.
      </p>
      {!blocked && (
        <form className="form-stack compact-form" onSubmit={submit}>
          <label htmlFor="share-kind">Link type</label>
          <select
            id="share-kind"
            value={kind}
            onChange={(event) =>
              setKind(event.target.value as 'live' | 'snapshot')
            }
          >
            <option value="live">Live — current shared room</option>
            <option value="snapshot">Snapshot — immutable revision</option>
          </select>
          {kind === 'live' ? (
            <>
              <label htmlFor="share-scope">Source access</label>
              <select name="scope" id="share-scope" defaultValue="read">
                <option value="read">Read only</option>
                <option value="write">Read and write source</option>
              </select>
              <p className="muted">
                A live link grants no project settings, file metadata, history
                or invitation access.
              </p>
            </>
          ) : (
            <>
              <label htmlFor="share-revision">Frozen revision</label>
              <select
                id="share-revision"
                name="revision_id"
                required
                defaultValue=""
              >
                <option value="" disabled>
                  Choose a named revision
                </option>
                {revisions.data?.items.map((revision) => (
                  <option key={revision.id} value={revision.id}>
                    {revision.name}
                  </option>
                ))}
              </select>
              <p className="muted">
                Snapshot links are always read only. Capture a revision in
                History first.
              </p>
            </>
          )}
          <label htmlFor="share-recipient">Recipient (optional)</label>
          <select name="recipient_id" id="share-recipient" defaultValue="">
            <option value="">Anyone eligible who holds the link</option>
            {members.data?.items.map((member) => (
              <option key={member.user_id} value={member.user_id}>
                {member.display_name}
              </option>
            ))}
          </select>
          <Field
            label="Expires in hours"
            name="expires_hours"
            type="number"
            min={1}
            max={168}
            defaultValue={24}
            required
            hint="Choose 1–168 hours (up to seven days)."
          />
          <Button
            type="submit"
            busy={create.isPending}
            disabled={kind === 'snapshot' && !revisions.data?.items.length}
          >
            Create shared link
          </Button>
        </form>
      )}
      {create.error && <Failure error={create.error} />}
      {revoke.error && <Failure error={revoke.error} />}
      {members.error && <Failure error={members.error} />}
      {revisions.error && <Failure error={revisions.error} />}
      {link && (
        <div className="content-section">
          <Field
            label="New shared link"
            value={link}
            readOnly
            hint="Shown only now. Copy it privately; the link is a capability. It cannot be recovered from the list."
          />
          <div className="actions">
            <Button
              variant="secondary"
              onClick={() => {
                if (!navigator.clipboard) {
                  setCopyError(
                    'Select the link above and copy it with your browser.',
                  );
                  return;
                }
                void navigator.clipboard
                  .writeText(link)
                  .then(() => {
                    setCopied(true);
                    setCopyError('');
                  })
                  .catch(() => {
                    setCopied(false);
                    setCopyError(
                      'Clipboard access was unavailable. Select and copy the link above.',
                    );
                  });
              }}
            >
              {copied ? 'Shared link copied' : 'Copy shared link'}
            </Button>
            <Button variant="secondary" onClick={() => setLink('')}>
              Dismiss shared link
            </Button>
          </div>
          {copyError && <Notice>{copyError}</Notice>}
        </div>
      )}
      {list.isPending && <Notice>Loading shared links…</Notice>}
      {list.error && <Failure error={list.error} />}
      {list.data?.count === 0 && <p>No shared links yet.</p>}
      <div className="list">
        {list.data?.items.map((share) => (
          <div className="list-row" key={share.id}>
            <div>
              <strong>
                {share.kind === 'live' ? 'Live shared room' : 'Frozen snapshot'}
              </strong>
              <p>
                {share.scope === 'write'
                  ? 'Read and write source'
                  : 'Read only'}{' '}
                ·{' '}
                {share.revoked
                  ? 'Revoked'
                  : Date.parse(share.expires_at) <= Date.now()
                    ? 'Expired'
                    : `Expires ${new Date(share.expires_at).toLocaleString()}`}
              </p>
              <p className="muted">
                {share.recipient_id
                  ? `Recipient: ${members.data?.items.find((member) => member.user_id === share.recipient_id)?.display_name ?? 'Selected account'}`
                  : 'Unbound link'}
              </p>
            </div>
            {!share.revoked && (
              <Button
                variant="secondary"
                busy={revoke.isPending}
                disabled={paused}
                onClick={() => revoke.mutate(share.id)}
              >
                Revoke {share.kind} link
              </Button>
            )}
          </div>
        ))}
      </div>
      <Pagination
        offset={offset}
        count={list.data?.count ?? 0}
        limit={20}
        onChange={setOffset}
      />
    </section>
  );
}
