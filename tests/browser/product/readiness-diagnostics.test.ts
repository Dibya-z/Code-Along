import { expect, it } from 'vitest';
import { networkFailureCode, responseMime } from './readiness-diagnostics.ts';

it('retains fixed browser transport classes without reflecting arbitrary errors', () => {
  for (const code of [
    'net::ERR_ABORTED',
    'net::ERR_CONNECTION_RESET',
    'net::ERR_BLOCKED_BY_CSP',
    'net::ERR_CONTENT_LENGTH_MISMATCH',
  ]) {
    expect(networkFailureCode(code)).toBe(code);
  }
  expect(networkFailureCode('cancelled')).toBe('cancelled');
  expect(networkFailureCode('Load failed')).toBe('load-failed');
  expect(networkFailureCode('The network connection was lost.')).toBe(
    'connection-lost',
  );
  for (const value of [
    'https://example.test/assets/viewer.css?ticket=private-token',
    'net::ERR_CONNECTION_RESET?ticket=private-token',
    'net::ERR_UNKNOWN_PRIVATE_TOKEN',
    'Load failed: private-token',
    'Cookie: sessionid=private-token',
  ]) {
    expect(networkFailureCode(value)).toBe('other-network-failure');
    expect(networkFailureCode(value)).not.toContain('private-token');
  }
  for (const value of [undefined, null, '', 503, { error: 'private-token' }]) {
    expect(networkFailureCode(value)).toBe('unavailable');
  }
});

it('distinguishes a CSS response from an HTML fallback using fixed MIME categories', () => {
  expect(responseMime('text/css')).toBe('css');
  expect(responseMime(' TEXT/CSS ; charset=utf-8')).toBe('css');
  expect(responseMime('text/html; charset=utf-8')).toBe('html');
  expect(responseMime('application/xhtml+xml')).toBe('html');
  expect(responseMime('application/javascript; charset=utf-8')).toBe(
    'javascript',
  );
  expect(responseMime('text/javascript')).toBe('javascript');
  expect(responseMime('application/octet-stream')).toBe('octet-stream');
});

it('never reflects unknown MIME values or parameters that could contain secrets', () => {
  expect(responseMime('text/css; ticket=private-token')).toBe('css');
  for (const value of [
    'application/private-token',
    'text/css-private-token',
    'https://example.test/?ticket=private-token',
  ]) {
    expect(responseMime(value)).toBe('other');
    expect(responseMime(value)).not.toContain('private-token');
  }
  for (const value of [undefined, null, '', '  ', 200]) {
    expect(responseMime(value)).toBe('unavailable');
  }
});
