/**
 * Round 1: the synthetic tile set (no AI call). 100 rooms from a fixed seed, the first 50 for
 * development (weights, thresholds, crop variants) and the last 50 for reporting only. Each room has
 * catalog tiles chosen by their use (floor: floor/both; walls: wall/both), sometimes a different back
 * wall, and its own conditions: a corner or centre view at three eye heights, a light cast and
 * exposure with darker corners, standard-model products in front, a small (400 px) photo.
 *
 * Usage: node tests/run-browser-test.mjs tests/catalog-match/browser/synth.ts [--count 100]
 * Output: test-results/catalog-match/synth/{cases.json,images/}
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { OUT, SNAPSHOT } from '../paths.mjs';
import type { PublicPlacement } from '../../../src/lib/catalog/placement-contract';
import { openHarness } from './harness';
import type * as SynthPage from './synth-page';

const count = Number(process.argv[process.argv.indexOf('--count') + 1] || 100) || 100;
export const SYNTH_SEED = 20261102;
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = mulberry32(SYNTH_SEED);
const pick = <T>(list: readonly T[]) => list[Math.floor(random() * list.length)];
const between = (lo: number, hi: number, step = 1) => lo + Math.round((random() * (hi - lo)) / step) * step;

const catalog = JSON.parse(await readFile(join(SNAPSHOT as string, 'catalog.json'), 'utf8')) as {
  takenAt: string;
  placements: PublicPlacement[];
};
const files = new Map(
  (await readdir(join(SNAPSHOT as string, 'images'))).map((file) => [file.replace(/\.[a-z]+$/, ''), file]),
);
const tiles = catalog.placements.filter((p) => p.category === 'tile' && files.has(p.textureAssetIds[0]));
const wallTiles = tiles.filter((p) => p.usage !== 'floor'),
  floorTiles = tiles.filter((p) => p.usage !== 'wall');
const ref = (placement: PublicPlacement) => ({
  placement,
  path: join(SNAPSHOT as string, 'images', files.get(placement.textureAssetIds[0])!),
});
const lightOf = () => {
  if (random() < 0.3)
    return { kind: 'neutral', ev: 0, gains: [1, 1, 1] as [number, number, number], vignette: 0 };
  const k = (random() * 2 - 1) * 0.18;
  const raw = [1 + k, 1, 1 - k];
  const luminance = 0.2126 * raw[0] + 0.7152 * raw[1] + 0.0722 * raw[2];
  return {
    kind: k > 0.06 ? 'warm' : k < -0.06 ? 'cool' : 'mild',
    ev: Math.round((random() * 1.3 - 0.8) * 100) / 100,
    gains: raw.map((v) => v / luminance) as [number, number, number],
    vignette: Math.round((0.1 + random() * 0.3) * 100) / 100,
  };
};
const specs = Array.from({ length: count }, (_, index) => {
  const wall = pick(wallTiles);
  const back = random() < 0.3 ? pick(wallTiles) : wall;
  const floor = pick(floorTiles);
  const light = lightOf();
  return {
    id: `s${String(index + 1).padStart(3, '0')}`,
    split: index < count / 2 ? 'dev' : 'report',
    room: {
      widthMm: between(1400, 2600, 100),
      depthMm: between(1600, 2800, 100),
      heightMm: between(2200, 2500, 100),
    },
    tiles: { back: ref(back), left: ref(wall), right: ref(wall), floor: ref(floor) },
    fixtures: random() < 0.5,
    // Inside views barely show the floor (eye 1500 mm, straight verticals): a third look from above.
    preset: pick(['center', 'center', 'left-corner', 'right-corner', 'orbit', 'orbit'] as const),
    orbit: { azimuth: between(-35, 35, 5), elevation: between(20, 45, 5) },
    eyeHeightMm: pick([undefined, undefined, undefined, 1100, 1700]),
    shift: pick([-0.3, -0.2, 0]),
    light,
    longEdge: random() < 0.3 ? 400 : 1024,
  };
});

await mkdir(join(OUT as string, 'synth', 'images'), { recursive: true });
const harness = await openHarness({
  pageEntry: resolve('tests/catalog-match/browser/synth-page.ts'),
  gpu: true,
});
const cases: unknown[] = [];
try {
  for (const spec of specs) {
    const result = await harness.page.evaluate(
      (input) => (window as unknown as { CM: typeof SynthPage }).CM.renderSynth(input as never),
      spec,
    );
    cases.push({
      id: spec.id,
      split: spec.split,
      room: spec.room,
      preset: spec.preset,
      orbit: spec.preset === 'orbit' ? spec.orbit : undefined,
      eyeHeightMm: spec.eyeHeightMm ?? 1500,
      shift: spec.shift,
      fixtures: spec.fixtures,
      light: spec.light,
      longEdge: spec.longEdge,
      path: join(OUT as string, 'synth', 'images', `${spec.id}.jpg`),
      width: result.width,
      height: result.height,
      boxes: result.boxes,
      faces: result.faces,
    });
    process.stdout.write(`\rsynth ${cases.length}/${specs.length}`);
  }
} finally {
  console.log();
  await writeFile(
    join(OUT as string, 'synth', 'cases.json'),
    JSON.stringify({ seed: SYNTH_SEED, catalogTakenAt: catalog.takenAt, cases }, null, 1),
  );
  await harness.close();
}
