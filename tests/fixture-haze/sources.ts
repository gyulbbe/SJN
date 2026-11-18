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
import { join } from 'node:path';
import { SEEDS, sources, type Source } from '../tile-pattern/sources';
import { OUT as MATERIAL } from '../fixture-material/paths.mjs';
import { OUT } from './paths.mjs';

export type HazeSource = Source & { layers: string };
export type HazeSet = 'dev' | 'holdout' | 'new' | 'new-holdout' | 'bath' | 'reg' | 'mat-semi' | 'mat-china';
/** This trial's new scenes (scenes.ts) whose result is back (run.ts): `n-<scene>-<seed>`. */
function fresh(holdout: boolean, group: 'new' | 'bath' | 'reg' = 'new'): HazeSource[] {
  const prefix = { new: 'n', bath: 'b', reg: 'r' }[group];
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
function material(variant: string): HazeSource[] {
  return (['new', 'reg'] as const).flatMap((group) => {
    const dir = join(MATERIAL as string, 'ai', group);
    if (!existsSync(dir)) return [];
    const prefix = group === 'new' ? 'n' : 'r';
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
export function haze(set: HazeSet): HazeSource[] {
  if (set === 'mat-semi' || set === 'mat-china') return material(set.slice(4));
  if (set === 'bath' || set === 'reg') return fresh(false, set);
  if (set === 'new' || set === 'new-holdout') return fresh(set === 'new-holdout');
  return sources(set).map((source) => ({
    ...source,
    // The empty-room layers drawn for its scene (behind.ts).
    layers: `${source.trial === 'tile' ? 't' : 'x'}-${source.scene}`,
  }));
}
