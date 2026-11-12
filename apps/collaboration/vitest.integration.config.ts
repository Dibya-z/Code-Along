import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/persistence/*.integration.test.ts'],
    passWithNoTests: false,
    fileParallelism: false,
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
});
