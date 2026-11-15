/**
 * The fixture-haze trial's results (docs/fixture-haze-20261116.md). `dev` and `holdout`: the earlier
 * trials' results with today's method on their scenes (tests/tile-pattern/sources.ts: the 11-13 tile
 * trial and the 11-14 added-objects trial; standard models, and one photo-product scene). `new`: this
 * trial's scenes with products whose direction photos are real (added when their results exist).
 */
import { sources, type Source } from '../tile-pattern/sources';

export type HazeSource = Source & { layers: string };
export function haze(set: 'dev' | 'holdout' | 'new'): HazeSource[] {
  if (set === 'new') return [];
  return sources(set).map((source) => ({
    ...source,
    // The empty-room layers drawn for its scene (behind.ts).
    layers: `${source.trial === 'tile' ? 't' : 'x'}-${source.scene}`,
  }));
}
