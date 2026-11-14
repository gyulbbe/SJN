/**
 * Compares light-tuning variants with the current code (no AI call; docs/light-tuning-results-20261114.md,
 * section 2): per scene and view, the walls' detail against `base` (how much more the joints and lines
 * show), the broad-light spread, the clipped share (criterion 2: not above the tile picture's own
 * share of 254+ pixels), and the walls' median colour as ΔE2000 from the tile's own average colour.
 *
 * Usage: node tests/run-browser-test.mjs tests/light-tuning-compare.ts --variants L1,L2,L1+L2
 * Output: the table, and test-results/light-tuning/compare.json
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { deltaE2000, type Rgb } from './helpers/delta-e';
import { ROOT, SNAPSHOT } from './tile-ai/paths.mjs';

const arg = (name: string, fallback = '') => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const OUT = join(ROOT as string, 'test-results', 'light-tuning');
type Face = {
  key: string;
  kind: 'wall' | 'floor';
  materialId?: string;
  pixels: number;
  detail: number;
  spread: number;
  clip: number;
  median: Rgb;
};
type Metrics = { means: Record<string, Rgb>; summary: Record<string, Record<string, Face[]>> };
const load = (variant: string): Metrics => {
  const file = join(OUT, variant, 'metrics.json');
  if (!existsSync(file)) throw new Error(`no metrics for ${variant}`);
  return JSON.parse(readFileSync(file, 'utf8'));
};
/** Criterion 1 is judged on these scenes, criterion 2 on the 2D views of the white ones. */
const LINES = ['scored', 'white', 'subway'],
  WHITE = ['scored', 'white'];
const walls = (faces: Face[]) => faces.filter((face) => face.kind === 'wall');
const weighted = (faces: Face[], value: (face: Face) => number) => {
  const total = faces.reduce((sum, face) => sum + face.pixels, 0);
  return total ? faces.reduce((sum, face) => sum + value(face) * face.pixels, 0) / total : NaN;
};
const deltaE = (metrics: Metrics, faces: Face[]) =>
  weighted(
    faces.filter((face) => face.materialId && metrics.means[face.materialId]),
    (face) => deltaE2000(face.median, metrics.means[face.materialId!]),
  );

/**
 * Criterion 2 as amended with the user on 2026-11-14: a white tile is not clipped whiter than its own
 * picture. The share of the tile picture's pixels at 254+ is the bound (plus 0.5 points).
 */
const catalog = JSON.parse(readFileSync(join(SNAPSHOT as string, 'catalog.json'), 'utf8')) as {
  placements: { materialId: string; textureAssetIds: string[] }[];
};
const imageFiles = Object.fromEntries(
  readdirSync(join(SNAPSHOT as string, 'images')).map((f) => [f.replace(/\.[a-z]+$/, ''), f]),
);
const whiteShare = new Map<string, number>();
const ownWhite = async (materialId: string) => {
  if (whiteShare.has(materialId)) return whiteShare.get(materialId)!;
  const record = catalog.placements.find((p) => p.materialId === materialId)!;
  const { data, info } = await sharp(
    join(SNAPSHOT as string, 'images', imageFiles[record.textureAssetIds[0]]),
  )
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let white = 0;
  for (let i = 0; i < info.width * info.height; i++)
    if (Math.max(data[i * 3], data[i * 3 + 1], data[i * 3 + 2]) >= 254) white++;
  whiteShare.set(materialId, (white / (info.width * info.height)) * 100);
  return whiteShare.get(materialId)!;
};
const base = load('base');
const report: Record<string, unknown> = {};
for (const variant of arg('variants', '').split(',').filter(Boolean)) {
  const metrics = load(variant);
  const rows: Record<string, Record<string, string>> = {};
  const checks = { lines: true, clip: true, colour: true, charcoal: true };
  for (const [scene, views] of Object.entries(metrics.summary))
    for (const [view, faces] of Object.entries(views)) {
      const was = walls(base.summary[scene]?.[view] ?? []),
        now = walls(faces);
      if (!was.length || !now.length) continue;
      const ratio = weighted(now, (f) => f.detail) / weighted(was, (f) => f.detail);
      const clip = weighted(now, (f) => f.clip);
      const e0 = deltaE(base, was),
        e1 = deltaE(metrics, now);
      const lightOf = (list: Face[]) => weighted(list, (f) => (f.median[0] + f.median[1] + f.median[2]) / 3);
      if (LINES.includes(scene) && ['capture', 'editor'].includes(view) && ratio < 1.5) checks.lines = false;
      if (WHITE.includes(scene) && ['editor', 'download'].includes(view))
        for (const face of now)
          if (face.materialId && face.clip > (await ownWhite(face.materialId)) + 0.5) checks.clip = false;
      if (e1 > e0 + 1) checks.colour = false;
      if (scene === 'charcoal' && (lightOf(now) > lightOf(was) + 2 || e1 > e0 + 0.3)) checks.charcoal = false;
      rows[`${scene} ${view}`] = {
        detail: `×${ratio.toFixed(2)}`,
        spread: `${weighted(was, (f) => f.spread).toFixed(0)}→${weighted(now, (f) => f.spread).toFixed(0)}`,
        clip: `${weighted(was, (f) => f.clip).toFixed(1)}→${clip.toFixed(1)}%`,
        light: `${lightOf(was).toFixed(0)}→${lightOf(now).toFixed(0)}`,
        dE: `${e0.toFixed(1)}→${e1.toFixed(1)}`,
      };
    }
  console.log(`\n${variant}  ${JSON.stringify(checks)}`);
  console.table(rows);
  report[variant] = { checks, rows };
}
writeFileSync(join(OUT, 'compare.json'), JSON.stringify(report, null, 1));
