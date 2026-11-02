import { defineConfig, devices } from '@playwright/test';

const baseURL = 'http://127.0.0.1:4173';
export default defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { baseURL, trace: 'retain-on-failure', screenshot: 'only-on-failure', channel: process.platform === 'win32' ? 'msedge' : undefined },
  projects: [
    { name: 'desktop', testIgnore: '**/mobile.spec.ts', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } } },
    { name: 'mobile', testMatch: '**/mobile.spec.ts', use: { ...devices['Pixel 7'], defaultBrowserType: 'chromium' } },
  ],
  webServer: { command: 'npm run build && npm run preview -- --port 4173 --strictPort', url: baseURL, reuseExistingServer: false, timeout: 120_000 },
});
