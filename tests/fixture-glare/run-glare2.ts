/**
 * The fixture-glare trial's second round (docs/fixture-glare-20261119.md, user OK 11-19: "유광 자재 전체
 * 비침 시험", about 24 calls, estimate about 2,600): the app's own prompt with the fixed instruction's
 * light sentence made soft and diffuse for glossy tiles and ceramics, on the second Cloudflare account
 * only, each once, the same seeds as the earlier results. Ledger and budget as run-glare.ts; a flagged
 * output skips its job, anything else stops.
 *
 * - `diffuse`: "soft diffuse lighting … glossy tiles and ceramics show only faint, soft highlights, with
 *   no mirror-like reflections, light streaks or glare"
 * - `diffsemi`: `diffuse`, and every tile and fixture said glossy or polished is said semi-gloss
 *
 * Usage: node tests/run-browser-test.mjs tests/fixture-glare/run-glare2.ts [--dry]
 * Output: test-results/fixture-glare-20261119/ai/<group>/<scene>-<seed>.<variant>.{png,json}
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { parseAccountFile, sendFlux } from '../direction-photo-methods/flux-send';
import { admit, BUDGET_STOP, isLimit, spent, type LedgerRow } from '../extra-ai/budget';
import { ACCOUNT_FILES } from '../extra-ai/paths.mjs';
import { OUT as HAZE } from '../fixture-haze/paths.mjs';
import { haze } from '../fixture-haze/sources';
import { FLUX_4B, fluxRequest } from '../photo-products/methods';
import { OUT, ROOT } from './paths.mjs';
import { FLUX_PROMPT } from '../../src/lib/ai-export/contract';

const dry = process.argv.includes('--dry');
const LEDGER = join(OUT as string, 'ledger.jsonl');
type Group = 'new' | 'reg' | 'bath' | 'dev' | 'holdout';
const JOBS: { group: Group; scene: string; seed: number }[] = [
  { group: 'new', scene: 'glossy-90', seed: 424242 },
  { group: 'dev', scene: 'scored', seed: 424242 },
  { group: 'dev', scene: 'subway', seed: 777001 },
  { group: 'dev', scene: 'structure', seed: 424242 },
  { group: 'dev', scene: 'marble', seed: 424242 },
  { group: 'holdout', scene: 'roman', seed: 424242 },
  { group: 'reg', scene: 'white-90', seed: 424242 },
  { group: 'reg', scene: 'streaks-90', seed: 424242 },
  { group: 'new', scene: 'white-90', seed: 424242 },
  { group: 'dev', scene: 'charcoal', seed: 777001 },
  { group: 'bath', scene: 'charcoal-0', seed: 424242 },
  { group: 'new', scene: 'waves-90', seed: 777001 },
];
const VARIANTS = ['diffuse', 'diffsemi'] as const;
type Variant = (typeof VARIANTS)[number];

const OLD =
  'physically plausible lighting, contact shadows, subtle material texture, ceramic glaze, metal reflections and transparent glass.';
const NEW =
  'soft diffuse lighting, contact shadows and subtle material texture; glossy tiles and ceramics show only faint, soft highlights, with no mirror-like reflections, light streaks or glare; transparent glass.';
if (!FLUX_PROMPT.includes(OLD)) throw new Error('the fixed instruction changed');
/** The prompt with the fixed instruction's light sentence changed (and, for diffsemi, gloss words). */
export function variantPrompt(prompt: string, variant: Variant): string {
  if (!prompt.startsWith(FLUX_PROMPT)) throw new Error('not the app prompt');
  const head = FLUX_PROMPT.replace(OLD, NEW);
  let rest = prompt.slice(FLUX_PROMPT.length);
  // Every tile and fixture finish word glossy or polished (metal fittings say "metal").
  if (variant === 'diffsemi') rest = rest.replace(/ (glossy|polished) /g, ' semi-gloss ');
  return head + rest;
}

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
const sceneDir = (job: (typeof JOBS)[number]) =>
  job.group === 'dev' || job.group === 'holdout'
    ? haze(job.group).find((s) => s.scene === job.scene && s.seed === job.seed)!.dir
    : join(HAZE as string, job.group, 'scenes', job.scene);
const base = (job: (typeof JOBS)[number], variant: Variant) =>
  join(OUT as string, 'ai', job.group, `${job.scene}-${job.seed}.${variant}`);
const work = JOBS.flatMap((job) => VARIANTS.map((variant) => ({ job, variant })));
// A call the provider refused (its output flagged) is not sent again.
const refused = new Set(
  rows(LEDGER)
    .filter((row) => row.status !== 200)
    .map((row) => `${row.scene}|${row.seed}|${row.method}`),
);
const pending = work.filter(
  ({ job, variant }) =>
    !existsSync(`${base(job, variant)}.png`) && !refused.has(`${job.group}/${job.scene}|${job.seed}|${variant}`),
);
const total = pending.reduce((s, { job }) => s + fluxRequest('cur', sceneDir(job)).estimate, 0);
console.log(
  `fixture-glare second: ${work.length} jobs, ${pending.length} to send, about ${Math.round(total)} neurons; trial spent ${Math.round(spent(rows(LEDGER)))} of ${BUDGET_STOP}`,
);
if (dry) {
  const sample = fluxRequest('cur', sceneDir(JOBS[0]));
  for (const variant of VARIANTS) {
    const text = variantPrompt(sample.prompt, variant);
    console.log(
      `--- ${variant} (${text.length} chars)\n${text.slice(text.indexOf('1. A '), text.indexOf('Image 0 contains'))}`,
    );
  }
  process.exit(0);
}
// Read once; never printed or written anywhere.
const rest = parseAccountFile(readFileSync(ACCOUNT_FILES.second as string, 'utf8'));
mkdirSync(join(OUT as string, 'ai'), { recursive: true });
for (const { job, variant } of pending) {
  const request = fluxRequest('cur', sceneDir(job));
  const prompt = variantPrompt(request.prompt, variant);
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
      prompt,
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
      round: 'fixture-glare-2',
      method: variant,
      scene: `${job.group}/${job.scene}`,
      seed: job.seed,
      ms,
      ...(error ? { error: error.slice(0, 200) } : {}),
    } satisfies LedgerRow) + '\n',
  );
  if (status !== 200 || !image) {
    // A flagged output skips that job; anything else (a limit above all) stops.
    if (!isLimit(status, error) && /flagged/i.test(error ?? '')) {
      console.error('SKIP flagged:', job.group, job.scene, job.seed, variant);
      continue;
    }
    console.error(isLimit(status, error) ? 'STOP limit:' : 'STOP failed:', status, error ?? 'no image');
    process.exit(2);
  }
  const file = base(job, variant);
  mkdirSync(join(file, '..'), { recursive: true });
  await sharp(Buffer.from(image, 'base64')).png().toFile(`${file}.png`);
  writeFileSync(
    `${file}.json`,
    JSON.stringify(
      { round: 'fixture-glare-2', variant, ...job, ms, estimate: request.estimate, prompt },
      null,
      1,
    ),
  );
  console.log('ok', job.group, job.scene, job.seed, variant, `${ms} ms`);
}
