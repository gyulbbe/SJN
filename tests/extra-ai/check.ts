/**
 * The Gemma check of the added-objects trial (docs/extra-ai-trials-20261114.md), sent exactly as the
 * app sends it (fluxCheckPayload: the backdrop-restored result as a JPEG at quality 0.9, at most 1,024
 * px) to the second Cloudflare account over REST, and read as the app reads it (readFluxCheck). The
 * saved answer keeps every extra object Gemma named, the small ones the app does not show too.
 *
 * --retry is O2: a result where Gemma named any added object is made once more with the next seed
 * (`<method>+retry`), that one is checked too, and `<method>+o2` keeps the one with fewer added
 * objects (the first on a tie). Every call is written to the ledger first; none is repeated, and the
 * first failure or limit stops the run.
 *
 * Usage: node tests/run-browser-test.mjs tests/extra-ai/check.ts --engine second --round r2
 *          --methods cur,names --scenes white,pattern --seeds 424242,777001 [--retry] [--holdout] [--dry]
 * Output: results/cf/<method>/<scene>-<seed>.check.json, results/cf/<method>+retry/…, results/cf/<method>+o2/…
 */
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import type { FluxCheckResult, FluxCheckScene } from '../../src/lib/ai-export/check-contract';
import { fluxCheckPayload, readFluxCheckCompletion } from '../../src/lib/ai-export/check-server';
import { readFluxCheck } from '../../src/lib/ai-export/notices';
import { parseAccountFile, sendFlux, type RestAccount } from '../direction-photo-methods/flux-send';
import { PRICES, tokenNeurons } from '../export-photoreal/budget';
import { appView, loadScene, pixels } from './app-view';
import { admit, isLimit, type LedgerRow } from './budget';
import { FLUX_4B, fluxRequest } from './methods';
import { ACCOUNT_FILES, HOLDOUT, LEDGER, OTHER_LEDGERS, RESULTS, SCENES } from './paths.mjs';

export const GEMMA = '@cf/google/gemma-4-26b-a4b-it';
/** A check before its tokens are known (11-04: 12–13 neurons). */
export const CHECK_ESTIMATE = 13;

export type SavedCheck = {
  parsed: FluxCheckResult | null;
  reading: ReturnType<typeof readFluxCheck> | null;
  neurons: number;
  error?: string;
};
/** How many added objects a saved check names (all of them, the small ones too). */
export const extrasOf = (check: SavedCheck) => check.parsed?.extras?.length ?? 0;

