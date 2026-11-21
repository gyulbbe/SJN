/**
 * The glossy-tile trial's prompt round (docs/glossy-tile-20261121.md): the olive glossy wall (#6a6b51,
 * saturation 0.138, just under prompt.ts `achromatic`'s 0.14) said as "olive" with the coloured
 * keep sentence instead of "grey … do not warm, yellow or tint it" (`olive`), and the app's prompt as
 * it is (`final`) where the trial has no such result yet. Second Cloudflare account only, each once,
 * after the user's OK. A flagged output skips its job, anything else stops.
 *
 * Usage: node tests/run-browser-test.mjs tests/glossy-tile/run-olive.ts [--dry]
 * Output: test-results/fixture-glare-20261119/ai/gloss/<scene>-<seed>.<variant>.{png,json},
 *         test-results/glossy-tile-20261121/ledger.jsonl
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { parseAccountFile, sendFlux } from '../direction-photo-methods/flux-send';
import { admit, isLimit, spent, type LedgerRow } from '../extra-ai/budget';
import { ACCOUNT_FILES } from '../extra-ai/paths.mjs';
import { OUT as HAZE } from '../fixture-haze/paths.mjs';
import { FLUX_4B, fluxRequest } from '../photo-products/methods';
import { GLARE, OUT, ROOT } from './paths.mjs';

const dry = process.argv.includes('--dry');
const LEDGER = join(OUT as string, 'ledger.jsonl');
mkdirSync(OUT as string, { recursive: true });
type Variant = 'olive' | 'final';
type Job = { scene: string; seed: number; variant: Variant; dir: string };

const GREY = 'grey (#6a6b51) semi-gloss tiles';
const GREY_KEEP = 'Keep this exact grey as it appears in image 0; do not warm, yellow or tint it.';
/** The olive wall said as a colour (what prompt.ts writes with `achromatic` under 0.13). */
export function olivePrompt(prompt: string): string {
  const at = prompt.indexOf(GREY);
  if (at < 0) throw new Error('no olive wall in the prompt');
  const keep = prompt.indexOf(GREY_KEEP, at);
  if (keep < 0) throw new Error('no keep sentence after the olive wall');
  return (
    prompt.slice(0, at) +
    'olive (#6a6b51) semi-gloss tiles' +
    prompt.slice(at + GREY.length, keep) +
    'Keep this exact colour as it appears in image 0; do not change its hue or saturation.' +
    prompt.slice(keep + GREY_KEEP.length)
  );
}

const dirOf = (scene: string) => join(HAZE as string, 'gloss', 'scenes', scene);
const base = (job: Job) => join(GLARE as string, 'ai', 'gloss', `${job.scene}-${job.seed}.${job.variant}`);
const work: Job[] = [];
for (const scene of ['olive-0', 'olive-90'])
  for (const seed of [424242, 777001]) {
    work.push({ scene, seed, variant: 'olive', dir: dirOf(scene) });
    // The app's prompt: the trial's diffsemi or final result where it is the same text.
    const same = ['final', 'diffsemi'].some((v) => {
      const file = join(GLARE as string, 'ai', 'gloss', `${scene}-${seed}.${v}.json`);
      return (
        existsSync(file) &&
        (JSON.parse(readFileSync(file, 'utf8')) as { prompt: string }).prompt ===
          fluxRequest('cur', dirOf(scene)).prompt
      );
    });
    if (!same) work.push({ scene, seed, variant: 'final', dir: dirOf(scene) });
  }

const rows = (file: string): LedgerRow[] =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as LedgerRow)
    : [];
/** Every other trial's ledger under test-results (three levels down), for the account's day. */
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
const refused = new Set(
  rows(LEDGER)
    .filter((r) => r.status !== 200)
    .map((r) => `${r.scene}|${r.seed}|${r.method}`),
);
const pending = work.filter(
  (job) => !existsSync(`${base(job)}.png`) && !refused.has(`gloss/${job.scene}|${job.seed}|${job.variant}`),
);
const total = pending.reduce((s, job) => s + fluxRequest('cur', job.dir).estimate, 0);
const today = new Date().toISOString().slice(0, 10);
const day = [...rows(LEDGER), ...others()].filter((r) => r.account === 'second' && r.at.startsWith(today));
console.log(
  `glossy-tile olive: ${work.length} jobs, ${pending.length} to send, about ${Math.round(total)} neurons; second account today (UTC ${today}): ${day.length} calls, about ${Math.round(spent(day))}`,
);
if (dry) {
  for (const job of work) {
    const prompt = fluxRequest('cur', job.dir).prompt;
    const text = job.variant === 'olive' ? olivePrompt(prompt) : prompt;
    console.log(
      job.variant,
      job.scene,
      job.seed,
      text.length,
      text.slice(text.indexOf('Left wall'), text.indexOf(' 1. A ')),
    );
  }
  process.exit(0);
}
// Read once; never printed or written anywhere.
const rest = parseAccountFile(readFileSync(ACCOUNT_FILES.second as string, 'utf8'));
for (const job of pending) {
  const request = fluxRequest('cur', job.dir);
  const prompt = job.variant === 'olive' ? olivePrompt(request.prompt) : request.prompt;
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
      round: 'glossy-tile',
      method: job.variant,
      scene: `gloss/${job.scene}`,
      seed: job.seed,
      ms,
      ...(error ? { error: error.slice(0, 200) } : {}),
    } satisfies LedgerRow) + '\n',
  );
  if (status !== 200 || !image) {
    if (!isLimit(status, error) && /flagged/i.test(error ?? '')) {
      console.error('SKIP flagged:', job.scene, job.seed, job.variant);
      continue;
    }
    console.error(isLimit(status, error) ? 'STOP limit:' : 'STOP failed:', status, error ?? 'no image');
    process.exit(2);
  }
  const file = base(job);
  await sharp(Buffer.from(image, 'base64')).png().toFile(`${file}.png`);
  writeFileSync(
    `${file}.json`,
    JSON.stringify(
      {
        round: 'glossy-tile',
        variant: job.variant,
        group: 'gloss',
        scene: job.scene,
        seed: job.seed,
        dir: job.dir,
        ms,
        estimate: request.estimate,
        prompt,
      },
      null,
      1,
    ),
  );
  console.log('ok', job.scene, job.seed, job.variant, `${ms} ms`);
}
