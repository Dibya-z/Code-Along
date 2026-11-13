import { describe, expect, it, vi } from 'vitest';
import { installFileBudgets, type BudgetedFS } from './file-budgets.ts';
import { PRACTICE_BUDGETS } from '@code-along/contracts/execution/budgets';
function fixture() {
  const node = { mode: 1, usedBytes: 16 },
    stream = { node, position: 0, flags: 0 };
  const fs: BudgetedFS = {
    isFile: (mode) => mode === 1,
    ErrnoError: class extends Error {
      constructor(readonly errno: number) {
        super('Virtual file budget reached');
      }
    },
    mknod: vi.fn((_path, mode) => ({ mode, usedBytes: 0 })),
    write: vi.fn((target, _buffer, _offset, length, position) => {
      const writable = target.node as typeof node;
      writable.usedBytes = Math.max(
        writable.usedBytes,
        (position ??
          (target.flags & 1024 ? writable.usedBytes : target.position)) +
          length,
      );
      return length;
    }),
    doTruncate: vi.fn((_stream, target, length) => {
      (target as typeof node).usedBytes = length;
    }),
  };
  const onLimit = vi.fn();
  installFileBudgets(fs, onLimit);
  return { fs, node, stream, onLimit };
}
describe('soft virtual file budgets on pinned MEMFS APIs', () => {
  it('bounds sparse/append growth before writing and does not replenish quota on truncation', () => {
    const { fs, node, stream, onLimit } = fixture();
    const bytes = new Uint8Array();
    fs.write(stream, bytes, 0, PRACTICE_BUDGETS.fileGrowthBytes + 16, 0);
    expect(node.usedBytes).toBe(PRACTICE_BUDGETS.fileGrowthBytes + 16);
    fs.write(stream, bytes, 0, 10, 0); // overwrite is allowed
    stream.flags = 1024;
    expect(() => fs.write(stream, bytes, 0, 1)).toThrow('Virtual file budget');
    fs.doTruncate(null, node, 0);
    expect(() => fs.doTruncate(null, node, 1)).toThrow('Virtual file budget');
    expect(onLimit).toHaveBeenCalledOnce();
  });
  it('counts successful file/node creations and rejects oversized paths', () => {
    const { fs } = fixture();
    for (let i = 0; i < PRACTICE_BUDGETS.fileCreations; i++)
      fs.mknod(`/file-${i}`, 1, 0);
    expect(() => fs.mknod('/extra', 1, 0)).toThrow('Virtual file budget');
    for (
      let i = PRACTICE_BUDGETS.fileCreations;
      i < PRACTICE_BUDGETS.nodeCreations;
      i++
    )
      fs.mknod(`/dir-${i}`, 0, 0);
    expect(() => fs.mknod('/extra-dir', 0, 0)).toThrow('Virtual file budget');
    const fresh = fixture();
    expect(() => fresh.fs.mknod('x'.repeat(1025), 1, 0)).toThrow(
      'Virtual file budget',
    );
  });
  it('does not charge character-device output against regular file storage', () => {
    const { fs } = fixture();
    const stream = { node: { mode: 0 }, flags: 0, position: 0 };
    expect(() =>
      fs.write(
        stream,
        new Uint8Array(),
        0,
        PRACTICE_BUDGETS.fileGrowthBytes + 1,
      ),
    ).not.toThrow();
  });
});
