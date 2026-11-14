/** Public notifications are hints from an authorized transport, never permission authority. */
export const EVENTS_PROTOCOL = 'code-along.events';
export const EVENTS_VERSION = 1;
export const MAX_EVENT_FRAME_BYTES = 512 * 1024;
export const MAX_EVENT_COMMAND_BYTES = 1024;
export const MAX_CHAT_BYTES = 4096;
/** Explicit union of Python whitespace and ECMAScript trim; accepted body bytes are never stripped. */
export const CHAT_BLANK_CODEPOINTS = Object.freeze([
  9, 10, 11, 12, 13, 28, 29, 30, 31, 32, 133, 160, 5760, 8192, 8193, 8194, 8195,
  8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288,
  65279,
]);
const blankCodepoints = new Set(CHAT_BLANK_CODEPOINTS);
const MAX_SEQUENCE = 9223372036854775807n;
const encoder = new TextEncoder();
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export interface ChatMessage {
  readonly id: string;
  readonly project_id: string;
  readonly client_message_id: string;
  readonly sequence: string;
  readonly author: { readonly id: string; readonly display_name: string };
  readonly body: string | null;
  readonly created_at: string;
  readonly deleted: boolean;
}
interface Envelope {
  readonly protocol: typeof EVENTS_PROTOCOL;
  readonly version: 1;
  readonly project_id: string;
}
export type ProjectEvent = Envelope & {
  readonly type: 'event';
  readonly id: string;
  readonly sequence: string;
  readonly occurred_at: string;
} & (
    | {
        readonly event_type: 'project.changed';
        readonly data: { readonly metadata_version: number };
      }
    | {
        readonly event_type: 'project.access.changed';
        readonly data: {
          readonly project_acl_version: string;
          readonly workspace_acl_version: string;
        };
      }
    | {
        readonly event_type: 'revision.created';
        readonly data: { readonly revision_id: string };
      }
    | {
        readonly event_type: 'chat.message.created';
        readonly data: { readonly message: ChatMessage };
      }
  );
export type EventFrame =
  | ProjectEvent
  | (Envelope & { readonly type: 'head'; readonly head_sequence: string })
  | (Envelope & {
      readonly type: 'subscribed';
      readonly head_sequence: string;
      readonly refresh_required: boolean;
      readonly events: readonly ProjectEvent[];
    });
