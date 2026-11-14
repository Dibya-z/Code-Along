import type { QueryClient, QueryKey } from '@tanstack/react-query';
export type VisibleRead = (signal: AbortSignal) => Promise<unknown>;
export interface QueryRead {
  refetch: (options: {
    throwOnError: boolean;
    cancelRefetch: boolean;
  }) => Promise<{ error?: unknown }>;
}
export async function refreshVisibleQuery(
  client: Pick<QueryClient, 'cancelQueries'>,
  key: QueryKey,
  query: QueryRead,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const cancel = () => {
    void client.cancelQueries({ queryKey: key, exact: true }, { silent: true });
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const cancelled = client.cancelQueries(
      { queryKey: key, exact: true },
      { silent: true },
    );
    signal.throwIfAborted();
    // Replace before yielding: existing manual waiters must follow this fresh
    // request, rather than resolve the cached snapshot from cancellation.
    const replacement = query.refetch({
      throwOnError: true,
      cancelRefetch: true,
    });
    const [, result] = await Promise.all([cancelled, replacement]);
    signal.throwIfAborted();
    if (result.error) throw result.error;
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}
/** Explicit registrations prevent hidden panels and source queries from joining a learning refresh. */
export class VisibleLearningViews {
  private readonly reads = new Map<
    string,
    Set<{ read: VisibleRead; expiry: string | null }>
  >();
  private expiry: ReturnType<typeof setTimeout> | null = null;
  constructor(
    private readonly changed: () => void,
    private readonly timeChanged: () => void,
  ) {}
  register(
    id: string,
    read: VisibleRead,
    expiry: string | null = null,
  ): () => void {
    if (!this.reads.has(id) && this.reads.size >= 16)
      throw new Error('Too many visible learning views.');
    const entry = { read, expiry };
    const entries = this.reads.get(id) ?? new Set();
    entries.add(entry);
    this.reads.set(id, entries);
    this.scheduleExpiry();
    this.changed();
    return () => {
      if (!entries.delete(entry)) return;
      if (entries.size === 0) this.reads.delete(id);
      this.scheduleExpiry();
      this.changed();
    };
  }
  async refresh(signal: AbortSignal) {
    signal.throwIfAborted();
    await Promise.all(
      [...this.reads.values()].map((entries) =>
        [...entries].at(-1)!.read(signal),
      ),
    );
    signal.throwIfAborted();
  }
  private scheduleExpiry() {
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = null;
    const now = Date.now();
    const future = [...this.reads.values()]
      .flatMap((entries) => [...entries])
      .map(({ expiry }) => (expiry === null ? NaN : Date.parse(expiry)))
      .filter((time) => Number.isFinite(time) && time > now);
    if (future.length)
      this.expiry = setTimeout(
        () => {
          this.expiry = null;
          this.timeChanged();
        },
        Math.min(2147483647, Math.min(...future) - now + 50),
      );
  }
  destroy() {
    if (this.expiry) clearTimeout(this.expiry);
    this.reads.clear();
  }
}
