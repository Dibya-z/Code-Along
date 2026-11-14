import { CHAT_BLANK_CODEPOINTS } from '../events/index.ts';
import {
  isRunnerId,
  sha256,
  sourceBytes,
  type RunnerEventBody,
  type TerminalStatus,
} from './runner.ts';
import {
  captureProjectManifest,
  isProjectRunManifest,
  verifyProjectManifest,
  type ProjectRunManifest,
  type ProjectSnapshot,
} from './project-manifest.ts';
import { validBatchInput } from './product-runner.ts';
import { runtimeProfile } from './profiles.ts';
import { isRasterPlot, type RasterPlot } from './plots.ts';
import {
  REVIEWED_HELPER_RELEASE,
  type HelperRelease,
} from './helper-release.ts';

export {
  REVIEWED_HELPER_RELEASE,
  type HelperRelease,
} from './helper-release.ts';
export const PRACTICE_PROTOCOL = 'code-along.practice';
export const PRACTICE_VERSION = 1;
export const PRACTICE_CHECK_BYTES = 16 * 1024;

export interface PublicChecksManifest {
  readonly protocol: 'code-along.public-checks';
  readonly version: 1;
  readonly language: 'python';
  readonly source: string;
  readonly source_sha256: string;
  readonly sha256: string;
}
export interface PracticeSnapshot {
  readonly assignment_id: string;
  readonly assignment_version_id: string;
  readonly assignment_content_sha256: string;
  readonly source: ProjectSnapshot;
  readonly helper_release: HelperRelease;
  readonly published_checks_sha256: string;
  readonly checks_source: string;
  readonly check_origin: 'published' | 'local_practice';
}
export interface PracticeManifest {
  readonly protocol: 'code-along.practice-manifest';
  readonly version: 1;
  readonly assignment_id: string;
  readonly assignment_version_id: string;
  readonly assignment_content_sha256: string;
  readonly source: ProjectRunManifest;
  readonly helper_release: HelperRelease;
  readonly published_checks_sha256: string;
  readonly checks: PublicChecksManifest;
  readonly check_origin: 'published' | 'local_practice';
  readonly sha256: string;
}

export interface PracticeEnvelope {
  readonly protocol: typeof PRACTICE_PROTOCOL;
  readonly version: typeof PRACTICE_VERSION;
  readonly session_nonce: string;
  readonly run_id: string;
}
export type PracticeRunnerCommand = PracticeEnvelope &
  (
    | {
        readonly type: 'run';
        readonly manifest: PracticeManifest;
        readonly stdin: readonly string[];
      }
    | { readonly type: 'stdin'; readonly text: string | null }
    | { readonly type: 'cancel' }
  );
export type PracticeRunnerEventBody =
  | RasterPlot
  | Exclude<RunnerEventBody, { type: 'terminal' }>
  | {
      readonly type: 'terminal';
      readonly status: TerminalStatus;
      readonly source_manifest_sha256: string;
      readonly practice_manifest_sha256: string;
      readonly checks_sha256: string;
      readonly helper_release_sha256: string;
      readonly runtime_id: string;
    };
export type PracticeRunnerEvent = PracticeEnvelope & PracticeRunnerEventBody;
export interface PracticeRunnerReady {
  readonly protocol: typeof PRACTICE_PROTOCOL;
  readonly version: typeof PRACTICE_VERSION;
  readonly session_nonce: string;
  readonly type: 'ready';
  readonly interactive: boolean;
  readonly cross_origin_isolated: boolean;
}

