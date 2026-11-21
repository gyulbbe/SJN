/**
 * The side-tile AI trial's model answers on LOCAL FLUX.2 klein 4B only (free, 127.0.0.1:8798,
 * tests/direction-photo-real/local-flux/server.py; never Cloudflare): for each revision's capture
 * (capture.ts) the app's request as src/lib/ai-export/server.ts makes it (image 0 the prepared input, no
 * other image, the scene's prompt, twice the input's size) at each seed. Same scene, prompt and seed for
 * `before` and `after`; only the input picture differs. An answer already on disk is not asked again.
 *
 * Usage: node tests/run-browser-test.mjs tests/side-tile-ai/flux.ts [--only olive-0,...] [--seeds 424242]
 * Output: test-results/side-tile-ai-20261121/<rev>/raw/<scene>-<seed>.{png,json}, ledger.jsonl
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { sendFlux } from '../direction-photo-methods/flux-send';
import { FLUX_MODEL } from '../../src/lib/ai-export/contract';
import { OUT, REVISIONS, SEEDS } from './paths.mjs';

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const only = arg('only')?.split(',');
const seeds = arg('seeds')?.split(',').map(Number) ?? (SEEDS as number[]);
const LEDGER = join(OUT as string, 'ledger.jsonl');
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex').slice(0, 16);

const health = (await (await fetch('http://127.0.0.1:8798/health')).json()) as {
  meta?: Record<string, unknown>;
};
if (health.meta?.engine !== 'local') throw new Error('no local FLUX on 127.0.0.1:8798');
for (const rev of Object.keys(REVISIONS as Record<string, string>)) {
  const scenes = join(OUT as string, rev, 'scenes');
  for (const scene of readdirSync(scenes)) {
    if (only && !only.includes(scene)) continue;
    const input = readFileSync(join(scenes, scene, 'input.png'));
    const prompt = readFileSync(join(scenes, scene, 'prompt.txt'), 'utf8');
    const { width, height } = await sharp(input).metadata();
    for (const seed of seeds) {
      const dir = join(OUT as string, rev, 'raw');
      mkdirSync(dir, { recursive: true });
      const base = join(dir, `${scene}-${seed}`);
      if (existsSync(`${base}.png`)) continue;
      const started = Date.now();
      const answer = await sendFlux(
        'local',
        { image0: input, refs: [], width: width!, height: height! },
        prompt,
        seed,
        FLUX_MODEL,
      );
      const ms = Date.now() - started;
      const row = {
        at: new Date().toISOString(),
        engine: 'local',
        rev,
        commit: (REVISIONS as Record<string, string>)[rev],
        scene,
        seed,
        status: answer.status,
        ms,
        input: sha(input),
        prompt: sha(prompt),
        out: [width! * 2, height! * 2],
        ...(answer.error ? { error: answer.error.slice(0, 200) } : {}),
      };
      appendFileSync(LEDGER, JSON.stringify(row) + '\n');
      if (answer.status !== 200 || !answer.image)
        throw new Error(`local FLUX failed: ${answer.status} ${answer.error}`);
      await sharp(Buffer.from(answer.image, 'base64')).png().toFile(`${base}.png`);
      writeFileSync(`${base}.json`, JSON.stringify({ ...row, meta: health.meta, prompt }, null, 1));
      console.log(rev, scene, seed, `${ms} ms`);
    }
  }
}
