import { useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Button, Dialog, Field, Notice } from '@code-along/design-system';
import { api } from '../../api/client.ts';
import { Failure } from '../../api/feedback.tsx';
import { queryClient } from '../../app/providers.tsx';
import { SignedIn } from '../auth/guard.tsx';
import { Pagination } from '../../components/pagination.tsx';
import type { Workspace, Page } from '../workspaces/types.ts';
interface Invitation {
  id: string;
  recipient_email: string;
  role: string;
  expires_at: string;
  status: string;
  workspace_id: string;
}
export function InvitationsPanel({ workspace }: { workspace: Workspace }) {
  const [open, setOpen] = useState(false);
  const [link, setLink] = useState('');
  const [copied, setCopied] = useState(false);
  const [offset, setOffset] = useState(0);
  const base = `/api/v1/workspaces/${workspace.id}/invitations/`;
  const query = useQuery({
    queryKey: ['invitations', workspace.id, offset],
    queryFn: () => api<Page<Invitation>>(`${base}?offset=${offset}`),
  });
  const create = useMutation({
    mutationFn: (body: unknown) =>
      api<{ invitation: Invitation; invite_url: string }>(base, {
        method: 'POST',
        body,
      }),
    onSuccess: async (data) => {
      setLink(data.invite_url);
      setCopied(false);
      setOpen(false);
      await queryClient.invalidateQueries({
        queryKey: ['invitations', workspace.id],
      });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) =>
      api<void>(base + id + '/', { method: 'DELETE' }),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: ['invitations', workspace.id],
      }),
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    create.mutate({
      recipient_email: String(form.get('recipient_email') ?? ''),
      role: String(form.get('role') ?? 'learner'),
      expires_hours: Number(form.get('expires_hours')),
    });
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }
  return (
    <section className="content-section" aria-labelledby="invitations-heading">
      <div className="section-head">
        <h2 id="invitations-heading">Invitations</h2>
        {!workspace.archived && (
          <Dialog
            open={open}
            onOpenChange={setOpen}
            title="Invite a workspace member"
            description="Only the person with this email address can use the link. They’ll need a verified account."
            trigger={<Button variant="secondary">Invite member</Button>}
          >
            <form className="form-stack" onSubmit={submit}>
              <Field
                label="Recipient email"
                name="recipient_email"
                type="email"
                required
                maxLength={254}
              />
              <label htmlFor="invite-role">Workspace role</label>
              <select id="invite-role" name="role" defaultValue="learner">
                <option value="learner">Learner</option>
                <option value="instructor">Instructor</option>
              </select>
              <label htmlFor="invite-expiry">Link expires after</label>
              <select id="invite-expiry" name="expires_hours" defaultValue="72">
                <option value="24">One day</option>
                <option value="72">Three days</option>
                <option value="168">Seven days</option>
              </select>
              {create.error && <Failure error={create.error} />}
              <Button busy={create.isPending} type="submit">
                Create invitation
              </Button>
            </form>
          </Dialog>
        )}
      </div>
      {link && (
        <div className="form-stack">
          <Field
            label="Invitation link"
            value={link}
            readOnly
            hint="Copy this link now; it is shown once. Share it privately with the recipient."
          />
          <div className="actions">
            <Button variant="secondary" onClick={() => void copy()}>
              Copy invitation link
            </Button>
            <span role="status">
              {copied
                ? 'Link copied.'
                : 'You can also select and copy the link above.'}
            </span>
          </div>
        </div>
      )}
      {query.error && <Failure error={query.error} />}
      {revoke.error && <Failure error={revoke.error} />}
      {query.data && (
        <>
          <div className="list">
            {query.data.items.map((invitation) => (
              <div className="list-row" key={invitation.id}>
                <div>
                  <strong>{invitation.recipient_email}</strong>
                  <p>
                    {invitation.role} · {invitation.status} · Expires{' '}
                    {new Date(invitation.expires_at).toLocaleDateString()}
                  </p>
                </div>
                {invitation.status === 'pending' && (
                  <Button
                    variant="secondary"
                    busy={revoke.isPending}
                    onClick={() => revoke.mutate(invitation.id)}
                  >
                    Revoke invitation
                  </Button>
                )}
              </div>
            ))}
          </div>
          {query.data.count === 0 && (
            <p className="muted">No invitations yet.</p>
          )}
          <Pagination
            offset={offset}
            count={query.data.count}
            limit={50}
            onChange={setOffset}
          />
        </>
      )}
    </section>
  );
}
export function InvitationPage() {
  return (
    <SignedIn>
      <InvitationDetails />
    </SignedIn>
  );
}
function InvitationDetails() {
  const { token } = useParams();
  const navigate = useNavigate();
  const preview = useQuery({
    queryKey: ['invitation', token],
    queryFn: () =>
      api<{
        workspace_name: string;
        project_name: string | null;
        role: string;
        accepted: boolean;
      }>('/api/v1/invitations/preview/', { method: 'POST', body: { token } }),
  });
  const accept = useMutation({
    mutationFn: () =>
      api<{ workspace_id: string; project_id: string | null }>(
        '/api/v1/invitations/accept/',
        {
          method: 'POST',
          body: { token },
        },
      ),
    onSuccess: async (data) => {
      await queryClient.invalidateQueries({ queryKey: ['workspaces'] });
      await navigate(
        data.project_id
          ? `/projects/${data.project_id}`
          : `/workspaces/${data.workspace_id}`,
        { replace: true },
      );
    },
  });
  return (
    <div className="page narrow">
      <p className="eyebrow">YOU’RE INVITED</p>
      <h1>
        {preview.data
          ? `Join ${preview.data.project_name ?? preview.data.workspace_name}`
          : 'Workspace invitation'}
      </h1>
      {preview.isPending ? (
        <Notice>Checking your invitation…</Notice>
      ) : preview.error ? (
        <Failure error={preview.error} />
      ) : (
        <>
          <p>
            {preview.data?.project_name
              ? `Accept to open this private project as a ${preview.data.role}.`
              : `You’re invited as a ${preview.data?.role}. Private project access is shared separately.`}
          </p>
          {accept.error && <Failure error={accept.error} />}
          <Button busy={accept.isPending} onClick={() => accept.mutate()}>
            {preview.data?.accepted
              ? preview.data.project_name
                ? 'Open project'
                : 'Open workspace'
              : preview.data?.project_name
                ? 'Join project'
                : 'Join workspace'}
          </Button>
        </>
      )}
    </div>
  );
}
