import {
  isRunnerId,
  sha256,
  sourceBytes,
} from '@code-along/contracts/execution';
import {
  isProjectRunManifest,
  verifyProjectManifest,
  type ProjectRunManifest,
} from '@code-along/contracts/execution/project';
import { REVIEWED_HELPER_RELEASE } from '@code-along/contracts/execution/practice';
import {
  validateRevisionManifest,
  type RevisionManifest,
} from '../history/manifest.ts';
import type {
  ClientPracticeEvidence,
  SourceCandidate,
} from '../execution/source-actions.ts';
import type {
  SubmissionDetail,
  SubmissionRequest,
  SubmissionSummary,
} from './types.ts';

export const SUBMISSION_BODY_BYTES = 6 * 1024 * 1024 + 64 * 1024;
const digest = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));
function exact(value: Record<string, unknown>, fields: readonly string[]) {
  return (
    Object.keys(value).length === fields.length &&
    Object.keys(value).every((key) => fields.includes(key))
  );
}
function invalid(): never {
  throw new Error(
    'This submission could not be verified. Its source has not been opened or confirmed.',
  );
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export function owned<T>(value: T): T {
  const json = JSON.stringify(value);
  if (sourceBytes(json).length > SUBMISSION_BODY_BYTES) invalid();
  return freeze(JSON.parse(json) as T);
}
export function validEvidence(
  value: unknown,
  sourceHash: string,
): value is ClientPracticeEvidence | null {
  if (value === null) return true;
  if (
    !object(value) ||
    !isRunnerId(value['run_id']) ||
    value['source_manifest_sha256'] !== sourceHash ||
    typeof value['status'] !== 'string' ||
    !['succeeded', 'failed', 'cancelled', 'timed_out', 'output_limit'].includes(
      value['status'],
    )
  )
    return false;
  const fields = ['kind', 'run_id', 'source_manifest_sha256', 'status'];
  if (value['kind'] === 'run') return exact(value, fields);
  return (
    value['kind'] === 'visible_checks' &&
    exact(value, [
      ...fields,
      'practice_manifest_sha256',
      'published_checks_sha256',
      'checks_sha256',
      'check_origin',
    ]) &&
    digest(value['practice_manifest_sha256']) &&
    digest(value['published_checks_sha256']) &&
    digest(value['checks_sha256']) &&
    typeof value['check_origin'] === 'string' &&
    ['published', 'local_practice'].includes(value['check_origin']) &&
    (value['check_origin'] !== 'published' ||
      value['checks_sha256'] === value['published_checks_sha256'])
  );
}
/** The execution wire is broader than the database-backed submission domain. */
function isSubmissionSource(value: unknown): value is ProjectRunManifest {
  return (
    isProjectRunManifest(value) &&
    value.source_kind === 'project' &&
    value.files.every((file) => file.generation <= 2_147_483_647)
  );
}
export async function submissionRevision(
  manifest: ProjectRunManifest,
  expectedHash?: string,
): Promise<RevisionManifest> {
  if (!isSubmissionSource(manifest)) invalid();
  const { runtime, files } = manifest;
  const hash = await sha256(
    sourceBytes(
      JSON.stringify([
        'code-along.revision',
        1,
        manifest.project_id,
        manifest.metadata_version,
        manifest.entrypoint_file_id,
        runtime.runtime_id,
        runtime.manifest_sha256,
        runtime.engine,
        runtime.engine_version,
        runtime.python_version,
        REVIEWED_HELPER_RELEASE.release_id,
        REVIEWED_HELPER_RELEASE.source_sha256,
        files.map((file) => [
          file.file_id,
          file.document_id,
          file.generation,
          file.path,
          file.sha256,
          file.source,
        ]),
      ]),
    ),
  );
  if (expectedHash !== undefined && hash !== expectedHash) invalid();
  return validateRevisionManifest({
    protocol: 'code-along.revision',
    version: 1,
    project_id: manifest.project_id,
    metadata_version: manifest.metadata_version,
    entrypoint_file_id: manifest.entrypoint_file_id,
    runtime,
    helper_release: REVIEWED_HELPER_RELEASE,
    files,
    sha256: hash,
  });
}
export async function prepareSubmission(
  candidate: SourceCandidate,
): Promise<{ candidate: SourceCandidate; body: SubmissionRequest }> {
  const copy = owned(candidate);
  const manifest = copy.captured.manifest;
  if (
    !isRunnerId(copy.task.assignment_id) ||
    !isRunnerId(copy.task.assignment_version_id) ||
    !digest(copy.task.assignment_content_sha256) ||
    !isSubmissionSource(manifest) ||
    manifest.project_id !== copy.task.project_id ||
    !validEvidence(copy.practice, manifest.sha256) ||
    !(await verifyProjectManifest(manifest))
  )
    invalid();
  if (
    !(await evidenceContext(
      copy.practice,
      copy.task.assignment_id,
      copy.task.assignment_version_id,
      copy.task.assignment_content_sha256,
      manifest.sha256,
    ))
  )
    invalid();
  if (
    !Object.keys(manifest.runtime).every(
      (key) =>
        manifest.runtime[key as keyof typeof manifest.runtime] ===
        copy.task.runtime[key as keyof typeof manifest.runtime],
    ) ||
    copy.task.helper_release.release_id !==
      REVIEWED_HELPER_RELEASE.release_id ||
    copy.task.helper_release.source_sha256 !==
      REVIEWED_HELPER_RELEASE.source_sha256
  )
    invalid();
  const body = Object.freeze({
    client_request_id: crypto.randomUUID(),
    manifest,
    practice: copy.practice,
  });
  if (sourceBytes(JSON.stringify(body)).length > SUBMISSION_BODY_BYTES)
    throw new Error(
      'This code exceeds the submission transport limit. Export it before choosing a smaller project.',
    );
  return { candidate: copy, body };
}
const summaryFields = [
  'id',
  'assignment_id',
  'work_id',
  'assignment_version_id',
  'assignment_submission_number',
  'submitted_at',
  'author',
  'participants',
  'client_request_id',
  'source_manifest_sha256',
  'artifact_manifest_sha256',
  'artifact_scope',
  'provenance',
  'practice',
  'can_review',
];
const utc = (value: unknown) =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(
    value,
  ) &&
  Number.isFinite(Date.parse(value));
function user(value: unknown) {
  return (
    object(value) &&
    exact(value, ['id', 'display_name']) &&
    isRunnerId(value['id']) &&
    typeof value['display_name'] === 'string' &&
    [...value['display_name']].length > 0 &&
    [...value['display_name']].length <= 80 &&
    !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value['display_name'])
  );
}
export function validSubmissionSummary(
  value: unknown,
): value is SubmissionSummary & Record<string, unknown> {
  if (!object(value)) return false;
  return (
    [
      'id',
      'assignment_id',
      'work_id',
      'assignment_version_id',
      'client_request_id',
    ].every((key) => isRunnerId(value[key])) &&
    Number.isSafeInteger(value['assignment_submission_number']) &&
    Number(value['assignment_submission_number']) > 0 &&
    utc(value['submitted_at']) &&
    user(value['author']) &&
    Array.isArray(value['participants']) &&
    value['participants'].length > 0 &&
    value['participants'].length <= 6 &&
    value['participants'].every(user) &&
    new Set(value['participants'].map((person) => person['id'])).size ===
      value['participants'].length &&
    value['participants'].some(
      (person) => person['id'] === (value['author'] as { id: string }).id,
    ) &&
    digest(value['source_manifest_sha256']) &&
    digest(value['artifact_manifest_sha256']) &&
    value['artifact_scope'] === 'submission' &&
    value['provenance'] === 'client_submitted_snapshot' &&
    typeof value['can_review'] === 'boolean' &&
    validEvidence(value['practice'], value['source_manifest_sha256'])
  );
}
export async function validateSubmissionDetail(
  input: unknown,
  assignmentId: string,
  submissionId?: string,
): Promise<{ detail: SubmissionDetail; revision: RevisionManifest }> {
  const value: unknown = owned(input);
  if (
    !object(value) ||
    !exact(value, [
      ...summaryFields,
      'manifest',
      'helper_release',
      'published_version',
    ]) ||
    !validSubmissionSummary(value) ||
    value.assignment_id !== assignmentId ||
    (submissionId !== undefined && value.id !== submissionId) ||
    !isSubmissionSource(value['manifest']) ||
    value['manifest'].sha256 !== value.source_manifest_sha256 ||
    !(await verifyProjectManifest(value['manifest'])) ||
    !object(value['helper_release']) ||
    !exact(value['helper_release'], ['release_id', 'source_sha256']) ||
    value['helper_release']['release_id'] !==
      REVIEWED_HELPER_RELEASE.release_id ||
    value['helper_release']['source_sha256'] !==
      REVIEWED_HELPER_RELEASE.source_sha256 ||
    !object(value['published_version']) ||
    !exact(value['published_version'], [
      'number',
      'title',
      'content_sha256',
      'submission_mode',
    ]) ||
    !Number.isSafeInteger(value['published_version']['number']) ||
    Number(value['published_version']['number']) < 1 ||
    typeof value['published_version']['title'] !== 'string' ||
    [...value['published_version']['title']].length < 1 ||
    [...value['published_version']['title']].length > 120 ||
    !digest(value['published_version']['content_sha256']) ||
    typeof value['published_version']['submission_mode'] !== 'string' ||
    !['individual', 'team'].includes(
      value['published_version']['submission_mode'],
    )
  )
    invalid();
  const detail = value as unknown as SubmissionDetail;
  if (
    !(await evidenceContext(
      detail.practice,
      detail.assignment_id,
      detail.assignment_version_id,
      detail.published_version.content_sha256,
      detail.source_manifest_sha256,
    ))
  )
    invalid();
  const revision = await submissionRevision(
    detail.manifest,
    detail.artifact_manifest_sha256,
  );
  return { detail, revision };
}
async function evidenceContext(
  evidence: ClientPracticeEvidence | null,
  assignmentId: string,
  versionId: string,
  contentHash: string,
  sourceHash: string,
) {
  if (evidence?.kind !== 'visible_checks') return true;
  return (
    evidence.practice_manifest_sha256 ===
    (await sha256(
      sourceBytes(
        JSON.stringify([
          'code-along.practice-manifest',
          1,
          assignmentId,
          versionId,
          contentHash,
          sourceHash,
          REVIEWED_HELPER_RELEASE.release_id,
          REVIEWED_HELPER_RELEASE.source_sha256,
          evidence.published_checks_sha256,
          evidence.checks_sha256,
          evidence.check_origin,
        ]),
      ),
    ))
  );
}
export async function validateReceipt(
  input: unknown,
  actorId: string,
  workId: string,
  candidate: SourceCandidate,
  body: SubmissionRequest,
) {
  const result = await validateSubmissionDetail(
    input,
    candidate.task.assignment_id,
  );
  const value = result.detail;
  if (
    value.author.id !== actorId ||
    value.work_id !== workId ||
    value.assignment_version_id !== candidate.task.assignment_version_id ||
    value.client_request_id !== body.client_request_id ||
    value.source_manifest_sha256 !== body.manifest.sha256 ||
    value.published_version.content_sha256 !==
      candidate.task.assignment_content_sha256 ||
    !sameEvidence(value.practice, body.practice)
  )
    invalid();
  return result;
}
function sameEvidence(
  left: ClientPracticeEvidence | null,
  right: ClientPracticeEvidence | null,
) {
  return left === null || right === null
    ? left === right
    : Object.keys(left).every(
        (key) =>
          left[key as keyof ClientPracticeEvidence] ===
          right[key as keyof ClientPracticeEvidence],
      ) && Object.keys(left).length === Object.keys(right).length;
}
