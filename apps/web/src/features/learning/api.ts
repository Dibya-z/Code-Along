import { api, ApiError } from '../../api/client.ts';
import type { components } from '@code-along/api-client';
import { validateRevisionManifest } from '../history/manifest.ts';
import { verifyAssignmentVersion, verifyStarter } from './validation.ts';
import type {
  Assignment,
  AssignmentDraft,
  AssignmentVersion,
  DraftFields,
  Page,
  VersionSummary,
} from './types.ts';

const base = (assignmentId: string) => `/api/v1/assignments/${assignmentId}/`;
export type PublishRequest = Readonly<
  components['schemas']['AssignmentPublishRequest']
>;
export const learningApi = {
  list: (
    workspaceId: string,
    offset: number,
    archived: boolean,
    signal?: AbortSignal,
  ) =>
    api<Page<Assignment>>(
      `/api/v1/workspaces/${workspaceId}/assignments/?offset=${offset}&limit=20&include_archived=${archived}`,
      signal ? { signal } : {},
    ),
  create: (workspaceId: string, title: string) =>
    api<Assignment>(`/api/v1/workspaces/${workspaceId}/assignments/`, {
      method: 'POST',
      body: {
        title,
      } satisfies components['schemas']['AssignmentCreateRequest'],
    }),
  summary: (id: string, signal?: AbortSignal) =>
    api<Assignment>(base(id), signal ? { signal } : {}),
  draft: (id: string, signal?: AbortSignal) =>
    api<AssignmentDraft>(`${base(id)}draft/`, signal ? { signal } : {}),
  save: (id: string, expected_revision: number, fields: DraftFields) =>
    api<AssignmentDraft>(`${base(id)}draft/`, {
      method: 'PATCH',
      body: {
        expected_revision,
        ...fields,
      } satisfies components['schemas']['AssignmentDraftPatchRequest'],
    }),
  archive: (id: string, expected_revision: number, archived: boolean) =>
    api<Assignment>(base(id), {
      method: 'PATCH',
      body: {
        expected_revision,
        archived,
      } satisfies components['schemas']['AssignmentArchiveRequest'],
    }),
  versions: (id: string, offset = 0, signal?: AbortSignal) =>
    api<Page<VersionSummary>>(
      `${base(id)}versions/?offset=${offset}&limit=20`,
      signal ? { signal } : {},
    ),
  async version(id: string, versionId: string, signal?: AbortSignal) {
    return verifyAssignmentVersion(
      await api<AssignmentVersion>(
        `${base(id)}versions/${versionId}/`,
        signal ? { signal } : {},
      ),
      id,
      versionId,
    );
  },
  async publish(id: string, request: PublishRequest) {
    const version = await api<AssignmentVersion>(`${base(id)}versions/`, {
      method: 'POST',
      body: request,
    });
    return verifyAssignmentVersion(version, id, version.id);
  },
  async starter(version: AssignmentVersion, signal?: AbortSignal) {
    const value = await api<components['schemas']['AssignmentStarter']>(
      `${base(version.assignment_id)}versions/${version.id}/starter/`,
      signal ? { signal } : {},
    );
    if (
      value.assignment_id !== version.assignment_id ||
      value.assignment_version_id !== version.id ||
      value.revision_id !== version.starter.revision_id
    )
      throw new Error('The starter belongs to a different published version.');
    return verifyStarter(
      version,
      await validateRevisionManifest(value.manifest),
    );
  },
};
export function capacityMessage(error: unknown): string | null {
  if (
    !(error instanceof ApiError) ||
    error.status !== 409 ||
    !error.body ||
    typeof error.body !== 'object' ||
    !('code' in error.body)
  )
    return null;
  switch (error.body.code) {
    case 'assignment_capacity':
      return 'This workspace has reached its limit of 100 assignments. Archiving an assignment does not release this limit.';
    case 'assignment_version_capacity':
      return 'This assignment has reached its limit of 50 published versions. Existing versions remain available.';
    case 'assignment_version_metadata_limit':
      return 'Published version metadata exceeds 256 KiB. Reduce the draft content before publishing.';
    case 'assignment_metadata_capacity':
      return 'This assignment has reached its 4 MiB published metadata limit. Existing versions remain available.';
    default:
      return null;
  }
}
