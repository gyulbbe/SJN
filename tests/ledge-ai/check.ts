/**
 * S6 of the ledge AI trial (docs/ledge-ai-trials-20261111.md): Gemma looks at a result and says whether
 * each built structure is still there; with --retry a result that lost one is made once more with the
 * next seed (the same method), and that answer is the method `<method>+retry`'s. Each Gemma call and
 * each retry is written to the ledger first; no call is repeated, and the first failure stops the run.
 *
 * Usage: node tests/run-browser-test.mjs tests/ledge-ai/check.ts --engine second --round r3
 *          --methods cur --scenes thin-l --seeds 424242,777001 [--retry] [--holdout] [--dry]
 * Output: results/cf/<method>/<scene>-<seed>.check.json and results/cf/<method>+retry/…
 */
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { parseAccountFile, sendFlux } from '../direction-photo-methods/flux-send';
import { PRICES, tokenNeurons } from '../export-photoreal/budget';
import { ACCOUNTS, admit, isLimit, type Account, type LedgerRow } from './budget';
import { FLUX_4B, fluxRequest } from './methods';
import { ACCOUNT_FILES, HOLDOUT, LEDGER, RESULTS, SCENES } from './paths.mjs';
import { structureSentence, type FluxStructure } from './structures';

export const GEMMA = '@cf/google/gemma-4-26b-a4b-it';
/** A Gemma check of one picture, before its tokens are known. */
const CHECK_ESTIMATE = 15;
export const SEEN = [
  'ledge',
  'niche',
  'window',
  'mirror',
  'shelf',
  'bench',
  'cabinet',
  'flat wall',
  'other',
] as const;
export type StructureCheck = {
  index: number;
  present: 'yes' | 'no' | 'unsure';
  seenAs: (typeof SEEN)[number];
};

/** What Gemma is asked about a result: one line a structure, said as the structure sentences say it. */
export function checkPrompt(structures: readonly FluxStructure[]): string {
  return [
    'Image 0 is an edited photograph of a bathroom seen from outside, the near walls cut away. Each numbered built structure below must still be in it, in the region given as percentages of the image width (x) and height (y) from the top-left corner.',
    'For each structure, look at its region and answer:',
    '- present: "yes" if the region shows that structure with about that shape, "no" if it shows only a flat wall, a different object or a clearly different shape, "unsure" if you cannot tell.',
    `- seenAs: what the region mainly shows, one of ${SEEN.map((word) => `"${word}"`).join(', ')}. A ledge is a tiled box standing out from the wall; a niche is a recess set into the wall.`,
    'Judge the shape, not the colour or the lighting.',
    ...structures.map((structure, index) =>
      structureSentence(structure, index + 1, 'ledge', true)
        .replace(/^Built structure (\d+): /, '$1. ')
        .replace(/[.;] (?:Keep|a recess)[^.]*\.$/, '.'),
    ),
    'Answer with JSON only, one entry per structure in order: {"structures":[{"index":1,"present":"yes","seenAs":"ledge"}]}',
  ].join('\n');
}
export function parseCheck(text: string, count: number): StructureCheck[] {
  const body = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as {
    structures?: { index?: number; present?: string; seenAs?: string }[];
  };
  const answers = body.structures ?? [];
  return Array.from({ length: count }, (_, i) => {
    const answer = answers.find((item) => item.index === i + 1);
    const present = answer?.present === 'yes' || answer?.present === 'no' ? answer.present : 'unsure';
    const seenAs = (SEEN as readonly string[]).includes(answer?.seenAs ?? '') ? answer!.seenAs : 'other';
    return { index: i + 1, present, seenAs } as StructureCheck;
  });
}
/** A result is made again when a structure is said to be gone or to be something else. */
export const lost = (checks: readonly StructureCheck[]) => checks.some((check) => check.present === 'no');

