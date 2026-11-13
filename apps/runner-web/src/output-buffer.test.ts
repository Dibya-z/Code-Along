import { describe, expect, it, vi } from 'vitest';
import { WorkerOutput } from './output-buffer.ts';
describe('bounded Worker output batching', () => {
  it('turns a million tiny writes into bounded chunks and signals overflow once', () => {
    const chunks: string[] = [],
      limit = vi.fn();
    const buffer = new WorkerOutput(
      (_stream, text) => chunks.push(text),
      limit,
      () => 0,
    );
    for (let i = 0; i < 1024 * 1024 + 100; i++) buffer.append('stdout', 'x');
    buffer.flush();
    expect(chunks).toHaveLength(256);
    expect(chunks.join('').length).toBe(1024 * 1024);
    expect(limit).toHaveBeenCalledOnce();
  });
  it('preserves stream order, Unicode boundaries and explicit prompt/end flushing', () => {
    const chunks: [string, string][] = [];
    const buffer = new WorkerOutput(
      (stream, text) => chunks.push([stream, text]),
      () => {
        throw new Error('unexpected limit');
      },
      () => 0,
    );
    buffer.append('stdout', 'x'.repeat(4095) + '🐍tail');
    buffer.append('stderr', 'problem');
    buffer.append('stdout', 'Name: ');
    buffer.flush();
    expect(chunks.map(([stream]) => stream)).toEqual([
      'stdout',
      'stdout',
      'stderr',
      'stdout',
    ]);
    expect(chunks[0]![1].length).toBe(4095);
    expect(chunks[1]![1]).toBe('🐍tail');
    expect(chunks.at(-1)![1]).toBe('Name: ');
    for (const [, text] of chunks)
      expect(
        new TextDecoder('utf-8', { fatal: true }).decode(
          new TextEncoder().encode(text),
        ),
      ).toBe(text);
  });
  it('flushes complete live lines periodically without a timer inside blocked Python', () => {
    const chunks: string[] = [];
    let time = 0;
    const buffer = new WorkerOutput(
      (_stream, text) => chunks.push(text),
      () => {},
      () => time,
    );
    buffer.append('stdout', 'a\n');
    time = 20;
    buffer.append('stdout', 'b\n');
    expect(chunks).toEqual(['a\nb\n']);
  });
});
