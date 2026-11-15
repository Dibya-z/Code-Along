import { productApi } from '../../api/product.ts';
import { ProjectsPanel } from '../projects/list.tsx';
import { SignedIn } from '../auth/guard.tsx';
import { Pagination } from '../../components/pagination.tsx';
import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Button, Dialog, Field, Notice } from '@code-along/design-system';
import { api } from '../../api/client.ts';
import { Failure } from '../../api/feedback.tsx';
import { queryClient } from '../../app/providers.tsx';
import { useIdentity } from '../auth/session.ts';
import { InvitationsPanel } from '../invitations/pages.tsx';
import { WorkspaceAssignments } from '../learning/list.tsx';
import { TaskNavigation } from '../learning/navigation.tsx';
import { Icon } from '../../ui/icon.tsx';
import './styles.css';
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
    queryFn: () => productApi.workspaces(offset),
  });
  const create = useMutation({
    mutationFn: (name: string) => productApi.createWorkspace(name),
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
    <div className="page workspace-index">
      <div className="workspace-page-header">
        <div>
          <p className="workspace-kicker">A LITTLE PROGRESS, TOGETHER</p>
          <h1>Your workspaces</h1>
          <p className="workspace-intro">
            Your groups, projects and Python practice, in one place.
          </p>
        </div>
        <Dialog
          title="Create a workspace"
          description="Give your learning group a name. You’ll be its first member and owner."
          trigger={
            <Button>
              <Icon name="plus" />
              Create workspace
            </Button>
          }
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
          <div className="workspace-collection-heading">
            <h2>Your spaces</h2>
            <span>
              {query.data.count}{' '}
              {query.data.count === 1 ? 'workspace' : 'workspaces'}
            </span>
          </div>
          <div className="workspace-grid">
            {query.data.items.map((workspace) => (
              <article className="workspace-card" key={workspace.id}>
                <Link
                  className="workspace-card-link"
                  to={`/workspaces/${workspace.id}`}
                  aria-label={workspace.name}
                  aria-describedby={`workspace-${workspace.id}-role workspace-${workspace.id}-state`}
                >
                  <span className="workspace-monogram" aria-hidden="true">
                    {Array.from(workspace.name.trim())
                      .slice(0, 2)
                      .join('')
                      .toLocaleUpperCase()}
                  </span>
                  <span
                    id={`workspace-${workspace.id}-role`}
                    className="workspace-card-role"
                  >
                    {workspace.role}
                  </span>
                  <div className="workspace-card-copy">
                    <h3>{workspace.name}</h3>
                    <p id={`workspace-${workspace.id}-state`}>
                      {workspace.archived
                        ? 'Archived workspace'
                        : 'Learning workspace'}
                    </p>
                  </div>
                  <div className="workspace-card-footer">
                    <span>
                      <Icon name="folder" />
                      Projects & assignments
                    </span>
                    <span className="workspace-card-arrow" aria-hidden="true">
                      <Icon name="arrow-right" />
                    </span>
                  </div>
                </Link>
              </article>
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
          <div className="workspace-empty">
            <span className="workspace-empty-icon" aria-hidden="true">
              <Icon name="workspace" />
            </span>
            <p className="workspace-kicker">GOOD THINGS START SMALL</p>
            <h2>A fresh workspace starts here.</h2>
            <p>
              Create a workspace for your group, or open an invitation someone
              has shared with you.
            </p>
            <ol className="workspace-first-steps">
              <li>
                <span>01</span> Make a space
              </li>
              <li>
                <span>02</span> Invite your people
              </li>
              <li>
                <span>03</span> Write some Python
              </li>
            </ol>
          </div>
        )
      )}
      <aside className="workspace-privacy-note">
        <Icon name="shield" />
        <div>
          <strong>Your projects stay yours.</strong>
          <p>
            Joining a workspace gives you membership. Private project access is
            always shared separately.
          </p>
        </div>
      </aside>
    </div>
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
  const location = useLocation();
  const active = location.hash === '#assignments' ? 'assignments' : 'projects';
  const { workspaceId } = useParams();
  const [memberOffset, setMemberOffset] = useState(0);
  const identity = useIdentity();
  const base = `/api/v1/workspaces/${workspaceId}/`;
  const query = useQuery({
    queryKey: ['workspace', workspaceId],
    queryFn: () => productApi.workspace(workspaceId ?? ''),
  });
  const members = useQuery({
    queryKey: ['members', workspaceId, memberOffset],
    queryFn: () => productApi.members(workspaceId ?? '', memberOffset),
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
        queryClient.invalidateQueries({
          queryKey: ['invitations', workspaceId],
        }),
      ]);
    },
  });
  const workspace = query.data;
  const owner = workspace?.role === 'owner';
  if (query.isPending)
    return (
      <div className="page workspace-detail">
        <Notice>Loading workspace…</Notice>
      </div>
    );
  if (query.error || !workspace)
    return (
      <div className="page workspace-detail">
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
    <div className="page workspace-detail">
      <Link className="workspace-back" to="/workspaces">
        <span aria-hidden="true">←</span> Your workspaces
      </Link>
      <div className="workspace-page-header workspace-detail-header">
        <span className="workspace-monogram" aria-hidden="true">
          {Array.from(workspace.name.trim())
            .slice(0, 2)
            .join('')
            .toLocaleUpperCase()}
        </span>
        <div className="workspace-detail-copy">
          <p className="workspace-kicker">LEARNING WORKSPACE</p>
          <h1>{workspace.name}</h1>
          <p className="workspace-intro">
            Your group's projects, lessons and shared progress.
          </p>
          <div className="workspace-context">
            <span className="workspace-role">{workspace.role}</span>
            {members.data && (
              <span>
                <Icon name="users" />
                {members.data.count}{' '}
                {members.data.count === 1 ? 'member' : 'members'}
              </span>
            )}
            <span>
              <Icon name="shield" />
              Project access is shared separately
            </span>
          </div>
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
      <TaskNavigation
        label="Workspace sections"
        active={active}
        sections={[
          { id: 'projects', label: 'Projects' },
          { id: 'assignments', label: 'Assignments' },
        ]}
      />
      <div
        className="learning-view"
        id="projects"
        tabIndex={-1}
        hidden={active !== 'projects'}
      >
        <ProjectsPanel workspace={workspace} active={active === 'projects'} />
      </div>
      <div
        className="learning-view"
        id="assignments"
        tabIndex={-1}
        hidden={active !== 'assignments'}
      >
        <WorkspaceAssignments
          workspace={workspace}
          active={active === 'assignments'}
        />
      </div>
      <details className="content-section task-disclosure workspace-disclosure">
        <summary>
          <Icon name="users" />
          Members
        </summary>
        <section className="content-section" aria-labelledby="members-heading">
          <h2 id="members-heading">Workspace members</h2>
          {members.error && <Failure error={members.error} />}
          {members.isPending ? (
            <Notice>Loading members…</Notice>
          ) : (
            <div className="list">
              {members.data?.items.map((member) => (
                <div className="list-row" key={member.user_id}>
                  <div className="workspace-member-identity">
                    <span className="workspace-member-mark" aria-hidden="true">
                      {Array.from(member.display_name.trim())
                        .slice(0, 1)
                        .join('')
                        .toLocaleUpperCase()}
                    </span>
                    <div>
                      <strong>{member.display_name}</strong>
                      <p>{member.role}</p>
                    </div>
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
        {owner && <InvitationsPanel workspace={workspace} />}
      </details>
      {(owner || !workspace.archived) && (
        <details className="content-section task-disclosure workspace-disclosure">
          <summary>
            <Icon name="workspace" />
            Workspace administration
          </summary>
          {owner ? (
            <section
              className="content-section"
              aria-labelledby="settings-heading"
            >
              <h2 id="settings-heading">Workspace settings</h2>
              <form
                className="form-stack workspace-settings-form"
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
                  <Button
                    type="submit"
                    variant="secondary"
                    busy={update.isPending}
                  >
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
                              <option
                                key={member.user_id}
                                value={member.user_id}
                              >
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
                        onClick={() =>
                          update.mutate({ body: { archived: true } })
                        }
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
        </details>
      )}
    </div>
  );
}
