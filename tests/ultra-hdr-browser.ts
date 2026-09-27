/**
 * Real Chrome: the five Android Ultra HDR photos go through importImage as a user would pick them.
 * The stored original is the first image only, and it decodes (Display P3 → sRGB, EXIF
 * orientation) to exactly the pixels of the photo as picked. No server, no AI.
 *
 * Usage: node tests/run-browser-test.mjs tests/ultra-hdr-browser.ts
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';

const PHOTOS =
  '.codex-remote-attachments/01a071fe-92b3-77b3-a261-8698b3d3f8e9/04c0e236-9188-46ed-9a61-a8ff283287f8';
const photos = readdirSync(PHOTOS)
  .filter((name) => name.endsWith('.jpg'))
  .map((name) => ({ name, base64: readFileSync(`${PHOTOS}/${name}`).toString('base64') }));
assert.equal(photos.length, 5);
const bundle = await build({
  stdin: {
    contents: `export {importImage} from './src/lib/images';export {extractPrimaryJpeg} from './src/lib/jpeg-container';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
  globalName: 'UltraHdr',
});
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('http://127.0.0.1:43217/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' }),
  );
  await page.goto('http://127.0.0.1:43217/');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const results = await page.evaluate(async (items) => {
    type Lib = typeof import('../src/lib/images') & typeof import('../src/lib/jpeg-container');
    type Asset = import('../src/lib/types').ImageAssetRecord;
    const lib = (window as unknown as { UltraHdr: Lib }).UltraHdr;
    const pixels = async (blob: Blob) => {
      const bitmap = await createImageBitmap(blob);
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      return {
        width: canvas.width,
        height: canvas.height,
        data: ctx.getImageData(0, 0, canvas.width, canvas.height).data,
      };
    };
    const out = [];
    for (const { name, base64 } of items) {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const stored: Asset[] = [];
      const assets = {
        put: async (asset: Asset) => void stored.push(asset),
        get: async () => {
          throw new Error('unused');
        },
        removeUnused: async () => {},
      };
      const { original, preview } = await lib.importImage(
        new File([bytes], name, { type: 'image/jpeg' }),
        'original',
        assets as never,
      );
      const saved = new Uint8Array(await original.blob.arrayBuffer());
      const expected = lib.extractPrimaryJpeg(bytes);
      const [picked, kept] = await Promise.all([
        pixels(new Blob([bytes], { type: 'image/jpeg' })),
        pixels(original.blob),
      ]);
      let differing = 0;
      for (let i = 0; i < picked.data.length; i++) if (picked.data[i] !== kept.data[i]) differing++;
      out.push({
        name,
        bytes: bytes.length,
        saved: saved.length,
        savedIsPrimary: saved.length === expected.length && saved.every((v, i) => v === expected[i]),
        endsAtEoi: saved.at(-2) === 0xff && saved.at(-1) === 0xd9,
        size: [original.width, original.height],
        decoded: [picked.width, picked.height, kept.width, kept.height],
        differing,
        preview: [preview.width, preview.height],
        stored: stored.length,
      });
    }
    return out;
  }, photos);
  if (errors.length) throw new Error(errors.join('\n'));
  console.table(results);
  for (const result of results) {
    assert.ok(result.savedIsPrimary && result.endsAtEoi && result.saved < result.bytes, result.name);
    assert.deepEqual(result.size, [960, 1280], result.name);
    assert.deepEqual(result.decoded, [960, 1280, 960, 1280], result.name);
    assert.equal(result.differing, 0, result.name);
    assert.equal(result.stored, 2, result.name);
  }
} finally {
  await browser.close();
}
