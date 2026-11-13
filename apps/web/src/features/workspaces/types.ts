import type { components } from '@code-along/api-client';
export type Workspace = components['schemas']['WorkspaceOutput'];
export type Member = components['schemas']['MemberOutput'];
export interface Page<T> {
  items: T[];
  count: number;
}
