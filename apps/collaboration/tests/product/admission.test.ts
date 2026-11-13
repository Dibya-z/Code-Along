import { describe, it, expect, vi } from 'vitest';
import {
  createAdmissionClient,
  parseGrant,
  sessionCookie,
  roomScope,
  AdmissionError,
} from '../../src/product/admission.ts';
import { grant, documentId } from './fixtures.ts';

const name = `${documentId}:1`;
describe('private product admission boundary', () => {
  it('forwards only the configured actual session cookie and rejects duplicates', () => {
    expect(
      sessionCookie(
        'other=private; codealong_session=actual; csrftoken=ignored',
        'codealong_session',
      ),
    ).toBe('codealong_session=actual');
    for (const header of [
      null,
      'codealong_session=a; codealong_session=b',
      'unrelated=a',
      'codealong_session=bad value',
    ])
      expect(() => sessionCookie(header, 'codealong_session')).toThrow(
        AdmissionError,
      );
  });
  it('rejects unbounded, wrong-room and unknown grant fields without reflecting source', () => {
    const good = grant();
    expect(parseGrant(good, name)).toBe(good);
    for (const value of [
      { ...good, extra: 'private' },
      { ...good, ttl_ms: 30_001 },
      { ...good, awareness_client_id: true },
      { ...good, document: { ...good.document, id: good.project_id } },
      {
        ...good,
        document: { ...good.document, initial_source: 'PRIVATE_SOURCE' },
      },
    ])
      expect(() => parseGrant(value, name)).toThrow();
    expect(() => roomScope(`${documentId}:01`)).toThrow();
  });
  it('uses fixed private paths and service auth; renew never forwards browser cookies', async () => {
    const good = grant(),
      fake = vi.fn<typeof fetch>(
        async () => new Response(JSON.stringify(good), { status: 200 }),
      );
    const client = createAdmissionClient({
      base: 'http://127.0.0.1:18001',
      secret: 's'.repeat(40),
      fetch: fake,
    });
    const input = {
      ticket: 'A'.repeat(43),
      document_name: name,
      connection_id: good.client_session_id,
      transport_id: good.lease_id,
      origin: 'https://app.test',
      cookie: 'codealong_session=actual',
    };
    const consumed = await client.consume(input);
    await client.renew({
      grant: good,
      document_name: name,
      connection_id: input.connection_id,
      transport_id: input.transport_id,
      deadline: consumed.started + 30_000,
      renewAt: consumed.started + 10_000,
      active: true,
    });
    expect(String(fake.mock.calls[0]![0])).toBe(
      'http://127.0.0.1:18001/internal/v1/collaboration/consume/',
    );
    expect(fake.mock.calls[0]![1]?.headers).toMatchObject({
      Cookie: 'codealong_session=actual',
      Authorization: `Bearer ${'s'.repeat(40)}`,
    });
    expect(fake.mock.calls[1]![1]?.headers).not.toHaveProperty('Cookie');
    expect(JSON.parse(fake.mock.calls[1]![1]!.body as string)).toEqual({
      version: 1,
      lease_id: good.lease_id,
      lease_token: good.lease_token,
      connection_id: input.connection_id,
      document_name: name,
    });
  });
  it('contains redirects, malformed/oversized service replies and fetch exceptions', async () => {
    for (const response of [
      new Response('x'.repeat(800_001)),
      new Response('{"version":1,"error":"PRIVATE"}', { status: 503 }),
    ]) {
      const client = createAdmissionClient({
        base: 'http://127.0.0.1',
        secret: 's'.repeat(40),
        fetch: async () => response,
      });
      await expect(
        client.consume({
          ticket: 'A'.repeat(43),
          document_name: name,
          connection_id: documentId,
          transport_id: documentId,
          origin: 'https://app.test',
          cookie: 'session=actual',
        }),
      ).rejects.toMatchObject({ code: 'unavailable', message: 'unavailable' });
    }
    expect(() =>
      createAdmissionClient({
        base: 'http://user:secret@127.0.0.1/private?token=bad',
        secret: 's'.repeat(40),
      }),
    ).toThrow();
  });
});

it('accepts projected80-codepoint astral names and refuses unprojected control/format labels', () => {
  const g = grant();
  g.user.display_name = '🐍'.repeat(80);
  expect(parseGrant(g, name).user.display_name).toHaveLength(160);
  for (const display_name of [
    '🐍'.repeat(81),
    'River\nTab',
    'River\u200bName',
    ' Learner ',
    '',
  ])
    expect(() =>
      parseGrant({ ...g, user: { ...g.user, display_name } }, name),
    ).toThrow();
});
