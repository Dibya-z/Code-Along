import { MAX_CHECKPOINT_MESSAGE_BYTES } from '@code-along/contracts/collaboration';

/** Conservative single-process bounds; measured capacity is a separate load gate. */
export const LIMITS = Object.freeze({
  frameBytes: MAX_CHECKPOINT_MESSAGE_BYTES + 4096,
  socketPendingBytes: 4 * 1024 * 1024,
  socketPendingMessages: 64,
  socketMessagesPerSecond: 120,
  socketBytesPerSecond: 8 * 1024 * 1024,
  connections: 120,
  documentsPerSocket: 24,
  rooms: 120,
  connectionsPerRoom: 12,
  awarenessBytes: 4096,
  controlBytes: 6 * 1024 * 1024 + 64 * 1024,
});
export class IngressBudget {
  private pendingBytes = 0;
  private pendingMessages = 0;
  private windowStart = 0;
  private windowBytes = 0;
  private windowMessages = 0;
  reserve(bytes: number, now: number): void {
    if (now - this.windowStart >= 1000) {
      this.windowStart = now;
      this.windowBytes = 0;
      this.windowMessages = 0;
    }
    if (
      bytes > LIMITS.frameBytes ||
      this.pendingBytes + bytes > LIMITS.socketPendingBytes ||
      this.pendingMessages + 1 > LIMITS.socketPendingMessages ||
      this.windowBytes + bytes > LIMITS.socketBytesPerSecond ||
      this.windowMessages + 1 > LIMITS.socketMessagesPerSecond
    )
      throw new Error('resource_limit');
    this.pendingBytes += bytes;
    this.pendingMessages++;
    this.windowBytes += bytes;
    this.windowMessages++;
  }
  release(bytes: number): void {
    this.pendingBytes = Math.max(0, this.pendingBytes - bytes);
    this.pendingMessages = Math.max(0, this.pendingMessages - 1);
  }
}
