import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { Button } from '@code-along/design-system';
import type { QueryKey } from '@tanstack/react-query';
import { queryClient } from '../../app/providers.tsx';
import type { Identity } from '../auth/session.ts';
import { learningObserverIO } from './api.ts';
import { LearningObserver, type LearningScope } from './observer.ts';
import {
  VisibleLearningViews,
  refreshVisibleQuery,
  type QueryRead,
  type VisibleRead,
} from './registry.ts';

interface LearningContextValue {
  observer: LearningObserver;
  registry: VisibleLearningViews;
  recheck: () => void;
  current: () => boolean;
}
const LearningContext = createContext<LearningContextValue | null>(null);

export function LearningUpdatesProvider({
  scope,
  streaming = true,
  children,
}: {
  scope: LearningScope;
  streaming?: boolean;
  children: ReactNode;
}) {
  const { accountId, assignmentId, audience } = scope;
  const resource = useMemo(() => {
    const current = () =>
      resource.mounted &&
      queryClient.getQueryData<Identity | null>(['me'])?.id === accountId;
    const registry = new VisibleLearningViews(
      () => observer.viewsChanged(),
      () => observer.focus(),
    );
    const observer = new LearningObserver(
      { accountId, assignmentId, audience },
      current,
      learningObserverIO(
        { accountId, assignmentId, audience },
        current,
        (signal) => registry.refresh(signal),
      ),
    );
    const recheck = () => {
      if (current()) observer.refresh();
    };
    return {
      observer,
      registry,
      recheck,
      current,
      mounted: false,
      leases: 0,
    };
  }, [accountId, assignmentId, audience]);
  useEffect(() => {
    resource.mounted = true;
    resource.leases++;
    resource.observer.start(streaming);
    const focus = () => {
      if (document.visibilityState === 'visible') resource.observer.focus();
    };
    window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', focus);
    window.addEventListener('offline', resource.observer.offline);
    window.addEventListener('online', resource.observer.online);
    return () => {
      resource.mounted = false;
      resource.leases--;
      window.removeEventListener('focus', focus);
      document.removeEventListener('visibilitychange', focus);
      window.removeEventListener('offline', resource.observer.offline);
      window.removeEventListener('online', resource.observer.online);
      queueMicrotask(() => {
        if (resource.leases === 0) {
          resource.observer.destroy();
          resource.registry.destroy();
        }
      });
    };
  }, [resource, streaming]);
  useEffect(() => {
    resource.observer.configure(streaming);
  }, [resource, streaming]);
  return (
    <LearningContext.Provider value={resource}>
      {children}
    </LearningContext.Provider>
  );
}

export function useLearningRead(
  id: string,
  active: boolean,
  read: VisibleRead,
  expiry: string | null = null,
) {
  const context = useContext(LearningContext);
  const latest = useRef(read);
  latest.current = read;
  useEffect(() => {
    if (!context || !active) return;
    return context.registry.register(
      id,
      async (signal) => {
        if (!context.current()) throw new Error('Learning account changed.');
        signal.throwIfAborted();
        await latest.current(signal);
        signal.throwIfAborted();
        if (!context.current()) throw new Error('Learning account changed.');
      },
      expiry,
    );
  }, [context, id, active, expiry]);
}

export function useLearningQuery(
  key: QueryKey,
  query: QueryRead,
  active: boolean,
  expiry: string | null = null,
) {
  const id = JSON.stringify(key);
  useLearningRead(
    id,
    active,
    async (signal) => {
      // Initial mount reads may predate the BEFORE head. Finish cancelling them,
      // then require a fresh request, rather than borrowing that older promise.
      await refreshVisibleQuery(queryClient, key, query, signal);
    },
    expiry,
  );
}
export function LearningQueryRead({
  queryKey,
  query,
  active = true,
  expiry = null,
}: {
  queryKey: QueryKey;
  query: QueryRead;
  active?: boolean;
  expiry?: string | null;
}) {
  useLearningQuery(queryKey, query, active, expiry);
  return null;
}

export function LearningUpdateStatus() {
  const context = useContext(LearningContext);
  return context ? <Status context={context} /> : null;
}
function Status({ context }: { context: LearningContextValue }) {
  const value = useSyncExternalStore(
    context.observer.subscribe,
    context.observer.getSnapshot,
  );
  const paused = ['stale', 'offline', 'denied'].includes(value.phase);
  return (
    <div className="learning-update-status">
      <p className="muted" role="status">
        {value.phase === 'current'
          ? 'Learning records checked.'
          : value.phase === 'offline'
            ? 'Offline. Learning records may be out of date.'
            : value.phase === 'denied'
              ? 'Learning access needs to be checked again.'
              : value.phase === 'stale'
                ? 'Learning records may be out of date. Refresh is needed.'
                : 'Checking learning updates…'}
      </p>
      {paused && (
        <Button
          type="button"
          variant="secondary"
          disabled={
            value.phase === 'offline' ||
            (value.retryAt !== null && value.retryAt > Date.now())
          }
          onClick={context.recheck}
        >
          Recheck learning updates
        </Button>
      )}
    </div>
  );
}
