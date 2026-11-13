import type { components } from '@code-along/api-client';
export type Project = components['schemas']['ProjectOutput'];
export type ProjectFile = components['schemas']['FileMetadata'] &
  Partial<Pick<components['schemas']['FileSource'], 'initial_source'>>;

/** Metadata needed by a local workbench; no server ownership/grants are synthesized. */
type EditorProjectMetadata = Pick<
  Project,
  | 'id'
  | 'name'
  | 'metadata_version'
  | 'entrypoint_file_id'
  | 'runtime_id'
  | 'archived'
  | 'workspace_archived'
>;
/** Capability access never creates or impersonates an ordinary project grant. */
export type OrdinaryEditorProject = EditorProjectMetadata & {
  role: Project['role'];
  access?: never;
};
export type LiveEditorProject = components['schemas']['SharedProject'] & {
  role?: never;
};
export type EditorProject = OrdinaryEditorProject | LiveEditorProject;
export function sourceWritable(project: EditorProject): boolean {
  return (
    (project.access?.kind === 'live_share'
      ? project.access.scope === 'write'
      : project.role === 'owner' || project.role === 'editor') &&
    !project.archived &&
    !project.workspace_archived
  );
}
