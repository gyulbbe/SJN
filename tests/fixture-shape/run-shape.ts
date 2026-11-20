/**
 * The fixture-shape trial's toilet sentences (docs/fixture-shape-20261120.md, user OK 11-20: "16회 시험"):
 * today's app prompt with one sentence after the toilet's own, on the registered glossy-tile scenes
 * (fixture-glare third round), the same seeds, each once, on the second Cloudflare account only. Its own
 * ledger (fixture-shape-20261120/ledger.jsonl); the other trials' ledgers count for the account's UTC
 * day. A flagged output skips its job, anything else stops.
 *
 * - `tka`: "Its tank keeps the width and flat top image 0 shows."
 * - `tkb`: "It is seen from exactly the same angle as in image 0, not turned."
 *
 * Usage: node tests/run-browser-test.mjs tests/fixture-shape/run-shape.ts [--dry]
 * Output: test-results/fixture-glare-20261119/ai/gloss/<scene>-<seed>.<tka|tkb>.{png,json} (beside the
 *   earlier results, so the cut-out and picture tools read them as the sets glare-tka, glare-tkb)
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { parseAccountFile, sendFlux } from '../direction-photo-methods/flux-send';
import { admit, BUDGET_STOP, isLimit, spent, type LedgerRow } from '../extra-ai/budget';
import { ACCOUNT_FILES } from '../extra-ai/paths.mjs';
import { OUT as HAZE } from '../fixture-haze/paths.mjs';
import { FLUX_4B, fluxRequest } from '../photo-products/methods';
import { GLARE as OUT, OUT as SHAPE, ROOT } from './paths.mjs';

const dry = process.argv.includes('--dry');
const LEDGER = join(SHAPE as string, 'ledger.jsonl');
mkdirSync(join(LEDGER, '..'), { recursive: true });
type Variant = 'tka' | 'tkb';
const SENTENCE: Record<Variant, string> = {
  tka: 'Its tank keeps the width and flat top image 0 shows.',
  tkb: 'It is seen from exactly the same angle as in image 0, not turned.',
};
/** The app's prompt with the sentence right after the toilet's "It must remain a toilet …" one. */
export function toiletPrompt(prompt: string, variant: Variant): string {
  const at = /(It must remain a toilet [^.]*.)/.exec(prompt);
  if (!at) throw new Error('no toilet sentence');
  const end = at.index + at[0].length;
  return `${prompt.slice(0, end)} ${SENTENCE[variant]}${prompt.slice(end)}`;
}
type Job = { group: string; scene: string; seed: number; variant: Variant; dir: string };

const SCENES: [string, number][] = [
  ['olive-0', 424242],
  ['olive-0', 777001],
  ['black-0', 424242],
  ['black-0', 777001],
  ['white-0', 424242],
  ['white-0', 777001],
  ['beige-90', 424242],
  ['olive-90', 424242],
];
const work: Job[] = (['tka', 'tkb'] as const).flatMap((variant) =>
  SCENES.map(([scene, seed]) => ({
    group: 'gloss',
    scene,
    seed,
    variant,
    dir: join(HAZE as string, 'gloss', 'scenes', scene),
  })),
);
for (const job of work) if (!existsSync(join(job.dir, 'input.png'))) throw new Error(`no scene ${job.dir}`);

const rows = (file: string): LedgerRow[] =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as LedgerRow)
    : [];
/** Every other trial's ledger under test-results (two levels down), for the account's day. */
function others(): LedgerRow[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && depth < 3) walk(path, depth + 1);
      else if (entry.name === 'ledger.jsonl' && path !== LEDGER) found.push(path);
    }
  };
  walk(join(ROOT as string, 'test-results'), 0);
  return found.flatMap(rows);
}
const base = (job: Job) => join(OUT as string, 'ai', job.group, `${job.scene}-${job.seed}.${job.variant}`);
// A call the provider refused (its output flagged) is not sent again.
const refused = new Set(
  rows(LEDGER)
    .filter((row) => row.status !== 200)
    .map((row) => `${row.scene}|${row.seed}|${row.method}`),
);
const pending = work.filter(
  (job) =>
    !existsSync(`${base(job)}.png`) && !refused.has(`${job.group}/${job.scene}|${job.seed}|${job.variant}`),
);
const total = pending.reduce((s, job) => s + fluxRequest('cur', job.dir).estimate, 0);
console.log(
  `fixture-shape toilet: ${work.length} jobs, ${pending.length} to send, about ${Math.round(total)} neurons; trial spent ${Math.round(spent(rows(LEDGER)))} of ${BUDGET_STOP}`,
);
if (dry) {
  for (const job of work)
    console.log(
      job.variant,
      job.scene,
      job.seed,
      toiletPrompt(fluxRequest('cur', job.dir).prompt, job.variant).length,
    );
  const sample = toiletPrompt(fluxRequest('cur', work[0].dir).prompt, 'tka');
  console.log(sample.slice(sample.indexOf('1. A '), sample.indexOf(' 2. A ')));
  process.exit(0);
}
// Read once; never printed or written anywhere.
const rest = parseAccountFile(readFileSync(ACCOUNT_FILES.second as string, 'utf8'));
for (const job of pending) {
  const request = fluxRequest('cur', job.dir);
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
      toiletPrompt(request.prompt, job.variant),
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
      round: 'fixture-glare-4',
      method: job.variant,
      scene: `${job.group}/${job.scene}`,
      seed: job.seed,
      ms,
      ...(error ? { error: error.slice(0, 200) } : {}),
    } satisfies LedgerRow) + '\n',
  );
  if (status !== 200 || !image) {
    // A flagged output skips that job; anything else (a limit above all) stops.
    if (!isLimit(status, error) && /flagged/i.test(error ?? '')) {
      console.error('SKIP flagged:', job.group, job.scene, job.seed, job.variant);
      continue;
    }
    console.error(isLimit(status, error) ? 'STOP limit:' : 'STOP failed:', status, error ?? 'no image');
    process.exit(2);
  }
  const file = base(job);
  mkdirSync(join(file, '..'), { recursive: true });
  await sharp(Buffer.from(image, 'base64')).png().toFile(`${file}.png`);
  writeFileSync(
    `${file}.json`,
    JSON.stringify(
      {
        round: 'fixture-glare-4',
        variant: job.variant,
        group: job.group,
        scene: job.scene,
        seed: job.seed,
        dir: job.dir,
        ms,
        estimate: request.estimate,
        prompt: toiletPrompt(request.prompt, job.variant),
      },
      null,
      1,
    ),
  );
  console.log('ok', job.group, job.scene, job.seed, job.variant, `${ms} ms`);
}
