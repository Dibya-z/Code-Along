import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Button, Dialog, Field, Notice } from '@code-along/design-system';
import { api } from '../../api/client.ts';
import { Failure } from '../../api/feedback.tsx';
import { queryClient } from '../../app/providers.tsx';
import { Pagination } from '../../components/pagination.tsx';
import type { Workspace, Page } from '../workspaces/types.ts';
import type { Project } from './types.ts';
export function ProjectsPanel({ workspace }: { workspace: Workspace }) {
  const [offset, setOffset] = useState(0);
  const navigate = useNavigate();
  const base = `/api/v1/workspaces/${workspace.id}/projects/`;
  const query = useQuery({
    queryKey: ['projects', workspace.id, offset],
    queryFn: () => api<Page<Project>>(`${base}?offset=${offset}`),
  });
  const create = useMutation({
    mutationFn: (name: string) =>
      api<Project>(base, { method: 'POST', body: { name } }),
    onSuccess: async (project) => {
      await queryClient.invalidateQueries({
        queryKey: ['projects', workspace.id],
      });
      await navigate(`/projects/${project.id}`);
    },
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    create.mutate(String(new FormData(event.currentTarget).get('name') ?? ''));
  }
  return (
    <section className="content-section" aria-labelledby="projects-heading">
      <div className="section-head">
        <h2 id="projects-heading">Projects</h2>
        {!workspace.archived && (
          <Dialog
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
              {create.error && <Failure error={create.error} />}
              <Button type="submit" busy={create.isPending}>
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
