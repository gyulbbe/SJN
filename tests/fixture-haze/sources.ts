/**
 * The fixture-haze trial's results (docs/fixture-haze-20261116.md). `dev` and `holdout`: the earlier
 * trials' results with today's method on their scenes (tests/tile-pattern/sources.ts: the 11-13 tile
 * trial and the 11-14 added-objects trial; standard models, and one photo-product scene). `new` (and
 * `new-holdout`): this trial's scenes with products whose direction photos are real (fresh()). `bath`:
 * the fixture-streaks trial's standard-model bathtub scenes; `reg`: its registered-product scenes (specs.ts,
 * docs/fixture-streaks-20261117.md). `mat-semi`, `mat-china`: the fixture-material trial's sentence
 * variants of some `new`/`reg` scenes (tests/fixture-material/run-prompt.ts), ids `<n|r>-<scene>-<seed>-<variant>`.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { SEEDS, sources, type Source } from '../tile-pattern/sources';
import { OUT as GLARE } from '../fixture-glare/paths.mjs';
import { OUT as MATERIAL } from '../fixture-material/paths.mjs';
import { OUT as PHOTO_PRODUCTS, PHOTOS_RESULTS, PHOTOS_SCENE } from '../photo-products/paths.mjs';
import { OUT as REFINE_LEVEL } from '../refine-level/paths.mjs';
import { OUT } from './paths.mjs';

export type HazeSource = Source & { layers: string };
export type HazeSet =
  | 'dev'
  | 'holdout'
  | 'new'
  | 'new-holdout'
  | 'bath'
  | 'reg'
  | 'gloss'
  | 'mat-semi'
  | 'mat-china'
  | 'mat-app'
  | 'mat-narrow'
  | 'glare-soft'
  | 'glare-nometal'
  | 'glare-diffuse'
  | 'glare-diffsemi'
  | 'glare-app'
  | 'glare-final'
  | 'glare-olive'
  | 'glare-r45'
  | 'glare-r60'
  | 'pp-cur'
  | 'pp-final';
/** This trial's new scenes (scenes.ts) whose result is back (run.ts): `n-<scene>-<seed>`. */
function fresh(holdout: boolean, group: 'new' | 'bath' | 'reg' | 'gloss' = 'new'): HazeSource[] {
  const prefix = { new: 'n', bath: 'b', reg: 'r', gloss: 'g' }[group];
  const NEW = join(OUT as string, group);
  if (!existsSync(join(NEW, 'scenes'))) return [];
  return readdirSync(join(NEW, 'scenes'))
    .filter(
      (scene) =>
        !!(JSON.parse(readFileSync(join(NEW, 'scenes', scene, 'spec.json'), 'utf8')) as { holdout?: boolean })
          .holdout === holdout,
    )
    .flatMap((scene) =>
      SEEDS.map((seed) => ({
        id: `${prefix}-${scene}-${seed}`,
        trial: 'extra' as const,
        scene,
        seed,
        dir: join(NEW, 'scenes', scene),
        jointsFile: 'joints.png',
        result: join(NEW, 'results', `${scene}-${seed}.png`),
        layers: `${prefix}-${scene}`,
      })),
    );
}
/** The fixture-material sentence variants that are back, on their fixture-haze scenes. */
function material(variant: string, root: string = MATERIAL as string): HazeSource[] {
  return (['new', 'reg', 'bath', 'gloss', 'dev', 'holdout'] as const).flatMap((group) => {
    const dir = join(root, 'ai', group);
    if (!existsSync(dir)) return [];
    if (group === 'dev' || group === 'holdout')
      return readdirSync(dir)
        .filter((file) => file.endsWith(`.${variant}.png`))
        .map((file) => {
          const [, scene, seed] = /^(.*)-(\d+)\./.exec(file)!;
          const base = haze(group).find((s) => s.scene === scene && s.seed === Number(seed))!;
          return { ...base, id: `${base.id}-${variant}`, result: join(dir, file) };
        });
    const prefix = { new: 'n', reg: 'r', bath: 'b', gloss: 'g' }[group];
    return readdirSync(dir)
      .filter((file) => file.endsWith(`.${variant}.png`))
      .map((file) => {
        const [, scene, seed] = /^(.*)-(\d+)\./.exec(file)!;
        return {
          id: `${prefix}-${scene}-${seed}-${variant}`,
          trial: 'extra' as const,
          scene,
          seed: Number(seed),
          dir: join(OUT as string, group, 'scenes', scene),
          jointsFile: 'joints.png',
          result: join(dir, file),
          layers: `${prefix}-${scene}`,
        };
      });
  });
}
/**
 * The photo-product trial's results of today's method (docs/photo-products-20261115.md, 11-15 prompt),
 * the scenes that also have an empty-room composite (experiment A): `pp-<scene>-<seed>`, its layers.
 */
function photoProducts(final = false): HazeSource[] {
  return ['angled', 'black', 'column', 'round', 'strip', 'photos'].flatMap((scene) =>
    SEEDS.map((seed) => ({
      id: `pp-${scene}-${seed}${final ? '-final' : ''}`,
      trial: 'extra' as const,
      scene,
      seed,
      dir: scene === 'photos' ? (PHOTOS_SCENE as string) : join(PHOTO_PRODUCTS as string, 'scenes', scene),
      jointsFile: 'joints.png',
      result: final
        ? join(REFINE_LEVEL as string, 'ai', 'pp', `${scene}-${seed}.final.png`)
        : scene === 'photos'
          ? join(PHOTOS_RESULTS as string, 'cur', `photos-${seed}.png`)
          : join(PHOTO_PRODUCTS as string, 'results', 'cur', `${scene}-${seed}.png`),
      // loadInput reads the layers under fixture-haze's behind folder: this trial's, beside it.
      layers: `../../${basename(PHOTO_PRODUCTS as string)}/behind/${scene}`,
    })),
  );
}
export function haze(set: HazeSet): HazeSource[] {
  if (set === 'pp-cur' || set === 'pp-final') return photoProducts(set === 'pp-final');
  // The softer 3D captures (fixture-glare section 7): their own scene folder and layers.
  if (set === 'glare-r45' || set === 'glare-r60') {
    const variant = set.slice(6);
    return material(variant, GLARE as string).map((source) => ({
      ...source,
      dir: join(GLARE as string, 'soft-scenes', variant, 'gloss', 'scenes', source.scene),
      layers: `../../${basename(GLARE as string)}/soft-scenes/${variant}/behind/${source.layers}`,
    }));
  }
  if (set.startsWith('glare-')) return material(set.slice(6), GLARE as string);
  if (set === 'mat-semi' || set === 'mat-china' || set === 'mat-app' || set === 'mat-narrow')
    return material(set.slice(4));
  if (set === 'bath' || set === 'reg' || set === 'gloss') return fresh(false, set);
  if (set === 'new' || set === 'new-holdout') return fresh(set === 'new-holdout');
  // The glare sets went back above (startsWith does not narrow the type).
  return sources(set as 'dev' | 'holdout').map((source) => ({
    ...source,
    // The empty-room layers drawn for its scene (behind.ts).
    layers: `${source.trial === 'tile' ? 't' : 'x'}-${source.scene}`,
  }));
}
