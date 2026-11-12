import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'apps/**/*.test.ts',
      'packages/**/*.test.ts',
      'tests/**/*.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/.git/**', '**/*.integration.test.ts'],
    passWithNoTests: false,
    testTimeout: 10_000,
  },
});
