/**
 * The fixture-streaks trial's pictures (no AI call, docs/fixture-streaks-20261117.md): each result as
 * the app shows it today (`now`: current-refine.ts with the model's fixture outline, as
 * tests/fixture-haze/pictures.ts f1), the render where the model sees it (`ref`), the model's picture
 * (`raw`), and each candidate rule on today's picture.
 *
 * Usage: node tests/run-browser-test.mjs tests/fixture-streaks/pictures.ts [--set dev|holdout|new|new-holdout] [--rules a,b]
 * Output: test-results/fixture-streaks-20261117/pictures/<id>.<rule>.png, pictures-<set>.json
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { restoreBackdrop } from '../../src/lib/ai-export/backdrop';
import { framing, projectCapture, type Pixels, type RegionMask } from '../../src/lib/ai-export/color';
import { refineCurrentResult } from '../../src/lib/ai-export/current-refine';
import { type Cut } from '../../src/lib/ai-export/fixture-outline';
import type { FluxScene } from '../../src/lib/ai-export/scene-contract';
import { loadScene, pixels, png } from '../extra-ai/app-view';
import { OUT as HAZE } from '../fixture-haze/paths.mjs';
import { haze, type HazeSet } from '../fixture-haze/sources';
import { keepFixtureLight, type StreakOptions } from './method';
import { OUT } from './paths.mjs';

const arg = (name: string, fallback = '') => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const set = arg('set', 'dev') as HazeSet;
/** Candidate rules: name → options. */
export const RULES: Record<string, StreakOptions> = {
  k25s08: { keep: 0.25, share: 0.08 },
  k50s08: { keep: 0.5, share: 0.08 },
  k25s15: { keep: 0.25, share: 0.15 },
  k50s15: { keep: 0.5, share: 0.15 },
  k25s04: { keep: 0.25, share: 0.04 },
  k0s08: { keep: 0, share: 0.08 },
  k50s04: { keep: 0.5, share: 0.04 },
  k25s04m: { keep: 0.25, share: 0.04, anchor: 'mean' },
  k25s08m: { keep: 0.25, share: 0.08, anchor: 'mean' },
  k25s04q: { keep: 0.25, share: 0.04, anchor: 0.75 },
  k25s08q: { keep: 0.25, share: 0.08, anchor: 0.75 },
  k25s04qw: { keep: 0.25, share: 0.04, anchor: 0.75, refWide: 2 },
  k25s06qw: { keep: 0.25, share: 0.06, anchor: 0.75, refWide: 2 },
  k50s04qw: { keep: 0.5, share: 0.04, anchor: 0.75, refWide: 2 },
};
const rules = arg('rules', Object.keys(RULES).join(',')).split(',').filter(Boolean);
const PAD = 0.3;
const dir = join(OUT as string, 'pictures');
mkdirSync(dir, { recursive: true });

async function cutsOf(id: string, scene: FluxScene, size: { width: number; height: number }) {
  const cuts: Cut[] = [];
  for (const [k, fixture] of scene.fixtures.entries()) {
    const file = join(HAZE as string, 'cutout', id, `cut-${k}.png`);
    if (!fixture.box || !existsSync(file)) continue;
    const [l, t, r, b] = fixture.box;
    const bw = r - l,
      bh = b - t;
    const left = Math.max(0, Math.floor((l - bw * PAD) * size.width)),
      top = Math.max(0, Math.floor((t - bh * PAD) * size.height)),
      right = Math.min(size.width, Math.ceil((r + bw * PAD) * size.width)),
      bottom = Math.min(size.height, Math.ceil((b + bh * PAD) * size.height));
    const alpha = new Uint8Array(
      await sharp(file)
        .ensureAlpha()
        .extractChannel(3)
        .resize(right - left, bottom - top, { fit: 'fill' })
        .raw()
        .toBuffer(),
    );
    cuts.push({ fixture: k, left, top, width: right - left, height: bottom - top, alpha });
  }
  return cuts;
}

function shifted(image: Pixels, dx: number, dy: number): Pixels {
  const { width, height } = image;
  const data = new Uint8ClampedArray(image.data.length);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const sx = Math.max(0, Math.min(width - 1, x - dx)),
        sy = Math.max(0, Math.min(height - 1, y - dy));
      for (let c = 0; c < 4; c++) data[(y * width + x) * 4 + c] = image.data[(sy * width + sx) * 4 + c];
    }
  return { width, height, data };
}

const rows = [];
for (const source of haze(set)) {
  if (!existsSync(source.result)) continue;
  const scene = await loadScene(source.dir, source.jointsFile);
  const result = await pixels(source.result);
  const size = { width: result.width, height: result.height };
  const reference = projectCapture(scene.capture, scene.layout, size);
  const layers = join(HAZE as string, 'behind', source.layers);
  const behind = await pixels(join(layers, 'behind.png'));
  const regions = JSON.parse(readFileSync(join(layers, 'regions-behind.json'), 'utf8')) as Omit<
    RegionMask,
    'data'
  >;
  const behindMask: RegionMask = {
    ...regions,
    data: new Uint8Array(await sharp(join(layers, 'mask-behind.png')).extractChannel(0).raw().toBuffer()),
  };
  const first = framing(reference, result);
  if (!first.aligned) {
    rows.push({ id: source.id, aligned: false });
    continue;
  }
  const checked =
    (scene.mask.outside
      ? restoreBackdrop({
          result,
          capture: scene.capture,
          mask: scene.mask,
          layout: scene.layout,
          shift: first,
        })
      : undefined) ?? result;
  const refined = refineCurrentResult({
    raw: checked,
    capture: scene.capture,
    mask: scene.mask,
    layout: scene.layout,
    joints: scene.joints,
    fixtures: scene.scene.fixtures,
    behind: { image: behind, mask: behindMask },
    cuts: await cutsOf(source.id, scene.scene, size),
  });
  const now = refined.shown ?? checked;
  const frame = refined.review.framing;
  writeFileSync(join(dir, `${source.id}.now.png`), await png(now));
  writeFileSync(join(dir, `${source.id}.raw.png`), await png(checked));
  writeFileSync(join(dir, `${source.id}.ref.png`), await png(shifted(reference, frame.dx, frame.dy)));
  const row: Record<string, unknown> = {
    id: source.id,
    aligned: true,
    design: join(source.dir, 'capture.png'),
    boxes: scene.scene.fixtures.map((f) => ({ kind: f.kind, box: f.box })),
    outline: !!refined.outline,
  };
  for (const rule of rules) {
    const started = performance.now();
    const out = keepFixtureLight({
      capture: scene.capture,
      mask: scene.mask,
      layout: scene.layout,
      fixtures: scene.scene.fixtures,
      result: now,
      frame,
      ...(refined.outline ? { resultMask: refined.outline.colourMask } : {}),
      options: RULES[rule],
    });
    row[rule] = { ms: Math.round(performance.now() - started), fixtures: out.fixtures };
    writeFileSync(join(dir, `${source.id}.${rule}.png`), await png(out.image));
  }
  rows.push(row);
  const first0 = row[rules[0]] as { fixtures: { kind: string; spread: number; after: number }[] } | undefined;
  console.log(
    source.id.padEnd(22),
    first0?.fixtures.map((f) => `${f.kind}:${f.spread}`).join(' '),
    rules.map((r) => `${r}=${(row[r] as { ms: number }).ms}ms`).join(' '),
  );
}
writeFileSync(join(OUT as string, `pictures-${set}.json`), JSON.stringify(rows, null, 1));
