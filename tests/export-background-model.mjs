// Copies the cached BiRefNet FP16 model out of the local QA Chrome profile into tmp/background-model
// for tests/product3d-batch-browser.ts, without a network download. Needs a dev server on 127.0.0.1:3000,
// because Cache Storage belongs to that origin. Run: node tests/export-background-model.mjs
import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
const cache = 'sjn-background-removal-model-v1';
const folder = path.resolve('tmp/background-model');
await fs.mkdir(folder, { recursive: true });
const context = await chromium.launchPersistentContext(path.resolve('tmp/multiview-chrome-profile'), {
  channel: 'chrome',
  headless: true,
});
try {
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto('http://127.0.0.1:3000/materials');
  const keys = await page.evaluate(
    async (name) => (await (await caches.open(name)).keys()).map((r) => r.url),
    cache,
  );
  console.log('cached', keys);
  for (const url of keys) {
    const size = await page.evaluate(
      async ({ name, url }) => {
        const blob = await (await (await caches.open(name)).match(url)).blob();
        window.exportBlob = blob;
        return blob.size;
      },
      { name: cache, url },
    );
    const target = path.join(folder, url.split('/').at(-1).split('?')[0]);
    const handle = await fs.open(target, 'w');
    const step = 8 * 1024 * 1024;
    for (let start = 0; start < size; start += step) {
      const chunk = await page.evaluate(
        async ({ start, end }) => {
          const bytes = new Uint8Array(await window.exportBlob.slice(start, end).arrayBuffer());
          let text = '';
          for (let i = 0; i < bytes.length; i += 0x8000)
            text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          return btoa(text);
        },
        { start, end: Math.min(size, start + step) },
      );
      await handle.write(Buffer.from(chunk, 'base64'));
    }
    await handle.close();
    console.log(target, (await fs.stat(target)).size);
  }
} finally {
  await context.close();
}
