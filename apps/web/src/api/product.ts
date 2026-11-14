import { createProductClient } from '@code-along/api-client';
import { ApiError, secureFetch } from './client.ts';
function client() {
  return createProductClient(window.location.origin, async (request) => {
    const url = new URL(request.url);
    if (url.origin !== window.location.origin)
      throw new Error('Only local API paths are allowed.');
    return secureFetch(url.pathname + url.search, {
      method: request.method,
      headers: request.headers,
      signal: request.signal,
      ...(!['GET', 'HEAD'].includes(request.method)
        ? { body: await request.text() }
        : {}),
    });
  });
}
async function result<T>(
  promise: Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<T> {
  let value: Awaited<typeof promise>;
  try {
    value = await promise;
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new Error(
        'The server returned an unreadable response. Please try again.',
        { cause: error },
      );
    throw error;
  }
  if (!value.response.ok)
    throw new ApiError(value.response.status, value.error);
  return value.data as T;
}
export const productApi = {
  runtimeProfiles: () => result(client().GET('/api/v1/runtime-profiles/')),
  me: (signal?: AbortSignal) =>
    result(client().GET('/api/v1/me/', signal ? { signal } : {})),
  workspaces: (offset = 0) =>
    result(
      client().GET('/api/v1/workspaces/', {
        params: { query: { offset, limit: 50 } },
      }),
    ),
  createWorkspace: (name: string) =>
    result(client().POST('/api/v1/workspaces/', { body: { name } })),
  workspace: (workspace_id: string) =>
    result(
      client().GET('/api/v1/workspaces/{workspace_id}/', {
        params: { path: { workspace_id } },
      }),
    ),
  members: (workspace_id: string, offset = 0) =>
    result(
      client().GET('/api/v1/workspaces/{workspace_id}/members/', {
        params: { path: { workspace_id }, query: { offset, limit: 100 } },
      }),
    ),
  projects: (workspace_id: string, offset = 0) =>
    result(
      client().GET('/api/v1/workspaces/{workspace_id}/projects/', {
        params: { path: { workspace_id }, query: { offset, limit: 50 } },
      }),
    ),
  createProject: (
    workspace_id: string,
    name: string,
    runtime_profile_id?: string,
  ) =>
    result(
      client().POST('/api/v1/workspaces/{workspace_id}/projects/', {
        params: { path: { workspace_id } },
        body: {
          name,
          ...(runtime_profile_id === undefined ? {} : { runtime_profile_id }),
        },
      }),
    ),
  project: (project_id: string) =>
    result(
      client().GET('/api/v1/projects/{project_id}/', {
        params: { path: { project_id } },
      }),
    ),
  files: (project_id: string) =>
    result(
      client().GET('/api/v1/projects/{project_id}/files/', {
        params: { path: { project_id } },
      }),
    ),
  file: (project_id: string, file_id: string) =>
    result(
      client().GET('/api/v1/projects/{project_id}/files/{file_id}/', {
        params: { path: { project_id, file_id } },
      }),
    ),
};
