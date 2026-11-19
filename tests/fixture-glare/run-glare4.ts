/**
 * The fixture-glare trial's fourth round (docs/fixture-glare-20261119.md sections 6–7, user OK 11-19:
 * "Check 9 first" and "0.45 and 0.6 both", sent after the UTC date changed), on the second Cloudflare
 * account only, each once. Its own ledger (round4/ledger.jsonl: approved on its own, so the trial total
 * starts again; the earlier rounds' ledger still counts for the account's UTC day). A flagged output skips
 * its job, anything else stops.
 *
 * - `final`: the app's prompt as it is now (prompt.ts, the soft light sentence and semi-gloss), for the
 *   scenes where it differs from the `diffsemi` prompt the trial sent (the longer instruction drops the
 *   last fixture's place and size; app-prompt-check.ts)
 * - `r45`, `r60`: the app's prompt on the glossy-tile scenes drawn with every non-metal surface at least
 *   that rough (scenes.ts SCENES_SOFTEN, soft-scenes/<variant>/gloss/scenes)
 *
 * Usage: node tests/run-browser-test.mjs tests/fixture-glare/run-glare4.ts [--dry]
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

const dry = process.argv.includes('--dry');
const LEDGER = join(OUT as string, 'round4', 'ledger.jsonl');
mkdirSync(join(LEDGER, '..'), { recursive: true });
type Variant = 'final' | 'r45' | 'r60';
type Job = { group: string; scene: string; seed: number; variant: Variant; dir: string };

const sceneDir = (group: string, scene: string, seed: number) =>
  group === 'dev' || group === 'holdout'
    ? haze(group).find((s) => s.scene === scene && s.seed === seed)!.dir
    : join(HAZE as string, group, 'scenes', scene);
// `final`: every scene the trial sent as diffsemi whose prompt the app now writes otherwise.
const finals: Job[] = readdirSync(join(OUT as string, 'ai')).flatMap((group) =>
  readdirSync(join(OUT as string, 'ai', group))
    .filter((file) => file.endsWith('.diffsemi.json'))
    .map((file) => JSON.parse(readFileSync(join(OUT as string, 'ai', group, file), 'utf8')))
    .map((sent: { scene: string; seed: number; prompt: string }) => ({
      sent,
      dir: sceneDir(group, sent.scene, sent.seed),
    }))
    .filter(({ sent, dir }) => existsSync(dir) && fluxRequest('cur', dir).prompt !== sent.prompt)
    .map(({ sent, dir }) => ({ group, scene: sent.scene, seed: sent.seed, variant: 'final' as const, dir })),
);
// The glossy-tile scenes of the third round, drawn softer.
const GLOSS: [string, number][] = [
  ['olive-0', 424242],
  ['olive-0', 777001],
  ['black-0', 424242],
  ['black-0', 777001],
  ['white-0', 424242],
  ['white-0', 777001],
  ['olive-90', 424242],
  ['beige-90', 424242],
];
const softs: Job[] = (['r45', 'r60'] as const).flatMap((variant) =>
  GLOSS.map(([scene, seed]) => ({
    group: 'gloss',
    scene,
    seed,
    variant,
    dir: join(OUT as string, 'soft-scenes', variant, 'gloss', 'scenes', scene),
  })),
);
const work = [...finals, ...softs];
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
  [...rows(LEDGER), ...rows(join(OUT as string, 'ledger.jsonl'))]
    .filter((row) => row.status !== 200)
    .map((row) => `${row.scene}|${row.seed}|${row.method}`),
);
const pending = work.filter(
  (job) =>
    !existsSync(`${base(job)}.png`) && !refused.has(`${job.group}/${job.scene}|${job.seed}|${job.variant}`),
);
const total = pending.reduce((s, job) => s + fluxRequest('cur', job.dir).estimate, 0);
console.log(
  `fixture-glare fourth: ${work.length} jobs (${finals.length} final, ${softs.length} soft), ${pending.length} to send, about ${Math.round(total)} neurons; trial spent ${Math.round(spent(rows(LEDGER)))} of ${BUDGET_STOP}`,
);
if (dry) {
  for (const job of work)
    console.log(job.variant, job.group, job.scene, job.seed, fluxRequest('cur', job.dir).prompt.length);
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
        prompt: request.prompt,
      },
      null,
      1,
    ),
  );
  console.log('ok', job.group, job.scene, job.seed, job.variant, `${ms} ms`);
}
