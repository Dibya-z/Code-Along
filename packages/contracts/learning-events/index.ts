/** Coalesced learning invalidations. No domain payload, recipient selector or event history. */
export const LEARNING_PROTOCOL = 'code-along.learning-events' as const;
export const LEARNING_VERSION = 1 as const;
export const MAX_LEARNING_COMMAND_BYTES = 1024;
export const MAX_LEARNING_FRAME_BYTES = 4096;
const encoder = new TextEncoder();
const MAX_GENERATION = 9223372036854775807n;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export type LearningAudience = 'teaching' | 'participant';
export interface LearningEnvelope {
  readonly protocol: typeof LEARNING_PROTOCOL;
  readonly version: typeof LEARNING_VERSION;
  readonly scope: 'assignment';
  readonly assignment_id: string;
  readonly audience: LearningAudience;
}
export interface LearningSubscribe extends LearningEnvelope {
  readonly type: 'subscribe';
  readonly after_generation: string | null;
}
export interface LearningHead extends LearningEnvelope {
  readonly head_generation: string;
}
export type LearningFrame = LearningHead &
  (
    | { readonly type: 'subscribed'; readonly refresh_required: boolean }
    | { readonly type: 'learning.changed' | 'head' }
  );
export type LearningParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly error: 'invalid_message' | 'invalid_json' | 'message_too_large';
    };
export const isLearningId = (value: unknown): value is string =>
  typeof value === 'string' && value.length === 36 && UUID.test(value);
export function learningGeneration(
  value: unknown,
  allowZero = true,
): value is string {
  return (
    typeof value === 'string' &&
    /^(0|[1-9][0-9]{0,18})$/.test(value) &&
    BigInt(value) <= MAX_GENERATION &&
    BigInt(value).toString() === value &&
    (allowZero || value !== '0')
  );
}
const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));
const exact = (value: Record<string, unknown>, fields: readonly string[]) =>
  Object.keys(value).length === fields.length &&
  fields.every((field) => Object.hasOwn(value, field));
const fields = [
  'protocol',
  'version',
  'scope',
  'assignment_id',
  'audience',
] as const;
function envelope(value: Record<string, unknown>) {
  return (
    value['protocol'] === LEARNING_PROTOCOL &&
    value['version'] === LEARNING_VERSION &&
    value['scope'] === 'assignment' &&
    isLearningId(value['assignment_id']) &&
    (value['audience'] === 'participant' || value['audience'] === 'teaching')
  );
}
/** JSON.parse has already checked syntax. Inspect decoded keys before it can conceal duplicates. */
function uniqueKeys(raw: string): boolean {
  let at = 0;
  const space = () => {
    while (/\s/.test(raw[at] ?? '') && at < raw.length) at++;
  };
  const string = () => {
    const start = at++;
    while (at < raw.length) {
      const char = raw[at++];
      if (char === '\\') at++;
      else if (char === '"') return JSON.parse(raw.slice(start, at)) as string;
    }
    throw new Error('invalid_json');
  };
  const visit = (depth: number): boolean => {
    if (depth > 8) return false;
    space();
    if (raw[at] === '{') {
      at++;
      space();
      const keys = new Set<string>();
      if (raw[at] === '}') {
        at++;
        return true;
      }
      while (at < raw.length) {
        space();
        const key = string();
        if (keys.has(key)) return false;
        keys.add(key);
        space();
        at++;
        if (!visit(depth + 1)) return false;
        space();
        if (raw[at++] === '}') return true;
      }
    } else if (raw[at] === '[') {
      at++;
      space();
      if (raw[at] === ']') {
        at++;
        return true;
      }
      while (at < raw.length) {
        if (!visit(depth + 1)) return false;
        space();
        if (raw[at++] === ']') return true;
      }
    } else if (raw[at] === '"') {
      string();
      return true;
    } else {
      while (at < raw.length && !/[\s,}\]]/.test(raw[at]!)) at++;
      return true;
    }
    return false;
  };
  return visit(0);
}
function json(frame: unknown, limit: number): LearningParseResult<unknown> {
  if (typeof frame !== 'string' || /\p{Cs}/u.test(frame))
    return { ok: false, error: 'invalid_message' };
  if (frame.length > limit || encoder.encode(frame).byteLength > limit)
    return { ok: false, error: 'message_too_large' };
  try {
    const value: unknown = JSON.parse(frame);
    return uniqueKeys(frame)
      ? { ok: true, value }
      : { ok: false, error: 'invalid_json' };
  } catch {
    return { ok: false, error: 'invalid_json' };
  }
}
export function parseLearningCommand(
  frame: unknown,
): LearningParseResult<LearningSubscribe> {
  const parsed = json(frame, MAX_LEARNING_COMMAND_BYTES);
  if (!parsed.ok) return parsed;
  const value = parsed.value;
  if (
    !record(value) ||
    !exact(value, [...fields, 'type', 'after_generation']) ||
    !envelope(value) ||
    value['type'] !== 'subscribe' ||
    (value['after_generation'] !== null &&
      !learningGeneration(value['after_generation']))
  )
    return { ok: false, error: 'invalid_message' };
  return {
    ok: true,
    value: Object.freeze(value) as unknown as LearningSubscribe,
  };
}
export function parseLearningHead(
  value: unknown,
): LearningParseResult<LearningHead> {
  if (
    !record(value) ||
    !exact(value, [...fields, 'head_generation']) ||
    !envelope(value) ||
    !learningGeneration(value['head_generation'])
  )
    return { ok: false, error: 'invalid_message' };
  return {
    ok: true,
    value: Object.freeze({ ...value }) as unknown as LearningHead,
  };
}
export function parseLearningFrame(
  frame: unknown,
): LearningParseResult<LearningFrame> {
  const parsed = json(frame, MAX_LEARNING_FRAME_BYTES);
  if (!parsed.ok) return parsed;
  const value = parsed.value;
  if (
    !record(value) ||
    !envelope(value) ||
    !learningGeneration(
      value['head_generation'],
      value['type'] !== 'learning.changed',
    )
  )
    return { ok: false, error: 'invalid_message' };
  if (
    value['type'] === 'subscribed'
      ? !exact(value, [
          ...fields,
          'type',
          'head_generation',
          'refresh_required',
        ]) || typeof value['refresh_required'] !== 'boolean'
      : (value['type'] !== 'head' && value['type'] !== 'learning.changed') ||
        !exact(value, [...fields, 'type', 'head_generation'])
  )
    return { ok: false, error: 'invalid_message' };
  return { ok: true, value: Object.freeze(value) as unknown as LearningFrame };
}
export function subscribeLearning(
  assignmentId: string,
  audience: LearningAudience,
  after: string | null,
): string {
  const raw = JSON.stringify({
    protocol: LEARNING_PROTOCOL,
    version: LEARNING_VERSION,
    type: 'subscribe',
    scope: 'assignment',
    assignment_id: assignmentId,
    audience,
    after_generation: after,
  });
  if (!parseLearningCommand(raw).ok)
    throw new Error('Invalid learning subscription.');
  return raw;
}
