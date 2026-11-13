import process from 'node:process';
import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  reporter: process.env['CI'] ? [['list'], ['github']] : [['list']],
  testDir: '.',
  testMatch: '**/*.spec.ts',
  workers: 1,
  fullyParallel: false,
  use: { baseURL: 'http://127.0.0.1:15173', trace: 'retain-on-failure' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: [
    {
      command:
        'corepack pnpm --filter @code-along/web exec vite preview --host 127.0.0.1 --port 15173 --strictPort',
      cwd: '../../..',
      url: 'http://127.0.0.1:15173',
      reuseExistingServer: false,
    },
    {
      command:
        'uv run --locked --offline python -m http.server 15174 --bind 127.0.0.1 --directory packages/design-system/dist/storybook',
      cwd: '../../..',
      url: 'http://127.0.0.1:15174',
      reuseExistingServer: false,
    },
  ],
});
