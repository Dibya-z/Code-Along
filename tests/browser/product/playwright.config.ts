import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  workers: 1,
  timeout: 60_000,
  use: {
    baseURL: 'https://127.0.0.1:18443',
    ignoreHTTPSErrors: true,
    trace: 'off',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    command:
      'CODE_ALONG_HTTPS_PORT=18443 CODE_ALONG_NATIVE_API_PORT=18001 uv run --locked --offline python tools/dev/run_native.py',
    cwd: '../../..',
    url: 'https://127.0.0.1:18443/health/ready/',
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
