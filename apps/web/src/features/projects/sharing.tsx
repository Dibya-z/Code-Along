import type { components } from '@code-along/api-client';
import { useState, type FormEvent } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Button, Dialog, Field, Notice } from '@code-along/design-system';
import { api } from '../../api/client.ts';
import { Failure } from '../../api/feedback.tsx';
import { queryClient } from '../../app/providers.tsx';
import type { Member, Page } from '../workspaces/types.ts';
import type { Project } from './types.ts';
type Grant = components['schemas']['GrantOutput'];
type Invitation = components['schemas']['InvitationOutput'];
export function ProjectSharing({
  project,
  active = true,
}: {
  project: Project;
  active?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [link, setLink] = useState('');
  const readOnly = project.archived || project.workspace_archived;
  const base = `/api/v1/projects/${project.id}/`;
  const members = useQuery({
    enabled: active,
    queryKey: ['members', project.workspace_id, 'sharing'],
    queryFn: () =>
      api<Page<Member>>(
        `/api/v1/workspaces/${project.workspace_id}/members/?limit=100`,
      ),
  });
  const grants = useQuery({
    enabled: active,
    queryKey: ['grants', project.id],
    queryFn: () => api<Page<Grant>>(base + 'grants/?limit=100'),
  });
  const invitations = useQuery({
    enabled: active,
    queryKey: ['project-invitations', project.id],
    queryFn: () => api<Page<Invitation>>(base + 'invitations/?limit=100'),
  });
  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['project', project.id] }),
      queryClient.invalidateQueries({ queryKey: ['grants', project.id] }),
      queryClient.invalidateQueries({
        queryKey: ['project-invitations', project.id],
      }),
    ]);
  }
  const change = useMutation({
    mutationFn: ({
      suffix,
      method,
      body,
    }: {
      suffix: string;
      method: string;
      body?: unknown;
    }) =>
      api<unknown>(base + suffix, {
        method,
        ...(body === undefined ? {} : { body }),
      }),
    onSuccess: async () => {
      setLink('');
      await refresh();
    },
  });
  const invite = useMutation({
    mutationFn: (body: unknown) =>
      api<{ invite_url: string }>(base + 'invitations/', {
        method: 'POST',
        body,
      }),
    onSuccess: async (data) => {
      setLink(data.invite_url);
      setOpen(false);
      await refresh();
    },
  });
  function grant(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    change.mutate({
      suffix: `grants/${String(form.get('user_id'))}/`,
      method: 'PUT',
      body: { role: String(form.get('role')) },
    });
  }
  function createInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    invite.mutate({
      recipient_email: String(form.get('recipient_email')),
      role: String(form.get('role')),
      expires_hours: 72,
    });
  }
  function transfer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    change.mutate({
      suffix: 'ownership/',
      method: 'POST',
      body: {
        new_owner_id: String(
          new FormData(event.currentTarget).get('new_owner_id'),
        ),
        expected_version: project.metadata_version,
      },
    });
  }
  return (
    <section className="content-section" aria-labelledby="sharing-heading">
      <h2 id="sharing-heading">Project access</h2>
      <p className="muted">
        These grants give ordinary project access. A workspace role alone gives
        no access. Valid shared links grant separate, limited source access.
      </p>
      {change.error && <Failure error={change.error} />}
      {grants.error && <Failure error={grants.error} />}
      {members.error && <Failure error={members.error} />}
      {!readOnly && (
        <form className="form-stack compact-form" onSubmit={grant}>
          <label htmlFor="grant-user">Workspace member</label>
          <select id="grant-user" name="user_id" required defaultValue="">
            <option value="" disabled>
              Choose a member
            </option>
            {members.data?.items
              .filter((m) => m.user_id !== project.owner_id)
              .map((m) => (
                <option key={m.user_id} value={m.user_id}>
                  {m.display_name}
                </option>
              ))}
          </select>
          <label htmlFor="grant-role">Project role</label>
          <select id="grant-role" name="role" defaultValue="viewer">
            <option value="viewer">Viewer — read access</option>
            <option value="editor">Editor — file changes</option>
          </select>
          <Button type="submit" variant="secondary" busy={change.isPending}>
            Grant project access
          </Button>
        </form>
      )}
      <div className="list">
        {grants.data?.items.map((g) => (
          <div className="list-row" key={g.user_id}>
            <div>
              <strong>{g.display_name}</strong>
              <p>{g.role}</p>
            </div>
            <Button
              variant="secondary"
              busy={change.isPending}
              onClick={() =>
                change.mutate({
                  suffix: `grants/${g.user_id}/`,
                  method: 'DELETE',
                })
              }
            >
              Remove project access
            </Button>
          </div>
        ))}
      </div>
      <div className="actions content-section">
        {!readOnly && (
          <>
            <Dialog
              open={open}
              onOpenChange={setOpen}
              title="Invite to project"
              description="Invite an existing workspace member. They can choose to accept the project link; it expires in three days."
              trigger={
                <Button variant="secondary">Create project invitation</Button>
              }
            >
              <form className="form-stack" onSubmit={createInvite}>
                <Field
                  label="Member email"
                  name="recipient_email"
                  type="email"
                  required
                />
                <label htmlFor="project-invite-role">Project role</label>
                <select
                  id="project-invite-role"
                  name="role"
                  defaultValue="viewer"
                >
                  <option value="viewer">Viewer</option>
                  <option value="editor">Editor</option>
                </select>
                {invite.error && <Failure error={invite.error} />}
                <Button type="submit" busy={invite.isPending}>
                  Create project invitation
                </Button>
              </form>
            </Dialog>
            <Dialog
              title="Transfer project ownership"
              description="The selected member becomes the owner. You keep editor access. Pending project invitations are revoked."
              trigger={
                <Button variant="secondary">Transfer project ownership</Button>
              }
            >
              <form className="form-stack" onSubmit={transfer}>
                <label htmlFor="project-new-owner">New project owner</label>
                <select
                  id="project-new-owner"
                  name="new_owner_id"
                  required
                  defaultValue=""
                >
                  <option value="" disabled>
                    Choose a workspace member
                  </option>
                  {members.data?.items
                    .filter((m) => m.user_id !== project.owner_id)
                    .map((m) => (
                      <option key={m.user_id} value={m.user_id}>
                        {m.display_name}
                      </option>
                    ))}
                </select>
                {change.error && <Failure error={change.error} />}
                <Button busy={change.isPending} type="submit">
                  Confirm project transfer
                </Button>
              </form>
            </Dialog>
          </>
        )}
      </div>
      {link && (
        <div className="content-section">
          <Field
            label="Project invitation link"
            value={link}
            readOnly
            hint="Shown once. Copy and share privately with the recipient."
          />
        </div>
      )}
      {invitations.error && <Failure error={invitations.error} />}
      <div className="list">
        {invitations.data?.items.map((i) => (
          <div className="list-row" key={i.id}>
            <div>
              <strong>{i.recipient_email}</strong>
              <p>
                {i.role} · {i.status}
              </p>
            </div>
            {i.status === 'pending' && (
              <Button
                variant="secondary"
                busy={change.isPending}
                onClick={() =>
                  change.mutate({
                    suffix: `invitations/${i.id}/`,
                    method: 'DELETE',
                  })
                }
              >
                Revoke project invitation
              </Button>
            )}
          </div>
        ))}
      </div>
      {grants.isPending && <Notice>Loading project access…</Notice>}
    </section>
  );
}
