/** Untrusted local practice only. No authentication, grading or API-command fields. */
export const RUNNER_PROTOCOL = 'code-along.runner';
export const RUNNER_VERSION = 1;
export const RUNTIME_ID = 'pyodide-314.0.7-core';
export const RUN_LIMITS = Object.freeze({
  files: 20,
  fileBytes: 128 * 1024,
  totalBytes: 1024 * 1024,
  outputBytes: 1024 * 1024,
  inputBytes: 4096,
  wallMs: 30000,
  startupMs: 30000,
});
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hash = /^[a-f0-9]{64}$/;
export function isRunnerId(value: unknown): value is string {
  return typeof value === 'string' && uuid.test(value);
}
export interface SourceFile {
  readonly document_id: string;
  readonly generation: number;
  readonly path: string;
  readonly source: string;
}
export interface RunManifest {
  readonly version: 1;
  readonly metadata_version: number;
  readonly runtime_id: typeof RUNTIME_ID;
  readonly entrypoint: string;
  readonly stdin_mode: 'batch' | 'interactive';
  readonly files: readonly (SourceFile & { readonly sha256: string })[];
  readonly sha256: string;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, allowed: string[]): boolean {
  const k = Object.keys(value);
  return k.length === allowed.length && k.every((s) => allowed.includes(s));
}
function integer(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
}
function path(v: unknown): v is string {
  return (
    typeof v === 'string' &&
    v.length <= 160 &&
    /^[A-Za-z_][A-Za-z0-9_/-]*\.py$/.test(v) &&
    !v.split('/').some((s) => s === '' || s === '.' || s === '..')
  );
}
export function sourceBytes(source: string): Uint8Array {
  const bytes = new TextEncoder().encode(source);
  if (
    new TextDecoder('utf-8', { fatal: true }).decode(bytes) !== source ||
    source.includes('\0')
  )
    throw new Error('invalid_source');
  return bytes;
}
export async function sha256(bytes: Uint8Array): Promise<string> {
  const result = await crypto.subtle.digest(
    'SHA-256',
    Uint8Array.from(bytes).buffer,
  );
  return Array.from(new Uint8Array(result), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}
function validFiles(
  value: unknown,
  hashed: boolean,
): value is RunManifest['files'] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > RUN_LIMITS.files
  )
    return false;
  const seen = new Set<string>(),
    ids = new Set<string>();
  let total = 0;
  for (const f of value) {
    if (
      !record(f) ||
      !keys(f, [
        'document_id',
        'generation',
        'path',
        'source',
        ...(hashed ? ['sha256'] : []),
      ]) ||
      !isRunnerId(f['document_id']) ||
      !integer(f['generation']) ||
      !path(f['path']) ||
      typeof f['source'] !== 'string' ||
      f['source'].length > RUN_LIMITS.fileBytes ||
      (hashed &&
        (typeof f['sha256'] !== 'string' || !hash.test(f['sha256']))) ||
      seen.has(f['path']) ||
      ids.has(f['document_id'])
    )
      return false;
    seen.add(f['path']);
    ids.add(f['document_id']);
    try {
      const bytes = sourceBytes(f['source']);
      if (bytes.length > RUN_LIMITS.fileBytes) return false;
      total += bytes.length;
    } catch {
      return false;
    }
  }
  return total <= RUN_LIMITS.totalBytes;
}
function canonical(m: Omit<RunManifest, 'sha256'>): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      version: m.version,
      metadata_version: m.metadata_version,
      runtime_id: m.runtime_id,
      entrypoint: m.entrypoint,
      stdin_mode: m.stdin_mode,
      files: m.files.map((f) => ({
        document_id: f.document_id,
        generation: f.generation,
        path: f.path,
        sha256: f.sha256,
        source: f.source,
      })),
    }),
  );
}
/** Copy all model values synchronously before the first await. No live model/DOM reads after capture. */
export async function captureRunManifest(
  files: readonly SourceFile[],
  entrypoint: string,
  metadataVersion: number,
  stdinMode: RunManifest['stdin_mode'] = 'batch',
): Promise<RunManifest> {
  const copy = files.map((f) =>
    Object.freeze({
      document_id: f.document_id,
      generation: f.generation,
      path: f.path,
      source: f.source,
    }),
  );
  if (
    !validFiles(copy, false) ||
    !path(entrypoint) ||
    !copy.some((f) => f.path === entrypoint) ||
    !integer(metadataVersion) ||
    !['batch', 'interactive'].includes(stdinMode)
  )
    throw new Error('invalid_manifest');
  copy.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const hashed = await Promise.all(
    copy.map(async (f) =>
      Object.freeze({ ...f, sha256: await sha256(sourceBytes(f.source)) }),
    ),
  );
  const m: Omit<RunManifest, 'sha256'> = {
    version: 1,
    metadata_version: metadataVersion,
    runtime_id: RUNTIME_ID,
    entrypoint,
    stdin_mode: stdinMode,
    files: Object.freeze(hashed),
  };
  return Object.freeze({ ...m, sha256: await sha256(canonical(m)) });
}
export function isRunManifest(v: unknown): v is RunManifest {
  if (
    !record(v) ||
    !keys(v, [
      'version',
      'metadata_version',
      'runtime_id',
      'entrypoint',
      'stdin_mode',
      'files',
      'sha256',
    ]) ||
    v['version'] !== 1 ||
    !integer(v['metadata_version']) ||
    v['runtime_id'] !== RUNTIME_ID ||
    !path(v['entrypoint']) ||
    !['batch', 'interactive'].includes(String(v['stdin_mode'])) ||
    !validFiles(v['files'], true) ||
    typeof v['sha256'] !== 'string' ||
    !hash.test(v['sha256'])
  )
    return false;
  return v['files'].some((f) => f.path === v['entrypoint']);
}
export async function verifyRunManifest(v: RunManifest): Promise<boolean> {
  try {
    const rebuilt = await captureRunManifest(
      v.files,
      v.entrypoint,
      v.metadata_version,
      v.stdin_mode,
    );
    return (
      rebuilt.sha256 === v.sha256 &&
      rebuilt.files.every((f, i) => f.sha256 === v.files[i]?.sha256)
    );
  } catch {
    return false;
  }
}
interface Envelope {
  readonly protocol: typeof RUNNER_PROTOCOL;
  readonly version: 1;
  readonly session_nonce: string;
  readonly run_id: string;
}
export type RunnerCommand = Envelope &
  (
    | {
        readonly type: 'run';
        readonly manifest: RunManifest;
        readonly stdin: readonly string[];
      }
    | { readonly type: 'stdin'; readonly text: string | null }
    | { readonly type: 'cancel' }
  );
