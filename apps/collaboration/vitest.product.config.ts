import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/product/*.integration.test.ts'],
    passWithNoTests: false,
    fileParallelism: false,
    testTimeout: 10_000,
    hookTimeout: 30_000,
  },
});
