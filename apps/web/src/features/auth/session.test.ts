import { describe, it, expect } from 'vitest';
import { safeDestination } from './session.ts';
describe('post-authentication destination', () => {
  it('rejects external URLs and unrecognised paths', () => {
    for (const path of [
      'https://evil.invalid',
      '//evil.invalid',
      '/\\evil.invalid',
      '/api/v1/me/',
      '/invitations/token?next=//evil.invalid',
    ])
      expect(safeDestination(path)).toBe('/workspaces');
  });
  it('preserves only a complete invitation route', () => {
    const path = '/invitations/' + 'a'.repeat(43);
    expect(safeDestination(path)).toBe(path);
    expect(safeDestination(path + '?extra=1')).toBe('/workspaces');
  });
});
