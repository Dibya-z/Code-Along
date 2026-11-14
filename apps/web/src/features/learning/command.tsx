import { useEffect, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Button, Notice } from '@code-along/design-system';
import { productApi } from '../../api/product.ts';
import { queryClient } from '../../app/providers.tsx';
import type { Identity } from '../auth/session.ts';
import { Failure } from '../../api/feedback.tsx';
import { participationConflict } from './work-model.ts';

/** A command remains one explicit attempt. No offline or reconnect mutation replay. */
export function useLearningCommand<Request, Result>(
  accountId: string,
  scopeId: string,
  execute: (request: Request) => Promise<Result>,
  refresh: () => Promise<unknown>,
) {
  const [pending, setPending] = useState<Request | null>(null),
    [refreshError, setRefreshError] = useState<unknown>(null),
    [refreshing, setRefreshing] = useState(false);
  const live = useRef(true);
  const inFlight = useRef(false);
  const retained = useRef<Request | null>(null);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const current = () =>
    live.current &&
    queryClient.getQueryData<Identity | null>(['me'])?.id === accountId;
  const mutation = useMutation({
    mutationKey: ['learning-command', accountId, scopeId],
    mutationFn: async (request: Request) => {
      if (!current())
        throw new Error(
          'This account session changed. Reopen the assignment before another action.',
        );
      const identity = await productApi.me();
      if (identity.id !== accountId || !current())
        throw new Error(
          'This account session changed. Reopen the assignment before another action.',
        );
      const result = await execute(request);
      if (!current())
        throw new Error(
          'This account session changed. Reopen the assignment to check the result.',
        );
      return result;
    },
    onSuccess: () => {
      if (!current()) {
        inFlight.current = false;
        return;
      }
      retained.current = null;
      setPending(null);
      setRefreshing(true);
      setRefreshError(null);
      // The server receipt stays confirmed even if this later snapshot read fails.
      void Promise.resolve()
        .then(refresh)
        .then(() => {
          if (current()) setRefreshing(false);
        })
        .catch((error: unknown) => {
          if (current()) {
            setRefreshError(error);
            setRefreshing(false);
          }
        })
        .finally(() => {
          inFlight.current = false;
        });
    },
    onError: () => {
      inFlight.current = false;
    },
  });
  const run = (request: Request) => {
    if (
      inFlight.current ||
      mutation.isPending ||
      refreshing ||
      !current() ||
      (retained.current !== null && retained.current !== request)
    )
      return;
    inFlight.current = true;
    retained.current = request;
    setPending(request);
    setRefreshError(null);
    mutation.mutate(request);
  };
  return {
    pending,
    mutation,
    refreshError,
    busy: mutation.isPending || refreshing,
    run,
    retry: () => {
      if (pending !== null) run(pending);
    },
    review: () => {
      if (mutation.isPending) return;
      setPending(null);
      retained.current = null;
      setRefreshError(null);
      mutation.reset();
    },
  };
}
export function CommandFeedback({
  error,
  refreshError,
  pending,
  busy,
  confirmed,
  onRetry,
  onReview,
}: {
  error: unknown;
  refreshError: unknown;
  pending: boolean;
  busy: boolean;
  confirmed?: string;
  onRetry: () => void;
  onReview: () => void;
}) {
  return (
    <>
      {error && (
        <>
          {participationConflict(error) ? (
            <Notice tone="error">{participationConflict(error)}</Notice>
          ) : (
            <Failure error={error} />
          )}
          <p>
            Review current records after a conflict. Retrying sends the same
            choices; it does not accept a changed roster or version.
          </p>
        </>
      )}
      {refreshError && (
        <>
          <Notice tone="error">
            The action is confirmed, but current records could not be refreshed.
            Recheck before another change.
          </Notice>
          <Failure error={refreshError} />
        </>
      )}
      {confirmed && !error && <Notice tone="success">{confirmed}</Notice>}
      {pending && !busy && (
        <div className="actions">
          <Button type="button" variant="secondary" onClick={onRetry}>
            Retry same action
          </Button>
          <Button type="button" variant="secondary" onClick={onReview}>
            Review current records
          </Button>
        </div>
      )}
    </>
  );
}
