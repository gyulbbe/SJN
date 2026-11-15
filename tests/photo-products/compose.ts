/**
 * The photo-product trial's empty-room pictures (no AI call, docs/photo-products-20261115.md): each
 * `a` result (the room sent without its fixtures) finished as the app's composite export does
 * (composite.ts composeFluxResult: joints, colours, our fixtures and their shadows on top).
 *
 * Usage: node tests/run-browser-test.mjs tests/photo-products/compose.ts [--holdout]
 * Output: test-results/photo-products-20261115/pictures-a/<scene>-a-<seed>.png, pictures-a.json
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import type { Pixels } from '../../src/lib/ai-export/color';
import { composeFluxResult, type RoomLayers } from '../../src/lib/ai-export/composite';
import { loadScene, pixels, png } from '../extra-ai/app-view';
import { OUT, PHOTOS_SCENE } from './paths.mjs';
import { resolveSpecs } from './specs';
import { SNAPSHOT } from '../tile-ai/paths.mjs';

const holdout = process.argv.includes('--holdout');
const ids = (
  JSON.parse(readFileSync(join(SNAPSHOT as string, 'catalog.json'), 'utf8')) as {
    placements: { materialId: string }[];
  }
).placements.map((p) => p.materialId);
const scenes = [
  ...(holdout ? [] : ['photos']),
  ...resolveSpecs(ids)
    .filter((spec) => !!spec.holdout === holdout)
    .map((spec) => spec.id),
];
const dir = join(OUT as string, 'pictures-a');
mkdirSync(dir, { recursive: true });
const rgba = async (file: string) => (await pixels(file)).data;
const rows = [];
for (const id of scenes) {
  const sceneDir = id === 'photos' ? (PHOTOS_SCENE as string) : join(OUT as string, 'scenes', id);
  const layersDir = join(OUT as string, 'behind', id);
  const scene = await loadScene(sceneDir, 'joints.png');
  const empty: Pixels = await pixels(join(layersDir, 'empty.png'));
  const layers: RoomLayers = {
    width: empty.width,
    height: empty.height,
    full: Uint8ClampedArray.from(await rgba(join(layersDir, "full.png"))),
    shadowed: Uint8ClampedArray.from(await rgba(join(layersDir, "behind.png"))),
    empty: Uint8ClampedArray.from(empty.data),
    coverage: new Uint8Array(await sharp(join(layersDir, 'coverage.png')).extractChannel(0).raw().toBuffer()),
  };
  for (const seed of [424242, 777001]) {
    const file = join(OUT as string, 'results', 'a', `${id}-${seed}.png`);
    if (!existsSync(file)) continue;
    const result = await pixels(file);
    const started = performance.now();
    const composed = composeFluxResult({
      result,
      input: empty,
      layers,
      mask: scene.mask,
      layout: scene.layout,
      boxes: scene.scene.fixtures.map((f) => f.box as [number, number, number, number]),
      joints: scene.joints,
    });
    const ms = Math.round(performance.now() - started);
    const shown = composed.corrected ?? composed.raw;
    writeFileSync(join(dir, `${id}-a-${seed}.png`), await png(shown));
    writeFileSync(join(dir, `${id}-a-${seed}.raw.png`), await png(composed.raw));
    rows.push({ id: `${id}-a-${seed}`, scene: id, seed, shifted: composed.shifted, floor: composed.floor, ms });
    console.log(id, seed, 'shifted', composed.shifted, 'floor', JSON.stringify(composed.floor), `${ms} ms`);
  }
}
writeFileSync(join(OUT as string, `pictures-a${holdout ? '-holdout' : ''}.json`), JSON.stringify(rows, null, 1));
