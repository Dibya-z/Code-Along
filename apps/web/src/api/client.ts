export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    public readonly retryAfterSeconds?: number,
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
/** Keep bounded timing only; never retain or display a raw response header. */
export function parseRetryAfter(
  value: string | null,
  now = Date.now(),
): number | undefined {
  if (value === null) return undefined;
  let seconds: number;
  if (/^[0-9]{1,5}$/.test(value)) seconds = Number(value);
  else if (
    /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(
      value,
    )
  )
    seconds = Math.ceil((Date.parse(value) - now) / 1000);
  else return undefined;
  return Number.isFinite(seconds) && seconds >= 0 && seconds <= 86400
    ? Math.max(1, seconds)
    : undefined;
}
let csrf: string | undefined;
let pendingCsrf: Promise<string> | undefined;
export function clearCsrf(): void {
  csrf = undefined;
  pendingCsrf = undefined;
}
async function csrfToken(): Promise<string> {
  if (csrf) return csrf;
  pendingCsrf ??= (async () => {
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
    return value.csrfToken;
  })();
  try {
    return await pendingCsrf;
  } finally {
    pendingCsrf = undefined;
  }
}
export async function secureFetch(
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  if (!path.startsWith('/api/') || path.includes('://') || path.includes('\\'))
    throw new Error('Only local API paths are allowed.');
  const method = (options.method ?? 'GET').toUpperCase();
  const headers = new Headers(options.headers);
  headers.set('Accept', 'application/json');
  if (!['GET', 'HEAD'].includes(method))
    headers.set('X-CSRFToken', await csrfToken());
  let response: Response;
  try {
    response = await fetch(path, {
      ...options,
      method,
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError')
      throw error;
    throw new Error('Could not connect. Check your connection and try again.', {
      cause: error,
    });
  }
  if (response.status === 403) clearCsrf();
  if (
    !response.ok &&
    !response.headers.get('Content-Type')?.includes('application/json')
  )
    return new Response(
      JSON.stringify({ detail: 'The request could not be completed.' }),
      {
        status: response.status,
        headers: {
          'Content-Type': 'application/json',
          ...(response.status === 429 &&
          parseRetryAfter(response.headers.get('Retry-After')) !== undefined
            ? {
                'Retry-After': String(
                  parseRetryAfter(response.headers.get('Retry-After')),
                ),
              }
            : {}),
        },
      },
    );
  return response;
}
export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const response = await secureFetch(path, {
    method: options.method ?? 'GET',
    ...(options.body !== undefined
      ? {
          body: JSON.stringify(options.body),
          headers: { 'Content-Type': 'application/json' },
        }
      : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  let body: unknown;
  if (response.status !== 204) {
    try {
      body = await response.json();
    } catch (error) {
      throw new Error(
        'The server returned an unreadable response. Please try again.',
        { cause: error },
      );
    }
  }
  if (!response.ok)
    throw new ApiError(
      response.status,
      body,
      response.status === 429
        ? parseRetryAfter(response.headers.get('Retry-After'))
        : undefined,
    );
  return body as T;
}