const digest = /^[a-f0-9]{64}$/;
const blanks = new Set<number>(CHAT_BLANK_CODEPOINTS);
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function exact(
  value: Record<string, unknown>,
  fields: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === fields.length && keys.every((key) => fields.includes(key))
  );
}
function hash(value: unknown): Promise<string> {
  return sha256(sourceBytes(JSON.stringify(value)));
}
function validDigest(value: unknown): value is string {
  return typeof value === 'string' && digest.test(value);
}
function helper(value: unknown): value is HelperRelease {
  return (
    object(value) &&
    exact(value, ['release_id', 'source_sha256']) &&
    value['release_id'] === REVIEWED_HELPER_RELEASE.release_id &&
    value['source_sha256'] === REVIEWED_HELPER_RELEASE.source_sha256
  );
}
function validChecksSource(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > PRACTICE_CHECK_BYTES)
    return false;
  try {
    return (
      sourceBytes(value).length <= PRACTICE_CHECK_BYTES &&
      [...value].some((character) => !blanks.has(character.codePointAt(0)!))
    );
  } catch {
    return false;
  }
}
function checkValues(
  value: Omit<PublicChecksManifest, 'sha256'>,
): readonly unknown[] {
  return [
    value.protocol,
    value.version,
    value.language,
    value.source_sha256,
    value.source,
  ];
}
function practiceValues(
  value: Omit<PracticeManifest, 'sha256'>,
): readonly unknown[] {
  return [
    value.protocol,
    value.version,
    value.assignment_id,
    value.assignment_version_id,
    value.assignment_content_sha256,
    value.source.sha256,
    value.helper_release.release_id,
    value.helper_release.source_sha256,
    value.published_checks_sha256,
    value.checks.sha256,
    value.check_origin,
  ];
}
export async function capturePublicChecksManifest(
  source: string,
): Promise<PublicChecksManifest> {
  if (!validChecksSource(source))
    throw new Error(
      'Use nonblank visible checks within 16 KiB of valid UTF-8 text.',
    );
  const source_sha256 = await sha256(sourceBytes(source));
  const manifest = {
    protocol: 'code-along.public-checks' as const,
    version: 1 as const,
    language: 'python' as const,
    source,
    source_sha256,
  };
  return Object.freeze({
    ...manifest,
    sha256: await hash(checkValues(manifest)),
  });
}
export function isPublicChecksManifest(
  value: unknown,
): value is PublicChecksManifest {
  return (
    object(value) &&
    exact(value, [
      'protocol',
      'version',
      'language',
      'source',
      'source_sha256',
      'sha256',
    ]) &&
    value['protocol'] === 'code-along.public-checks' &&
    value['version'] === 1 &&
    value['language'] === 'python' &&
    validChecksSource(value['source']) &&
    validDigest(value['source_sha256']) &&
    validDigest(value['sha256'])
  );
}
export async function verifyPublicChecksManifest(
  value: unknown,
): Promise<boolean> {
  if (!isPublicChecksManifest(value)) return false;
  const captured = { ...value };
  try {
    const rebuilt = await capturePublicChecksManifest(captured.source);
    return (
      rebuilt.sha256 === captured.sha256 &&
      rebuilt.source_sha256 === captured.source_sha256 &&
      isPublicChecksManifest(value) &&
      JSON.stringify({ ...value }) === JSON.stringify(captured)
    );
  } catch {
    return false;
  }
}

/** Source and check bytes are copied in this first synchronous turn, before any digest await. */
export async function capturePracticeManifest(
  input: PracticeSnapshot,
): Promise<PracticeManifest> {
  const context = {
    assignment_id: input.assignment_id,
    assignment_version_id: input.assignment_version_id,
    assignment_content_sha256: input.assignment_content_sha256,
    helper_release: Object.freeze({ ...input.helper_release }),
    published_checks_sha256: input.published_checks_sha256,
    check_origin: input.check_origin,
  };
  const checksSource = input.checks_source;
  if (
    !isRunnerId(context.assignment_id) ||
    !isRunnerId(context.assignment_version_id) ||
    !validDigest(context.assignment_content_sha256) ||
    !helper(context.helper_release) ||
    !validDigest(context.published_checks_sha256) ||
    !['published', 'local_practice'].includes(context.check_origin) ||
    !validChecksSource(checksSource)
  )
    throw new Error('This practice capture is invalid.');
  const sourcePending = captureProjectManifest(input.source);
  const checksPending = capturePublicChecksManifest(checksSource);
  const [source, checks] = await Promise.all([sourcePending, checksPending]);
  if (
    context.check_origin === 'published' &&
    context.published_checks_sha256 !== checks.sha256
  )
    throw new Error(
      'The published visible checks do not match this practice capture.',
    );
  const manifest = {
    protocol: 'code-along.practice-manifest' as const,
    version: 1 as const,
    ...context,
    source,
    checks,
  };
  return Object.freeze({
    ...manifest,
    sha256: await hash(practiceValues(manifest)),
  });
}
export function isPracticeManifest(value: unknown): value is PracticeManifest {
  return (
    object(value) &&
    exact(value, [
      'protocol',
      'version',
      'assignment_id',
      'assignment_version_id',
      'assignment_content_sha256',
      'source',
      'helper_release',
      'published_checks_sha256',
      'checks',
      'check_origin',
      'sha256',
    ]) &&
    value['protocol'] === 'code-along.practice-manifest' &&
    value['version'] === 1 &&
    isRunnerId(value['assignment_id']) &&
    isRunnerId(value['assignment_version_id']) &&
    validDigest(value['assignment_content_sha256']) &&
    isProjectRunManifest(value['source']) &&
    helper(value['helper_release']) &&
    validDigest(value['published_checks_sha256']) &&
    isPublicChecksManifest(value['checks']) &&
    (value['check_origin'] === 'local_practice' ||
      (value['check_origin'] === 'published' &&
        value['published_checks_sha256'] === value['checks'].sha256)) &&
    validDigest(value['sha256'])
  );
}
export async function verifyPracticeManifest(value: unknown): Promise<boolean> {
  if (!isPracticeManifest(value)) return false;
  // A boolean verifier cannot grant ownership of the caller's mutable object.
  // Copy before awaiting and also reject a candidate changed during verification.
  const original = JSON.stringify(value);
  const captured = JSON.parse(original) as PracticeManifest;
  try {
    const [sourceValid, checksValid, sha] = await Promise.all([
      verifyProjectManifest(captured.source),
      verifyPublicChecksManifest(captured.checks),
      hash(practiceValues(captured)),
    ]);
    return (
      sourceValid &&
      checksValid &&
      sha === captured.sha256 &&
      isPracticeManifest(value) &&
      JSON.stringify(value) === original
    );
  } catch {
    return false;
  }
}

