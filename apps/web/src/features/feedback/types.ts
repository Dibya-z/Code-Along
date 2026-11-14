import type { components } from '@code-along/api-client';

type Immutable<T> = T extends readonly (infer Item)[]
  ? readonly Immutable<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: Immutable<T[Key]> }
    : T;
export type FeedbackDraft = Immutable<components['schemas']['FeedbackDraft']>;
export type FeedbackSave = Immutable<
  components['schemas']['FeedbackDraftSaveRequest']
>;
export type FeedbackPublish = Immutable<
  components['schemas']['FeedbackPublishRequest']
>;
export type FeedbackPublication = Immutable<
  components['schemas']['FeedbackPublication']
>;
export type FeedbackLatest = Immutable<components['schemas']['FeedbackLatest']>;
export type FeedbackPage = Immutable<components['schemas']['FeedbackPage']>;
export type Assessment = components['schemas']['ManualAssessmentStatus'];
export interface FeedbackScope {
  readonly accountId: string;
  readonly assignmentId: string;
  readonly submissionId: string;
  readonly versionId: string;
}
