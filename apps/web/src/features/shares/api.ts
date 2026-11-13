import {
  isRunnerId,
  RUN_LIMITS,
  sha256,
  sourceBytes,
} from '@code-along/contracts/execution';
import { validatePythonPaths } from '@code-along/contracts/execution/project';
import { runtimeProfile } from '@code-along/contracts/execution/profiles';
import { api } from '../../api/client.ts';
import type { components } from '@code-along/api-client';
import type { FileSource } from '../editor/model/workspace.ts';
import {
  validateRevisionManifest,
  type RevisionManifest,
} from '../history/manifest.ts';

export type Share = components['schemas']['ShareOutput'];
export type ShareRequest = components['schemas']['CreateShareBodyRequest'];
export type LiveShare = components['schemas']['LiveShareResolved'];
type PublicSnapshot = components['schemas']['SnapshotShareResolved'];
export type SnapshotShare = Omit<PublicSnapshot, 'revision'> & {
  revision: Omit<PublicSnapshot['revision'], 'manifest'> & {
    manifest: RevisionManifest;
  };
};
export type ResolvedShare = LiveShare | SnapshotShare;
const base = (projectId: string) => `/api/v1/projects/${projectId}/shares/`;
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, fields: readonly string[]) {
  return (
    Object.keys(value).length === fields.length &&
    Object.keys(value).every((key) => fields.includes(key))
  );
}
function invalid(): never {
  throw new Error(
    'This shared source could not be verified. Ask its owner for a current link.',
  );
}
export function shareToken(fragment: string): string {
  const token = fragment.startsWith('#') ? fragment.slice(1) : fragment;
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : '';
}
export function safeShareUrl(value: string, origin: string): string {
  const url = new URL(value, origin);
  if (
    url.origin !== origin ||
    url.pathname !== '/shares' ||
    url.search ||
    url.username ||
    url.password ||
    !shareToken(url.hash)
  )
    throw new Error('The server returned an invalid shared link.');
  return url.href;
}
/** A dedicated resolve response is the sole metadata/baseline authority for capability pages. */
export async function validateResolvedShare(
  value: unknown,
): Promise<ResolvedShare> {
  if (
    !object(value) ||
    !isRunnerId(value['share_id']) ||
    typeof value['expires_at'] !== 'string' ||
    !Number.isFinite(Date.parse(value['expires_at'])) ||
    Date.parse(value['expires_at']) <= Date.now()
  )
    invalid();
  if (value['kind'] === 'snapshot') {
    const revision = value['revision'];
    if (
      !exact(value, ['kind', 'share_id', 'expires_at', 'revision']) ||
      !object(revision) ||
      !exact(revision, ['id', 'name', 'created_at', 'manifest']) ||
      !isRunnerId(revision['id']) ||
      typeof revision['name'] !== 'string' ||
      !revision['name'].trim() ||
      [...revision['name']].length > 120 ||
      typeof revision['created_at'] !== 'string' ||
      !Number.isFinite(Date.parse(revision['created_at']))
    )
      invalid();
    const manifest = await validateRevisionManifest(revision['manifest']);
    return {
      kind: 'snapshot',
      share_id: value['share_id'],
      expires_at: value['expires_at'],
      revision: {
        id: revision['id'],
        name: revision['name'],
        created_at: revision['created_at'],
        manifest,
      },
    };
  }
  const project = value['project'],
    files = value['files'];
  if (
    value['kind'] !== 'live' ||
    !exact(value, [
      'kind',
      'share_id',
      'expires_at',
      'scope',
      'project',
      'files',
    ]) ||
    !['read', 'write'].includes(String(value['scope'])) ||
    !object(project) ||
    !exact(project, [
      'id',
      'name',
      'entrypoint_file_id',
      'metadata_version',
      'runtime_id',
      'archived',
      'workspace_archived',
      'access',
    ]) ||
    !isRunnerId(project['id']) ||
    !isRunnerId(project['entrypoint_file_id']) ||
    typeof project['name'] !== 'string' ||
    !project['name'].trim() ||
    [...project['name']].length > 120 ||
    !Number.isSafeInteger(project['metadata_version']) ||
    Number(project['metadata_version']) < 1 ||
    !runtimeProfile(project['runtime_id']) ||
    typeof project['archived'] !== 'boolean' ||
    typeof project['workspace_archived'] !== 'boolean' ||
    !object(project['access']) ||
    !exact(project['access'], ['kind', 'scope']) ||
    project['access']['kind'] !== 'live_share' ||
    project['access']['scope'] !== value['scope'] ||
    !object(files) ||
    !exact(files, ['items', 'count']) ||
    !Array.isArray(files['items']) ||
    files['items'].length < 1 ||
    files['items'].length > RUN_LIMITS.files ||
    files['count'] !== files['items'].length
  )
    invalid();
  const ids = new Set<string>(),
    documents = new Set<string>();
  const items: FileSource[] = [];
  let total = 0;
  for (const file of files['items']) {
    if (
      !object(file) ||
      !exact(file, [
        'id',
        'document_id',
        'generation',
        'path',
        'kind',
        'initial_source',
        'initial_sha256',
      ]) ||
      !isRunnerId(file['id']) ||
      !isRunnerId(file['document_id']) ||
      !Number.isSafeInteger(file['generation']) ||
      Number(file['generation']) < 1 ||
      typeof file['path'] !== 'string' ||
      file['kind'] !== 'python' ||
      typeof file['initial_source'] !== 'string' ||
      typeof file['initial_sha256'] !== 'string' ||
      !/^[0-9a-f]{64}$/.test(file['initial_sha256']) ||
      ids.has(file['id']) ||
      documents.has(file['document_id'])
    )
      invalid();
    let bytes: Uint8Array;
    try {
      bytes = sourceBytes(file['initial_source']);
    } catch {
      invalid();
    }
    total += bytes.length;
    if (
      bytes.length > RUN_LIMITS.fileBytes ||
      total > RUN_LIMITS.totalBytes ||
      (await sha256(bytes)) !== file['initial_sha256']
    )
      invalid();
    ids.add(file['id']);
    documents.add(file['document_id']);
    items.push({
      id: file['id'],
      document_id: file['document_id'],
      generation: Number(file['generation']),
      path: file['path'],
      kind: 'python',
      initial_source: file['initial_source'],
      initial_sha256: file['initial_sha256'],
    });
  }
  try {
    validatePythonPaths(items.map((file) => file.path));
  } catch {
    invalid();
  }
  if (!ids.has(project['entrypoint_file_id'])) invalid();
  const scope = value['scope'] as 'read' | 'write';
  return {
    kind: 'live',
    share_id: value['share_id'],
    expires_at: value['expires_at'],
    scope,
    project: {
      id: project['id'],
      name: project['name'],
      entrypoint_file_id: project['entrypoint_file_id'],
      metadata_version: Number(project['metadata_version']),
      runtime_id: String(project['runtime_id']),
      archived: project['archived'],
      workspace_archived: project['workspace_archived'],
      access: { kind: 'live_share', scope },
    },
    files: { items, count: items.length },
  };
}
export const shareApi = {
  list: (projectId: string, offset = 0) =>
    api<components['schemas']['SharePage']>(
      `${base(projectId)}?offset=${offset}&limit=20`,
    ),
  create: (projectId: string, body: ShareRequest) =>
    api<components['schemas']['ShareCreated']>(base(projectId), {
      method: 'POST',
      body,
    }),
  revoke: (projectId: string, shareId: string) =>
    api<void>(`${base(projectId)}${shareId}/`, { method: 'DELETE' }),
  async resolve(token: string, signal?: AbortSignal): Promise<ResolvedShare> {
    if (!shareToken(token)) invalid();
    return validateResolvedShare(
      await api<unknown>('/api/v1/shares/resolve/', {
        method: 'POST',
        body: {
          token,
        } satisfies components['schemas']['ResolveShareBodyRequest'],
        ...(signal ? { signal } : {}),
      }),
    );
  },
};
