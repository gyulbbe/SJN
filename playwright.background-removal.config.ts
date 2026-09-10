import { defineConfig } from '@playwright/test';

const cloudflare = process.env.SJN_AI_BACKGROUND_TARGET === 'cloudflare';
export default defineConfig({
  testDir: './e2e',
  testMatch: [
    'background-removal.spec.ts',
    'background-removal-failures.spec.ts',
    'background-removal-wasm.spec.ts',
    'background-removal-cache.spec.ts',
  ],
  outputDir: './test-results/background-removal-browser',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    channel: 'chrome',
    baseURL: cloudflare ? 'http://127.0.0.1:8787' : 'http://127.0.0.1:3000',
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: { args: [] },
  },
  webServer: {
    command: cloudflare ? 'npm run start:vinext' : 'npm run dev',
    url: cloudflare ? 'http://127.0.0.1:8787' : 'http://127.0.0.1:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
