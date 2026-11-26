/**
 * Backlog item 10, step 46, the Cloudflare check: today's app captures of the held-out scenes (capture.ts
 * --rev app, SIDE_TILE_SPECS=held, tests/side-tile-ai/specs.ts heldOutSpecs) through the app's model,
 * seed 424242, one answer each; today's refine with the rescue off and the new default are then applied to
 * the same answer (refine.ts --tuning '{"rescue":false}' / default). Billed calls go through
 * tests/export-photoreal/ai.ts (its ledger and budget, a local temporary Worker of the signed-in account;
 * a 429 or daily limit stops the run, nothing is retried). An answer already in the tree is not asked again.
 *
 * Usage (EXPORT_PHOTOREAL_ROOT must be this checkout; EXPORT_PHOTOREAL_AI_URL the Worker, which cannot use
 * 8805 while Windows reserves 8727–8826):
 *   EXPORT_PHOTOREAL_ROOT=C:/dev/SJN-dev EXPORT_PHOTOREAL_AI_URL=http://127.0.0.1:9199  *   node tests/run-browser-test.mjs tests/cutout-haze/cloud.ts [--max 3] [--dry]
 * Output: test-results/cutout-held-20261126/app/raw/ (a side-tile-ai results tree)
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { FLUX_MODEL } from '../../src/lib/ai-export/contract';
import { fluxCall, StopRun } from '../export-photoreal/ai';
import { fluxNeurons } from '../export-photoreal/budget';
import { LEDGER } from '../export-photoreal/paths.mjs';
import { ROOT } from '../side-tile-ai/paths.mjs';

const maxAt = process.argv.indexOf('--max');
const max = maxAt > 0 ? Number(process.argv[maxAt + 1]) : 3;
const dry = process.argv.includes('--dry');
const here = (p: string) => resolve(p).toLowerCase().replace(/\\/g, '/');
if (!process.env.EXPORT_PHOTOREAL_ROOT || here(process.env.EXPORT_PHOTOREAL_ROOT) !== here(ROOT as string))
  throw new Error(
    'EXPORT_PHOTOREAL_ROOT must be this checkout (the ledger must not go to the main checkout)',
  );
if (!here(LEDGER as string).startsWith(here(ROOT as string))) throw new Error('ledger outside this checkout');

const SEED = 424242;
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex').slice(0, 16);
// The three held-out scenes, the app's own capture and prompt (no saved answer has the same input).
const TREE = join(ROOT as string, 'test-results', 'cutout-held-20261126');
const jobs = ['side-beige-90', 'tank-white-0', 'thin-white-0'].map((scene) => ({ scene, rev: 'app' }));
let sent = 0;
for (const { scene, rev } of jobs) {
  const dir = join(TREE, rev, 'scenes', scene);
  const out = join(TREE, rev, 'raw', `${scene}-${SEED}.png`);
  if (existsSync(out)) {
    console.log(rev, scene, 'kept');
    continue;
  }
  if (sent >= max) {
    console.log(rev, scene, `not sent: --max ${max}`);
    continue;
  }
  const input = readFileSync(join(dir, 'input.png'));
  const prompt = readFileSync(join(dir, 'prompt.txt'), 'utf8');
  const { width, height } = await sharp(input).metadata();
  const output = { width: width! * 2, height: height! * 2 };
  const estimate = fluxNeurons([{ width: width!, height: height! }], output);
  if (dry) {
    console.log(rev, scene, `would send (estimate ${estimate.toFixed(1)} neurons)`);
    sent++;
    continue;
  }
  try {
    const { image, ms } = await fluxCall(
      {
        round: 'cutout-held-final',
        method: 'current',
        scene: `cutout-held-${scene}`,
        seed: SEED,
        model: FLUX_MODEL,
        estimate,
        sizes: { inputs: 1, input: [width, height], output: [output.width, output.height] },
      },
      { images: [input], prompt, width: output.width, height: output.height, seed: SEED },
    );
    sent++;
    mkdirSync(join(TREE, rev, 'raw'), { recursive: true });
    await sharp(image).png().toFile(out);
    writeFileSync(
      out.replace(/\.png$/, '.json'),
      JSON.stringify({ rev, scene, seed: SEED, ms, input: sha(input), prompt: sha(prompt) }, null, 1),
    );
    console.log(rev, scene, `${ms} ms`);
  } catch (e) {
    sent++;
    if (e instanceof StopRun) {
      console.log('stopped:', e.message);
      break;
    }
    throw e;
  }
}
console.log(`sent ${dry ? 0 : sent} (max ${max})`);
