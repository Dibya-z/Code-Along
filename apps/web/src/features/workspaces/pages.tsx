import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Button, Dialog, Field, Notice } from '@code-along/design-system';
import { api } from '../../api/client.ts';
import { Failure } from '../../api/feedback.tsx';
import { queryClient } from '../../app/providers.tsx';
import { useIdentity } from '../auth/session.ts';
export interface Workspace {
  id: string;
  name: string;
  role: 'owner' | 'instructor' | 'learner';
  archived: boolean;
  acl_version: string;
}
export interface Member {
  user_id: string;
  display_name: string;
  role: Workspace['role'];
}
export interface Page<T> {
  items: T[];
  count: number;
}
export function SignedIn({ children }: { children: ReactNode }) {
  const identity = useIdentity();
  if (identity.isPending)
    return (
      <div className="page">
        <Notice>Loading your account…</Notice>
      </div>
    );
  if (identity.error)
    return (
      <div className="page">
        <Failure error={identity.error} />
      </div>
    );
  if (!identity.data)
    return (
      <div className="page narrow">
        <h1>Sign in to continue.</h1>
        <p>Your workspaces are only visible to your account.</p>
        <Link className="button" to="/login">
          Sign in
        </Link>
      </div>
    );
  return children;
}
export function WorkspacesPage() {
  return (
    <SignedIn>
      <WorkspaceList />
    </SignedIn>
  );
}
function WorkspaceList() {
  const [offset, setOffset] = useState(0);
  const navigate = useNavigate();
  const query = useQuery({
    queryKey: ['workspaces', offset],
    queryFn: () =>
      api<Page<Workspace>>(`/api/v1/workspaces/?limit=50&offset=${offset}`),
  });
  const create = useMutation({
    mutationFn: (name: string) =>
      api<Workspace>('/api/v1/workspaces/', { method: 'POST', body: { name } }),
    onSuccess: async (workspace) => {
      await queryClient.invalidateQueries({ queryKey: ['workspaces'] });
      await navigate(`/workspaces/${workspace.id}`);
    },
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    create.mutate(String(new FormData(event.currentTarget).get('name') ?? ''));
  }
  return (
    <div className="page">
      <div className="section-head">
        <div>
          <p className="eyebrow">YOUR WORKBENCH</p>
          <h1>Your workspaces</h1>
          <p className="lead">
            One home for each group. A clear place for every project.
          </p>
        </div>
        <Dialog
          title="Create a workspace"
          description="Give your learning group a name. You’ll be its first member and owner."
          trigger={<Button>Create workspace</Button>}
        >
          <form className="form-stack" onSubmit={submit}>
            <Field
              label="Workspace name"
              name="name"
              maxLength={100}
              required
              autoComplete="off"
            />
            {create.error && <Failure error={create.error} />}
            <Button busy={create.isPending} type="submit">
              Create workspace
            </Button>
          </form>
        </Dialog>
      </div>
      {query.error && <Failure error={query.error} />}
      {query.isPending ? (
        <Notice>Loading workspaces…</Notice>
      ) : query.data?.items.length ? (
        <>
          <div className="list">
            {query.data.items.map((workspace) => (
              <div key={workspace.id} className="list-row">
                <div>
                  <h2>
                    <Link to={`/workspaces/${workspace.id}`}>
                      {workspace.name}
                    </Link>
                  </h2>
                  <p>
                    {workspace.archived
                      ? 'Archived workspace'
                      : 'Learning workspace'}
                  </p>
                </div>
                <span className="badge">{workspace.role}</span>
              </div>
            ))}
          </div>
          <Pagination
            offset={offset}
            count={query.data.count}
            limit={50}
            onChange={setOffset}
          />
        </>
      ) : (
        !query.error && (
          <div className="empty-state">
            <span className="empty-mark" aria-hidden="true">
              [ ]
            </span>
            <h2>A fresh workspace starts here.</h2>
            <p>
              Create a workspace for your group, or open an invitation someone
              has shared with you.
            </p>
          </div>
        )
      )}
      <div className="page-note">
        <strong>Your projects stay yours.</strong>
        <p>
          Joining a workspace gives you membership. Private project access is
          always shared separately.
        </p>
      </div>
    </div>
  );
}
export function Pagination({
  offset,
  count,
  limit,
  onChange,
}: {
  offset: number;
  count: number;
  limit: number;
  onChange: (n: number) => void;
}) {
  if (count <= limit) return null;
  return (
    <nav aria-label="Pagination" className="actions content-section">
      <Button
        variant="secondary"
        disabled={offset === 0}
        onClick={() => onChange(Math.max(0, offset - limit))}
      >
        Previous page
      </Button>
      <span>
        {offset + 1}–{Math.min(offset + limit, count)} of {count}
      </span>
      <Button
        variant="secondary"
        disabled={offset + limit >= count}
        onClick={() => onChange(offset + limit)}
      >
        Next page
      </Button>
    </nav>
  );
}
export function WorkspacePage() {
  return (
    <SignedIn>
      <WorkspaceDetail />
    </SignedIn>
  );
}
function WorkspaceDetail() {
  const { workspaceId } = useParams();
  const [memberOffset, setMemberOffset] = useState(0);
  const identity = useIdentity();
  const base = `/api/v1/workspaces/${workspaceId}/`;
  const query = useQuery({
    queryKey: ['workspace', workspaceId],
    queryFn: () => api<Workspace>(base),
  });
  const members = useQuery({
    queryKey: ['members', workspaceId, memberOffset],
    queryFn: () =>
      api<Page<Member>>(`${base}members/?limit=100&offset=${memberOffset}`),
    enabled: Boolean(query.data),
  });
  const update = useMutation({
    mutationFn: ({
      path = '',
      method = 'PATCH',
      body,
    }: {
      path?: string;
      method?: string;
      body?: unknown;
    }) =>
      api<unknown>(base + path, {
        method,
        ...(body === undefined ? {} : { body }),
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['workspace', workspaceId] }),
        queryClient.invalidateQueries({ queryKey: ['members', workspaceId] }),
        queryClient.invalidateQueries({ queryKey: ['workspaces'] }),
      ]);
    },
  });
  const workspace = query.data;
  const owner = workspace?.role === 'owner';
  if (query.isPending)
    return (
      <div className="page">
        <Notice>Loading workspace…</Notice>
      </div>
    );
  if (query.error || !workspace)
    return (
      <div className="page">
        <Link to="/workspaces">← Your workspaces</Link>
        <h1>Workspace unavailable.</h1>
        <Failure error={query.error} />
      </div>
    );
  function rename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    update.mutate({
      body: {
        name: String(new FormData(event.currentTarget).get('name') ?? ''),
      },
    });
  }
  function transfer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    update.mutate({
      path: 'ownership/',
      method: 'POST',
      body: {
        new_owner_id: String(
          new FormData(event.currentTarget).get('new_owner_id') ?? '',
        ),
      },
    });
  }
  return (
    <div className="page">
      <Link to="/workspaces">← Your workspaces</Link>
      <div className="section-head content-section">
        <div>
          <p className="eyebrow">
            LEARNING WORKSPACE · {workspace.role.toUpperCase()}
          </p>
          <h1>{workspace.name}</h1>
          <p className="lead">
            A shared place to learn. Each project has its own access list.
          </p>
        </div>
        {workspace.archived && <span className="badge">Archived</span>}
      </div>
      {update.error && <Failure error={update.error} />}
      {workspace.archived && (
        <Notice>
          This workspace is archived. Its records are preserved; restore it to
          make changes.
        </Notice>
      )}
      <section className="content-section" aria-labelledby="projects-heading">
        <h2 id="projects-heading">Projects</h2>
        <p className="muted">No projects yet.</p>
      </section>
      <section className="content-section" aria-labelledby="members-heading">
        <h2 id="members-heading">Members</h2>
        {members.error && <Failure error={members.error} />}
        {members.isPending ? (
          <Notice>Loading members…</Notice>
        ) : (
          <div className="list">
            {members.data?.items.map((member) => (
              <div className="list-row" key={member.user_id}>
                <div>
                  <strong>{member.display_name}</strong>
                  <p>{member.role}</p>
                </div>
                {owner && member.role !== 'owner' && !workspace.archived ? (
                  <div className="actions">
                    <select
                      aria-label={`Role for ${member.display_name}`}
                      value={member.role}
                      disabled={update.isPending}
                      onChange={(event) =>
                        update.mutate({
                          path: `members/${member.user_id}/`,
                          body: { role: event.target.value },
                        })
                      }
                    >
                      <option value="learner">Learner</option>
                      <option value="instructor">Instructor</option>
                    </select>
                    <Dialog
                      title={`Remove ${member.display_name}?`}
                      description="They will lose workspace access. Projects they own must be transferred first."
                      trigger={
                        <Button variant="secondary">Remove member</Button>
                      }
                    >
                      {update.error && <Failure error={update.error} />}
                      <Button
                        variant="danger"
                        busy={update.isPending}
                        onClick={() =>
                          update.mutate({
                            path: `members/${member.user_id}/`,
                            method: 'DELETE',
                          })
                        }
                      >
                        Confirm removal
                      </Button>
                    </Dialog>
                  </div>
                ) : (
                  <span className="badge">{member.role}</span>
                )}
              </div>
            ))}
          </div>
        )}
        {members.data && (
          <Pagination
            offset={memberOffset}
            count={members.data.count}
            limit={100}
            onChange={setMemberOffset}
          />
        )}
      </section>
      {owner ? (
        <section className="content-section" aria-labelledby="settings-heading">
          <h2 id="settings-heading">Workspace settings</h2>
          <form
            className="form-stack"
            style={{ maxWidth: '28rem' }}
            onSubmit={rename}
          >
            <Field
              key={workspace.name}
              label="Workspace name"
              name="name"
              defaultValue={workspace.name}
              required
              maxLength={100}
            />
            <div>
              <Button type="submit" variant="secondary" busy={update.isPending}>
                Save workspace name
              </Button>
            </div>
          </form>
          <div className="actions content-section">
            {workspace.archived ? (
              <Button
                variant="secondary"
                busy={update.isPending}
                onClick={() => update.mutate({ body: { archived: false } })}
              >
                Restore workspace
              </Button>
            ) : (
              <>
                <Dialog
                  title="Transfer workspace ownership"
                  description="The new owner will manage this workspace. You’ll remain an instructor; private project ownership is unchanged."
                  trigger={
                    <Button variant="secondary">Transfer ownership</Button>
                  }
                >
                  <form className="form-stack" onSubmit={transfer}>
                    <label htmlFor="new-owner">New owner</label>
                    <select
                      id="new-owner"
                      name="new_owner_id"
                      required
                      defaultValue=""
                    >
                      <option value="" disabled>
                        Choose an active member
                      </option>
                      {members.data?.items
                        .filter(
                          (member) => member.user_id !== identity.data?.id,
                        )
                        .map((member) => (
                          <option key={member.user_id} value={member.user_id}>
                            {member.display_name}
                          </option>
                        ))}
                    </select>
                    {update.error && <Failure error={update.error} />}
                    <Button type="submit" busy={update.isPending}>
                      Transfer workspace
                    </Button>
                  </form>
                </Dialog>
                <Dialog
                  title="Archive this workspace?"
                  description="Your group’s records will be preserved. Changes stay paused until the owner restores the workspace."
                  trigger={
                    <Button variant="secondary">Archive workspace</Button>
                  }
                >
                  {update.error && <Failure error={update.error} />}
                  <Button
                    variant="danger"
                    busy={update.isPending}
                    onClick={() => update.mutate({ body: { archived: true } })}
                  >
                    Confirm archive
                  </Button>
                </Dialog>
              </>
            )}
          </div>
        </section>
      ) : (
        !workspace.archived && (
          <section className="content-section">
            <Dialog
              title="Leave this workspace?"
              description="You will lose access. Transfer projects you own before leaving."
              trigger={<Button variant="secondary">Leave workspace</Button>}
            >
              {update.error && <Failure error={update.error} />}
              <Button
                variant="danger"
                busy={update.isPending}
                onClick={() =>
                  update.mutate({
                    path: `members/${identity.data?.id}/`,
                    method: 'DELETE',
                  })
                }
              >
                Confirm leave
              </Button>
            </Dialog>
          </section>
        )
      )}
    </div>
  );
}
