export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(
      status === 403
        ? 'You do not have permission to do that.'
        : status === 404
          ? 'This resource is unavailable.'
          : status === 429
            ? 'Too many attempts. Please try again later.'
            : 'The request could not be completed.',
    );
  }
}
let csrf: string | undefined;
export function clearCsrf(): void {
  csrf = undefined;
}
export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  if (!path.startsWith('/api/') || path.includes('://') || path.includes('\\'))
    throw new Error('Only local API paths are allowed.');
  const method = options.method ?? 'GET';
  if (!['GET', 'HEAD'].includes(method) && !csrf) {
    const response = await fetch('/api/v1/csrf/', {
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (!response.ok) throw new ApiError(response.status, null);
    const value: unknown = await response.json();
    if (
      typeof value !== 'object' ||
      !value ||
      !('csrfToken' in value) ||
      typeof value.csrfToken !== 'string'
    )
      throw new Error('Invalid security response.');
    csrf = value.csrfToken;
  }
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (csrf && !['GET', 'HEAD'].includes(method)) headers['X-CSRFToken'] = csrf;
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
      ...(options.body !== undefined
        ? { body: JSON.stringify(options.body) }
        : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError')
      throw error;
    throw new Error('Could not connect. Check your connection and try again.', {
      cause: error,
    });
  }
  const body: unknown =
    response.status === 204
      ? undefined
      : await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 403) clearCsrf();
    throw new ApiError(response.status, body);
  }
  return body as T;
}
