import { describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import type { Project } from '../projects/types.ts';
import { editorSourceQuery, loadEditorProject } from './api.ts';
import type { FileMetadata } from './model/document.ts';

const project = {
  id: 'project',
  metadata_version: 1,
  acl_version: '1',
  role: 'owner',
  archived: false,
  workspace_archived: false,
} as Project;
const files = { count: 1, items: [] };
describe('account-scoped source query cancellation', () => {
  it('aborts the actual baseline GET when the last editor leaves, without touching another project read', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const file = {
      id: '33333333-3333-4333-8333-333333333333',
      document_id: '44444444-4444-4444-8444-444444444444',
      generation: 1,
      initial_sha256: 'a'.repeat(64),
    } as FileMetadata;
    const projectId = '22222222-2222-4222-8222-222222222222';
    let observed: AbortSignal | null | undefined;
    let rejectPending: ((reason: unknown) => void) | undefined;
    vi.stubGlobal('window', {
      location: { origin: 'https://code-along.test' },
    });
    const fetch = vi.fn((_path: RequestInfo | URL, options?: RequestInit) => {
      observed = options?.signal;
      return new Promise<Response>((_resolve, reject) => {
        rejectPending = reject;
        observed?.addEventListener('abort', () =>
          reject(new DOMException('Source read cancelled', 'AbortError')),
        );
      });
    });
    vi.stubGlobal('fetch', fetch);
    const otherProject = ['project', 'unrelated-project', 'account'];
    client.setQueryData(otherProject, project);
    const observer = new QueryObserver(
      client,
      editorSourceQuery('account', projectId, file),
    );
    const leave = observer.subscribe(() => {});
    try {
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
      expect(observed?.aborted).toBe(false);
      leave();
      expect(observed?.aborted).toBe(true);
      expect(fetch.mock.calls[0]?.[0]).toBe(
        `/api/v1/projects/${projectId}/files/${file.id}/`,
      );
      expect(client.getQueryData(otherProject)).toEqual(project);
      expect(observer.getCurrentResult().data).toBeUndefined();
    } finally {
      leave();
      client.clear();
      rejectPending?.(new DOMException('Owned test settled', 'AbortError'));
      vi.unstubAllGlobals();
    }
  });
});
describe('coherent project metadata loading', () => {
  it.each([1, 2, 3])(
    'aborts the actual fetch while metadata read %i is pending without issuing a later read',
    async (stage) => {
      const cancellation = new AbortController();
      let observed: AbortSignal | null | undefined;
      let rejectPending: ((error: unknown) => void) | undefined;
      let requests = 0;
      vi.stubGlobal('window', {
        location: { origin: 'https://code-along.test' },
      });
      vi.stubGlobal(
        'fetch',
        vi.fn((_input: RequestInfo | URL, options?: RequestInit) => {
          requests++;
          if (requests !== stage)
            return Promise.resolve(
              new Response(JSON.stringify(requests === 2 ? files : project), {
                headers: { 'Content-Type': 'application/json' },
              }),
            );
          observed = options?.signal;
          return new Promise<Response>((_resolve, reject) => {
            rejectPending = reject;
            observed?.addEventListener(
              'abort',
              () =>
                reject(
                  new DOMException('Cancelled metadata read', 'AbortError'),
                ),
              { once: true },
            );
          });
        }),
      );
      // Handle rejection before aborting, including when the regression fails.
      const result = loadEditorProject(
        'project',
        undefined,
        cancellation.signal,
      ).then(
        () => ({ status: 'resolved' as const }),
        (error: unknown) => ({ status: 'rejected' as const, error }),
      );
      try {
        await vi.waitFor(() => expect(observed).toBeDefined());
        cancellation.abort();
        await vi.waitFor(() => expect(observed?.aborted).toBe(true));
        await expect(result).resolves.toMatchObject({
          status: 'rejected',
          error: { name: 'AbortError' },
        });
        expect(requests).toBe(stage);
      } finally {
        cancellation.abort();
        rejectPending?.(
          new DOMException('Settled owned test request', 'AbortError'),
        );
        await result;
        vi.unstubAllGlobals();
      }
    },
  );
  it('retries a file-list read across metadata or permission changes', async () => {
    const newer = {
      ...project,
      metadata_version: 2,
      role: 'viewer' as const,
      acl_version: '2',
    };
    const read = {
      project: vi.fn().mockResolvedValue(newer).mockResolvedValueOnce(project),
      files: vi.fn().mockResolvedValue(files),
    };
    expect(await loadEditorProject('project', read)).toEqual({
      project: newer,
      files,
    });
    expect(read.files).toHaveBeenCalledTimes(2);
  });
  it('stops after bounded retries instead of admitting a mixed file list', async () => {
    let revision = 0;
    const read = {
      project: vi.fn(async () => ({
        ...project,
        metadata_version: ++revision,
      })),
      files: vi.fn(async () => files),
    };
    await expect(loadEditorProject('project', read)).rejects.toThrow(
      'changed while loading',
    );
    expect(read.files).toHaveBeenCalledTimes(3);
  });
  it('does not issue the next request after its account-scoped read is cancelled', async () => {
    const abort = new AbortController();
    const read = {
      project: vi.fn(async () => {
        abort.abort();
        return project;
      }),
      files: vi.fn(async () => files),
    };
    await expect(
      loadEditorProject('project', read, abort.signal),
    ).rejects.toThrow();
    expect(read.files).not.toHaveBeenCalled();
  });
});
