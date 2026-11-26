// Backlog item 9, step 39: the shower set's colour sentence, three ways, on today's app captures of the
// two shower scenes (capture.ts --rev app, SIDE_TILE_SPECS=photo). Same input and seed; only the
// shower's words change:
//   cur  today: the photo's average, "grey (#8d8a87)"
//   w1   the record's colour name (화이트 → "white"), no hex
//   w2   white at the photo's hue: the average's L* raised to 92 (a*, b* kept), "white (#ebe8e4)"
// Usage: node tests/photo-colour/variants.mjs
// Output: test-results/photo-colour-20261126/{cur,w1,w2}/scenes/<scene>/
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from '../side-tile-ai/paths.mjs';

export const OUT = join(ROOT, 'test-results', 'photo-colour-20261126');
export const SCENES = ['shower-white-0', 'shower-beige-0'];
const TODAY = 'A grey (#8d8a87) matte shower set';
export const WORDS = { cur: TODAY, w1: 'A white matte shower set', w2: 'A white (#ebe8e4) matte shower set' };
if (import.meta.url === pathToFileURL(process.argv[1]).href)
  for (const scene of SCENES) {
    const from = join(OUT, 'app', 'scenes', scene);
    const prompt = readFileSync(join(from, 'prompt.txt'), 'utf8');
    if (prompt.split(TODAY).length !== 2) throw new Error(`${scene}: the shower sentence is not there once`);
    for (const [rev, words] of Object.entries(WORDS)) {
      const to = join(OUT, rev, 'scenes', scene);
      if (!existsSync(to)) {
        mkdirSync(to, { recursive: true });
        cpSync(from, to, { recursive: true });
      }
      writeFileSync(join(to, 'prompt.txt'), prompt.replace(TODAY, words));
    }
    console.log(scene, 'prepared');
  }
