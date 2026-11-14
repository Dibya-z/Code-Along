import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/client.ts';
import { refreshVisibleQuery } from './registry.ts';

interface Roster {
  version: number;
}
type Outcome<T> =
  | { status: 'pending' }
  | { status: 'fulfilled'; value: T }
  | { status: 'rejected'; reason: unknown };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function track<T>(promise: Promise<T>) {
  let outcome: Outcome<T> = { status: 'pending' };
  const settled = promise.then(
    (value) => {
      outcome = { status: 'fulfilled', value };
    },
    (reason: unknown) => {
      outcome = { status: 'rejected', reason };
    },
  );
  return { settled, outcome: () => outcome };
}
async function flush() {
  for (let count = 0; count < 24; count++) await Promise.resolve();
}
function fixture() {
  const key = ['assignment-team', 'account', 'assignment', 'team', 'version'];
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  client.setQueryData<Roster>(key, { version: 1 });
  const manual = deferred<Roster>(),
    replacement = deferred<Roster>();
  let requests = 0;
  const signals: AbortSignal[] = [];
  const observer = new QueryObserver(client, {
    queryKey: key,
    staleTime: Infinity,
    queryFn: ({ signal }) => {
      signals.push(signal);
      requests++;
      if (requests === 1) return manual.promise;
      if (requests === 2) return replacement.promise;
      throw new Error('Unexpected additional roster request.');
    },
  });
  const stop = observer.subscribe(() => {});
  return {
    key,
    client,
    observer,
    manual,
    replacement,
    signals,
    requests: () => requests,
    close() {
      manual.resolve({ version: 2 });
      replacement.resolve({ version: 3 });
      stop();
      client.clear();
    },
  };
}

describe('manual roster refresh and head-anchored replacement', () => {
  it('keeps a manual refresh pending until the genuinely fresh replacement completes', async () => {
    const f = fixture();
    const manual = track(
      f.observer.refetch({ throwOnError: true }).then((result) => result.data),
    );
    const anchored = track(
      refreshVisibleQuery(
        f.client,
        f.key,
        f.observer,
        new AbortController().signal,
      ),
    );
    try {
      await flush();
      expect(f.requests()).toBe(2);
      expect(f.signals[0]?.aborted).toBe(true);
      expect(manual.outcome()).toEqual({ status: 'pending' });
      f.replacement.resolve({ version: 3 });
      await Promise.all([manual.settled, anchored.settled]);
      expect(manual.outcome()).toEqual({
        status: 'fulfilled',
        value: { version: 3 },
      });
      expect(anchored.outcome()).toEqual({
        status: 'fulfilled',
        value: undefined,
      });
      expect(f.observer.getCurrentResult().data).toEqual({ version: 3 });
    } finally {
      f.close();
      await Promise.allSettled([manual.settled, anchored.settled]);
    }
  });

  it('propagates replacement429 to the manual waiter instead of confirming cached roster data', async () => {
    const f = fixture();
    const manual = track(
      f.observer.refetch({ throwOnError: true }).then((result) => result.data),
    );
    const anchored = track(
      refreshVisibleQuery(
        f.client,
        f.key,
        f.observer,
        new AbortController().signal,
      ),
    );
    try {
      await flush();
      expect(f.requests()).toBe(2);
      const quota = new ApiError(429, { detail: 'Read quota reached.' }, 17);
      f.replacement.reject(quota);
      await Promise.all([manual.settled, anchored.settled]);
      expect(anchored.outcome()).toEqual({ status: 'rejected', reason: quota });
      expect(manual.outcome()).toEqual({ status: 'rejected', reason: quota });
      expect(f.observer.getCurrentResult().data).toEqual({ version: 1 });
      expect(f.observer.getCurrentResult().error).toBe(quota);
    } finally {
      f.close();
      await Promise.allSettled([manual.settled, anchored.settled]);
    }
  });
});
