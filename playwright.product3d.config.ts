import { defineConfig } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const downloadsPath = path.join(tmpdir(), 'sjn-product3d-downloads');
mkdirSync(downloadsPath, { recursive: true });

export default defineConfig({
  testDir: './e2e',
  testMatch: ['product3d.spec.ts', 'material-images.spec.ts'],
  outputDir: './test-results/product3d-browser',
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  use: {
    channel: 'chrome',
    launchOptions: { downloadsPath },
    actionTimeout: 20_000,
    screenshot: 'only-on-failure',
    viewport: { width: 1440, height: 1100 },
    acceptDownloads: true,
  },
  reporter: 'line',
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
