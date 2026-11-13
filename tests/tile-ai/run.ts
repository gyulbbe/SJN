/**
 * Sends the tile AI trial's FLUX jobs (scene × seed × method), each once: a result already on disk is
 * not asked again. `--engine local` is the free FLUX on this PC (127.0.0.1:8798, no ledger);
 * `--engine second|third` is that Cloudflare account over REST, every call written to the ledger
 * before the budget lets the next one out. No retry; the first failure stops the run.
 *
 * Usage: node tests/run-browser-test.mjs tests/tile-ai/run.ts --engine local --round r1
 *          --methods cur,grout --scenes scored,subway --seeds 424242 [--dry] [--holdout]
 * Output: test-results/tile-ai-20261113/results/<local|cf>/<method>/<scene>-<seed>.{png,json}
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { parseAccountFile, sendFlux } from '../direction-photo-methods/flux-send';
import { ACCOUNTS } from '../ledge-ai/budget';
import { admit, BUDGET_STOP, isLimit, spent, type Account, type LedgerRow } from './budget';
import { FLUX_4B, fluxRequest } from './methods';
import { ACCOUNT_FILES, HOLDOUT, LEDGER, OTHER_LEDGERS, RESULTS, SCENES } from './paths.mjs';

const arg = (name: string, fallback = '') => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const engine = arg('engine');
if (engine !== 'local' && !(ACCOUNTS as readonly string[]).includes(engine))
  throw new Error('--engine local|second|third is required');
const round = arg('round');
if (!round) throw new Error('--round is required');
const methods = arg('methods').split(',').filter(Boolean);
const scenes = arg('scenes').split(',').filter(Boolean);
const seeds = arg('seeds', '424242').split(',').map(Number);
const dry = process.argv.includes('--dry');
const holdout = process.argv.includes('--holdout');

const sceneDir = (scene: string) => {
  const dir = join((holdout ? HOLDOUT : SCENES) as string, scene);
  if (!existsSync(dir)) throw new Error(`no scene ${scene}${holdout ? ' (holdout)' : ''}`);
  return dir;
};
const group = engine === 'local' ? 'local' : 'cf';
const base = (method: string, scene: string, seed: number) =>
  join(RESULTS as string, group, method, `${scene}-${seed}`);
const rows = (file: string): LedgerRow[] =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as LedgerRow)
    : [];
const ledger = () => rows(LEDGER as string);
const others = () => (OTHER_LEDGERS as string[]).flatMap(rows);

const jobs = scenes.flatMap((scene) =>
  seeds.flatMap((seed) => methods.map((method) => ({ scene, seed, method }))),
);
const pending = jobs.filter((job) => !existsSync(`${base(job.method, job.scene, job.seed)}.png`));
const estimates = pending.map((job) => fluxRequest(job.method, sceneDir(job.scene)).estimate);
console.log(
  `${round} ${engine}: ${jobs.length} jobs, ${pending.length} to send` +
    (engine === 'local'
      ? ' (free)'
      : `, about ${Math.round(estimates.reduce((s, n) => s + n, 0))} neurons; spent ${Math.round(spent(ledger()))} of ${BUDGET_STOP}`),
);
if (dry) {
  for (const [i, job] of pending.entries())
    console.log(' ', job.method, job.scene, job.seed, Math.round(estimates[i]));
  process.exit(0);
}
// Read once; never printed or written anywhere.
const rest =
  engine === 'local'
    ? undefined
    : parseAccountFile(readFileSync(ACCOUNT_FILES[engine as Account] as string, 'utf8'));
mkdirSync(RESULTS as string, { recursive: true });
for (const job of pending) {
  const request = fluxRequest(job.method, sceneDir(job.scene));
  const at = new Date().toISOString();
  if (engine !== 'local') {
    const allowed = admit(ledger(), { at, account: engine as Account, cost: request.estimate }, others());
    if (!allowed.ok) {
      console.error('STOP budget:', allowed.reason);
      process.exit(2);
    }
  }
  const started = Date.now();
  let status: number | string = 0,
    image: string | undefined,
    error: string | undefined;
  try {
    const answer = await sendFlux(
      engine === 'local' ? 'local' : 'cf',
      {
        image0: request.images[0],
        refs: request.images.slice(1),
        width: request.width,
        height: request.height,
        out: request.out,
      },
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
  if (engine !== 'local')
    appendFileSync(
      LEDGER as string,
      JSON.stringify({
        at,
        account: engine as Account,
        model: FLUX_4B,
        neurons: request.estimate,
        status,
        round,
        ...job,
        ms,
        ...(error ? { error: error.slice(0, 200) } : {}),
      } satisfies LedgerRow) + '\n',
    );
  if (status !== 200 || !image) {
    console.error(isLimit(status, error) ? 'STOP limit:' : 'STOP failed:', status, error ?? 'no image');
    process.exit(2);
  }
  const file = base(job.method, job.scene, job.seed);
  mkdirSync(join(file, '..'), { recursive: true });
  await sharp(Buffer.from(image, 'base64')).png().toFile(`${file}.png`);
  writeFileSync(
    `${file}.json`,
    JSON.stringify(
      {
        round,
        engine,
        ...job,
        ms,
        estimate: request.estimate,
        size: [request.out.width, request.out.height],
        input: [request.width, request.height],
        inputs: request.images.length,
        prompt: request.prompt,
      },
      null,
      1,
    ),
  );
  console.log('ok', job.method, job.scene, job.seed, `${ms} ms`);
}
