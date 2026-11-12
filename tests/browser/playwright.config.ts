import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './specs',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 60000,
  expect: { timeout: 40000 },
  use: {
    baseURL: 'https://127.0.0.1:9443',
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node server.ts',
    url: 'https://127.0.0.1:9443/health',
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    timeout: 30000,
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: { args: ['--ignore-certificate-errors'] },
      },
    },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
});
