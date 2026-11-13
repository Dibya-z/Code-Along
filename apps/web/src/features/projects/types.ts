export interface Project {
  id: string;
  workspace_id: string;
  owner_id: string;
  name: string;
  role: 'owner' | 'editor' | 'viewer';
  entrypoint_file_id: string;
  entrypoint_path: string;
  runtime_profile_id: string;
  runtime_id: string;
  metadata_version: number;
  acl_version: string;
  archived: boolean;
  workspace_archived: boolean;
}
export interface ProjectFile {
  id: string;
  document_id: string;
  path: string;
  kind: 'python';
  generation: number;
  initial_sha256: string;
  initial_source?: string;
}
