/**
 * Backlog item 2, the Cloudflare check before release: the app's 3D picture with the wall–wall corner
 * shade (5268cf1, c6) against today's main (3037c8e light) through the app's model, same input frame,
 * prompt and seed. Billed calls go through tests/export-photoreal/ai.ts (its ledger and budget, the
 * local temporary Worker on 127.0.0.1:8805 of the signed-in account; a 429 or daily limit stops the run,
 * nothing is retried). Answers already in the tree are reused, not asked again:
 *   - today's main for olive 0°, olive 90°, white 0° (supervisor, 2026-11-21, seed 424242), whose input
 *     and prompt are byte-identical to today's render (checked here before anything is sent);
 *   - every answer this script already got.
 *
 * Usage (EXPORT_PHOTOREAL_ROOT must be this checkout, so the ledger stays here):
 *   EXPORT_PHOTOREAL_ROOT=C:/dev/SJN-dev node tests/run-browser-test.mjs tests/room-depth/cloud.ts [--max 6] [--dry]
 * Output: test-results/room-depth-20261123/cf/<rev>/{scenes,raw}/ — a side-tile-ai results tree
 *   (SIDE_TILE_OUT=… refine.ts --rev after,app finishes them).
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { FLUX_MODEL } from '../../src/lib/ai-export/contract';
import { fluxCall, StopRun } from '../export-photoreal/ai';
import { fluxNeurons } from '../export-photoreal/budget';
import { LEDGER } from '../export-photoreal/paths.mjs';
import { OUT as TRIAL, ROOT } from '../side-tile-ai/paths.mjs';

const max = Number(process.argv[process.argv.indexOf('--max') + 1] ?? 6) || 6;
const dry = process.argv.includes('--dry');
const here = (p: string) => resolve(p).toLowerCase().replace(/\\/g, '/');
if (!process.env.EXPORT_PHOTOREAL_ROOT || here(process.env.EXPORT_PHOTOREAL_ROOT) !== here(ROOT as string))
  throw new Error(
    'EXPORT_PHOTOREAL_ROOT must be this checkout (the ledger must not go to the main checkout)',
  );
if (!here(LEDGER as string).startsWith(here(ROOT as string))) throw new Error('ledger outside this checkout');

const CF = join(ROOT as string, 'test-results', 'room-depth-20261123', 'cf');
const EARLIER = join(
  ROOT as string,
  'test-results',
  'supervisor',
  'cf1',
  'test-results',
  'side-tile-ai-20261121',
);
const SEED = 424242;
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

// Today's main: reuse the supervisor's answers where the frame is the same.
for (const scene of ['olive-0', 'olive-90', 'white-0']) {
  for (const f of ['input.png', 'prompt.txt'])
    if (
      sha(readFileSync(join(EARLIER, 'after', 'scenes', scene, f))) !==
      sha(readFileSync(join(TRIAL as string, 'after', 'scenes', scene, f)))
    )
      throw new Error(`after ${scene} ${f} differs from the supervisor's: cannot reuse its answer`);
  cpSync(join(EARLIER, 'after', 'scenes', scene), join(CF, 'after', 'scenes', scene), { recursive: true });
  mkdirSync(join(CF, 'after', 'raw'), { recursive: true });
  const raw = join(CF, 'after', 'raw', `${scene}-${SEED}.png`);
  if (!existsSync(raw)) cpSync(join(EARLIER, 'after', 'raw', `${scene}-${SEED}.png`), raw);
}
// To ask: the app (c6) on the same three and beige 90°, and today's main on beige 90°.
const asks: [string, string][] = [
  ['app', 'olive-0'],
  ['app', 'olive-90'],
  ['app', 'white-0'],
  ['app', 'beige-90'],
  ['after', 'beige-90'],
];
let sent = 0;
for (const [rev, scene] of asks) {
  const scenes = join(CF, rev, 'scenes', scene);
  if (!existsSync(scenes)) cpSync(join(TRIAL as string, rev, 'scenes', scene), scenes, { recursive: true });
  const out = join(CF, rev, 'raw', `${scene}-${SEED}.png`);
  if (existsSync(out)) {
    console.log(rev, scene, 'kept');
    continue;
  }
  if (sent >= max) {
    console.log(rev, scene, `not sent: --max ${max}`);
    continue;
  }
  const input = readFileSync(join(scenes, 'input.png'));
  const prompt = readFileSync(join(scenes, 'prompt.txt'), 'utf8');
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
        round: 'room-depth-final',
        method: 'current',
        scene: `room-depth-${rev}-${scene}`,
        seed: SEED,
        model: FLUX_MODEL,
        estimate,
        sizes: { inputs: 1, input: [width, height], output: [output.width, output.height] },
      },
      { images: [input], prompt, width: output.width, height: output.height, seed: SEED },
    );
    sent++;
    mkdirSync(join(CF, rev, 'raw'), { recursive: true });
    await sharp(image).png().toFile(out);
    writeFileSync(
      out.replace(/\.png$/, '.json'),
      JSON.stringify(
        { rev, scene, seed: SEED, ms, input: sha(input).slice(0, 16), prompt: sha(prompt).slice(0, 16) },
        null,
        1,
      ),
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
