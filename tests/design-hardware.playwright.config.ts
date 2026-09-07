import { defineConfig } from '@playwright/test';
import base from '../playwright.config';
import path from 'node:path';
/** Same UI assertions; use the machine's actual ANGLE backend instead of forced SwiftShader. */
export default defineConfig({
  ...base,
  testDir: path.resolve(process.cwd(), 'e2e'),
  outputDir: path.resolve(process.cwd(), 'test-results/design-comparison-hardware-after'),
  use: { ...base.use, launchOptions: { args: ['--enable-webgl', '--ignore-gpu-blocklist'] } },
});
