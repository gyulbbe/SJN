/**
 * Candidate O1's pictures (no AI call, docs/fixture-streaks-20261117.md section 12): per result the app
 * picture (`now`, current-refine.ts), the trial copy with O1 off (must equal `now`) and with O1 (`o1`).
 *
 * Usage: node tests/run-browser-test.mjs tests/fixture-streaks/outline-pictures.ts [--set reg] [--line 28] [--share 0.4]
 * Output: test-results/fixture-streaks-20261117/pictures/<id>.o1.png, o1-<set>.json
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { restoreBackdrop } from '../../src/lib/ai-export/backdrop';
import { framing, projectCapture, type Pixels, type RegionMask } from '../../src/lib/ai-export/color';
import { refineCurrentResult } from '../../src/lib/ai-export/current-refine';
import type { Cut } from '../../src/lib/ai-export/fixture-outline';
import type { FluxScene } from '../../src/lib/ai-export/scene-contract';
import { loadScene, pixels, png } from '../extra-ai/app-view';
import { OUT as HAZE } from '../fixture-haze/paths.mjs';
import { haze, type HazeSet } from '../fixture-haze/sources';
import { PIECE_LOG, setPieceRule } from './outline-method';
import { OUT } from './paths.mjs';
import { refineTrial } from './refine-trial';

const arg = (name: string, fallback = '') => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const set = arg('set', 'reg') as HazeSet;
const only = arg('ids') ? new Set(arg('ids').split(',')) : undefined;
const PAD = 0.3;
const dir = join(OUT as string, 'pictures');
setPieceRule(Number(arg('line', '28')), Number(arg('share', '0.7')), Number(arg('wall', '0.3')));
const tag = arg('tag', 'o1');
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

const rows = [];
const differs = (a: Pixels, b: Pixels) => {
  let n = 0;
  for (let i = 0; i < a.data.length; i += 4)
    if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2]) n++;
  return n;
};
let mismatch = 0;
for (const source of haze(set)) {
  if (only && !only.has(source.id)) continue;
  if (!existsSync(source.result)) continue;
  const scene = await loadScene(source.dir, source.jointsFile);
  const result = await pixels(source.result);
  const size = { width: result.width, height: result.height };
  const reference = projectCapture(scene.capture, scene.layout, size);
  const first = framing(reference, result);
  if (!first.aligned) continue;
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
  const checked =
    (scene.mask.outside
      ? restoreBackdrop({ result, capture: scene.capture, mask: scene.mask, layout: scene.layout, shift: first })
      : undefined) ?? result;
  const input = {
    raw: checked,
    capture: scene.capture,
    mask: scene.mask,
    layout: scene.layout,
    joints: scene.joints,
    fixtures: scene.scene.fixtures,
    behind: { image: behind, mask: behindMask },
    cuts: await cutsOf(source.id, scene.scene, size),
  };
  const now = refineCurrentResult(input).shown ?? checked;
  const off = refineTrial({ ...input, pieces: false }).shown ?? checked;
  if (differs(now, off)) mismatch++;
  const started = performance.now();
  PIECE_LOG.length = 0;
  const trial = refineTrial({ ...input, pieces: true });
  const pieces = PIECE_LOG.map((p) => `${p.kind}${p.fixture}:${p.pixels}px/${p.border} ${p.share}${p.wall ? 'W' : p.share > 0.7 ? 'F' : '-'}`);
  const ms = Math.round(performance.now() - started);
  const o1 = trial.shown ?? checked;
  const changed = differs(now, o1);
  writeFileSync(join(dir, `${source.id}.${tag}.png`), await png(o1));
  rows.push({ id: source.id, changed, ms, removed: trial.outline?.removed, pieces: [...PIECE_LOG] });
  console.log(source.id.padEnd(24), 'changed px', changed, `${ms} ms`, pieces.join('  '));
}
console.log(`trial off = app: ${mismatch ? `${mismatch} differ` : 'all same'}`);
writeFileSync(join(OUT as string, `${tag}-${set}.json`), JSON.stringify(rows, null, 1));
