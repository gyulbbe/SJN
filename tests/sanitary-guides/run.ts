/**
 * Sends the sanitary-ware AI direction-photo trial's calls (docs/sanitary-direction-photos-20261107.md) to
 * local FLUX (free, shape screening only) or to Cloudflare through the direction-photo methods trial's
 * temporary Worker (billed), and keeps every call in the ledger. The pictures are prepare.ts's.
 *
 *   node tests/run-browser-test.mjs tests/sanitary-guides/run.ts <local|cf> <classes|all> <G,C0,G2> <rep,other> [seeds]
 *     seeds: default 1001,1002. Views: the app's (prompts.ts viewsOf).
 *   DRY=1 counts the calls and their estimated neurons and sends nothing.
 *   ONLY=T2:front,B1:left limits the run to those class views.
 *
 * At most 2 calls at a time, no retry. A Cloudflare call that budget.ts refuses is written as `refused`
 * and stops the run, as does a 429 or the account's daily limit (exit 3). A finished answer is never
 * asked again.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { budgetCheck, endsRun, fluxCost, FLUX_4B, type Row } from '../direction-photo-methods/budget';
import { sendFlux } from '../direction-photo-methods/flux-send';
import { CLASSES } from './classes';
import { LEDGER, OTHER_LEDGERS, OUT, PREP } from './paths.mjs';
import { promptFor, TRIAL_METHODS, viewsOf, type TrialMethod } from './prompts';
import type { Manifest, Who } from './prepare';

const [engine, classList, methodList, whoList, seedList = '1001,1002'] = process.argv.slice(3);
if ((engine !== 'local' && engine !== 'cf') || !classList || !methodList || !whoList)
  throw new Error('usage: run.ts <local|cf> <classes|all> <G,C0,G2> <rep,other> [seeds]');
const DRY = !!process.env.DRY;
const MODEL = process.env.FLUX_MODEL ?? FLUX_4B;
const seeds = seedList.split(',').map(Number);
const methods = methodList.split(',') as TrialMethod[];
for (const m of methods) if (!TRIAL_METHODS.includes(m)) throw new Error(`method ${m}?`);
const whos = whoList.split(',') as Who[];
const classes = classList === 'all' ? CLASSES : CLASSES.filter((c) => classList.split(',').includes(c.id));
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : undefined;
const manifest = JSON.parse(readFileSync(path.join(PREP, 'manifest.json'), 'utf8')) as Manifest;

const readRows = (file: string): Row[] =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Row)
    : [];
const others = OTHER_LEDGERS.flatMap(readRows);
export const answerFile = (
  eng: string,
  id: string,
  who: string,
  method: string,
  view: string,
  seed: number,
) => path.join(OUT, 'runs', eng, id, who, method, `${view}-${seed}.png`);

type Job = {
  id: string;
  who: Who;
  cd: number;
  method: TrialMethod;
  view: string;
  seed: number;
  guide: string;
  ref: string;
  prompt: string;
};
let estimate = 0,
  calls = 0,
  stopped = false;
runs: for (const method of methods)
  for (const who of whos) {
    const jobs: Job[] = [];
    for (const c of classes) {
      const product = manifest[c.id]?.[who];
      const guides = product?.guides[method === 'C0' ? 'C0' : 'G'];
      if (!product || !guides) continue;
      for (const view of viewsOf(c).filter((v) => !ONLY || ONLY.has(`${c.id}:${v}`)))
        for (const seed of seeds) {
          if (existsSync(answerFile(engine, c.id, who, method, view, seed))) continue;
          jobs.push({
            id: c.id,
            who,
            cd: product.cd,
            method,
            view,
            seed,
            guide: guides[view],
            ref: product.ref,
            prompt: promptFor(c, view, method, product.sizeMm),
          });
        }
    }
    let next = 0;
    await Promise.all(
      Array.from({ length: 2 }, async () => {
        while (next < jobs.length && !stopped) {
          const job = jobs[next++];
          const image0 = readFileSync(job.guide);
          const meta = await sharp(image0).metadata();
          const p = { image0, refs: [readFileSync(job.ref)], width: meta.width!, height: meta.height! };
          const cost = engine === 'cf' ? fluxCost({ width: p.width, height: p.height }, p.refs.length) : 0;
          estimate += cost;
          calls++;
          if (DRY) continue;
          const out = answerFile(engine, job.id, job.who, job.method, job.view, job.seed);
          mkdirSync(path.dirname(out), { recursive: true });
          const at = new Date().toISOString();
          const row = {
            at,
            engine,
            model: engine === 'cf' ? MODEL : 'local-klein-4b',
            class: job.id,
            who: job.who,
            product: job.cd,
            view: job.view,
            method: job.method,
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
            if (answer.image) await sharp(Buffer.from(answer.image, 'base64')).png().toFile(out);
            else if (!error) error = 'no image';
          } catch (e) {
            error = e instanceof Error ? e.message : String(e);
          }
          appendFileSync(
            path.join(path.dirname(out), 'prompts.jsonl'),
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
          process.stdout.write(status === 200 ? '.' : `[${status} ${error?.slice(0, 80)}]`);
          if (engine === 'cf' && status !== 200 && endsRun(status, error)) {
            console.error(`\nstopped: ${status} ${error}`);
            stopped = true;
          }
          if (engine === 'local' && status !== 200) {
            console.error(`\nlocal error: ${status} ${error}`);
            stopped = true;
          }
        }
      }),
    );
    console.log(`\n${method} ${who}: ${jobs.length} jobs`);
    if (stopped) break runs;
  }
console.log(`${DRY ? 'would send' : 'sent'} ${calls} calls, estimate ${Math.round(estimate)} neurons`);
if (stopped) process.exit(3);
writeFileSync(
  path.join(OUT, 'last-run.txt'),
  `${new Date().toISOString()} ${process.argv.slice(3).join(' ')}\n`,
);