const common = ['protocol', 'version', 'session_nonce', 'run_id', 'type'];
function envelope(
  value: unknown,
  nonce: string,
): value is Record<string, unknown> {
  return (
    object(value) &&
    value['protocol'] === PRACTICE_PROTOCOL &&
    value['version'] === PRACTICE_VERSION &&
    value['session_nonce'] === nonce &&
    isRunnerId(nonce) &&
    isRunnerId(value['run_id'])
  );
}
export function parsePracticeCommand(
  value: unknown,
  nonce: string,
): PracticeRunnerCommand | null {
  if (!envelope(value, nonce)) return null;
  if (value['type'] === 'cancel' && exact(value, common))
    return value as unknown as PracticeRunnerCommand;
  if (
    value['type'] === 'stdin' &&
    exact(value, [...common, 'text']) &&
    (value['text'] === null || validBatchInput([value['text']]))
  )
    return value as unknown as PracticeRunnerCommand;
  if (
    value['type'] === 'run' &&
    exact(value, [...common, 'manifest', 'stdin']) &&
    isPracticeManifest(value['manifest']) &&
    validBatchInput(value['stdin'])
  )
    return value as unknown as PracticeRunnerCommand;
  return null;
}
export function parsePracticeReady(
  value: unknown,
  nonce: string,
): PracticeRunnerReady | null {
  if (
    !object(value) ||
    !exact(value, [
      'protocol',
      'version',
      'session_nonce',
      'type',
      'interactive',
      'cross_origin_isolated',
    ]) ||
    value['protocol'] !== PRACTICE_PROTOCOL ||
    value['version'] !== PRACTICE_VERSION ||
    value['type'] !== 'ready' ||
    value['session_nonce'] !== nonce ||
    !isRunnerId(nonce) ||
    typeof value['interactive'] !== 'boolean' ||
    typeof value['cross_origin_isolated'] !== 'boolean' ||
    (value['interactive'] && !value['cross_origin_isolated'])
  )
    return null;
  return value as unknown as PracticeRunnerReady;
}
export function parsePracticeEvent(
  value: unknown,
  nonce: string,
): PracticeRunnerEvent | null {
  if (!envelope(value, nonce)) return null;
  if (
    value['type'] === 'plot' &&
    exact(value, [...common, 'index', 'title', 'png']) &&
    isRasterPlot(value)
  )
    return value as unknown as PracticeRunnerEvent;
  if (
    value['type'] === 'state' &&
    exact(value, [...common, 'state']) &&
    ['initializing', 'running', 'waiting_for_input'].includes(
      value['state'] as string,
    )
  )
    return value as unknown as PracticeRunnerEvent;
  if (
    value['type'] === 'output' &&
    exact(value, [...common, 'stream', 'text', 'sequence']) &&
    (value['stream'] === 'stdout' || value['stream'] === 'stderr') &&
    typeof value['text'] === 'string' &&
    value['text'].length <= 8192 &&
    typeof value['sequence'] === 'number' &&
    Number.isSafeInteger(value['sequence']) &&
    value['sequence'] >= 0
  )
    return value as unknown as PracticeRunnerEvent;
  if (
    value['type'] === 'terminal' &&
    exact(value, [
      ...common,
      'status',
      'source_manifest_sha256',
      'practice_manifest_sha256',
      'checks_sha256',
      'helper_release_sha256',
      'runtime_id',
    ]) &&
    ['succeeded', 'failed', 'cancelled', 'timed_out', 'output_limit'].includes(
      value['status'] as string,
    ) &&
    validDigest(value['source_manifest_sha256']) &&
    validDigest(value['practice_manifest_sha256']) &&
    validDigest(value['checks_sha256']) &&
    validDigest(value['helper_release_sha256']) &&
    !!runtimeProfile(value['runtime_id'])
  )
    return value as unknown as PracticeRunnerEvent;
  return null;
}
