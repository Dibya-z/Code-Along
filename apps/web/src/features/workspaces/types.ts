export interface Workspace {
  id: string;
  name: string;
  role: 'owner' | 'instructor' | 'learner';
  archived: boolean;
  acl_version: string;
}
export interface Member {
  user_id: string;
  display_name: string;
  role: Workspace['role'];
}
export interface Page<T> {
  items: T[];
  count: number;
}
