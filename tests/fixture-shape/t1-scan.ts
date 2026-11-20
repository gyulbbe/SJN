/**
 * Where T1 (protrusion.ts) would act, over many results of today's method (no AI call): each set's
 * results, the pieces it takes out (fixture, size). For a wide check against cutting real fixture parts.
 *
 * Usage: node tests/run-browser-test.mjs tests/fixture-shape/t1-scan.ts reg new gloss dev holdout glare-app …
 * Output: console, test-results/fixture-shape-20261120/t1-scan.json
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { refineCurrentResult } from '../../src/lib/ai-export/current-refine';
import { haze, type HazeSet } from '../fixture-haze/sources';
import { loadInput } from '../fixture-shadows/load';
import { trimProtrusions } from './protrusion';
import { OUT } from './paths.mjs';

const sets = process.argv.slice(2).filter((a) => !/[\/.]/.test(a) && !a.startsWith('--'));
const rows: unknown[] = [];
let results = 0;
for (const set of sets)
  for (const source of haze(set as HazeSet)) {
    const loaded = await loadInput(source);
    if (!loaded?.input.cuts.length) continue;
    results++;
    const app = refineCurrentResult(loaded.input);
    if (!app.review.framing.aligned) continue;
    const { dx, dy } = app.review.framing;
    const trim = trimProtrusions({ ...loaded.input, size: loaded.input.raw, dx, dy });
    if (!trim.trimmed.length) continue;
    rows.push({ set, id: source.id, trimmed: trim.trimmed });
    // Before and after, cropped around each fixture it acted on.
    const after = refineCurrentResult({ ...loaded.input, cuts: trim.cuts });
    const dir = join(OUT as string, 'scan');
    mkdirSync(dir, { recursive: true });
    for (const t of trim.trimmed) {
      const [l, top, r, b] = loaded.input.fixtures[t.fixture].box!;
      const { width, height } = loaded.input.raw;
      const crop = {
        left: Math.max(0, Math.round((l - 0.05) * width)),
        top: Math.max(0, Math.round((top - 0.15) * height)),
      };
      const w = Math.min(width - crop.left, Math.round((r - l + 0.1) * width)),
        h = Math.min(height - crop.top, Math.round((b - top + 0.18) * height));
      const parts = await Promise.all(
        [loaded.input.raw, app.shown!, after.shown!].map((p) =>
          sharp(Buffer.from(p.data), { raw: { width: p.width, height: p.height, channels: 4 } })
            .extract({ ...crop, width: w, height: h })
            .resize({ height: 300 })
            .png()
            .toBuffer(),
        ),
      );
      const pw = Math.round((w * 300) / h);
      await sharp({ create: { width: pw * 3 + 12, height: 300, channels: 3, background: '#f0f' } })
        .composite(parts.map((input, k) => ({ input, left: k * (pw + 6), top: 0 })))
        .png()
        .toFile(join(dir, `${source.id}-${t.fixture}.png`));
    }
    console.log(
      set.padEnd(14),
      source.id.padEnd(34),
      trim.trimmed.map((t) => `${loaded.input.fixtures[t.fixture].kind} ${t.width}×${t.height}`).join(', '),
    );
  }
console.log(`${rows.length} of ${results} results`);
writeFileSync(join(OUT as string, 't1-scan.json'), JSON.stringify(rows, null, 1));
