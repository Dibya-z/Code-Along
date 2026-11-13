import { expect, it } from 'vitest';
import { privateMailLink } from './mail-link.ts';

const message = (recipient: string, key: string, kind = 'verify') =>
  `To: ${recipient}\nSubject: Owned fixture\n\nhttps://127.0.0.1:18443/auth/${kind}?key=${key}\n${'-'.repeat(79)}\n`;

it('matches recipient and action within one message in a combined private spool file', () => {
  const spool =
    message('owner@example.test', 'owner-fixture') +
    message('learner@example.test', 'learner-fixture');
  expect(privateMailLink(spool, 'learner@example.test', 'verify')).toBe(
    'https://127.0.0.1:18443/auth/verify?key=learner-fixture',
  );
  expect(privateMailLink(spool, 'owner@example.test', 'verify')).toBe(
    'https://127.0.0.1:18443/auth/verify?key=owner-fixture',
  );
  expect(
    privateMailLink(spool, 'other@example.test', 'verify'),
  ).toBeUndefined();
  expect(
    privateMailLink(spool, 'learner@example.test', 'reset'),
  ).toBeUndefined();
});

it('selects the newest matching message and accepts CRLF without matching recipient prefixes', () => {
  const spool =
    message('river@example.test', 'old-fixture') +
    message('river@example.test.attacker.test', 'other-fixture') +
    message('river@example.test', 'new-fixture');
  expect(
    privateMailLink(
      spool.replace(/\n/g, '\r\n'),
      'river@example.test',
      'verify',
    ),
  ).toBe('https://127.0.0.1:18443/auth/verify?key=new-fixture');
});
