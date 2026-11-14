import type { components } from '@code-along/api-client';
import type { ProjectRunManifest } from '@code-along/contracts/execution/project';

type Immutable<T> = T extends readonly (infer Item)[]
  ? readonly Immutable<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: Immutable<T[Key]> }
    : T;
export type SubmissionRequest = Omit<
  Immutable<components['schemas']['SubmissionCreateRequest']>,
  'manifest'
> & {
  readonly manifest: ProjectRunManifest;
};
export type SubmissionSummary = Immutable<
  components['schemas']['SubmissionSummary']
>;
export type SubmissionDetail = Omit<
  Immutable<components['schemas']['SubmissionDetail']>,
  'manifest'
> & {
  readonly manifest: ProjectRunManifest;
};
export type SubmissionPage = Immutable<components['schemas']['SubmissionPage']>;
export type WorkSubmissionPage = Immutable<
  components['schemas']['WorkSubmissionPage']
>;
