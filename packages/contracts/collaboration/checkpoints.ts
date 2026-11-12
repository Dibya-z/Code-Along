/** Save acknowledgment extension; ordinary Yjs sync remains provider-owned. */
export const CHECKPOINT_PROTOCOL = 'code-along.checkpoint';
export const CHECKPOINT_VERSION = 1;
export const MAX_CHECKPOINT_STATE_BYTES = 1024 * 1024;
export const MAX_CHECKPOINT_BASE64_LENGTH =
  4 * Math.ceil(MAX_CHECKPOINT_STATE_BYTES / 3);
export const MAX_CHECKPOINT_MESSAGE_BYTES = MAX_CHECKPOINT_BASE64_LENGTH + 4096;

const MAX_DURABLE_REVISION = '9223372036854775807';
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const BASE64_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const encoder = new TextEncoder();

export interface ObservedDocumentState {
  readonly document_id: string;
  readonly generation: number;
  readonly client_session_id: string;
  readonly observed_counter: number;
}

interface CheckpointEnvelope extends ObservedDocumentState {
  readonly protocol: typeof CHECKPOINT_PROTOCOL;
  readonly version: typeof CHECKPOINT_VERSION;
  readonly checkpoint_id: string;
}

export interface CheckpointRequest extends CheckpointEnvelope {
  readonly type: 'checkpoint.request';
  readonly state_base64: string;
}

export interface CheckpointReceipt extends CheckpointEnvelope {
  readonly type: 'checkpoint.receipt';
  readonly durable_revision: string;
  readonly state_sha256: string;
}

export const CHECKPOINT_ERROR_CODES = Object.freeze([
  'unauthorized',
  'read_only',
  'generation_mismatch',
  'checkpoint_conflict',
  'invalid_state',
  'resource_limit',
  'storage_unavailable',
] as const);

export interface CheckpointError extends CheckpointEnvelope {
  readonly type: 'checkpoint.error';
  readonly code: (typeof CHECKPOINT_ERROR_CODES)[number];
}

export type CheckpointResponse = CheckpointReceipt | CheckpointError;

export type CheckpointParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly error: 'invalid_message' | 'invalid_json' | 'message_too_large';
    };

const COMMON_KEYS = [
  'protocol',
  'version',
  'type',
  'document_id',
  'generation',
  'client_session_id',
  'checkpoint_id',
  'observed_counter',
] as const;
const REQUEST_KEYS = new Set<string>([...COMMON_KEYS, 'state_base64']);
const RECEIPT_KEYS = new Set<string>([
  ...COMMON_KEYS,
  'durable_revision',
  'state_sha256',
]);
const ERROR_KEYS = new Set<string>([...COMMON_KEYS, 'code']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: ReadonlySet<string>,
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.size && keys.every((key) => expected.has(key))
  );
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function isCounter(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function hasEnvelope(value: Record<string, unknown>): boolean {
  return (
    value['protocol'] === CHECKPOINT_PROTOCOL &&
    value['version'] === CHECKPOINT_VERSION &&
    isUuid(value['document_id']) &&
    isCounter(value['generation']) &&
    value['generation'] > 0 &&
    isUuid(value['client_session_id']) &&
    isUuid(value['checkpoint_id']) &&
    isCounter(value['observed_counter'])
  );
}

function isBase64State(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_CHECKPOINT_BASE64_LENGTH ||
    value.length % 4 !== 0 ||
    !BASE64.test(value)
  ) {
    return false;
  }

  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const decodedLength = (value.length / 4) * 3 - padding;
  if (decodedLength > MAX_CHECKPOINT_STATE_BYTES) return false;

  // A canonical encoding zeros the unused low bits in the final data sextet.
  const last = value.charAt(value.length - padding - 1);
  const sextet = BASE64_ALPHABET.indexOf(last);
  return padding === 2
    ? (sextet & 15) === 0
    : padding === 1
      ? (sextet & 3) === 0
      : true;
}

function isRevision(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[1-9][0-9]{0,18}$/.test(value) &&
    (value.length < MAX_DURABLE_REVISION.length ||
      value <= MAX_DURABLE_REVISION)
  );
}

function isRequest(value: unknown): value is CheckpointRequest {
  return (
    isRecord(value) &&
    hasExactKeys(value, REQUEST_KEYS) &&
    hasEnvelope(value) &&
    value['type'] === 'checkpoint.request' &&
    isBase64State(value['state_base64'])
  );
}

function isResponse(value: unknown): value is CheckpointResponse {
  if (!isRecord(value) || !hasEnvelope(value)) return false;
  if (value['type'] === 'checkpoint.receipt') {
    return (
      hasExactKeys(value, RECEIPT_KEYS) &&
      isRevision(value['durable_revision']) &&
      typeof value['state_sha256'] === 'string' &&
      SHA256.test(value['state_sha256'])
    );
  }
  return (
    value['type'] === 'checkpoint.error' &&
    hasExactKeys(value, ERROR_KEYS) &&
    CHECKPOINT_ERROR_CODES.some((code) => code === value['code'])
  );
}

function parseFrame<T extends object>(
  frame: unknown,
  validate: (value: unknown) => value is T,
): CheckpointParseResult<T> {
  if (typeof frame !== 'string') return { ok: false, error: 'invalid_message' };
  // Cheap UTF-16 lower bound first, then count actual UTF-8 bytes before parsing.
  if (
    frame.length > MAX_CHECKPOINT_MESSAGE_BYTES ||
    encoder.encode(frame).byteLength > MAX_CHECKPOINT_MESSAGE_BYTES
  ) {
    return { ok: false, error: 'message_too_large' };
  }

  let value: unknown;
  try {
    value = JSON.parse(frame);
  } catch {
    return { ok: false, error: 'invalid_json' };
  }
  return validate(value)
    ? { ok: true, value: Object.freeze(value) }
    : { ok: false, error: 'invalid_message' };
}

export function parseCheckpointRequest(
  frame: unknown,
): CheckpointParseResult<CheckpointRequest> {
  return parseFrame(frame, isRequest);
}

export function parseCheckpointResponse(
  frame: unknown,
): CheckpointParseResult<CheckpointResponse> {
  return parseFrame(frame, isResponse);
}

/** Requires a parsed response from the trusted provider; not a commit verifier. */
export function receiptCoversObservedState(
  response: CheckpointResponse,
  pending: CheckpointRequest,
  current: ObservedDocumentState,
): boolean {
  return (
    response.type === 'checkpoint.receipt' &&
    response.checkpoint_id === pending.checkpoint_id &&
    response.document_id === pending.document_id &&
    response.generation === pending.generation &&
    response.client_session_id === pending.client_session_id &&
    response.observed_counter === pending.observed_counter &&
    current.document_id === pending.document_id &&
    current.generation === pending.generation &&
    current.client_session_id === pending.client_session_id &&
    current.observed_counter === pending.observed_counter
  );
}
