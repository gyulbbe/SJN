/**
 * G1 pictures on top of today's app picture (no AI call, docs/fixture-glare-20261119.md).
 *
 * Usage: node tests/run-browser-test.mjs tests/fixture-glare/glare-pictures.ts [--sets reg,new,dev,bath,mat-narrow]
 * Output: test-results/fixture-glare-20261119/pictures/<id>.{now,g1,g1d}.png (mat-* ids drop the variant)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { refineCurrentResult } from '../../src/lib/ai-export/current-refine';
import { png } from '../extra-ai/app-view';
import { haze, type HazeSet } from '../fixture-haze/sources';
import { loadInput } from '../fixture-shadows/load';
import { lessGlare, type GlareRule } from './glare-method';
import { OUT } from './paths.mjs';

const i = process.argv.indexOf('--sets');
const sets = (i > 0 ? process.argv[i + 1] : 'reg,new,dev,bath,mat-narrow').split(',') as HazeSet[];
const RULES: Record<string, GlareRule> = {
  g1: { start: 1.15, floor: 0.45 },
  g1d: { start: 1.15, floor: 0.45, dark: true },
};
const dir = join(OUT as string, 'pictures');
mkdirSync(dir, { recursive: true });
for (const set of sets)
  for (const source of haze(set)) {
    const loaded = await loadInput(source);
    if (!loaded) continue;
    const id = set.startsWith('mat-') ? source.id.slice(0, source.id.lastIndexOf('-')) : source.id;
    const app = refineCurrentResult(loaded.input);
    if (!app.shown) continue;
    const tag = set.startsWith('mat-') ? `.${set.slice(4)}` : '';
    writeFileSync(join(dir, `${id}${tag}.now.png`), await png(app.shown));
    const notes: string[] = [];
    for (const [name, rule] of Object.entries(RULES)) {
      const { image, log } = lessGlare(loaded.input, app, rule);
      writeFileSync(join(dir, `${id}${tag}.${name}.png`), await png(image ?? app.shown));
      if (name === 'g1') notes.push(log.map((l) => `${l.kind} ${l.bands}/${l.refBands}→${l.factor}`).join(' '));
    }
    console.log(`${id}${tag}`.padEnd(32), notes.join(' '));
  }
