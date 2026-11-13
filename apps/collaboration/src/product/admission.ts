import { performance } from 'node:perf_hooks';
import { stateHash, validateSource } from '../persistence/binary-state.ts';

export const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const DIGEST = /^[0-9a-f]{64}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
export function isToken(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    TOKEN.test(value) &&
    Buffer.from(value, 'base64url').toString('base64url') === value
  );
}
const REVISION = /^(0|[1-9][0-9]{0,18})$/;
export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function exact(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
export function uuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}
export function safeInteger(value: unknown, minimum = 0): value is number {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
  );
}
export function roomScope(name: string): {
  document_id: string;
  generation: number;
} {
  const parts = name.split(':');
  if (
    parts.length !== 2 ||
    !uuid(parts[0]) ||
    !/^[1-9][0-9]*$/.test(parts[1] ?? '') ||
    !safeInteger(Number(parts[1]), 1)
  )
    throw new AdmissionError('unauthorized');
  return { document_id: parts[0], generation: Number(parts[1]) };
}
export class AdmissionError extends Error {
  readonly code:
    | 'unauthorized'
    | 'generation_mismatch'
    | 'lease_expired'
    | 'resource_limit'
    | 'unavailable';
  constructor(
    code:
      | 'unauthorized'
      | 'generation_mismatch'
      | 'lease_expired'
      | 'resource_limit'
      | 'unavailable',
  ) {
    super(code);
    this.name = 'AdmissionError';
    this.code = code;
  }
}
export interface Grant {
  version: 1;
  lease_id: string;
  lease_token: string;
  ttl_ms: number;
  scope: 'read' | 'write';
  client_session_id: string;
  awareness_client_id: number;
  workspace_id: string;
  project_id: string;
  workspace_acl_version: string;
  project_acl_version: string;
  user: { id: string; display_name: string; color: string };
  document: {
    id: string;
    file_id: string;
    generation: number;
    schema_version: 1;
    initial_source: string;
    initial_sha256: string;
  };
}
export interface Lease {
  grant: Grant;
  readonly connection_id: string;
  readonly transport_id: string;
  readonly document_name: string;
  deadline: number;
  renewAt: number;
  active: boolean;
}
export interface AdmissionClient {
  consume(input: {
    ticket: string;
    document_name: string;
    connection_id: string;
    transport_id: string;
    origin: string;
    cookie: string;
  }): Promise<{ grant: Grant; started: number }>;
  renew(lease: Lease): Promise<{ grant: Grant; started: number }>;
}
const PALETTE = [
  '#2563eb',
  '#7c3aed',
  '#db2777',
  '#dc2626',
  '#ea580c',
  '#059669',
  '#0891b2',
  '#4f46e5',
];
export function parseGrant(value: unknown, name: string): Grant {
  if (
    !record(value) ||
    !exact(value, [
      'version',
      'lease_id',
      'lease_token',
      'ttl_ms',
      'scope',
      'client_session_id',
      'awareness_client_id',
      'workspace_id',
      'project_id',
      'workspace_acl_version',
      'project_acl_version',
      'user',
      'document',
    ])
  )
    throw new AdmissionError('unavailable');
  const user = value['user'],
    doc = value['document'];
  const scope = roomScope(name);
  if (
    value['version'] !== 1 ||
    !uuid(value['lease_id']) ||
    !isToken(value['lease_token']) ||
    !safeInteger(value['ttl_ms'], 1) ||
    value['ttl_ms'] > 30_000 ||
    !['read', 'write'].includes(String(value['scope'])) ||
    !uuid(value['client_session_id']) ||
    !safeInteger(value['awareness_client_id']) ||
    value['awareness_client_id'] > 0xffff_ffff ||
    !uuid(value['workspace_id']) ||
    !uuid(value['project_id']) ||
    !['workspace_acl_version', 'project_acl_version'].every(
      (key) =>
        typeof value[key] === 'string' &&
        REVISION.test(value[key]) &&
        BigInt(value[key]) <= 9223372036854775807n,
    ) ||
    !record(user) ||
    !exact(user, ['id', 'display_name', 'color']) ||
    !uuid(user['id']) ||
    typeof user['display_name'] !== 'string' ||
    user['display_name'].length < 1 ||
    [...user['display_name']].length > 80 ||
    /[\p{Cc}\p{Cf}\p{Cs}]/u.test(user['display_name']) ||
    user['display_name'].trim().replace(/\s+/gu, ' ') !==
      user['display_name'] ||
    typeof user['color'] !== 'string' ||
    !PALETTE.includes(user['color']) ||
    !record(doc) ||
    !exact(doc, [
      'id',
      'file_id',
      'generation',
      'schema_version',
      'initial_source',
      'initial_sha256',
    ]) ||
    doc['id'] !== scope.document_id ||
    doc['generation'] !== scope.generation ||
    !uuid(doc['file_id']) ||
    doc['schema_version'] !== 1 ||
    typeof doc['initial_source'] !== 'string' ||
    typeof doc['initial_sha256'] !== 'string' ||
    !DIGEST.test(doc['initial_sha256'])
  )
    throw new AdmissionError('unavailable');
  validateSource(doc['initial_source']);
  if (
    stateHash(Buffer.from(doc['initial_source'], 'utf8')) !==
    doc['initial_sha256']
  )
    throw new AdmissionError('unavailable');
  return value as unknown as Grant;
}
export function sessionCookie(header: string | null, name: string): string {
  if (
    !/^[A-Za-z0-9_-]{1,80}$/.test(name) ||
    !header ||
    header.length > 8192 ||
    /[\r\n]/.test(header)
  )
    throw new AdmissionError('unauthorized');
  const matches = header
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.split('=', 1)[0] === name);
  if (matches.length !== 1) throw new AdmissionError('unauthorized');
  const value = matches[0]!.slice(name.length + 1);
  if (!/^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]{1,4096}$/.test(value))
    throw new AdmissionError('unauthorized');
  return `${name}=${value}`;
}
export function privateBase(value: string): URL {
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('invalid_collaboration_configuration');
  return url;
}
export async function boundedJson(
  response: Response,
  maximum: number,
): Promise<unknown> {
  if (!response.body) throw new AdmissionError('unavailable');
  const reader = response.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) throw new AdmissionError('unavailable');
      chunks.push(value);
    }
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
    );
  } catch {
    throw new AdmissionError('unavailable');
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
export function createAdmissionClient(options: {
  base: string;
  secret: string;
  fetch?: typeof fetch;
}): AdmissionClient {
  const base = privateBase(options.base);
  if (!/^[\x21-\x7e]{32,256}$/.test(options.secret))
    throw new Error('invalid_collaboration_configuration');
  const request = async (
    path: 'consume' | 'renew',
    body: object,
    name: string,
    cookie?: string,
  ) => {
    const started = performance.now();
    try {
      const response = await (options.fetch ?? fetch)(
        new URL(`/internal/v1/collaboration/${path}/`, base),
        {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(2500),
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${options.secret}`,
            ...(cookie ? { Cookie: cookie } : {}),
          },
          body: JSON.stringify(body),
        },
      );
      if (response.status !== 200) {
        const value = await boundedJson(response, 1024);
        if (
          record(value) &&
          exact(value, ['version', 'error']) &&
          value['version'] === 1 &&
          [
            'unauthorized',
            'generation_mismatch',
            'lease_expired',
            'resource_limit',
            'unavailable',
          ].includes(String(value['error']))
        ) {
          const code = value['error'] as AdmissionError['code'];
          const status = {
            unauthorized: 403,
            lease_expired: 403,
            generation_mismatch: 409,
            resource_limit: 429,
            unavailable: 503,
          }[code];
          if (response.status !== status)
            throw new AdmissionError('unavailable');
          throw new AdmissionError(code);
        }
        throw new AdmissionError('unavailable');
      }
      return {
        grant: parseGrant(await boundedJson(response, 800_000), name),
        started,
      };
    } catch (error) {
      if (error instanceof AdmissionError) throw error;
      throw new AdmissionError('unavailable');
    }
  };
  return {
    consume: ({ cookie, ...input }) =>
      request('consume', { version: 1, ...input }, input.document_name, cookie),
    renew: (lease) =>
      request(
        'renew',
        {
          version: 1,
          lease_id: lease.grant.lease_id,
          lease_token: lease.grant.lease_token,
          connection_id: lease.connection_id,
          document_name: lease.document_name,
        },
        lease.document_name,
      ),
  };
}
