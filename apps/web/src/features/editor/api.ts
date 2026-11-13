import { productApi } from '../../api/product.ts';

/** Read across the existing endpoints without mixing two metadata/ACL revisions. */
export async function loadEditorProject(
  projectId: string,
  read: Pick<typeof productApi, 'project' | 'files'> = productApi,
  signal?: AbortSignal,
) {
  for (let attempt = 0; attempt < 3; attempt++) {
    signal?.throwIfAborted();
    const before = await read.project(projectId);
    signal?.throwIfAborted();
    const files = await read.files(projectId);
    signal?.throwIfAborted();
    const project = await read.project(projectId);
    signal?.throwIfAborted();
    if (
      before.id === project.id &&
      before.metadata_version === project.metadata_version &&
      before.acl_version === project.acl_version &&
      before.role === project.role &&
      before.archived === project.archived &&
      before.workspace_archived === project.workspace_archived
    ) {
      return { project, files };
    }
  }
  throw new Error(
    'The project changed while loading. Refresh to load a consistent file list.',
  );
}