if (process.argv[2]?.endsWith('check.ts')) {
  const arg = (name: string, fallback = '') => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : fallback;
  };
  if (arg('engine') !== 'second') throw new Error('--engine second is required (the only account here)');
  const round = arg('round');
  if (!round) throw new Error('--round is required');
  const methods = arg('methods').split(',').filter(Boolean);
  const scenes = arg('scenes').split(',').filter(Boolean);
  const seeds = arg('seeds', '424242').split(',').map(Number);
  const retry = process.argv.includes('--retry');
  const dry = process.argv.includes('--dry');
  const holdout = process.argv.includes('--holdout');
  const rows = (file: string): LedgerRow[] =>
    existsSync(file)
      ? readFileSync(file, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as LedgerRow)
      : [];
  const allow = (cost: number) => {
    const allowed = admit(
      rows(LEDGER as string),
      { at: new Date().toISOString(), account: 'second', cost },
      (OTHER_LEDGERS as string[]).flatMap(rows),
    );
    if (!allowed.ok) {
      console.error('STOP budget:', allowed.reason);
      process.exit(2);
    }
  };
  const write = (row: Omit<LedgerRow, 'at' | 'account'>) =>
    appendFileSync(
      LEDGER as string,
      JSON.stringify({ at: new Date().toISOString(), account: 'second', ...row }) + '\n',
    );
  const stop = (status: number | string, error?: string): never => {
    console.error(isLimit(status, error) ? 'STOP limit:' : 'STOP failed:', status, error ?? '');
    process.exit(2);
  };
  // Read once; never printed or written anywhere.
  let account: RestAccount | undefined;
  const rest = () => (account ??= parseAccountFile(readFileSync(ACCOUNT_FILES.second as string, 'utf8')));

  /** Checks one result once (an answer on disk is read back). */
  async function check(
    base: string,
    job: { round: string; method: string; scene: string; seed: number },
    dir: string,
    scene: FluxCheckScene,
  ): Promise<SavedCheck | undefined> {
    if (existsSync(`${base}.check.json`))
      return JSON.parse(readFileSync(`${base}.check.json`, 'utf8')) as SavedCheck;
    if (dry) {
      console.log('would check', job.method, job.scene, job.seed);
      return undefined;
    }
    allow(CHECK_ESTIMATE);
    const view = appView(await loadScene(dir), await pixels(`${base}.png`));
    const jpeg = await sharp(
      Buffer.from(view.checked.data.buffer, view.checked.data.byteOffset, view.checked.data.byteLength),
      {
        raw: { width: view.checked.width, height: view.checked.height, channels: 4 },
      },
    )
      .removeAlpha()
      .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 90 })
      .toBuffer();
    const started = Date.now();
    let status: number | string = 0,
      text = '';
    try {
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${rest().accountId}/ai/run/${GEMMA}`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${rest().token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(fluxCheckPayload(scene, { bytes: new Uint8Array(jpeg), mime: 'image/jpeg' })),
        },
      );
      status = response.status;
      text = await response.text();
    } catch (e) {
      status = 'error';
      text = e instanceof Error ? e.message : String(e);
    }
    let body: { result?: { usage?: Record<string, number> }; errors?: { message?: string }[] } = {};
    try {
      body = JSON.parse(text);
    } catch {
      /* an error page */
    }
    const usage = body.result?.usage;
    const neurons =
      usage?.prompt_tokens !== undefined
        ? tokenNeurons(PRICES[GEMMA], usage.prompt_tokens, usage.completion_tokens ?? 0)
        : CHECK_ESTIMATE;
    const error =
      status === 200 ? undefined : body.errors?.map((e) => e.message).join('; ') || text.slice(0, 200);
    write({
      model: GEMMA,
      neurons,
      status,
      ...job,
      method: `check:${job.method}`,
      ms: Date.now() - started,
      ...(error ? { error: error.slice(0, 200) } : {}),
    });
    if (status !== 200) stop(status, error);
    let saved: SavedCheck;
    try {
      const parsed = readFluxCheckCompletion(body, scene);
      saved = { parsed, reading: readFluxCheck(parsed, scene.fixtures), neurons };
    } catch (e) {
      // An answer the app could not read either: kept, never asked again.
      saved = { parsed: null, reading: null, neurons, error: e instanceof Error ? e.message : String(e) };
    }
    writeFileSync(`${base}.check.json`, JSON.stringify(saved, null, 1));
    return saved;
  }

  for (const method of methods)
    for (const scene of scenes)
      for (const seed of seeds) {
        const dir = join((holdout ? HOLDOUT : SCENES) as string, scene);
        const checkScene = JSON.parse(
          readFileSync(join(dir, 'check-scene.json'), 'utf8'),
        ) as FluxCheckScene | null;
        const base = join(RESULTS as string, 'cf', method, `${scene}-${seed}`);
        if (!existsSync(`${base}.png`) || !checkScene) continue;
        const job = { round, method, scene, seed };
        const first = await check(base, job, dir, checkScene);
        if (!first) continue;
        console.log(method, scene, seed, 'extras', JSON.stringify(first.parsed?.extras ?? null));
        if (!retry) continue;
        const pick = join(RESULTS as string, 'cf', `${method}+o2`, `${scene}-${seed}`);
        if (existsSync(`${pick}.png`)) continue;
        const again = join(RESULTS as string, 'cf', `${method}+retry`, `${scene}-${seed}`);
        if (extrasOf(first) && !existsSync(`${again}.png`)) {
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
              refs: [],
              width: request.width,
              height: request.height,
              out: request.out,
            },
            request.prompt,
            seed + 1,
            FLUX_4B,
            rest(),
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
          mkdirSync(join(again, '..'), { recursive: true });
          await sharp(Buffer.from(answer.image!, 'base64')).png().toFile(`${again}.png`);
          writeFileSync(
            `${again}.json`,
            JSON.stringify(
              { ...job, method: `${method}+retry`, retrySeed: seed + 1, prompt: request.prompt },
              null,
              1,
            ),
          );
        }
        let chosen = base,
          second: SavedCheck | undefined;
        if (extrasOf(first)) {
          second = await check(again, { ...job, method: `${method}+retry` }, dir, checkScene);
          if (!second) continue;
          if (extrasOf(second) < extrasOf(first)) chosen = again;
        }
        mkdirSync(join(pick, '..'), { recursive: true });
        copyFileSync(`${chosen}.png`, `${pick}.png`);
        copyFileSync(`${chosen}.check.json`, `${pick}.check.json`);
        writeFileSync(
          `${pick}.json`,
          JSON.stringify(
            {
              ...job,
              method: `${method}+o2`,
              from: chosen === base ? method : `${method}+retry`,
              extras: [extrasOf(first), second ? extrasOf(second) : null],
            },
            null,
            1,
          ),
        );
        console.log(
          `${method}+o2`,
          scene,
          seed,
          chosen === base ? 'kept' : 'retry',
          extrasOf(first),
          second ? extrasOf(second) : '',
        );
      }
}