if (process.argv[2]?.endsWith('check.ts')) {
  const arg = (name: string, fallback = '') => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : fallback;
  };
  const engine = arg('engine') as Account;
  if (!(ACCOUNTS as readonly string[]).includes(engine)) throw new Error('--engine second|third is required');
  const round = arg('round');
  if (!round) throw new Error('--round is required');
  const methods = arg('methods').split(',').filter(Boolean);
  const scenes = arg('scenes').split(',').filter(Boolean);
  const seeds = arg('seeds', '424242').split(',').map(Number);
  const retry = process.argv.includes('--retry');
  const dry = process.argv.includes('--dry');
  const holdout = process.argv.includes('--holdout');
  const rest = parseAccountFile(readFileSync(ACCOUNT_FILES[engine] as string, 'utf8'));
  const ledger = (): LedgerRow[] =>
    existsSync(LEDGER as string)
      ? readFileSync(LEDGER as string, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as LedgerRow)
      : [];
  const allow = (cost: number) => {
    const allowed = admit(ledger(), { at: new Date().toISOString(), account: engine, cost });
    if (!allowed.ok) {
      console.error('STOP budget:', allowed.reason);
      process.exit(2);
    }
  };
  const write = (row: Omit<LedgerRow, 'at' | 'account'>) =>
    appendFileSync(
      LEDGER as string,
      JSON.stringify({ at: new Date().toISOString(), account: engine, ...row }) + '\n',
    );
  const stop = (status: number | string, error?: string): never => {
    console.error(isLimit(status, error) ? 'STOP limit:' : 'STOP failed:', status, error ?? '');
    process.exit(2);
  };
  for (const method of methods)
    for (const scene of scenes)
      for (const seed of seeds) {
        const dir = join((holdout ? HOLDOUT : SCENES) as string, scene);
        const from = method.split('+').includes('elev') ? join(dir, 'elev') : dir;
        const structures = JSON.parse(readFileSync(join(from, 'structures.json'), 'utf8')) as FluxStructure[];
        const base = join(RESULTS as string, 'cf', method, `${scene}-${seed}`);
        if (!existsSync(`${base}.png`) || !structures.length) continue;
        const job = { round, method, scene, seed };
        let checks: StructureCheck[];
        if (existsSync(`${base}.check.json`))
          checks = (JSON.parse(readFileSync(`${base}.check.json`, 'utf8')) as { checks: StructureCheck[] })
            .checks;
        else {
          if (dry) {
            console.log('would check', method, scene, seed);
            continue;
          }
          allow(CHECK_ESTIMATE);
          const jpeg = await sharp(`${base}.png`).jpeg({ quality: 88 }).toBuffer();
          const started = Date.now();
          const response = await fetch(
            `https://api.cloudflare.com/client/v4/accounts/${rest.accountId}/ai/run/${GEMMA}`,
            {
              method: 'POST',
              headers: { Authorization: `Bearer ${rest.token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                messages: [
                  {
                    role: 'user',
                    content: [
                      { type: 'text', text: checkPrompt(structures) },
                      {
                        type: 'image_url',
                        image_url: { url: `data:image/jpeg;base64,${jpeg.toString('base64')}` },
                      },
                    ],
                  },
                ],
                temperature: 0,
                // Its reasoning comes out of the same allowance: 300 left no room for the answer.
                max_tokens: 1500,
              }),
            },
          );
          const text = await response.text();
          let body: {
            result?: {
              response?: string;
              choices?: { message?: { content?: string } }[];
              usage?: Record<string, number>;
            };
            errors?: { message?: string }[];
          } = {};
          try {
            body = JSON.parse(text);
          } catch {
            /* not JSON: an error page */
          }
          const usage = body.result?.usage;
          const answer = body.result?.response ?? body.result?.choices?.[0]?.message?.content;
          const error =
            body.errors?.map((e) => e.message).join('; ') || (answer ? undefined : text.slice(0, 200));
          write({
            model: GEMMA,
            neurons:
              usage?.neurons ??
              (usage
                ? tokenNeurons(PRICES[GEMMA], usage.prompt_tokens ?? 0, usage.completion_tokens ?? 0)
                : CHECK_ESTIMATE),
            status: response.status,
            ...job,
            ms: Date.now() - started,
            ...(error ? { error: error.slice(0, 200) } : {}),
          });
          if (response.status !== 200) stop(response.status, error);
          // An answered call without words (its allowance spent on reasoning) is "unsure", not asked again.
          let parsed: StructureCheck[] | undefined;
          try {
            parsed = answer ? parseCheck(answer, structures.length) : undefined;
          } catch {
            parsed = undefined;
          }
          checks =
            parsed ??
            structures.map(
              (_, i) => ({ index: i + 1, present: 'unsure', seenAs: 'other' }) as StructureCheck,
            );
          writeFileSync(
            `${base}.check.json`,
            JSON.stringify(
              { checks, answer: answer ?? null, ...(parsed ? {} : { raw: text.slice(0, 4000) }) },
              null,
              1,
            ),
          );
        }
        console.log(method, scene, seed, checks.map((c) => `${c.present}:${c.seenAs}`).join(' '));
        if (!retry) continue;
        const again = join(RESULTS as string, 'cf', `${method}+retry`, `${scene}-${seed}`);
        if (existsSync(`${again}.png`)) continue;
        mkdirSync(join(again, '..'), { recursive: true });
        if (!lost(checks)) {
          // Nothing lost: the method's own answer stands.
          copyFileSync(`${base}.png`, `${again}.png`);
          writeFileSync(`${again}.json`, JSON.stringify({ ...job, kept: true, checks }, null, 1));
          continue;
        }
        if (dry) {
          console.log('would retry', method, scene, seed);
          continue;
        }
        const request = fluxRequest(method, dir);
        allow(request.estimate);
        const started = Date.now();
        const answer = await sendFlux(
          'cf',
          {
            image0: request.images[0],
            refs: request.images.slice(1),
            width: request.width,
            height: request.height,
          },
          request.prompt,
          seed + 1,
          FLUX_4B,
          rest,
        );
        write({
          model: FLUX_4B,
          neurons: request.estimate,
          status: answer.status,
          ...job,
          method: `${method}+retry`,
          ms: Date.now() - started,
          ...(answer.error ? { error: answer.error.slice(0, 200) } : {}),
        });
        if (answer.status !== 200 || !answer.image) stop(answer.status, answer.error);
        await sharp(Buffer.from(answer.image!, 'base64')).png().toFile(`${again}.png`);
        writeFileSync(
          `${again}.json`,
          JSON.stringify(
            { ...job, kept: false, retrySeed: seed + 1, checks, estimate: request.estimate },
            null,
            1,
          ),
        );
        console.log('retried', method, scene, seed);
      }
}
