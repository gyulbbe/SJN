/**
 * Sends the niche-look trial's FLUX jobs (docs/niche-look-20261115.md): its three niche scenes drawn
 * with today's look (`cur`) and the chosen one (`h3s`), each with the app's own prompt, on the second
 * Cloudflare account only, each once. Every call is in the ledger before the budget lets the next one
 * out (the same account's other trials count per UTC day); no retry, the first failure stops the run.
 *
 * Usage: node tests/run-browser-test.mjs tests/niche-look/run.ts [--variants cur,h3s] [--dry]
 * Output: test-results/niche-look-20261115/results/cf/<variant>/<scene>-<seed>.{png,json}, ledger.jsonl
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { parseAccountFile, sendFlux } from '../direction-photo-methods/flux-send';
import { admit, BUDGET_STOP, isLimit, spent, type LedgerRow } from '../extra-ai/budget';
import { FLUX_4B, fluxRequest } from '../extra-ai/methods';
import { ACCOUNT_FILES, OTHER_LEDGERS as EXTRA_OTHERS, LEDGER as EXTRA_LEDGER } from '../extra-ai/paths.mjs';
import { OUT as FIXTURE_OUT } from '../fixture-colour/paths.mjs';
import { OUT } from './paths.mjs';

const arg = (name: string, fallback = '') => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const variants = arg('variants', 'cur,h3s').split(',');
const scenes = arg('scenes', 'structure,niche-only,busy').split(',');
const seeds = arg('seeds', '424242,777001').split(',').map(Number);
const dry = process.argv.includes('--dry');
const LEDGER = join(OUT as string, 'ledger.jsonl');
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
    ...(EXTRA_OTHERS as string[]),
  ].flatMap(rows);
const sceneDir = (variant: string, scene: string) => join(OUT as string, 'scenes', variant, scene);
const base = (variant: string, scene: string, seed: number) =>
  join(OUT as string, 'results', 'cf', variant, `${scene}-${seed}`);

const jobs = scenes.flatMap((scene) =>
  seeds.flatMap((seed) => variants.map((variant) => ({ variant, scene, seed }))),
);
const pending = jobs.filter((job) => !existsSync(`${base(job.variant, job.scene, job.seed)}.png`));
const estimate = (job: (typeof jobs)[number]) =>
  fluxRequest('cur', sceneDir(job.variant, job.scene)).estimate;
const total = pending.reduce((s, job) => s + estimate(job), 0);
console.log(
  `niche second: ${jobs.length} jobs, ${pending.length} to send, about ${Math.round(total)} neurons; trial spent ${Math.round(spent(rows(LEDGER)))} of ${BUDGET_STOP}`,
);
if (dry) {
  for (const job of pending) console.log(' ', job.variant, job.scene, job.seed, Math.round(estimate(job)));
  process.exit(0);
}
// Read once; never printed or written anywhere.
const rest = parseAccountFile(readFileSync(ACCOUNT_FILES.second as string, 'utf8'));
for (const job of pending) {
  const request = fluxRequest('cur', sceneDir(job.variant, job.scene));
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
      round: 'niche',
      method: job.variant,
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
  const file = base(job.variant, job.scene, job.seed);
  mkdirSync(join(file, '..'), { recursive: true });
  await sharp(Buffer.from(image, 'base64')).png().toFile(`${file}.png`);
  writeFileSync(
    `${file}.json`,
    JSON.stringify(
      { round: 'niche', engine: 'second', ...job, ms, estimate: request.estimate, prompt: request.prompt },
      null,
      1,
    ),
  );
  console.log('ok', job.variant, job.scene, job.seed, `${ms} ms`);
}
