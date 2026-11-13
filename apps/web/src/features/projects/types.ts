import type { components } from '@code-along/api-client';
export type Project = components['schemas']['ProjectOutput'];
export type ProjectFile = components['schemas']['FileMetadata'] &
  Partial<Pick<components['schemas']['FileSource'], 'initial_source'>>;

/** Metadata needed by a local workbench; no server ownership/grants are synthesized. */
export type EditorProject = Pick<
  Project,
  | 'id'
  | 'name'
  | 'metadata_version'
  | 'entrypoint_file_id'
  | 'runtime_id'
  | 'role'
  | 'archived'
  | 'workspace_archived'
>;
