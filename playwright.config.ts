import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1100 } } },
    { name: 'mobile', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } },
  ],
  webServer: {
    command: 'node dist/server/index.js',
    url: 'http://127.0.0.1:4173/api/health',
    reuseExistingServer: false,
    env: {
      HOST: '127.0.0.1', PORT: '4173', DATABASE_PATH: ':memory:',
      PUBLIC_URL: 'http://127.0.0.1:4173', COOKIE_SECURE: 'false',
      CREATE_RATE_LIMIT: '1000', WEBHOOK_RATE_LIMIT: '1000',
    },
  },
});
