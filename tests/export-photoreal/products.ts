/**
 * Whether each placed product survived a result (no AI call): around each product's box (15% margin)
 * the render and the result (backdrop restored, brought back to the capture's grid with the app's
 * resultOnCapture) are both cut out with the app's BiRefNet, and the two silhouettes' overlap is
 * measured. A product whose overlap is under 0.5 counts as gone or changed (docs §3, round 2).
 * Toilets, basins, vanities and baths only: a shower rail or a mirror is too thin or flat to cut out.
 *
 * Usage: node tests/run-browser-test.mjs tests/export-photoreal/products.ts [--methods a,b] [--holdout] [--gpu]
 * Output: results/<method>/<scene>-<seed>.products.json
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { resultOnCapture } from '../../src/lib/ai-export/composite';
import { fluxInputLayout } from '../../src/lib/ai-export/contract';
import type { FluxScene } from '../../src/lib/ai-export/scene-contract';
import { pngBuffer, readPng, sceneDir } from './io';
import { openLab, type Lab } from './lab';
import { RESULTS } from './paths.mjs';

const only = (() => {
  const i = process.argv.indexOf('--methods');
  return i > 0 ? process.argv[i + 1].split(',') : undefined;
})();
export const MEASURED = new Set(['toilet', 'basin', 'vanity', 'bath']);
const MARGIN = 0.15;

async function silhouette(lab: Lab, png: Buffer, width: number, height: number) {
  const cut = await lab.cutout(png);
  const alpha = await sharp(cut)
    .resize(width, height, { fit: 'fill' })
    .ensureAlpha()
    .extractChannel(3)
    .raw()
    .toBuffer();
  return Uint8Array.from(alpha, (v) => (v >= 128 ? 1 : 0));
}
const iou = (a: Uint8Array, b: Uint8Array) => {
  let both = 0,
    either = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] && b[i]) both++;
    if (a[i] || b[i]) either++;
  }
  return either ? both / either : 1;
};

const lab = await openLab({ gpu: process.argv.includes('--gpu') });
const renderCache = new Map<string, Uint8Array>();
try {
  for (const method of readdirSync(RESULTS as string)) {
    if (only && !only.includes(method)) continue;
    const folder = join(RESULTS as string, method);
    for (const file of readdirSync(folder).filter((f) => /^[a-z]+-\d+\.restored\.png$/.test(f))) {
      const [scene, seed] = file.replace('.restored.png', '').split('-');
      let dir: string;
      try {
        dir = sceneDir(scene);
      } catch {
        continue;
      }
      const base = join(folder, `${scene}-${seed}`);
      if (existsSync(`${base}.products.json`)) continue;
      const sub = method === 'inroom' ? join(dir, 'inroom') : dir;
      const capture = await readPng(join(sub, 'capture.png'));
      const layout = fluxInputLayout(capture.width, capture.height);
      const result = await readPng(`${base}.restored.png`);
      // The composite methods' results are already on the capture's grid.
      const onCapture =
        result.width === capture.width && result.height === capture.height
          ? result
          : resultOnCapture(result, layout, { width: capture.width, height: capture.height });
      const renderPng = await pngBuffer(capture);
      const resultPng = await pngBuffer(onCapture);
      const { boxes } = JSON.parse(readFileSync(join(sub, 'boxes.json'), 'utf8')) as {
        boxes: Record<string, [number, number, number, number]>;
      };
      const { scene: facts, placed } = JSON.parse(readFileSync(join(sub, 'grounding.json'), 'utf8')) as {
        scene: FluxScene;
        placed: { id: string }[];
      };
      const rows = [];
      for (const [index, item] of placed.entries()) {
        const kind = facts.fixtures[index]?.kind;
        const box = boxes[item.id];
        if (!box || !MEASURED.has(kind)) continue;
        const [l, t, r, b] = box;
        const mx = (r - l) * MARGIN,
          my = (b - t) * MARGIN;
        const left = Math.max(0, Math.floor((l - mx) * capture.width)),
          top = Math.max(0, Math.floor((t - my) * capture.height));
        const width = Math.min(capture.width, Math.ceil((r + mx) * capture.width)) - left,
          height = Math.min(capture.height, Math.ceil((b + my) * capture.height)) - top;
        if (width < 8 || height < 8) continue;
        const region = { left, top, width, height };
        const key = `${sub}:${item.id}`;
        if (!renderCache.has(key))
          renderCache.set(
            key,
            await silhouette(lab, await sharp(renderPng).extract(region).png().toBuffer(), width, height),
          );
        const ours = renderCache.get(key)!;
        const theirs = await silhouette(
          lab,
          await sharp(resultPng).extract(region).png().toBuffer(),
          width,
          height,
        );
        rows.push({ id: item.id, kind, box: [left, top, width, height], iou: +iou(ours, theirs).toFixed(3) });
      }
      writeFileSync(`${base}.products.json`, JSON.stringify(rows, null, 1));
      console.log(method, scene, seed, rows.map((r) => `${r.kind} ${r.iou}`).join(', '));
    }
  }
} finally {
  await lab.close();
}
