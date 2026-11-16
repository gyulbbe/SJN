/**
 * Sends the fixture-haze trial's FLUX jobs (docs/fixture-haze-20261116.md, section 4): its new scenes
 * (specs.ts, drawn by scenes.ts) with today's request (`cur`: the model draws the fixtures too), on the
 * second Cloudflare account only, each once. Every call is in the ledger before the budget lets the next
 * one out (the same account's other trials count per UTC day); no retry, the first failure stops.
 *
 * Usage: node tests/run-browser-test.mjs tests/fixture-haze/run.ts [--holdout] [--dry]
 * Output: test-results/fixture-haze-20261116/new/results/<scene>-<seed>.{png,json}, new/ledger.jsonl
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { parseAccountFile, sendFlux } from '../direction-photo-methods/flux-send';
import { admit, BUDGET_STOP, isLimit, spent, type LedgerRow } from '../extra-ai/budget';
import { ACCOUNT_FILES, OTHER_LEDGERS as EXTRA_OTHERS, LEDGER as EXTRA_LEDGER } from '../extra-ai/paths.mjs';
import { OUT as FIXTURE_OUT } from '../fixture-colour/paths.mjs';
import { OUT as NICHE_OUT } from '../niche-look/paths.mjs';
import { OUT as PHOTO_OUT } from '../photo-products/paths.mjs';
import { FLUX_4B, fluxRequest } from '../photo-products/methods';
import { OUT as TRIAL } from './paths.mjs';

const holdout = process.argv.includes('--holdout');
const dry = process.argv.includes('--dry');
const SEEDS = [424242, 777001];
const OUT = join(TRIAL as string, 'new');
const LEDGER = join(OUT, 'ledger.jsonl');
const rows = (file: string): LedgerRow[] =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as LedgerRow)
    : [];
const others = () =>
  [
    EXTRA_LEDGER as string,
    join(FIXTURE_OUT as string, 'ledger.jsonl'),
    join(NICHE_OUT as string, 'ledger.jsonl'),
    join(PHOTO_OUT as string, 'ledger.jsonl'),
    ...(EXTRA_OTHERS as string[]),
  ].flatMap(rows);
const sceneDir = (scene: string) => join(OUT, 'scenes', scene);
const base = (scene: string, seed: number) => join(OUT, 'results', `${scene}-${seed}`);

// The drawn scenes of this set (scenes.ts writes spec.json with `holdout`).
const scenes = readdirSync(join(OUT, 'scenes')).filter(
  (scene) =>
    !!(JSON.parse(readFileSync(join(sceneDir(scene), 'spec.json'), 'utf8')) as { holdout?: boolean })
      .holdout === holdout,
);
type Job = { scene: string; seed: number };
const jobs: Job[] = scenes.flatMap((scene) => SEEDS.map((seed) => ({ scene, seed })));
const pending = jobs.filter((job) => !existsSync(`${base(job.scene, job.seed)}.png`));
const estimate = (job: Job) => fluxRequest('cur', sceneDir(job.scene)).estimate;
const total = pending.reduce((s, job) => s + estimate(job), 0);
console.log(
  `fixture-haze second: ${jobs.length} jobs, ${pending.length} to send, about ${Math.round(total)} neurons; trial spent ${Math.round(spent(rows(LEDGER)))} of ${BUDGET_STOP}`,
);
if (dry) {
  for (const job of pending) console.log(' ', job.scene, job.seed, Math.round(estimate(job)));
  process.exit(0);
}
// Read once; never printed or written anywhere.
const rest = parseAccountFile(readFileSync(ACCOUNT_FILES.second as string, 'utf8'));
for (const job of pending) {
  const request = fluxRequest('cur', sceneDir(job.scene));
  const at = new Date().toISOString();
  const allowed = admit(rows(LEDGER), { at, account: 'second', cost: request.estimate }, others());
  if (!allowed.ok) {
    console.error('STOP budget:', allowed.reason);
    process.exit(2);
  }
  const started = Date.now();
  let status: number | string = 0,
    image: string | undefined,
    error: string | undefined;
  try {
    const answer = await sendFlux(
      'cf',
      { image0: request.images[0], refs: [], width: request.width, height: request.height, out: request.out },
      request.prompt,
      job.seed,
      FLUX_4B,
      rest,
    );
    status = answer.status;
    image = answer.image;
    error = answer.error;
  } catch (e) {
    status = 'error';
    error = e instanceof Error ? e.message : String(e);
  }
  const ms = Date.now() - started;
  appendFileSync(
    LEDGER,
    JSON.stringify({
      at,
      account: 'second',
      model: FLUX_4B,
      neurons: request.estimate,
      status,
      round: 'fixture-haze',
      method: 'cur',
      scene: job.scene,
      seed: job.seed,
      ms,
      ...(error ? { error: error.slice(0, 200) } : {}),
    } satisfies LedgerRow) + '\n',
  );
  if (status !== 200 || !image) {
    console.error(isLimit(status, error) ? 'STOP limit:' : 'STOP failed:', status, error ?? 'no image');
    process.exit(2);
  }
  const file = base(job.scene, job.seed);
  mkdirSync(join(file, '..'), { recursive: true });
  await sharp(Buffer.from(image, 'base64')).png().toFile(`${file}.png`);
  writeFileSync(
    `${file}.json`,
    JSON.stringify(
      {
        round: 'fixture-haze',
        engine: 'second',
        method: 'cur',
        ...job,
        ms,
        estimate: request.estimate,
        prompt: request.prompt,
      },
      null,
      1,
    ),
  );
  console.log('ok', job.scene, job.seed, `${ms} ms`);
}
