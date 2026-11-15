/**
 * The pictures of the tile-pattern trial (docs/tile-pattern-trials-20261115.md): AI results that two
 * earlier trials already made, so no AI is called. Development: the 11-13 tile trial's current method
 * on its eight scenes and the 11-14 end-sentence results on theirs, two seeds each. Held out (not used
 * to set the pattern score's threshold): the tile trial's `roman`, `small` and the added-objects
 * trial's `large`, `side`.
 */
import { join } from 'node:path';
import { EXTRA, TILE } from './paths.mjs';

export type Source = {
  id: string;
  trial: 'tile' | 'extra';
  scene: string;
  seed: number;
  /** The scene folder (capture, widened joints, mask, layout). */
  dir: string;
  jointsFile: string;
  /** The model's picture as it came back. */
  result: string;
};
export const SEEDS = [424242, 777001];
const TILE_DEV = ['scored', 'patchwork', 'marble', 'charcoal', 'subway', 'beige', 'large', 'accent'];
const EXTRA_DEV = ['white', 'charcoal', 'pattern', 'partial', 'structure', 'smc', 'photos', 'narrow'];

export function sources(set: 'dev' | 'holdout'): Source[] {
  const tile = set === 'dev' ? TILE_DEV : ['roman', 'small'],
    extra = set === 'dev' ? EXTRA_DEV : ['large', 'side'];
  const folder = set === 'dev' ? 'scenes' : 'holdout';
  const out: Source[] = [];
  for (const scene of tile)
    for (const seed of SEEDS)
      out.push({
        id: `t-${scene}-${seed}`,
        trial: 'tile',
        scene,
        seed,
        dir: join(TILE as string, folder, scene),
        jointsFile: 'capture-grout.png',
        result: join(TILE as string, 'results', 'cf', 'cur', `${scene}-${seed}.png`),
      });
  for (const scene of extra)
    for (const seed of SEEDS)
      out.push({
        id: `x-${scene}-${seed}`,
        trial: 'extra',
        scene,
        seed,
        dir: join(EXTRA as string, folder, scene),
        jointsFile: 'joints.png',
        result: join(EXTRA as string, 'results', 'cf', 'names-end', `${scene}-${seed}.png`),
      });
  return out;
}
