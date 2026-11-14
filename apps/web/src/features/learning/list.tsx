import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Button, Dialog, Field, Notice } from '@code-along/design-system';
import { Failure } from '../../api/feedback.tsx';
import { Pagination } from '../../components/pagination.tsx';
import { useIdentity } from '../auth/session.ts';
import type { Workspace } from '../workspaces/types.ts';
import { capacityMessage, learningApi } from './api.ts';
import { safeLabel } from './validation.ts';
import './styles.css';

export function WorkspaceAssignments({
  workspace,
  active,
}: {
  workspace: Workspace;
  active: boolean;
}) {
  const account = useIdentity().data?.id;
  const [offset, setOffset] = useState(0),
    [archived, setArchived] = useState(false);
  const [error, setError] = useState('');
  const navigate = useNavigate();
  const query = useQuery({
    queryKey: ['assignments', account, workspace.id, offset, archived],
    queryFn: ({ signal }) =>
      learningApi.list(workspace.id, offset, archived, signal),
    enabled: active && Boolean(account),
  });
  const create = useMutation({
    mutationFn: (title: string) => learningApi.create(workspace.id, title),
    onSuccess: (assignment) => {
      void navigate(`/assignments/${assignment.id}#draft`);
    },
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const title = String(new FormData(event.currentTarget).get('title') ?? '');
    if (!safeLabel(title, 120)) {
      setError(
        'Use a nonblank title within 120 characters, without control characters.',
      );
      return;
    }
    setError('');
    create.mutate(title);
  }
  const teacher = workspace.role === 'owner' || workspace.role === 'instructor';
  return (
    <section className="content-section" aria-labelledby="assignments-heading">
      <div className="section-head">
        <div>
          <h2 id="assignments-heading">Assignments</h2>
          <p className="muted">
            Read published instructions and frozen starters from your workspace.
          </p>
        </div>
        {teacher && !workspace.archived && (
          <Dialog
            title="Create an assignment"
            description="Start an unpublished draft that workspace teachers can edit. Publish when you are ready to share its frozen content with workspace members."
            trigger={<Button>Create assignment</Button>}
          >
            <form className="form-stack" onSubmit={submit}>
              <Field label="Assignment title" name="title" required />
              {error && <Notice tone="error">{error}</Notice>}
              {create.error &&
                (capacityMessage(create.error) ? (
                  <Notice tone="error">{capacityMessage(create.error)}</Notice>
                ) : (
                  <Failure error={create.error} />
                ))}
              <Button type="submit" busy={create.isPending}>
                Create assignment
              </Button>
            </form>
          </Dialog>
        )}
      </div>
      <label className="checkbox-field">
        <input
          type="checkbox"
          checked={archived}
          onChange={(event) => {
            setArchived(event.target.checked);
            setOffset(0);
          }}
        />{' '}
        Include archived assignments
      </label>
      {query.isFetching && <Notice>Loading assignments…</Notice>}
      {query.error && <Failure error={query.error} />}
      <div className="list">
        {query.data?.items.map((assignment) => (
          <div className="list-row" key={assignment.id}>
            <div>
              <h3>
                <Link to={`/assignments/${assignment.id}`}>
                  {assignment.title}
                </Link>
              </h3>
              <p>
                {assignment.archived ? 'Archived · ' : ''}
                {assignment.current_version
                  ? `Published version ${assignment.current_version.number}`
                  : 'Unpublished draft'}
              </p>
            </div>
            <Link
              className="button secondary"
              to={`/assignments/${assignment.id}${assignment.current_version ? '' : '#draft'}`}
            >
              {assignment.current_version ? 'Read assignment' : 'Edit draft'}
            </Link>
          </div>
        ))}
      </div>
      {query.data?.count === 0 && (
        <p>No {archived ? '' : 'current '}assignments to show.</p>
      )}
      <Pagination
        offset={offset}
        count={query.data?.count ?? 0}
        limit={20}
        onChange={setOffset}
      />
    </section>
  );
}
