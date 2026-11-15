import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { Button, Notice } from '@code-along/design-system';
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
  if (identity.error && !identity.data)
    return (
      <div className="page">
        <Failure error={identity.error} />
        <Button
          type="button"
          variant="secondary"
          busy={identity.isFetching}
          onClick={() => {
            void identity.refetch();
          }}
        >
          Retry account check
        </Button>
      </div>
    );
  if (!identity.data)
    return (
      <Navigate
        replace
        to={`/login?next=${encodeURIComponent(safeDestination(location.pathname))}`}
      />
    );
  return children;
}
