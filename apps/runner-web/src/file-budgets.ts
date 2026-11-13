import { PRACTICE_BUDGETS } from '@code-along/contracts/execution/budgets';
interface FileNode {
  readonly mode: number;
  readonly usedBytes?: number;
}
interface FileStream {
  readonly node: FileNode;
  readonly position: number;
  readonly flags: number;
}
export interface BudgetedFS {
  isFile(mode: number): boolean;
  ErrnoError: new (code: number) => Error;
  mknod(path: string, mode: number, device: number): FileNode;
  write(
    stream: FileStream,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position?: number,
    canOwn?: boolean,
  ): number;
  doTruncate(stream: FileStream | null, node: FileNode, length: number): void;
}
/** Soft product controls on pinned MEMFS APIs, not a security or hard RAM boundary. */
export function installFileBudgets(
  fs: BudgetedFS,
  onLimit: () => void = () => {},
): void {
  let reported = false;
  let growth = 0,
    files = 0,
    nodes = 0;
  const mknod = fs.mknod.bind(fs),
    write = fs.write.bind(fs),
    truncate = fs.doTruncate.bind(fs);
  const exhausted = (): never => {
    if (!reported) {
      reported = true;
      onLimit();
    }
    throw new fs.ErrnoError(51);
  }; // Pinned Emscripten ENOSPC.
  const admission = (node: FileNode, end: number) => {
    if (!fs.isFile(node.mode)) return 0;
    const increase = Math.max(0, end - (node.usedBytes ?? 0));
    if (
      !Number.isSafeInteger(end) ||
      increase > PRACTICE_BUDGETS.fileGrowthBytes - growth
    )
      exhausted();
    return increase;
  };
  fs.mknod = (path, mode, device) => {
    if (
      path.length > PRACTICE_BUDGETS.virtualPathCharacters ||
      nodes >= PRACTICE_BUDGETS.nodeCreations ||
      (fs.isFile(mode) && files >= PRACTICE_BUDGETS.fileCreations)
    )
      exhausted();
    const node = mknod(path, mode, device);
    nodes++;
    if (fs.isFile(mode)) files++;
    return node;
  };
  fs.write = (stream, buffer, offset, length, position, canOwn) => {
    const before = stream.node.usedBytes ?? 0;
    const end =
      (position ?? (stream.flags & 1024 ? before : stream.position)) + length;
    admission(stream.node, end);
    const written = write(stream, buffer, offset, length, position, canOwn);
    if (fs.isFile(stream.node.mode))
      growth += Math.max(0, (stream.node.usedBytes ?? before) - before);
    return written;
  };
  fs.doTruncate = (stream, node, length) => {
    const increase = admission(node, length);
    truncate(stream, node, length);
    growth += increase;
  };
}
