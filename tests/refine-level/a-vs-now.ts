/**
 * The refine-level trial's first step (no AI call, docs/refine-level-20261120.md): for the photo-product
 * trial's results (11-15 prompt) that have both methods, the empty-room composite the app opens on for
 * photo products (experiment A, its pictures as that trial made them) beside today's method refined by
 * today's app (current-refine.ts), and the design. Written into the fixture-glare pictures folder as
 * `pp-<scene>-<seed>.{rla,rlnow,ref}.png` for the review screen.
 *
 * Usage: node tests/run-browser-test.mjs tests/refine-level/a-vs-now.ts
 */
import { copyFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectCapture } from '../../src/lib/ai-export/color';
import { refineCurrentResult } from '../../src/lib/ai-export/current-refine';
import { png } from '../extra-ai/app-view';
import { haze } from '../fixture-haze/sources';
import { loadInput } from '../fixture-shadows/load';
import { GLARE, PHOTO_PRODUCTS } from './paths.mjs';

const dir = join(GLARE as string, 'pictures');
// --final: today's prompt's results (run.ts), written as `.rlfinal`.
const final = process.argv.includes('--final');
for (const source of haze(final ? 'pp-final' : 'pp-cur')) {
  const id = final ? source.id.slice(0, -6) : source.id;
  const a = join(PHOTO_PRODUCTS as string, 'pictures-a', `${source.scene}-a-${source.seed}.png`);
  if (!existsSync(a)) continue;
  const loaded = await loadInput(source);
  if (!loaded) {
    console.log(source.id, 'framing moved');
    continue;
  }
  const { input } = loaded;
  const app = refineCurrentResult(input);
  writeFileSync(join(dir, `${id}.${final ? 'rlfinal' : 'rlnow'}.png`), await png(app.shown ?? input.raw));
  writeFileSync(join(dir, `${id}.${final ? 'rlfinal' : 'rlnow'}-raw.png`), await png(input.raw));
  writeFileSync(
    join(dir, `${id}.ref.png`),
    await png(
      projectCapture(input.capture, input.layout, { width: input.raw.width, height: input.raw.height }),
    ),
  );
  copyFileSync(a, join(dir, `${id}.rla.png`));
  console.log(
    source.id.padEnd(22),
    (app.outline?.verdicts ?? []).map((v) => `#${v.fixture} ${v.used ? 'used' : 'FALLBACK'}`).join(' '),
    app.metal?.length ? `P1 ${app.metal}` : '',
    app.trimmed?.length ? `T1 ${app.trimmed.length}` : '',
  );
}
