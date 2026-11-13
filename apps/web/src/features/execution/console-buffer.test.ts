import { describe, expect, it } from 'vitest';
import { ConsoleBuffer, CONSOLE_LIMITS } from './console-buffer.ts';
describe('bounded plain-text console', () => {
  it('coalesces partial writes, retains blank lines and separates stderr without mutating snapshots', () => {
    const buffer = new ConsoleBuffer();
    buffer.append('stdout', 'Hel');
    const first = buffer.snapshot();
    buffer.append('stdout', 'lo\r\n\nworld');
    buffer.append('stderr', 'error');
    expect(first[0]?.text).toBe('Hel');
    expect(buffer.snapshot().map(({ stream, text }) => [stream, text])).toEqual(
      [
        ['stdout', 'Hello'],
        ['stdout', ''],
        ['stdout', 'world'],
        ['stderr', 'error'],
      ],
    );
  });
  it('strips split ANSI/OSC sequences and controls while preserving literal HTML and Unicode', () => {
    const buffer = new ConsoleBuffer();
    for (const part of [
      '\x1b[3',
      '1mred\x1b[0m\x1b]8;;https://bad',
      '\x07link\x1b]8;;\x1b',
      '\\<img onerror=x> 🐍\b',
    ])
      buffer.append('stdout', part);
    expect(buffer.snapshot()[0]?.text).toBe('redlink<img onerror=x> 🐍');
    buffer.append('stderr', '\x1b[31merror\x1b[0m');
    expect(buffer.snapshot().at(-1)?.text).toBe('error');
  });
  it('bounds line count and wraps very long logical lines without splitting code points', () => {
    const buffer = new ConsoleBuffer();
    buffer.append(
      'stdout',
      'a'.repeat(CONSOLE_LIMITS.lineCharacters - 1) + '🐍',
    );
    expect(buffer.snapshot().map((row) => row.text.length)).toEqual([8191, 2]);
    buffer.clear();
    expect(buffer.append('stdout', '\n'.repeat(CONSOLE_LIMITS.lines))).toBe(
      true,
    );
    expect(buffer.append('stdout', 'one more')).toBe(false);
    expect(buffer.snapshot()).toHaveLength(CONSOLE_LIMITS.lines);
  });
  it('handles many tiny chunks as one row and keeps escape state across Clear', () => {
    const buffer = new ConsoleBuffer();
    for (let i = 0; i < 4000; i++) buffer.append('stdout', 'x');
    expect(buffer.snapshot()).toHaveLength(1);
    buffer.append('stdout', '\x1b]');
    buffer.clear();
    buffer.append('stdout', 'hidden\x07visible');
    expect(buffer.snapshot()[0]?.text).toBe('visible');
  });
});
