/**
 * The app's refine (current-refine.ts with fixture-shape.ts) against the trial's P1+T1 pictures
 * (pictures.ts `p1t1`, made before the app had them), result by result (no AI call).
 *
 * Usage: node tests/run-browser-test.mjs tests/fixture-shape/app-check.ts
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { refineCurrentResult } from '../../src/lib/ai-export/current-refine';
import { haze, type HazeSet } from '../fixture-haze/sources';
import { loadInput } from '../fixture-shadows/load';
import { OUT } from './paths.mjs';

const done = new Set<string>();
let same = 0,
  differ = 0;
for (const [set, cut] of [
  ['glare-final', 6],
  ['glare-diffsemi', 9],
  ['reg', 0],
  ['new', 0],
] as const)
  for (const source of haze(set as HazeSet)) {
    const id = cut ? source.id.slice(0, -cut) : source.id;
    if (!/^[gnr]-/.test(id) || done.has(id)) continue;
    const file = join(OUT as string, 'pictures', `${id}.p1t1.png`);
    if (!existsSync(file)) continue;
    const loaded = await loadInput(source);
    if (!loaded) continue;
    done.add(id);
    const app = refineCurrentResult(loaded.input);
    const want = await sharp(file).ensureAlpha().raw().toBuffer();
    const got = app.shown!.data;
    let diff = 0;
    for (let i = 0; i < got.length; i++) if (Math.abs(got[i] - want[i]) > 0) diff++;
    if (diff) differ++;
    else same++;
    console.log(
      id.padEnd(24),
      diff ? `DIFFER ${diff}` : 'same',
      app.metal?.length ? `P1 ${app.metal.join(',')}` : '',
      app.trimmed?.length ? `T1 ${app.trimmed.length}` : '',
    );
  }
console.log(`same ${same}, differ ${differ}`);
