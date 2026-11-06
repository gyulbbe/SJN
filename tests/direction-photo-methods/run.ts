/**
 * Sends the direction-photo methods trial's jobs (methods.ts) to local FLUX (free, shape screening only)
 * or to Cloudflare through the trial's temporary Worker (billed), and keeps every call in the ledger.
 *
 *   node tests/run-browser-test.mjs tests/direction-photo-methods/run.ts <round> <local|cf> <products> <methods> [views] [seeds]
 *     products: ids, comma-separated (held-out ids only with --holdout)
 *     methods:  comma-separated, run one after another (C1s1 before C1; B6 after C0)
 *     views:    comma-separated or "app" (the product's own, default)
 *     seeds:    default 1001,1002
 *   DRY=1 counts the calls and their estimated neurons and sends nothing.
 *
 * Cloudflare: http://127.0.0.1:8806/flux (ai-worker/, `wrangler dev`, remote AI binding), the route's
 * multipart fields. Local: http://127.0.0.1:8798 (tests/direction-photo-real/local-flux/server.py).
 * At most 2 calls at a time, no retry. A call that budget.ts refuses is written as `refused` and stops
 * the run, as does a 429 or the account's daily limit (exit 3). A finished answer is never asked again.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { LEDGER, OTHER_LEDGERS, OUT } from './paths.mjs';
import { productById } from './products';
import { jobFor, METHODS, type Job, type Method } from './methods';
import { budgetCheck, endsRun, fluxCost, FLUX_4B, type Row } from './budget';
import { sendFlux } from './flux-send';
import type { DirectionPhotoView } from '../../src/lib/direction-photo/contract';

const args = process.argv.slice(3);
const HOLDOUT = args.includes('--holdout');
const [round, engine, productList, methodList, viewList = 'app', seedList = '1001,1002'] = args.filter(
  (a) => !a.startsWith('--'),
);
if (!round || (engine !== 'local' && engine !== 'cf') || !productList || !methodList)
  throw new Error('round local|cf products methods [views] [seeds]');
const DRY = !!process.env.DRY;
const MODEL = process.env.FLUX_MODEL ?? FLUX_4B;
const seeds = seedList.split(',').map(Number);
const methods = methodList.split(',') as Method[];
for (const m of methods) if (!METHODS.includes(m)) throw new Error(`method ${m}?`);
const PREP = path.join(OUT, 'prep');
const RUNS = path.join(OUT, 'runs', round);
const manifest = JSON.parse(readFileSync(path.join(PREP, 'manifest.json'), 'utf8')) as Record<
  string,
  { refs: string[]; guides: Record<string, Record<string, string>> }
>;

const readRows = (file: string): Row[] =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Row)
    : [];
const others = OTHER_LEDGERS.flatMap(readRows);

const answerFile = (product: string, method: string, view: string, seed: number) =>
  path.join(RUNS, product, method, `${view}-${seed}.png`);
const step16 = (v: number) => Math.max(128, Math.min(496, Math.round(v / 16) * 16));
async function fitTo(png: Buffer, width: number, height: number) {
  return sharp(png)
    .flatten({ background: '#ffffff' })
    .resize(width, height, { fit: 'fill' })
    .png()
    .toBuffer();
}
async function toEdge(png: Buffer) {
  const { width = 1, height = 1 } = await sharp(png).metadata();
  const scale = 496 / Math.max(width, height);
  return fitTo(png, step16(width * scale), step16(height * scale));
}

/** A job's pictures as PNG bytes: image 0 at its guide's size, the photos at most 496 px. */
async function pictures(job: Job) {
  const product = job.product;
  const guideOf = (variant: string, view: string) => {
    const file = manifest[product].guides[variant]?.[view];
    if (!file) throw new Error(`${product}: no ${variant} guide for ${view}`);
    return file;
  };
  let image0: Buffer;
  if (job.image0.startsWith('prep:')) {
    const [, variant, view] = job.image0.split(':');
    image0 = readFileSync(guideOf(variant, view));
  } else {
    // An earlier answer (mirrored with run!), at the size of this view's guide.
    const [kind, method, view] = job.image0.split(':');
    const file = answerFile(product, method, view, job.seed);
    if (!existsSync(file)) throw new Error(`${product}: ${method} ${view} seed ${job.seed} is not made yet`);
    const variant = method.startsWith('B2') ? 'b2' : 'b0';
    const meta = await sharp(guideOf(variant, job.view)).metadata();
    let picture = sharp(readFileSync(file));
    if (kind === 'run!') picture = picture.flop();
    image0 = await fitTo(await picture.png().toBuffer(), meta.width!, meta.height!);
  }
  const refs: Buffer[] = [];
  for (const ref of job.refs) {
    if (!ref.startsWith('run:')) {
      refs.push(readFileSync(ref));
      continue;
    }
    const [, method, view] = ref.split(':');
    const file = answerFile(product, method, view, job.seed);
    if (!existsSync(file)) throw new Error(`${product}: ${method} ${view} seed ${job.seed} is not made yet`);
    refs.push(await toEdge(readFileSync(file)));
  }
  const meta = await sharp(image0).metadata();
  return { image0, refs, width: meta.width!, height: meta.height! };
}

