import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import { Notice } from '@code-along/design-system';
import { Failure } from '../../api/feedback.tsx';
import { useIdentity, safeDestination } from './session.ts';
export function SignedIn({ children }: { children: ReactNode }) {
  const identity = useIdentity();
  const location = useLocation();
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
        <Link
          className="button"
          to={`/login?next=${encodeURIComponent(safeDestination(location.pathname))}`}
        >
          Sign in
        </Link>
        <p className="muted">
          If you create an account, verify your email and reopen the invitation
          link to join.
        </p>
      </div>
    );
  return children;
}
