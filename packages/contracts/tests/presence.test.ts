import { describe, expect, it } from 'vitest';
import {
  MAX_PRESENCE_MESSAGE_BYTES,
  PRESENCE_COLORS,
  parsePresenceIdentity,
  type PresenceIdentity,
} from '@code-along/contracts/collaboration/presence';
const fixture: PresenceIdentity = {
  protocol: 'code-along.presence',
  version: 1,
  type: 'presence.identity',
  document_id: '10000000-0000-4000-8000-000000000001',
  generation: 1,
  client_session_id: '10000000-0000-4000-8000-000000000002',
  awareness_client_id: 123,
  user: {
    id: '10000000-0000-4000-8000-000000000003',
    display_name: 'River',
    color: '#2563eb',
  },
};
const invalid = { ok: false, error: 'invalid_message' };
describe('public presence identity schema', () => {
  it('parses and freezes a minimal identity without claiming admission authority', () => {
    const parsed = parsePresenceIdentity(JSON.stringify(fixture));
    expect(parsed).toEqual({ ok: true, value: fixture });
    if (!parsed.ok) throw new Error('valid_fixture_required');
    expect(Object.isFrozen(parsed.value)).toBe(true);
    expect(Object.isFrozen(parsed.value.user)).toBe(true);
  });
  it('accepts safe generation/uint32 edges, UUIDv7 and every reviewed palette color', () => {
    for (const color of PRESENCE_COLORS) {
      const value = {
        ...fixture,
        generation: Number.MAX_SAFE_INTEGER,
        document_id: '01980000-0000-7000-8000-000000000001',
        awareness_client_id: 0xffff_ffff,
        user: { ...fixture.user, color },
      };
      expect(parsePresenceIdentity(JSON.stringify(value))).toEqual({
        ok: true,
        value,
      });
    }
    expect(
      parsePresenceIdentity(
        JSON.stringify({ ...fixture, awareness_client_id: 0 }),
      ).ok,
    ).toBe(true);
  });
  it('accepts80 Unicode code points while rejecting unprojected or lossy labels', () => {
    const user = { ...fixture.user, display_name: '🐍'.repeat(80) };
    expect(parsePresenceIdentity(JSON.stringify({ ...fixture, user })).ok).toBe(
      true,
    );
    for (const display_name of [
      '',
      ' ',
      ' River',
      'River ',
      'River  Smith',
      'River\nSmith',
      'River\tSmith',
      'River\u200bSmith',
      '\ud800',
      '🐍'.repeat(81),
    ])
      expect(
        parsePresenceIdentity(
          JSON.stringify({ ...fixture, user: { ...user, display_name } }),
        ),
      ).toEqual(invalid);
  });
  it.each([
    { protocol: 'other' },
    { version: 2 },
    { version: true },
    { type: 'checkpoint.receipt' },
    { document_id: '10000000-0000-4000-c000-000000000001' },
    { document_id: '10000000-0000-4000-8000-00000000000A' },
    { generation: 0 },
    { generation: 1.5 },
    { generation: Number.MAX_SAFE_INTEGER + 1 },
    { generation: '1' },
    { awareness_client_id: -1 },
    { awareness_client_id: 0x1_0000_0000 },
    { awareness_client_id: 1.5 },
    { awareness_client_id: true },
    { client_session_id: 'not-a-uuid' },
    { lease_id: fixture.document_id },
    { ticket: 'private' },
    { source: 'private' },
    { user: { ...fixture.user, email: 'private@example.test' } },
    { user: { ...fixture.user, color: '#000000' } },
    { user: { ...fixture.user, color: '#2563EB' } },
    { user: { ...fixture.user, id: 'invalid' } },
    { user: null },
  ])(
    'rejects unknown fields, scope confusion and invalid typed bounds %#',
    (patch) => {
      expect(
        parsePresenceIdentity(JSON.stringify({ ...fixture, ...patch })),
      ).toEqual(invalid);
    },
  );
  it('requires all exact envelope and user fields', () => {
    for (const key of Object.keys(fixture)) {
      const value = { ...fixture } as Record<string, unknown>;
      delete value[key];
      expect(parsePresenceIdentity(JSON.stringify(value))).toEqual(invalid);
    }
    for (const key of Object.keys(fixture.user)) {
      const user = { ...fixture.user } as Record<string, unknown>;
      delete user[key];
      expect(
        parsePresenceIdentity(JSON.stringify({ ...fixture, user })),
      ).toEqual(invalid);
    }
  });
  it('checks UTF8 size before JSON parsing, including the exact4096-byte boundary', () => {
    const frame = JSON.stringify(fixture),
      boundary = frame + ' '.repeat(MAX_PRESENCE_MESSAGE_BYTES - frame.length);
    expect(parsePresenceIdentity(boundary).ok).toBe(true);
    expect(parsePresenceIdentity(boundary + ' ')).toEqual({
      ok: false,
      error: 'message_too_large',
    });
    const unicode = `"${'€'.repeat(Math.ceil(MAX_PRESENCE_MESSAGE_BYTES / 3))}"`;
    expect(unicode.length).toBeLessThan(MAX_PRESENCE_MESSAGE_BYTES);
    expect(parsePresenceIdentity(unicode)).toEqual({
      ok: false,
      error: 'message_too_large',
    });
    expect(parsePresenceIdentity('{')).toEqual({
      ok: false,
      error: 'invalid_json',
    });
    for (const frame of [undefined, null, fixture, [], 0])
      expect(parsePresenceIdentity(frame)).toEqual(invalid);
  });
});
