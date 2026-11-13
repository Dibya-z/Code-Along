import type { components } from '@code-along/api-client';
export type Project = components['schemas']['ProjectOutput'];
export type ProjectFile = components['schemas']['FileMetadata'] &
  Partial<Pick<components['schemas']['FileSource'], 'initial_source'>>;
