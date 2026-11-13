import { it, expect } from 'vitest';
import { IngressBudget, LIMITS } from '../../src/product/limits.ts';
it('bounds authenticated queued operations, bytes and rate before Hocuspocus allocation', () => {
  const ops = new IngressBudget();
  for (let i = 0; i < LIMITS.socketPendingMessages; i++) ops.reserve(1, 1000);
  expect(() => ops.reserve(1, 1000)).toThrow();
  ops.release(1);
  expect(() => ops.reserve(1, 1000)).not.toThrow();
  const bytes = new IngressBudget();
  for (let i = 0; i < 2; i++) bytes.reserve(LIMITS.frameBytes, 1000);
  expect(() => bytes.reserve(LIMITS.frameBytes, 1000)).toThrow();
  const rate = new IngressBudget();
  for (let i = 0; i < LIMITS.socketMessagesPerSecond; i++) {
    rate.reserve(1, 1000);
    rate.release(1);
  }
  expect(() => rate.reserve(1, 1000)).toThrow();
  expect(() => rate.reserve(1, 2000)).not.toThrow();
});
