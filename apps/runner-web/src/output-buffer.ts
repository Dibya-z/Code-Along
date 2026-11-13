import { RUN_LIMITS } from '@code-along/contracts/execution';
/** Coalesce byte-at-a-time Python writes before they can flood the trusted shell. */
export class WorkerOutput {
  private stream: 'stdout' | 'stderr' = 'stdout';
  private pending = '';
  private bytes = 0;
  private limited = false;
  private lastFlush = 0;
  constructor(
    private readonly send: (stream: 'stdout' | 'stderr', text: string) => void,
    private readonly limit: () => void,
    private readonly clock = () => performance.now(),
  ) {}
  append(stream: 'stdout' | 'stderr', text: string): void {
    if (this.limited || !text) return;
    this.bytes += new TextEncoder().encode(text).length;
    if (this.bytes > RUN_LIMITS.outputBytes) {
      this.flush();
      this.limited = true;
      this.limit();
      return;
    }
    if (stream !== this.stream) {
      this.flush();
      this.stream = stream;
    }
    this.pending += text;
    while (this.pending.length >= 4096) this.chunk();
    if (this.pending.endsWith('\n') && this.clock() - this.lastFlush >= 16)
      this.flush();
  }
  private chunk() {
    let length = Math.min(4096, this.pending.length);
    const last = this.pending.charCodeAt(length - 1);
    if (length < this.pending.length && last >= 0xd800 && last <= 0xdbff)
      length--;
    const text = this.pending.slice(0, length);
    this.pending = this.pending.slice(length);
    if (text) this.send(this.stream, text);
    this.lastFlush = this.clock();
  }
  flush(): void {
    while (this.pending) this.chunk();
  }
}