export interface EventPage {
  readonly items: readonly ProjectEvent[];
  readonly head_sequence: string;
  readonly next_after: string;
  readonly refresh_required: boolean;
}
export interface ChatPage {
  readonly items: readonly ChatMessage[];
  readonly head_sequence: string;
  readonly next_after: string;
  readonly next_before: string | null;
  readonly has_more: boolean;
}
export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly error: 'invalid_message' | 'invalid_json' | 'message_too_large';
    };
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, keys: readonly string[]) {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
function uuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}
export function eventSequence(
  value: unknown,
  allowZero = true,
): value is string {
  return (
    typeof value === 'string' &&
    /^(0|[1-9][0-9]{0,18})$/.test(value) &&
    BigInt(value) <= MAX_SEQUENCE &&
    (allowZero || value !== '0')
  );
}
export function validChatBody(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= MAX_CHAT_BYTES &&
    [...value].some((char) => !blankCodepoints.has(char.codePointAt(0)!)) &&
    !value.includes('\0') &&
    !/\p{Cs}/u.test(value) &&
    encoder.encode(value).byteLength <= MAX_CHAT_BYTES
  );
}
function utc(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(value)
  )
    return false;
  const time = Date.parse(value);
  return (
    Number.isFinite(time) &&
    new Date(time).toISOString().slice(0, 19) === value.slice(0, 19)
  );
}
function name(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    [...value].length <= 80 &&
    value.length > 0 &&
    !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value) &&
    value.trim().replace(/\s+/gu, ' ') === value
  );
}
export function isChatMessage(value: unknown): value is ChatMessage {
  if (
    !record(value) ||
    !exact(value, [
      'id',
      'project_id',
      'client_message_id',
      'sequence',
      'author',
      'body',
      'created_at',
      'deleted',
    ]) ||
    !uuid(value['id']) ||
    !uuid(value['project_id']) ||
    !uuid(value['client_message_id']) ||
    !eventSequence(value['sequence'], false) ||
    !utc(value['created_at']) ||
    !record(value['author']) ||
    !exact(value['author'], ['id', 'display_name']) ||
    !uuid(value['author']['id']) ||
    !name(value['author']['display_name']) ||
    typeof value['deleted'] !== 'boolean'
  )
    return false;
  return value['deleted']
    ? value['body'] === null
    : validChatBody(value['body']);
}
function envelope(value: Record<string, unknown>) {
  return (
    value['protocol'] === EVENTS_PROTOCOL &&
    value['version'] === EVENTS_VERSION &&
    uuid(value['project_id'])
  );
}
export function isProjectEvent(value: unknown): value is ProjectEvent {
  if (
    !record(value) ||
    !exact(value, [
      'protocol',
      'version',
      'type',
      'id',
      'project_id',
      'sequence',
      'event_type',
      'occurred_at',
      'data',
    ]) ||
    !envelope(value) ||
    value['type'] !== 'event' ||
    !uuid(value['id']) ||
    !eventSequence(value['sequence'], false) ||
    !utc(value['occurred_at']) ||
    !record(value['data'])
  )
    return false;
  const data = value['data'];
  switch (value['event_type']) {
    case 'project.changed':
      return (
        exact(data, ['metadata_version']) &&
        Number.isSafeInteger(data['metadata_version']) &&
        Number(data['metadata_version']) >= 1
      );
    case 'project.access.changed':
      return (
        exact(data, ['project_acl_version', 'workspace_acl_version']) &&
        eventSequence(data['project_acl_version'], false) &&
        eventSequence(data['workspace_acl_version'], false)
      );
    case 'revision.created':
      return exact(data, ['revision_id']) && uuid(data['revision_id']);
    case 'chat.message.created':
      return (
        exact(data, ['message']) &&
        isChatMessage(data['message']) &&
        data['message'].project_id === value['project_id'] &&
        data['message'].sequence === value['sequence']
      );
    default:
      return false;
  }
}
function ordered<T extends { readonly sequence: string; readonly id: string }>(
  items: readonly T[],
  head: string,
) {
  let previous = 0n;
  const ids = new Set<string>();
  for (const item of items) {
    const sequence = BigInt(item.sequence);
    if (sequence <= previous || sequence > BigInt(head) || ids.has(item.id))
      return false;
    previous = sequence;
    ids.add(item.id);
  }
  return true;
}
function freezeMessage(value: ChatMessage): ChatMessage {
  Object.freeze(value.author);
  return Object.freeze(value);
}
function freezeEvent(value: ProjectEvent): ProjectEvent {
  if (value.event_type === 'chat.message.created')
    freezeMessage(value.data.message);
  Object.freeze(value.data);
  return Object.freeze(value);
}
export function parseEventFrame(frame: unknown): ParseResult<EventFrame> {
  if (typeof frame !== 'string') return { ok: false, error: 'invalid_message' };
  if (
    frame.length > MAX_EVENT_FRAME_BYTES ||
    encoder.encode(frame).byteLength > MAX_EVENT_FRAME_BYTES
  )
    return { ok: false, error: 'message_too_large' };
  let value: unknown;
  try {
    value = JSON.parse(frame);
  } catch {
    return { ok: false, error: 'invalid_json' };
  }
  if (isProjectEvent(value)) return { ok: true, value: freezeEvent(value) };
  if (
    !record(value) ||
    !envelope(value) ||
    !eventSequence(value['head_sequence'])
  )
    return { ok: false, error: 'invalid_message' };
  if (
    value['type'] === 'head' &&
    exact(value, ['protocol', 'version', 'type', 'project_id', 'head_sequence'])
  )
    return { ok: true, value: Object.freeze(value) as unknown as EventFrame };
  if (
    value['type'] !== 'subscribed' ||
    !exact(value, [
      'protocol',
      'version',
      'type',
      'project_id',
      'head_sequence',
      'refresh_required',
      'events',
    ]) ||
    typeof value['refresh_required'] !== 'boolean' ||
    !Array.isArray(value['events']) ||
    value['events'].length > 10 ||
    !value['events'].every(isProjectEvent) ||
    !value['events'].every(
      (event) => event.project_id === value['project_id'],
    ) ||
    !ordered(value['events'], value['head_sequence']) ||
    (value['refresh_required'] && value['events'].length > 0)
  )
    return { ok: false, error: 'invalid_message' };
  value['events'].forEach(freezeEvent);
  Object.freeze(value['events']);
  return { ok: true, value: Object.freeze(value) as unknown as EventFrame };
}
export function parseEventPage(value: unknown, projectId: string): EventPage {
  if (
    !record(value) ||
    !exact(value, [
      'items',
      'head_sequence',
      'next_after',
      'refresh_required',
    ]) ||
    !eventSequence(value['head_sequence']) ||
    !eventSequence(value['next_after']) ||
    BigInt(value['next_after']) > BigInt(value['head_sequence']) ||
    typeof value['refresh_required'] !== 'boolean' ||
    !Array.isArray(value['items']) ||
    value['items'].length > 100 ||
    !value['items'].every(isProjectEvent) ||
    !value['items'].every((event) => event.project_id === projectId) ||
    !ordered(value['items'], value['head_sequence']) ||
    (value['refresh_required'] && value['items'].length > 0) ||
    (value['items'].length > 0 &&
      value['next_after'] !== value['items'].at(-1)?.sequence)
  )
    throw new Error('Invalid project event history.');
  value['items'].forEach(freezeEvent);
  Object.freeze(value['items']);
  return Object.freeze(value) as unknown as EventPage;
}
export function parseChatPage(value: unknown, projectId: string): ChatPage {
  if (
    !record(value) ||
    !exact(value, [
      'items',
      'head_sequence',
      'next_after',
      'next_before',
      'has_more',
    ]) ||
    !eventSequence(value['head_sequence']) ||
    !eventSequence(value['next_after']) ||
    (value['next_before'] !== null && !eventSequence(value['next_before'])) ||
    typeof value['has_more'] !== 'boolean' ||
    !Array.isArray(value['items']) ||
    value['items'].length > 100 ||
    !value['items'].every(isChatMessage) ||
    !value['items'].every((message) => message.project_id === projectId) ||
    !ordered(value['items'], value['head_sequence']) ||
    BigInt(value['next_after']) > BigInt(value['head_sequence'])
  )
    throw new Error('Invalid discussion history.');
  value['items'].forEach(freezeMessage);
  Object.freeze(value['items']);
  return Object.freeze(value) as unknown as ChatPage;
}
export function subscribeEvents(
  projectId: string,
  afterSequence: string | null,
): string {
  if (
    !uuid(projectId) ||
    (afterSequence !== null && !eventSequence(afterSequence))
  )
    throw new Error('Invalid event subscription.');
  return JSON.stringify({
    protocol: EVENTS_PROTOCOL,
    version: EVENTS_VERSION,
    type: 'subscribe',
    project_id: projectId,
    after_sequence: afterSequence,
  });
}
