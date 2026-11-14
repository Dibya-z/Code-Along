const networkFailureCodes = [
  'net::ERR_ABORTED',
  'net::ERR_BLOCKED_BY_CLIENT',
  'net::ERR_BLOCKED_BY_CSP',
  'net::ERR_BLOCKED_BY_RESPONSE',
  'net::ERR_CERT_AUTHORITY_INVALID',
  'net::ERR_CONNECTION_CLOSED',
  'net::ERR_CONNECTION_REFUSED',
  'net::ERR_CONNECTION_RESET',
  'net::ERR_CONNECTION_TIMED_OUT',
  'net::ERR_CONTENT_DECODING_FAILED',
  'net::ERR_CONTENT_LENGTH_MISMATCH',
  'net::ERR_EMPTY_RESPONSE',
  'net::ERR_FAILED',
  'net::ERR_HTTP_RESPONSE_CODE_FAILURE',
  'net::ERR_INTERNET_DISCONNECTED',
  'net::ERR_NAME_NOT_RESOLVED',
  'net::ERR_NETWORK_CHANGED',
  'net::ERR_SSL_PROTOCOL_ERROR',
  'net::ERR_TIMED_OUT',
] as const;

export type NetworkFailureCode =
  | (typeof networkFailureCodes)[number]
  | 'cancelled'
  | 'load-failed'
  | 'connection-lost'
  | 'other-network-failure'
  | 'unavailable';

export function networkFailureCode(value: unknown): NetworkFailureCode {
  if (typeof value !== 'string' || !value) return 'unavailable';
  const known = networkFailureCodes.find((code) => value === code);
  if (known) return known;
  if (value === 'cancelled') return 'cancelled';
  if (value === 'Load failed') return 'load-failed';
  if (value === 'The network connection was lost.') return 'connection-lost';
  return 'other-network-failure';
}

export type ResponseMime =
  'css' | 'html' | 'javascript' | 'octet-stream' | 'other' | 'unavailable';

export function responseMime(value: unknown): ResponseMime {
  if (typeof value !== 'string' || !value.trim()) return 'unavailable';
  switch (value.split(';', 1)[0]?.trim().toLowerCase()) {
    case 'text/css':
      return 'css';
    case 'text/html':
    case 'application/xhtml+xml':
      return 'html';
    case 'text/javascript':
    case 'application/javascript':
    case 'application/ecmascript':
    case 'text/ecmascript':
      return 'javascript';
    case 'application/octet-stream':
      return 'octet-stream';
    default:
      return 'other';
  }
}
