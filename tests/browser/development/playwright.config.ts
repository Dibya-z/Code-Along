import { defineConfig, devices } from '@playwright/test';
import process from 'node:process';
if (process.env['CODE_ALONG_DEVELOPMENT_PROOF'] !== 'true') {
  throw new Error(
    'Start the isolated Compose development-test stack and set CODE_ALONG_DEVELOPMENT_PROOF=true.',
  );
}
const origin = new URL(
  process.env['CODE_ALONG_DEVELOPMENT_ORIGIN'] ?? 'https://127.0.0.1:8443',
);
if (
  origin.protocol !== 'https:' ||
  origin.hostname !== '127.0.0.1' ||
  origin.pathname !== '/' ||
  origin.search ||
  origin.hash ||
  origin.username ||
  origin.password
) {
  throw new Error(
    'Development browser checks require the owned loopback HTTPS stack.',
  );
}
export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  forbidOnly: true,
  workers: 1,
  timeout: 30_000,
  use: {
    baseURL: origin.origin,
    ignoreHTTPSErrors: true,
    trace: 'off',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
});
