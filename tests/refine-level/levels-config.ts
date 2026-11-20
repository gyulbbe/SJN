/** The refine-level trial's levels (docs/refine-level-20261120.md): L0 is today's app. */
import type { RefineTuning } from '../../src/lib/ai-export/current-refine';

export const LEVELS: RefineTuning[] = [
  {},
  { aiDetail: 0.3, bodyDark: 0.75, bodyBright: 0.9, bodyRaise: 0.6, ceramicShare: 0.6 },
  { aiDetail: 0.5, lightKeep: 0.4, bodyDark: 1, bodyBright: 1, bodyRaise: 0.4, ceramicShare: 0.4 },
  { aiDetail: 0.7, lightKeep: 0.5, bodyDark: 1, bodyBright: 1, bodyRaise: 0.2, ceramicShare: 0.2 },
  // L2 with today's light (the reviewer's quarter, 11-15): more AI texture and ceramic shading, no more streaks.
  { aiDetail: 0.5, bodyDark: 1, bodyBright: 1, bodyRaise: 0.4, ceramicShare: 0.4 },
  // The ceramics only (the reviewer's "특히 도기들이"): their AI shading kept, the walls as today (the
  // model's wall detail brought back ghosts of what the steps took away, a tap by a thin basin).
  { bodyDark: 1, bodyBright: 1, bodyRaise: 0.4, ceramicShare: 0.4 },
];