// ---------- the jobs ----------
const products = productList.split(',').map(productById);
for (const p of products)
  if (p.set === 'holdout' && !HOLDOUT) throw new Error(`${p.id} is held out for the final check (--holdout)`);
let estimate = 0,
  calls = 0,
  stopped = false;
for (const method of methods) {
  const jobs: Job[] = [];
  for (const product of products) {
    const views = (viewList === 'app' ? product.views : (viewList.split(',') as DirectionPhotoView[])).filter(
      (v) => product.views.includes(v),
    );
    for (const view of views)
      for (const seed of seeds) {
        let job: Job;
        try {
          job = jobFor(
            product,
            view,
            method,
            seed,
            manifest[product.id].refs.filter((r) => !path.basename(r).startsWith('cutout')),
          );
        } catch (error) {
          if (process.env.VERBOSE) console.log('skip', product.id, view, method, (error as Error).message);
          continue;
        }
        if (!existsSync(answerFile(job.product, method, view, seed))) jobs.push(job);
      }
  }
  let next = 0;
  await Promise.all(
    Array.from({ length: 2 }, async () => {
      while (next < jobs.length && !stopped) {
        const job = jobs[next++];
        const p = await pictures(job);
        const cost = engine === 'cf' ? fluxCost({ width: p.width, height: p.height }, p.refs.length) : 0;
        estimate += cost;
        calls++;
        if (DRY) continue;
        const dir = path.join(RUNS, job.product, method);
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, `${job.view}-${job.seed}.image0.png`), p.image0);
        p.refs.forEach((ref, i) =>
          writeFileSync(path.join(dir, `${job.view}-${job.seed}.ref${i + 1}.png`), ref),
        );
        const at = new Date().toISOString();
        const product = productById(job.product);
        const row = {
          at,
          round,
          engine,
          model: engine === 'cf' ? MODEL : 'local-klein-4b',
          category: product.category,
          product: job.product,
          view: job.view,
          method,
          seed: job.seed,
          guide: [p.width, p.height],
          refs: p.refs.length,
          neurons: Number(cost.toFixed(2)),
        };
        if (engine === 'cf') {
          const check = budgetCheck(readRows(LEDGER), others, { at, cost });
          if (!check.ok) {
            appendFileSync(
              LEDGER,
              JSON.stringify({ ...row, neurons: 0, status: 'refused', error: check.reason }) + '\n',
            );
            console.error('refused:', check.reason);
            stopped = true;
            return;
          }
        }
        const started = Date.now();
        let status = 0,
          error: string | undefined;
        try {
          const answer = await sendFlux(engine, p, job.prompt, job.seed, MODEL);
          status = answer.status;
          error = answer.error;
          if (answer.image)
            await sharp(Buffer.from(answer.image, 'base64'))
              .png()
              .toFile(answerFile(job.product, method, job.view, job.seed));
          else if (!error) error = 'no image';
        } catch (e) {
          error = e instanceof Error ? e.message : String(e);
        }
        appendFileSync(
          path.join(dir, 'prompts.jsonl'),
          JSON.stringify({ view: job.view, seed: job.seed, prompt: job.prompt }) + '\n',
        );
        appendFileSync(
          LEDGER,
          JSON.stringify({
            ...row,
            status,
            ms: Date.now() - started,
            ...(error ? { error: error.slice(0, 300) } : {}),
          }) + '\n',
        );
        process.stdout.write(`${status === 200 ? '.' : `[${status} ${error?.slice(0, 80)}]`}`);
        if (engine === 'cf' && status !== 200 && endsRun(status, error)) {
          console.error(`\nstopped: ${status} ${error}`);
          stopped = true;
        }
      }
    }),
  );
  console.log(`\n${method}: ${jobs.length} jobs`);
  if (stopped) break;
}
console.log(`${DRY ? 'would send' : 'sent'} ${calls} calls, estimate ${Math.round(estimate)} neurons`);
if (stopped) process.exit(3);
