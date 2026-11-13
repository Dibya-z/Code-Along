import { api } from '../../api/client.ts';
import type { components } from '@code-along/api-client';
import type { Project } from '../projects/types.ts';
import { validateRevisionManifest, type RevisionManifest } from './manifest.ts';

export type Revision = components['schemas']['RevisionOutput'];
export type RevisionRequest = Readonly<
  components['schemas']['CreateRevisionBodyRequest']
>;
export type RevisionDetail = Omit<
  components['schemas']['RevisionDetail'],
  'manifest'
> & {
  manifest: RevisionManifest;
};
const base = (projectId: string) => `/api/v1/projects/${projectId}/revisions/`;
export const revisionApi = {
  list: (projectId: string, offset = 0, limit = 20) =>
    api<components['schemas']['RevisionPage']>(
      `${base(projectId)}?offset=${offset}&limit=${limit}`,
    ),
  create: (projectId: string, body: RevisionRequest) =>
    api<Revision>(base(projectId), { method: 'POST', body }),
  async detail(
    projectId: string,
    revisionId: string,
    signal?: AbortSignal,
  ): Promise<RevisionDetail> {
    const detail = await api<components['schemas']['RevisionDetail']>(
      `${base(projectId)}${revisionId}/`,
      signal ? { signal } : {},
    );
    const manifest = await validateRevisionManifest(detail.manifest);
    if (
      detail.id !== revisionId ||
      detail.project_id !== projectId ||
      manifest.project_id !== projectId ||
      manifest.sha256 !== detail.manifest_sha256 ||
      manifest.metadata_version !== detail.metadata_version ||
      detail.provenance !== 'shared_room_capture'
    )
      throw new Error('The revision does not match its verified manifest.');
    return { ...detail, manifest };
  },
  copy: (projectId: string, revisionId: string, name: string) =>
    api<Project>(`${base(projectId)}${revisionId}/copies/`, {
      method: 'POST',
      body: { name } satisfies components['schemas']['CopyRevisionBodyRequest'],
    }),
};
