/**
 * The fixture-material trial's sentence variants (docs/fixture-material-20261118.md, user OK 11-18:
 * about 20 calls, estimate about 2,200): today's request for the fixture-haze scenes with the ceramic
 * fixture sentences changed, the same seeds as the earlier results, on the second Cloudflare account
 * only, each once. Every call is in the ledger before the budget lets the next one out (all trials'
 * ledgers under test-results count per UTC day); no retry, the first failure stops.
 *
 * - `semi`: a ceramic (toilet, washbasin, bathtub) sentence's finish "glossy" becomes "semi-gloss".
 * - `china`: `semi`, and a light ceramic colour (every channel ≥ 0xb0) is called "white" (no hex), and
 *   each ceramic sentence ends with "It is white vitreous china, not metal or chrome."
 *
 * `app` (--confirm, user OK 11-18: about 12 calls, estimate about 1,300): the app's own prompt after the
 * change (prompt.ts FLUX_CHINA_SENTENCE) on held-out, bathtub and standard-model scenes.
 *
 * Usage: node tests/run-browser-test.mjs tests/fixture-material/run-prompt.ts [--dry] [--confirm]
 * Output: test-results/fixture-material-20261118/ai/<group>/<scene>-<seed>.<variant>.{png,json}, ledger.jsonl
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

const dry = process.argv.includes('--dry');
const LEDGER = join(OUT as string, 'ledger.jsonl');
const confirm = process.argv.includes('--confirm');
type Group = 'new' | 'reg' | 'bath' | 'dev' | 'holdout';
const SWEEP: { group: Group; scene: string; seed: number }[] = [
  { group: 'new', scene: 'white-0', seed: 777001 },
  { group: 'new', scene: 'white-0', seed: 424242 },
  { group: 'new', scene: 'white-90', seed: 424242 },
  { group: 'new', scene: 'charcoal-0', seed: 777001 },
  { group: 'new', scene: 'streaks-0', seed: 777001 },
  { group: 'reg', scene: 'white-0', seed: 777001 },
  { group: 'reg', scene: 'bath-white-0', seed: 424242 },
  { group: 'reg', scene: 'waves-0', seed: 424242 },
  { group: 'reg', scene: 'charcoal-90', seed: 424242 },
  { group: 'reg', scene: 'waves-90', seed: 777001 },
];
const CONFIRM: { group: Group; scene: string; seed: number }[] = [
  { group: 'new', scene: 'cream-0', seed: 424242 },
  { group: 'new', scene: 'cream-0', seed: 777001 },
  { group: 'new', scene: 'glossy-90', seed: 424242 },
  { group: 'new', scene: 'glossy-90', seed: 777001 },
  { group: 'reg', scene: 'bath-white-0', seed: 777001 },
  { group: 'reg', scene: 'bath-charcoal-0', seed: 424242 },
  { group: 'bath', scene: 'white-0', seed: 777001 },
  { group: 'dev', scene: 'white', seed: 777001 },
  { group: 'dev', scene: 'scored', seed: 777001 },
  { group: 'dev', scene: 'photos', seed: 777001 },
  { group: 'holdout', scene: 'large', seed: 424242 },
  { group: 'reg', scene: 'white-90', seed: 777001 },
];
const JOBS = confirm ? CONFIRM : SWEEP;
const VARIANTS = (confirm ? ['app'] : ['semi', 'china']) as readonly Variant[];
type Variant = 'semi' | 'china' | 'app';

const CERAMIC = /(toilet|washbasin|bathtub)/;
/** The prompt with its ceramic fixture sentences changed. */
export function variantPrompt(prompt: string, variant: Variant): string {
  if (variant === 'app') return prompt;
  // Fixture sentences start "N. A " and run to the next one or to "Image 0 contains exactly".
  return prompt.replace(/(\d+\. A [^]*?)(?=\s\d+\. A |\sImage 0 contains exactly)/g, (sentence) => {
    const head = sentence.slice(0, sentence.search(/ at | on the /) > 0 ? sentence.search(/ at | on the /) : sentence.length);
    if (!CERAMIC.test(head)) return sentence;
    let out = sentence.replace(/ glossy /, ' semi-gloss ');
    if (variant === 'china') {
      out = out.replace(/^(\d+\. A )([a-z -]+?) \(#([0-9a-f]{6})\) /, (whole, start: string, _name: string, hex: string) => {
        const light = [0, 2, 4].every((k) => parseInt(hex.slice(k, k + 2), 16) >= 0xb0);
        return light ? `${start}white ` : whole;
      });
      out = `${out} It is white vitreous china, not metal or chrome.`;
    }
    return out;
  });
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
const pending = work.filter(({ job, variant }) => !existsSync(`${base(job, variant)}.png`));
const total = pending.reduce((s, { job }) => s + fluxRequest('cur', sceneDir(job)).estimate, 0);
console.log(
  `fixture-material second: ${work.length} jobs, ${pending.length} to send, about ${Math.round(total)} neurons; trial spent ${Math.round(spent(rows(LEDGER)))} of ${BUDGET_STOP}`,
);
if (dry) {
  const sample = fluxRequest('cur', sceneDir(JOBS[0]));
  for (const variant of VARIANTS) {
    const text = variantPrompt(sample.prompt, variant);
    console.log(`--- ${variant} (${text.length} chars)\n${text.slice(text.indexOf('1. A '), text.indexOf('Image 0 contains'))}`);
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
      round: 'fixture-material',
      method: variant,
      scene: `${job.group}/${job.scene}`,
      seed: job.seed,
      ms,
      ...(error ? { error: error.slice(0, 200) } : {}),
    } satisfies LedgerRow) + '\n',
  );
  if (status !== 200 || !image) {
    console.error(isLimit(status, error) ? 'STOP limit:' : 'STOP failed:', status, error ?? 'no image');
    process.exit(2);
  }
  const file = base(job, variant);
  mkdirSync(join(file, '..'), { recursive: true });
  await sharp(Buffer.from(image, 'base64')).png().toFile(`${file}.png`);
  writeFileSync(
    `${file}.json`,
    JSON.stringify({ round: 'fixture-material', variant, ...job, ms, estimate: request.estimate, prompt }, null, 1),
  );
  console.log('ok', job.group, job.scene, job.seed, variant, `${ms} ms`);
}
