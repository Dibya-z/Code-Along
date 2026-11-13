import {
  isRunnerId,
  RUNNER_PROTOCOL,
  RUN_LIMITS,
  type RunnerReady,
  type RunnerEventBody,
  type TerminalStatus,
} from './runner.ts';
import {
  isProjectRunManifest,
  type ProjectRunManifest,
} from './project-manifest.ts';
import { runtimeProfile } from './profiles.ts';
export const PRODUCT_RUNNER_VERSION = 2;
export interface ProductEnvelope {
  readonly protocol: typeof RUNNER_PROTOCOL;
  readonly version: 2;
  readonly session_nonce: string;
  readonly run_id: string;
}
export type ProductRunnerCommand = ProductEnvelope &
  (
    | {
        readonly type: 'run';
        readonly manifest: ProjectRunManifest;
        readonly stdin: readonly string[];
      }
    | { readonly type: 'stdin'; readonly text: string | null }
    | { readonly type: 'cancel' }
  );
export type ProductRunnerEventBody =
  | Exclude<RunnerEventBody, { type: 'terminal' }>
  | {
      readonly type: 'terminal';
      readonly status: TerminalStatus;
      readonly manifest_sha256: string;
      readonly runtime_id: string;
    };
export type ProductRunnerEvent = ProductEnvelope & ProductRunnerEventBody;
export type ProductRunnerReady = Omit<RunnerReady, 'version'> & {
  readonly version: 2;
};
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, fields: readonly string[]) {
  const keys = Object.keys(value);
  return (
    keys.length === fields.length && keys.every((key) => fields.includes(key))
  );
}
function envelope(
  value: unknown,
  nonce: string,
): value is Record<string, unknown> {
  return (
    object(value) &&
    value['protocol'] === RUNNER_PROTOCOL &&
    value['version'] === PRODUCT_RUNNER_VERSION &&
    value['session_nonce'] === nonce &&
    isRunnerId(nonce) &&
    isRunnerId(value['run_id'])
  );
}
function inputLine(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= RUN_LIMITS.inputBytes &&
    new TextEncoder().encode(value).length <= RUN_LIMITS.inputBytes &&
    new TextDecoder('utf-8', { fatal: true }).decode(
      new TextEncoder().encode(value),
    ) === value
  );
}
const common = ['protocol', 'version', 'session_nonce', 'run_id', 'type'];
export function validBatchInput(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length <= 100 &&
    value.every(inputLine) &&
    value.reduce(
      (bytes, line) => bytes + new TextEncoder().encode(line).length,
      0,
    ) <=
      64 * 1024
  );
}
export function parseProductCommand(
  value: unknown,
  nonce: string,
): ProductRunnerCommand | null {
  if (!envelope(value, nonce)) return null;
  if (value['type'] === 'cancel' && exact(value, common))
    return value as unknown as ProductRunnerCommand;
  if (
    value['type'] === 'stdin' &&
    exact(value, [...common, 'text']) &&
    (value['text'] === null || inputLine(value['text']))
  )
    return value as unknown as ProductRunnerCommand;
  if (
    value['type'] === 'run' &&
    exact(value, [...common, 'manifest', 'stdin']) &&
    isProjectRunManifest(value['manifest']) &&
    validBatchInput(value['stdin'])
  )
    return value as unknown as ProductRunnerCommand;
  return null;
}
export function parseProductReady(
  value: unknown,
  nonce: string,
): ProductRunnerReady | null {
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
    value['protocol'] !== RUNNER_PROTOCOL ||
    value['version'] !== PRODUCT_RUNNER_VERSION ||
    value['type'] !== 'ready' ||
    value['session_nonce'] !== nonce ||
    !isRunnerId(nonce) ||
    typeof value['interactive'] !== 'boolean' ||
    typeof value['cross_origin_isolated'] !== 'boolean' ||
    (value['interactive'] && !value['cross_origin_isolated'])
  )
    return null;
  return value as unknown as ProductRunnerReady;
}
export function parseProductEvent(
  value: unknown,
  nonce: string,
): ProductRunnerEvent | null {
  if (!envelope(value, nonce)) return null;
  if (
    value['type'] === 'state' &&
    exact(value, [...common, 'state']) &&
    (value['state'] === 'initializing' ||
      value['state'] === 'running' ||
      value['state'] === 'waiting_for_input')
  )
    return value as unknown as ProductRunnerEvent;
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
    return value as unknown as ProductRunnerEvent;
  if (
    value['type'] === 'terminal' &&
    exact(value, [...common, 'status', 'manifest_sha256', 'runtime_id']) &&
    ['succeeded', 'failed', 'cancelled', 'timed_out', 'output_limit'].includes(
      value['status'] as string,
    ) &&
    typeof value['manifest_sha256'] === 'string' &&
    /^[a-f0-9]{64}$/.test(value['manifest_sha256']) &&
    !!runtimeProfile(value['runtime_id'])
  )
    return value as unknown as ProductRunnerEvent;
  return null;
}
