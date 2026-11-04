/**
 * Sends one round's FLUX jobs (scene × seed × method), each once: a result already on disk is not
 * asked again (rounds share results: round 3 reuses round 2's seed 424242). Every call goes through
 * ai.ts (ledger, budget, no retry); the first refusal stops the run.
 *
 * Usage: node tests/run-browser-test.mjs tests/export-photoreal/run.ts --round r2
 *          --methods current,photo --scenes white,charcoal --seeds 424242 [--dry] [--holdout]
 * Output: test-results/export-photoreal/results/<method>/<scene>-<seed>.{png,json}
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { fluxCall, spent, StopRun } from './ai';
import { BUDGET, BUDGET_SHARE } from './budget';
import { resultBase, sceneDir } from './io';
import { FLUX_4B, fluxRequest, type FluxMethod } from './methods';

const arg = (name: string, fallback = '') => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const round = arg('round');
if (!round) throw new Error('--round is required');
const methods = arg('methods').split(',').filter(Boolean) as FluxMethod[];
const scenes = arg('scenes').split(',').filter(Boolean);
const seeds = arg('seeds', '424242').split(',').map(Number);
const dry = process.argv.includes('--dry');

const jobs = scenes.flatMap((scene) =>
  seeds.flatMap((seed) => methods.map((method) => ({ scene, seed, method }))),
);
const pending = jobs.filter((j) => !existsSync(`${resultBase(j.method, j.scene, j.seed)}.png`));
const estimates = pending.map((j) => fluxRequest(j.method, sceneDir(j.scene)).estimate);
const total = estimates.reduce((s, n) => s + n, 0);
console.log(
  `${round}: ${jobs.length} jobs, ${pending.length} to send, about ${Math.round(total)} neurons; ` +
    `spent so far ${Math.round(spent())} of ${BUDGET * BUDGET_SHARE}`,
);
if (dry) {
  for (const [i, j] of pending.entries())
    console.log(' ', j.method, j.scene, j.seed, Math.round(estimates[i]));
  process.exit(0);
}
for (const job of pending) {
  const request = fluxRequest(job.method, sceneDir(job.scene));
  const base = resultBase(job.method, job.scene, job.seed);
  mkdirSync(join(base, '..'), { recursive: true });
  try {
    const { image, ms } = await fluxCall(
      {
        round,
        method: job.method,
        scene: job.scene,
        seed: job.seed,
        model: FLUX_4B,
        estimate: request.estimate,
        sizes: {
          inputs: request.images.length,
          input: [request.width / 2, request.height / 2],
          output: [request.width, request.height],
          promptLength: request.prompt.length,
        },
      },
      {
        images: request.images,
        prompt: request.prompt,
        width: request.width,
        height: request.height,
        seed: job.seed,
      },
    );
    // The answer may be JPEG; the trial keeps it as it came and as PNG for the tools.
    const format = (await sharp(image).metadata()).format;
    writeFileSync(`${base}.${format === 'jpeg' ? 'jpg' : format}`, image);
    await sharp(image).png().toFile(`${base}.png`);
    writeFileSync(
      `${base}.json`,
      JSON.stringify(
        {
          round,
          method: job.method,
          scene: job.scene,
          seed: job.seed,
          model: FLUX_4B,
          ms,
          format,
          estimate: request.estimate,
          prompt: request.prompt,
          size: [request.width, request.height],
          inputs: request.images.length,
        },
        null,
        1,
      ),
    );
    console.log('ok', job.method, job.scene, job.seed, `${ms} ms`);
  } catch (error) {
    if (error instanceof StopRun) {
      console.error('STOP', error.message);
      process.exit(2);
    }
    throw error;
  }
}
