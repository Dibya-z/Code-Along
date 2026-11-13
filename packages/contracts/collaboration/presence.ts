/** Public profile projection. Parsing checks shape, never caller authority. */
export const PRESENCE_PROTOCOL = 'code-along.presence';
export const PRESENCE_VERSION = 1;
export const MAX_PRESENCE_MESSAGE_BYTES = 4096;
export const PRESENCE_COLORS = Object.freeze([
  '#2563eb',
  '#7c3aed',
  '#db2777',
  '#dc2626',
  '#ea580c',
  '#059669',
  '#0891b2',
  '#4f46e5',
] as const);
export interface PresenceIdentity {
  readonly protocol: typeof PRESENCE_PROTOCOL;
  readonly version: typeof PRESENCE_VERSION;
  readonly type: 'presence.identity';
  readonly document_id: string;
  readonly generation: number;
  readonly client_session_id: string;
  readonly awareness_client_id: number;
  readonly user: {
    readonly id: string;
    readonly display_name: string;
    readonly color: (typeof PRESENCE_COLORS)[number];
  };
}
export type PresenceParseResult =
  | { readonly ok: true; readonly value: PresenceIdentity }
  | {
      readonly ok: false;
      readonly error: 'invalid_message' | 'invalid_json' | 'message_too_large';
    };
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const encoder = new TextEncoder();
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function exact(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
function uuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}
function projectedName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    [...value].length <= 80 &&
    !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value) &&
    value.trim().replace(/\s+/gu, ' ') === value
  );
}
function identity(value: unknown): value is PresenceIdentity {
  if (
    !record(value) ||
    !exact(value, [
      'protocol',
      'version',
      'type',
      'document_id',
      'generation',
      'client_session_id',
      'awareness_client_id',
      'user',
    ])
  )
    return false;
  const user = value['user'];
  return (
    value['protocol'] === PRESENCE_PROTOCOL &&
    value['version'] === PRESENCE_VERSION &&
    value['type'] === 'presence.identity' &&
    uuid(value['document_id']) &&
    typeof value['generation'] === 'number' &&
    Number.isSafeInteger(value['generation']) &&
    value['generation'] >= 1 &&
    uuid(value['client_session_id']) &&
    typeof value['awareness_client_id'] === 'number' &&
    Number.isInteger(value['awareness_client_id']) &&
    value['awareness_client_id'] >= 0 &&
    value['awareness_client_id'] <= 0xffff_ffff &&
    record(user) &&
    exact(user, ['id', 'display_name', 'color']) &&
    uuid(user['id']) &&
    projectedName(user['display_name']) &&
    PRESENCE_COLORS.some((color) => color === user['color'])
  );
}
/** Accept only a bounded JSON frame from the admitted server; bind its IDs there. */
export function parsePresenceIdentity(frame: unknown): PresenceParseResult {
  if (typeof frame !== 'string') return { ok: false, error: 'invalid_message' };
  if (
    frame.length > MAX_PRESENCE_MESSAGE_BYTES ||
    encoder.encode(frame).byteLength > MAX_PRESENCE_MESSAGE_BYTES
  )
    return { ok: false, error: 'message_too_large' };
  let value: unknown;
  try {
    value = JSON.parse(frame);
  } catch {
    return { ok: false, error: 'invalid_json' };
  }
  if (!identity(value)) return { ok: false, error: 'invalid_message' };
  Object.freeze(value.user);
  return { ok: true, value: Object.freeze(value) };
}
