import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/protocol/*.integration.test.ts'],
    passWithNoTests: false,
    fileParallelism: false,
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
