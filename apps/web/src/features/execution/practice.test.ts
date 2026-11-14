import { describe, expect, it } from 'vitest';
import { checksCopyError } from './practice.ts';

describe('bounded in-memory practice check text', () => {
  it.each(['x'.repeat(16384), 'π'.repeat(8192), '\uFEFFprint("exact")\r\n'])(
    'accepts exact scalar text at the UTF-8 boundary',
    (source) => {
      expect(checksCopyError(source)).toBeNull();
    },
  );
  it.each(['x'.repeat(16385), 'π'.repeat(8193)])(
    'rejects an oversized copy without truncating it',
    (source) => {
      expect(checksCopyError(source)).toContain('16 KiB');
    },
  );
  it.each(['', '\uFEFF\t\u0085\u001c', '\u3000\u200a\n'])(
    'uses the shared nonblank codepoint contract',
    (source) => {
      expect(checksCopyError(source)).toContain('Add some Python');
    },
  );
  it.each(['print(1)\0', '\ud800'])(
    'rejects NUL and non-scalar Unicode',
    (source) => {
      expect(checksCopyError(source)).toContain('valid Unicode');
    },
  );
});
