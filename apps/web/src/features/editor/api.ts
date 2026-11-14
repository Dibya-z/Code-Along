import { productApi } from '../../api/product.ts';
import type { FileMetadata } from './model/document.ts';

export function editorSourceQuery(
  accountId: string,
  projectId: string,
  file: FileMetadata,
) {
  return {
    queryKey: [
      'editor-source',
      accountId,
      projectId,
      file.id,
      file.document_id,
      file.generation,
      file.initial_sha256,
    ],
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      productApi.file(projectId, file.id, signal),
    staleTime: Infinity,
  };
}

/** Read across the existing endpoints without mixing two metadata/ACL revisions. */
export async function loadEditorProject(
  projectId: string,
  read: Pick<typeof productApi, 'project' | 'files'> = productApi,
  signal?: AbortSignal,
) {
  for (let attempt = 0; attempt < 3; attempt++) {
    signal?.throwIfAborted();
    const before = await read.project(projectId, signal);
    signal?.throwIfAborted();
    const files = await read.files(projectId, signal);
    signal?.throwIfAborted();
    const project = await read.project(projectId, signal);
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
