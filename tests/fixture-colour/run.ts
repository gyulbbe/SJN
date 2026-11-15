/**
 * Sends the fixture-colour trial's W2 jobs (docs/fixture-colour-20261115.md): the added-objects trial's
 * development scenes with the prompt the app sends now (its end sentence) and the model input with the
 * white ceramics lifted (w2.ts), on the second Cloudflare account only, each once. Every call is in the
 * ledger before the budget lets the next one out (the same account's other trials count per UTC day);
 * no retry, the first failure stops the run. The same scenes and seeds without W2 are the 11-14
 * trial's `names-end` results.
 *
 * Usage: node tests/run-browser-test.mjs tests/fixture-colour/run.ts --seeds 424242,777001 [--dry]
 * Output: test-results/fixture-colour-20261115/results/cf/w2/<scene>-<seed>.{png,json},
 *         inputs/<scene>.png (the lifted input), ledger.jsonl
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { parseAccountFile, sendFlux } from '../direction-photo-methods/flux-send';
import { loadScene, pixels, png } from '../extra-ai/app-view';
import { admit, BUDGET_STOP, isLimit, spent, type LedgerRow } from '../extra-ai/budget';
import { FLUX_4B, fluxRequest } from '../extra-ai/methods';
import {
  ACCOUNT_FILES,
  OTHER_LEDGERS as EXTRA_OTHERS,
  LEDGER as EXTRA_LEDGER,
  SCENES,
} from '../extra-ai/paths.mjs';
import { OUT } from './paths.mjs';
import { brightenCeramics } from './w2';

const arg = (name: string, fallback = '') => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const scenes = arg('scenes', 'white,charcoal,pattern,partial,structure,smc,photos,narrow').split(',');
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
const others = () => [EXTRA_LEDGER as string, ...(EXTRA_OTHERS as string[])].flatMap(rows);
const base = (scene: string, seed: number) => join(OUT as string, 'results', 'cf', 'w2', `${scene}-${seed}`);

const jobs = scenes.flatMap((scene) => seeds.map((seed) => ({ scene, seed })));
const pending = jobs.filter((job) => !existsSync(`${base(job.scene, job.seed)}.png`));
const estimate = (scene: string) => fluxRequest('names-end', join(SCENES as string, scene)).estimate;
const total = pending.reduce((s, job) => s + estimate(job.scene), 0);
console.log(
  `w2 second: ${jobs.length} jobs, ${pending.length} to send, about ${Math.round(total)} neurons; trial spent ${Math.round(spent(rows(LEDGER)))} of ${BUDGET_STOP}`,
);
if (dry) {
  for (const job of pending) console.log(' ', job.scene, job.seed, Math.round(estimate(job.scene)));
  process.exit(0);
}
// Read once; never printed or written anywhere.
const rest = parseAccountFile(readFileSync(ACCOUNT_FILES.second as string, 'utf8'));
mkdirSync(join(OUT as string, 'inputs'), { recursive: true });
for (const job of pending) {
  const dir = join(SCENES as string, job.scene);
  const request = fluxRequest('names-end', dir);
  const scene = await loadScene(dir);
  const lifted = brightenCeramics({
    image: await pixels(request.images[0]),
    mask: scene.mask,
    layout: scene.layout,
    fixtures: scene.scene.fixtures,
  });
  const image0 = await png(lifted.image);
  writeFileSync(join(OUT as string, 'inputs', `${job.scene}.png`), image0);
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
      { image0, refs: [], width: request.width, height: request.height, out: request.out },
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
      round: 'w2',
      method: 'w2',
      ...job,
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
        round: 'w2',
        engine: 'second',
        ...job,
        ms,
        estimate: request.estimate,
        prompt: request.prompt,
        lifted: lifted.lifted,
      },
      null,
      1,
    ),
  );
  console.log(
    'ok',
    job.scene,
    job.seed,
    `${ms} ms`,
    lifted.lifted.map((l) => `${l.kind} ${l.from}+${l.add}`).join(', '),
  );
}
