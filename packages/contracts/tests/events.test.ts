import { describe, expect, it } from 'vitest';
import {
  CHAT_BLANK_CODEPOINTS,
  eventSequence,
  isChatMessage,
  parseChatPage,
  parseEventFrame,
  parseEventPage,
  subscribeEvents,
  validChatBody,
  type ChatMessage,
  type ProjectEvent,
} from '../events/index.ts';
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const message: ChatMessage = {
  id: id(1),
  project_id: id(2),
  client_message_id: id(3),
  sequence: '9007199254740993',
  author: { id: id(4), display_name: '🐍'.repeat(80) },
  body: '<script>plain text</script>\r\nπ',
  created_at: '2026-11-14T00:00:00.123456Z',
  deleted: false,
};
const event: ProjectEvent = {
  protocol: 'code-along.events',
  version: 1,
  type: 'event',
  id: id(5),
  project_id: id(2),
  sequence: message.sequence,
  occurred_at: message.created_at,
  event_type: 'chat.message.created',
  data: { message },
};
describe('strict public project event/chat contract', () => {
  it('preserves exact plaintext, author-scoped nonce and large decimal precision immutably', () => {
    const parsed = parseEventFrame(JSON.stringify(event));
    expect(parsed).toEqual({ ok: true, value: event });
    if (
      !parsed.ok ||
      parsed.value.type !== 'event' ||
      parsed.value.event_type !== 'chat.message.created'
    )
      throw new Error('Expected chat event');
    expect(Object.isFrozen(parsed.value.data.message.author)).toBe(true);
    expect(parsed.value.data.message.body).toBe(message.body);
    expect(eventSequence('9223372036854775807')).toBe(true);
    expect(eventSequence('9007199254740993')).toBe(true);
    for (const value of [
      '01',
      '-1',
      '1.0',
      '1e3',
      '',
      '9223372036854775808',
      1,
    ])
      expect(eventSequence(value)).toBe(false);
  });
  it('rejects unknown frames/fields, actor forgery, private payloads and inconsistent nested project/sequence', () => {
    for (const value of [
      { ...event, type: 'error' },
      { ...event, version: 2 },
      { ...event, source: 'private' },
      { ...event, data: { ...event.data, lease_token: 'private' } },
      { ...event, data: { message: { ...message, project_id: id(9) } } },
      { ...event, data: { message: { ...message, sequence: '1' } } },
      {
        ...event,
        data: {
          message: {
            ...message,
            author: { ...message.author, email: 'private' },
          },
        },
      },
      { ...event, event_type: 'share.changed', data: { share_id: id(9) } },
      { ...event, occurred_at: '2026-02-30T00:00:00Z' },
      { ...event, occurred_at: '2026-11-14T01:00:00+01:00' },
    ])
      expect(parseEventFrame(JSON.stringify(value)).ok).toBe(false);
    expect(parseEventFrame('{')).toEqual({ ok: false, error: 'invalid_json' });
    expect(parseEventFrame('🐍'.repeat(140000))).toEqual({
      ok: false,
      error: 'message_too_large',
    });
  });
  it('bounds UTF-8 without normalizing accepted text and enforces tombstones', () => {
    for (const point of CHAT_BLANK_CODEPOINTS) {
      const blank = String.fromCodePoint(point);
      expect(validChatBody(blank)).toBe(false);
      expect(validChatBody(`${blank}message${blank}`)).toBe(true);
      expect(
        isChatMessage({ ...message, body: `${blank}message${blank}` }),
      ).toBe(true);
    }
    expect(validChatBody('🐍'.repeat(1024))).toBe(true);
    for (const value of [
      '🐍'.repeat(1025),
      '\u0000',
      '\ud800',
      ' \r\n ',
      'x'.repeat(4097),
    ])
      expect(validChatBody(value)).toBe(false);
    expect(isChatMessage({ ...message, deleted: true, body: null })).toBe(true);
    expect(isChatMessage({ ...message, deleted: true })).toBe(false);
    expect(isChatMessage({ ...message, body: null })).toBe(false);
    expect(
      isChatMessage({
        ...message,
        author: { ...message.author, display_name: 'Hidden\u200bname' },
      }),
    ).toBe(false);
  });
  it('checks bounded hello replay and ordered scoped REST pages without treating chat gaps as event gaps', () => {
    const hello = {
      protocol: 'code-along.events',
      version: 1,
      type: 'subscribed',
      project_id: id(2),
      head_sequence: event.sequence,
      refresh_required: false,
      events: [event],
    };
    expect(parseEventFrame(JSON.stringify(hello)).ok).toBe(true);
    expect(
      parseEventFrame(JSON.stringify({ ...hello, refresh_required: true })).ok,
    ).toBe(false);
    expect(
      parseEventFrame(
        JSON.stringify({
          ...hello,
          events: Array.from({ length: 11 }, () => event),
        }),
      ).ok,
    ).toBe(false);
    expect(
      parseEventFrame(JSON.stringify({ ...hello, project_id: id(8) })).ok,
    ).toBe(false);
    const page = {
      items: [event],
      head_sequence: event.sequence,
      next_after: event.sequence,
      refresh_required: false,
    };
    expect(parseEventPage(page, id(2))).toEqual(page);
    expect(() => parseEventPage({ ...page, next_after: '1' }, id(2))).toThrow();
    expect(() => parseEventPage(page, id(8))).toThrow();
    const chat = {
      items: [
        { ...message, id: id(10), client_message_id: id(11), sequence: '1' },
        message,
      ],
      head_sequence: event.sequence,
      next_after: event.sequence,
      next_before: '1',
      has_more: true,
    };
    expect(parseChatPage(chat, id(2)).items).toHaveLength(2);
    expect(() =>
      parseChatPage({ ...chat, items: [...chat.items].reverse() }, id(2)),
    ).toThrow();
    expect(JSON.parse(subscribeEvents(id(2), null))).toEqual({
      protocol: 'code-along.events',
      version: 1,
      type: 'subscribe',
      project_id: id(2),
      after_sequence: null,
    });
    expect(() => subscribeEvents(id(2), '01')).toThrow();
  });
});
