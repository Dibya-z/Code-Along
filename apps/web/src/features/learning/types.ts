import type { components } from '@code-along/api-client';
export type Hint = components['schemas']['AssignmentHint'];
export type VersionSummary = components['schemas']['AssignmentVersionSummary'];
export type Assignment = components['schemas']['AssignmentSummary'];
export type AssignmentDraft = components['schemas']['AssignmentDraft'];
export type DraftFields = Pick<
  AssignmentDraft,
  | 'title'
  | 'instructions'
  | 'hints'
  | 'public_checks_source'
  | 'starter_revision_id'
  | 'submission_mode'
  | 'max_attempts'
  | 'max_team_size'
  | 'due_at'
>;
export type PublicChecks = components['schemas']['PublishedChecks'];
export type AssignmentVersion =
  components['schemas']['AssignmentVersionDetail'];
export interface Page<T> {
  items: T[];
  count: number;
}
