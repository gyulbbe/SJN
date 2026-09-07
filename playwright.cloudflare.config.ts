import { defineConfig } from '@playwright/test';

// Build first with npm run build:vinext so this exercises the deployed Worker output.
export default defineConfig({
  testDir: './e2e',
  testMatch: 'cloudflare-local.spec.ts',
  outputDir: './test-results/cloudflare',
  fullyParallel: false,
  workers: 1,
  timeout: 180000,
  expect: { timeout: 15000 },
  use: {
    channel: 'chrome',
    baseURL: 'http://127.0.0.1:8787',
    viewport: { width: 1440, height: 1000 },
    actionTimeout: 15000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: {
      args: ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    },
  },
  webServer: {
    command: 'npm run start:vinext',
    url: 'http://127.0.0.1:8787',
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },
});
