import { productApi } from '../../api/product.ts';
import { useId, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Button, Dialog, Field, Notice } from '@code-along/design-system';
import { Failure } from '../../api/feedback.tsx';
import { queryClient } from '../../app/providers.tsx';
import { Pagination } from '../../components/pagination.tsx';
import type { Workspace } from '../workspaces/types.ts';
import { useIdentity } from '../auth/session.ts';
import {
  CORE_RUNTIME,
  runtimeProfile,
} from '@code-along/contracts/execution/profiles';
import { projectRuntimeChoices } from './runtime-choices.ts';
export function ProjectsPanel({
  workspace,
  active = true,
}: {
  workspace: Workspace;
  active?: boolean;
}) {
  const [offset, setOffset] = useState(0);
  const [open, setOpen] = useState(false),
    [runtime, setRuntime] = useState(CORE_RUNTIME.runtime_id),
    [runtimeError, setRuntimeError] = useState('');
  const accountId = useIdentity().data?.id;
  const runtimeField = useId();
  const navigate = useNavigate();
  const query = useQuery({
    queryKey: ['projects', workspace.id, offset],
    queryFn: () => productApi.projects(workspace.id, offset),
    enabled: active,
  });
  const catalogue = useQuery({
    queryKey: ['runtime-profiles', accountId],
    queryFn: productApi.runtimeProfiles,
    enabled: open && Boolean(accountId),
  });
  const choices = projectRuntimeChoices(catalogue.data?.items ?? []);
  const selectedRuntime = choices.find(
    (choice) => choice.profile.identity.runtime_id === runtime,
  );
  const create = useMutation({
    mutationFn: ({
      name,
      runtimeProfileId,
    }: {
      name: string;
      runtimeProfileId: string;
    }) => productApi.createProject(workspace.id, name, runtimeProfileId),
    onSuccess: async (project) => {
      await queryClient.invalidateQueries({
        queryKey: ['projects', workspace.id],
      });
      await navigate(`/projects/${project.id}`);
    },
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !selectedRuntime ||
      catalogue.isFetching ||
      catalogue.error ||
      !accountId
    ) {
      setRuntimeError(
        'Choose an available Python environment before creating the project.',
      );
      return;
    }
    setRuntimeError('');
    create.mutate({
      name: String(new FormData(event.currentTarget).get('name') ?? ''),
      runtimeProfileId: selectedRuntime.id,
    });
  }
  return (
    <section className="content-section" aria-labelledby="projects-heading">
      <div className="section-head">
        <h2 id="projects-heading">Projects</h2>
        {!workspace.archived && (
          <Dialog
            open={open}
            onOpenChange={(next) => {
              setOpen(next);
              if (next && !create.isPending) {
                setRuntime(CORE_RUNTIME.runtime_id);
                setRuntimeError('');
                create.reset();
              }
            }}
            title="Create a Python project"
            description="Start with a private main.py. Choose who can join when you’re ready."
            trigger={<Button>Create project</Button>}
          >
            <form className="form-stack" onSubmit={submit}>
              <Field
                label="Project name"
                name="name"
                maxLength={120}
                required
              />
              <label htmlFor={runtimeField}>Python environment</label>
              <select
                id={runtimeField}
                value={runtime}
                disabled={
                  catalogue.isPending ||
                  Boolean(catalogue.error) ||
                  create.isPending
                }
                onChange={(event) => {
                  setRuntime(event.target.value);
                  setRuntimeError('');
                }}
              >
                {!selectedRuntime && (
                  <option value={runtime} disabled>
                    {runtimeProfile(runtime)?.name ?? 'Selected environment'}{' '}
                    {catalogue.isPending
                      ? '(checking availability…)'
                      : '(unavailable)'}
                  </option>
                )}
                {choices.map(({ id, profile }) => (
                  <option key={id} value={profile.identity.runtime_id}>
                    {profile.name}
                  </option>
                ))}
              </select>
              {selectedRuntime && (
                <p className="muted">{selectedRuntime.profile.description}</p>
              )}
              {catalogue.isFetching && (
                <p role="status">Checking Python environments…</p>
              )}
              {catalogue.error && <Failure error={catalogue.error} />}
              {!catalogue.isPending && !catalogue.error && !choices.length && (
                <Notice>
                  No reviewed Python environment is available. Refresh the list
                  before creating a project.
                </Notice>
              )}
              <div>
                <Button
                  type="button"
                  variant="secondary"
                  busy={catalogue.isFetching}
                  disabled={create.isPending}
                  onClick={() => {
                    void catalogue.refetch();
                  }}
                >
                  Refresh environments
                </Button>
              </div>
              {runtimeError && <Notice tone="error">{runtimeError}</Notice>}
              {create.error && <Failure error={create.error} />}
              <Button
                type="submit"
                busy={create.isPending}
                disabled={
                  !selectedRuntime ||
                  catalogue.isFetching ||
                  Boolean(catalogue.error)
                }
              >
                Create project
              </Button>
            </form>
          </Dialog>
        )}
      </div>
      {query.isPending ? (
        <Notice>Loading your projects…</Notice>
      ) : query.error ? (
        <Failure error={query.error} />
      ) : (
        query.data && (
          <>
            <div className="list">
              {query.data.items.map((project) => (
                <div className="list-row" key={project.id}>
                  <div>
                    <h3>
                      <Link to={`/projects/${project.id}`}>{project.name}</Link>
                    </h3>
                    <p>
                      {project.archived ? 'Archived' : 'Python'} ·{' '}
                      {project.entrypoint_path}
                    </p>
                  </div>
                  <span className="badge">{project.role}</span>
                </div>
              ))}
            </div>
            {query.data.count === 0 && (
              <p className="muted">
                No projects shared with you yet. Create your own, or ask a
                project owner for access.
              </p>
            )}
            <Pagination
              offset={offset}
              count={query.data.count}
              limit={50}
              onChange={setOffset}
            />
          </>
        )
      )}
    </section>
  );
}