export type TerminalStatus =
  'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'output_limit';
export type RunnerEventBody =
  | {
      readonly type: 'state';
      readonly state: 'initializing' | 'running' | 'waiting_for_input';
    }
  | {
      readonly type: 'output';
      readonly stream: 'stdout' | 'stderr';
      readonly sequence: number;
      readonly text: string;
    }
  | {
      readonly type: 'terminal';
      readonly status: TerminalStatus;
      readonly manifest_sha256: string;
      readonly runtime_id: typeof RUNTIME_ID;
    };
export type RunnerEvent = Envelope & RunnerEventBody;
export interface RunnerReady {
  readonly protocol: typeof RUNNER_PROTOCOL;
  readonly version: 1;
  readonly type: 'ready';
  readonly session_nonce: string;
  readonly interactive: boolean;
  readonly cross_origin_isolated: boolean;
}
export function parseRunnerReady(
  v: unknown,
  nonce: string,
): RunnerReady | null {
  if (
    !record(v) ||
    !keys(v, [
      'protocol',
      'version',
      'type',
      'session_nonce',
      'interactive',
      'cross_origin_isolated',
    ]) ||
    v['protocol'] !== RUNNER_PROTOCOL ||
    v['version'] !== 1 ||
    v['type'] !== 'ready' ||
    v['session_nonce'] !== nonce ||
    !isRunnerId(nonce) ||
    typeof v['interactive'] !== 'boolean' ||
    typeof v['cross_origin_isolated'] !== 'boolean' ||
    (v['interactive'] && !v['cross_origin_isolated'])
  )
    return null;
  return v as unknown as RunnerReady;
}
export function parseRunnerEvent(
  v: unknown,
  nonce: string,
): RunnerEvent | null {
  if (
    !record(v) ||
    v['protocol'] !== RUNNER_PROTOCOL ||
    v['version'] !== 1 ||
    v['session_nonce'] !== nonce ||
    !isRunnerId(nonce) ||
    !isRunnerId(v['run_id'])
  )
    return null;
  const common = ['protocol', 'version', 'session_nonce', 'run_id', 'type'];
  if (
    v['type'] === 'state' &&
    keys(v, [...common, 'state']) &&
    ['initializing', 'running', 'waiting_for_input'].includes(
      String(v['state']),
    )
  )
    return v as unknown as RunnerEvent;
  if (
    v['type'] === 'output' &&
    keys(v, [...common, 'stream', 'sequence', 'text']) &&
    ['stdout', 'stderr'].includes(String(v['stream'])) &&
    typeof v['sequence'] === 'number' &&
    Number.isSafeInteger(v['sequence']) &&
    v['sequence'] >= 0 &&
    typeof v['text'] === 'string' &&
    v['text'].length <= 8192
  )
    return v as unknown as RunnerEvent;
  if (
    v['type'] === 'terminal' &&
    keys(v, [...common, 'status', 'manifest_sha256', 'runtime_id']) &&
    ['succeeded', 'failed', 'cancelled', 'timed_out', 'output_limit'].includes(
      String(v['status']),
    ) &&
    typeof v['manifest_sha256'] === 'string' &&
    hash.test(v['manifest_sha256']) &&
    v['runtime_id'] === RUNTIME_ID
  )
    return v as unknown as RunnerEvent;
  return null;
}
export function parseRunnerCommand(
  v: unknown,
  nonce: string,
): RunnerCommand | null {
  if (
    !record(v) ||
    v['protocol'] !== RUNNER_PROTOCOL ||
    v['version'] !== 1 ||
    v['session_nonce'] !== nonce ||
    !isRunnerId(nonce) ||
    !isRunnerId(v['run_id'])
  )
    return null;
  const common = ['protocol', 'version', 'session_nonce', 'run_id', 'type'];
  if (v['type'] === 'cancel' && keys(v, common))
    return v as unknown as RunnerCommand;
  if (
    v['type'] === 'stdin' &&
    keys(v, [...common, 'text']) &&
    (v['text'] === null ||
      (typeof v['text'] === 'string' &&
        new TextEncoder().encode(v['text']).length <= RUN_LIMITS.inputBytes))
  )
    return v as unknown as RunnerCommand;
  if (
    v['type'] === 'run' &&
    keys(v, [...common, 'manifest', 'stdin']) &&
    isRunManifest(v['manifest']) &&
    Array.isArray(v['stdin']) &&
    v['stdin'].length <= 100 &&
    v['stdin'].every(
      (s) =>
        typeof s === 'string' &&
        new TextEncoder().encode(s).length <= RUN_LIMITS.inputBytes,
    )
  )
    return v as unknown as RunnerCommand;
  return null;
}
