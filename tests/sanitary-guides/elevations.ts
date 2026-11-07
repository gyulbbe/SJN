/**
 * The class guides of some views drawn from other camera heights than the app's 10° (2026-11-07, the
 * user's "안 된 가이드 고쳐 다시 시험"): from 10° above, a 1.2 m counter's side and a bath's end show a
 * top as tall as the side, and both engines drew the long front instead. For each `class:view`, the
 * representative's guide at its size from each elevation goes to prep/<class>/rep/E<deg>/<view>.png
 * and into prep/manifest.json as guides.E<deg> (run.ts method G2E0, G2E5), with a sheet beside the 10°
 * guide. No AI.
 *
 *   node tests/run-browser-test.mjs tests/sanitary-guides/elevations.ts <0,5> <B9:left,A1:left,…>
 */
import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';
import sharp, { type OverlayOptions } from 'sharp';
import { CLASSES } from './classes';
import { OUT, PREP } from './paths.mjs';
import type { Manifest } from './prepare';
import { KOREAN_VIEW } from './prompts';

const [elevationList, viewList] = process.argv.slice(3);
if (!elevationList || !viewList) throw new Error('usage: elevations.ts <0,5> <class:view,…>');
const elevations = elevationList.split(',').map(Number);
for (const e of elevations) if (![0, 5].includes(e)) throw new Error(`elevation ${e}: only 0 or 5 (E0, E5)`);
const views = viewList.split(',').map((s) => s.split(':') as [string, keyof typeof KOREAN_VIEW]);
const manifestFile = path.join(PREP, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as Manifest;

const bundle = await build({
  entryPoints: ['tests/sanitary-guides/browser.ts'],
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'esm',
  logLevel: 'warning',
});
const server = createServer((req, res) => {
  if (req.url === '/app.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    res.end(bundle.outputFiles[0].text);
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
  }
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--enable-gpu'],
});
const rows: string[][] = [];
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto(`${origin}/`);
  for (const [id, view] of views) {
    const c = CLASSES.find((x) => x.id === id);
    const product = manifest[id]?.rep;
    if (!c || !product?.guides.G?.[view]) throw new Error(`${id} ${view}: no class or no 10° guide`);
    const row = [product.guides.G[view]];
    for (const elevation of elevations) {
      const [drawn] = await page.evaluate(
        async ({ cls, options }) => {
          const url = '/app.js';
          const app = (await import(url)) as {
            drawClass: (c: unknown, o: unknown) => Promise<{ direction: string; png: string }[]>;
          };
          return app.drawClass(cls, options);
        },
        { cls: c, options: { sizeMm: product.sizeMm, directions: [KOREAN_VIEW[view]], elevation } },
      );
      const key = `E${elevation}` as 'E0' | 'E5';
      const file = path.join(PREP, id, 'rep', key, `${view}.png`);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, Buffer.from(drawn.png, 'base64'));
      product.guides[key] = { ...product.guides[key], [view]: file };
      row.push(file);
    }
    rows.push(row);
    console.log(id, view, row.length - 1, 'guides');
  }
} finally {
  await browser.close();
  server.close();
}
writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));

// ---------- a sheet: each view's 10° guide, then the others ----------
const CELL = 220,
  LABEL = 120;
const text = (t: string, w: number, size = 16) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="28"><text x="4" y="20" font-family="Malgun Gothic" font-size="${size}" font-weight="700">${t}</text></svg>`,
  );
const comp: OverlayOptions[] = [10, ...elevations].map((e, i) => ({
  input: text(`${e}° 위에서${e === 10 ? ' (지금)' : ''}`, CELL),
  left: LABEL + i * (CELL + 6),
  top: 0,
}));
for (const [r, row] of rows.entries()) {
  const top = 30 + r * (CELL + 6);
  comp.push({ input: text(`${views[r][0]} ${KOREAN_VIEW[views[r][1]]}`, LABEL, 18), left: 0, top });
  for (const [i, file] of row.entries())
    comp.push({
      input: await sharp(file)
        .flatten({ background: '#ffffff' })
        .resize(CELL, CELL, { fit: 'contain', background: '#ffffff' })
        .png()
        .toBuffer(),
      left: LABEL + i * (CELL + 6),
      top,
    });
}
const sheet = path.join(OUT, `가이드-높이-${elevations.join('-')}.png`);
await sharp({
  create: {
    width: LABEL + (1 + elevations.length) * (CELL + 6),
    height: 30 + rows.length * (CELL + 6),
    channels: 3,
    background: '#e4e4e4',
  },
})
  .composite(comp)
  .png()
  .toFile(sheet);
console.log(sheet);
