/**
 * Sends the "고칠 점" trial's calls (cases.ts) to local FLUX (free, screening) or to Cloudflare through
 * the user's second account's REST API (CF_ACCOUNT=second, as tests/sanitary-guides/run.ts does), and
 * keeps every call in the ledger.
 *
 *   node tests/run-browser-test.mjs tests/direction-photo-feedback/run.ts <local|cf> [A,B] [fix,ko] [cases|all] [seeds]
 *     cases: B1,B6,… (cases.ts ids); seeds: default 1001. DRY=1 counts and sends nothing.
 *
 * At most 2 calls at a time, no retry. A Cloudflare call past the account's daily share (budget.ts,
 * counting that account's rows of every trial ledger) is refused and stops the run, as does a 429 or
 * a limit (exit 3). A finished answer is never asked again.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import {
  budgetCheck,
  endsRun,
  fluxCost,
  FLUX_4B,
  ofAccount,
  type Row,
} from '../direction-photo-methods/budget';
import { parseAccountFile, sendFlux } from '../direction-photo-methods/flux-send';
import { CLASSES } from '../sanitary-guides/classes';
import { SECOND_ACCOUNT_FILE } from '../sanitary-guides/paths.mjs';
import type { Manifest } from '../sanitary-guides/prepare';
import { promptFor } from '../sanitary-guides/prompts';
import { CASES, FRAMES, promptOf, WORDS, type Frame, type Words } from './cases';
import { LEDGER, OTHER_LEDGERS, OUT, SANITARY, SANITARY_PREP } from './paths.mjs';

const [engine, frameList = 'A,B', wordList = 'fix,ko', caseList = 'all', seedList = '1001'] =
  process.argv.slice(3);
if (engine !== 'local' && engine !== 'cf')
  throw new Error('usage: run.ts <local|cf> [A,B] [fix,ko] [cases] [seeds]');
const frames = frameList.split(',') as Frame[];
const words = wordList.split(',') as Words[];
for (const f of frames) if (!FRAMES.includes(f)) throw new Error(`frame ${f}?`);
for (const w of words) if (!WORDS.includes(w)) throw new Error(`words ${w}?`);
const cases = caseList === 'all' ? CASES : CASES.filter((c) => caseList.split(',').includes(c.id));
const seeds = seedList.split(',').map(Number);
const DRY = !!process.env.DRY;
const ACCOUNT = process.env.CF_ACCOUNT ?? 'main';
const rest =
  engine === 'cf' && ACCOUNT === 'second'
    ? parseAccountFile(readFileSync(SECOND_ACCOUNT_FILE, 'utf8'))
    : undefined;
if (engine === 'cf' && !rest) throw new Error('this trial calls Cloudflare through CF_ACCOUNT=second only');
const manifest = JSON.parse(readFileSync(path.join(SANITARY_PREP, 'manifest.json'), 'utf8')) as Manifest;
mkdirSync(OUT, { recursive: true });
const readRows = (file: string): Row[] =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Row)
    : [];
const others = ofAccount(OTHER_LEDGERS.flatMap(readRows), ACCOUNT);
export const answerFile = (
  eng: string,
  id: string,
  view: string,
  frame: string,
  word: string,
  seed: number,
) => path.join(OUT, 'runs', eng, `${id}-${view}-${frame}-${word}-${seed}.png`);
/** The earlier answer sent back: the sanitary-ware trial's Cloudflare answer (seed 1001). */
export const earlierFile = (id: string, method: string, view: string) =>
  path.join(SANITARY, 'runs', 'cf', id, 'rep', method, `${view}-1001.png`);

type Job = { c: (typeof CASES)[number]; frame: Frame; word: Words; seed: number };
const jobs: Job[] = [];
for (const c of cases)
  for (const frame of frames)
    for (const word of words)
      for (const seed of seeds)
        if (!existsSync(answerFile(engine, c.id, c.view, frame, word, seed)))
          jobs.push({ c, frame, word, seed });
let next = 0,
  estimate = 0,
  calls = 0,
  stopped = false;
await Promise.all(
  Array.from({ length: 2 }, async () => {
    while (next < jobs.length && !stopped) {
      const { c, frame, word, seed } = jobs[next++];
      const product = manifest[c.id]?.rep;
      const cls = CLASSES.find((x) => x.id === c.id);
      if (!product?.guides.G?.[c.view] || !cls) throw new Error(`${c.id} ${c.view}: not prepared`);
      const guide = readFileSync(product.guides.G[c.view]);
      const { width, height } = await sharp(guide).metadata();
      // The earlier answer at the guide's size (it is twice the guide): one input tile, as the app sends it.
      const earlier = await sharp(readFileSync(earlierFile(c.id, c.method, c.view)))
        .flatten({ background: '#ffffff' })
        .resize(width!, height!, { fit: 'fill' })
        .png()
        .toBuffer();
      const ref = readFileSync(product.ref);
      const prompt = promptOf(promptFor(cls, c.view, c.method, product.sizeMm), c, frame, word);
      const p =
        frame === 'A'
          ? { image0: guide, refs: [ref, earlier], width: width!, height: height! }
          : { image0: earlier, refs: [ref, guide], width: width!, height: height! };
      const cost = engine === 'cf' ? fluxCost({ width: width!, height: height! }, p.refs.length) : 0;
      estimate += cost;
      calls++;
      if (DRY) continue;
      const out = answerFile(engine, c.id, c.view, frame, word, seed);
      mkdirSync(path.dirname(out), { recursive: true });
      const at = new Date().toISOString();
      const row = {
        at,
        engine,
        model: engine === 'cf' ? FLUX_4B : 'local-klein-4b',
        ...(engine === 'cf' && ACCOUNT !== 'main' ? { account: ACCOUNT, via: 'rest' } : {}),
        case: c.id,
        view: c.view,
        frame,
        words: word,
        seed,
        guide: [width, height],
        refs: p.refs.length,
        neurons: Number(cost.toFixed(2)),
      };
      if (engine === 'cf') {
        const check = budgetCheck(ofAccount(readRows(LEDGER), ACCOUNT), others, { at, cost });
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
        const answer = await sendFlux(engine, p, prompt, seed, FLUX_4B, rest);
        status = answer.status;
        error = answer.error;
        if (answer.image) await sharp(Buffer.from(answer.image, 'base64')).png().toFile(out);
        else if (!error) error = 'no image';
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      appendFileSync(
        path.join(OUT, 'runs', engine, 'prompts.jsonl'),
        JSON.stringify({ case: c.id, view: c.view, frame, words: word, seed, prompt }) + '\n',
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
      if (status !== 200 && (engine === 'local' || endsRun(status, error))) {
        console.error(`\nstopped: ${status} ${error}`);
        stopped = true;
      }
    }
  }),
);
console.log(`\n${DRY ? 'would send' : 'sent'} ${calls} calls, estimate ${Math.round(estimate)} neurons`);
if (stopped) process.exit(3);
