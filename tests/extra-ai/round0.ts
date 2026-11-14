/**
 * Round 0 of the added-objects trial (no AI call): O3a (erase.ts, every wall and floor) on the tile AI
 * trial's rated results (11-13, review t4), where the user marked "없던 물건이 생김" on some and not on
 * the others. For each: the app's picture, the same with O3a, and O3a's objects boxed (red), side by
 * side; and a summary of what it found and how much of the faces it changed, by the user's mark.
 *
 * Usage: node tests/run-browser-test.mjs tests/extra-ai/round0.ts [--only t4-s009,t4-s022]
 *          [--criteria dark,bright,colour]
 * Output: test-results/extra-ai-20261114/round0/<criteria>/<id>.png, summary.json
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { ROOT } from '../export-photoreal/paths.mjs';
import { appView, loadScene, pixels, png, type TrialScene } from './app-view';
import { ALL_CRITERIA } from './erase';
import { OUT } from './paths.mjs';

const only = (() => {
  const i = process.argv.indexOf('--only');
  return i > 0 ? new Set(process.argv[i + 1].split(',')) : undefined;
})();
/** Which of O3's tests to use (all by default). */
const criteria = (() => {
  const i = process.argv.indexOf('--criteria');
  if (i < 0) return ALL_CRITERIA;
  const on = new Set(process.argv[i + 1].split(','));
  return { dark: on.has('dark'), bright: on.has('bright'), colour: on.has('colour'), edges: on.has('edges') };
})();
const tag = process.argv.includes('--criteria')
  ? process.argv[process.argv.indexOf('--criteria') + 1].replace(/,/g, '-')
  : 'all';
const TILE = join(ROOT, 'test-results', 'tile-ai-20261113');
const key = (
  JSON.parse(readFileSync(join(TILE, 'review', 't4', 'key.json'), 'utf8')) as {
    singles: Record<string, { method: string; scene: string; seed: number }>;
  }
).singles;
const ratings = new Map<string, { flags?: string[]; note?: string }>();
for (const line of readFileSync(join(TILE, 'review', 't4', 'ratings.jsonl'), 'utf8').split('\n'))
  if (line.trim()) {
    const row = JSON.parse(line) as { id: string; flags?: string[]; note?: string };
    ratings.set(row.id, row);
  }
const out = join(OUT as string, 'round0', tag);
mkdirSync(out, { recursive: true });
const scenes = new Map<string, TrialScene>();
const rows: Record<string, unknown>[] = [];
for (const [id, job] of Object.entries(key)) {
  if (only && !only.has(id)) continue;
  const rating = ratings.get(id);
  if (!rating || job.method.endsWith('+restore')) continue;
  const file = join(TILE, 'results', 'cf', job.method, `${job.scene}-${job.seed}.png`);
  if (!existsSync(file)) continue;
  if (!scenes.has(job.scene))
    scenes.set(job.scene, await loadScene(join(TILE, 'scenes', job.scene), 'capture-grout.png'));
  const scene = scenes.get(job.scene)!;
  const result = await pixels(file);
  const started = Date.now();
  const plain = appView(scene, result);
  const erased = appView(scene, result, { criteria });
  const ms = Date.now() - started;
  const objects = erased.erased?.objects ?? [];
  const { width, height } = plain.shown;
  const boxes = objects
    .map(
      (o) =>
        `<rect x="${o.box[0]}" y="${o.box[1]}" width="${o.box[2]}" height="${o.box[3]}" fill="none" stroke="#ff2020" stroke-width="2"/>`,
    )
    .join('');
  const marked = await sharp(await png(erased.shown))
    .composite([
      {
        input: Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${boxes}</svg>`,
        ),
      },
    ])
    .png()
    .toBuffer();
  await sharp({ create: { width: width * 3 + 16, height, channels: 3, background: '#ffffff' } })
    .composite([
      { input: await png(plain.shown), left: 0, top: 0 },
      { input: await png(erased.shown), left: width + 8, top: 0 },
      { input: marked, left: 2 * (width + 8), top: 0 },
    ])
    .png()
    .toFile(join(out, `${id}.png`));
  const changed = Object.values(erased.erased?.changed ?? {});
  const row = {
    id,
    ...job,
    added: (rating.flags ?? []).includes('added'),
    note: rating.note ?? '',
    objects: objects.length,
    reasons: objects.map((o) => `${o.reasons.join('+')}:${o.cells}`),
    changedMax: +Math.max(0, ...changed).toFixed(4),
    changedMean: +(changed.reduce((s, v) => s + v, 0) / Math.max(1, changed.length)).toFixed(4),
    skipped: erased.erased?.skipped ?? 0,
    aligned: erased.aligned,
    ms,
  };
  rows.push(row);
  console.log(
    id,
    row.added ? 'ADDED' : 'clean',
    job.method,
    job.scene,
    job.seed,
    `objects ${row.objects}`,
    `changed max ${row.changedMax}`,
    `${ms} ms`,
  );
}
writeFileSync(join(out, 'summary.json'), JSON.stringify(rows, null, 1));
const group = (added: boolean) => rows.filter((r) => r.added === added);
for (const added of [true, false]) {
  const set = group(added);
  const found = set.filter((r) => (r.objects as number) > 0).length;
  console.log(added ? 'marked added' : 'not marked', `${found}/${set.length} with objects found`);
}
