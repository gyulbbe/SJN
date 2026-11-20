/**
 * The cut-out verdicts of today's method (fixture-outline.ts) for some fixture-glare pictures (no AI
 * call): whether each fixture's AI cut-out overlapped its render enough to be used.
 *
 * Usage: node tests/run-browser-test.mjs tests/fixture-glare/verdicts.ts glare-final glare-r45 …
 */
import { refineCurrentResult } from '../../src/lib/ai-export/current-refine';
import { haze, type HazeSet } from '../fixture-haze/sources';
import { loadInput } from '../fixture-shadows/load';

const only = process.env.ONLY?.split(',');
for (const set of process.argv.slice(2).filter((a) => a.startsWith('glare-') || a === 'gloss')) {
  for (const source of haze(set as HazeSet)) {
    if (only && !only.some((o) => source.id.startsWith(o))) continue;
    const loaded = await loadInput(source);
    if (!loaded) continue;
    const app = refineCurrentResult(loaded.input);
    const verdicts = (
      app.outline as { verdicts?: { fixture: number; iou: number; used: boolean }[] } | undefined
    )?.verdicts;
    console.log(
      source.id.padEnd(32),
      (verdicts ?? []).map((v) => `#${v.fixture} ${v.iou} ${v.used ? 'used' : 'FALLBACK'}`).join(' | '),
    );
  }
}
