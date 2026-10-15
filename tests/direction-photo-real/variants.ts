/**
 * Real, billed direction-photo calls outside the screen, the same seeds as another run, to compare one
 * change at a time (docs/direction-photo-results-20261013.md, "곰·스마트 변기 시험"). Two kinds:
 *
 * - `app`: the app as it is (a bath sends no photo angle since 2026-10-15) — its guide renderer (renderDirectionGuides) and photo preparation
 *   (prepareReferenceImage) in a real Chrome, its spec check and prompt (buildDirectionPhotoPrompt)
 *   for the product's settings below.
 * - `replay`: the very guides, photos and prompts a recorded run sent (REPLAY=<run folder>), so any
 *   earlier variant can be sent again without the code it was made with.
 *
 * Each request is the route's model call (guide as image 0, photos as images 1–3, width and height
 * twice the guide's, the seed) through the test Worker (a copy of
 * test-results/product-representation/real/gen/tools/flux-test-worker.js limited to klein 4B, run with
 * `wrangler dev` and its remote AI binding, never committed), no retry. Every call goes to the ledger
 * with its estimated neurons (callNeurons), and none is sent past 90% of AI_BUDGET_NEURONS counted
 * over today's (UTC) calls; a failure counts as spent.
 *
 * Usage: node tests/run-browser-test.mjs tests/direction-photo-real/variants.ts <bear|smart|bath> <app|replay> [directions] [label]
 *   e.g. ... variants.ts bear app front,left,right after
 * Env: AI_BUDGET_NEURONS (required), FLUX_WORKER (default http://127.0.0.1:8799),
 *   AI_ROOT (default test-results/direction-photo-bear), AI_LEDGER (default <root>/ledger.jsonl),
 *   AI_INPUT (the photos' folder), SEEDS (default 1001,1002), REPLAY (replay's run folder),
 *   GUIDES_ONLY=1 (draw the guides into <root>/guides-preview, no call).
 */
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';
import { buildDirectionPhotoPrompt } from '../../src/lib/direction-photo/prompt';
import { callNeurons } from '../../src/lib/direction-photo/plan';
import {
  directionPhotoSpecSchema,
  type DirectionPhotoSpec,
  type DirectionPhotoView,
} from '../../src/lib/direction-photo/contract';

const ROOT = process.env.AI_ROOT ?? 'test-results/direction-photo-bear';
const LEDGER = process.env.AI_LEDGER ?? `${ROOT}/ledger.jsonl`;
const BUDGET = Number(process.env.AI_BUDGET_NEURONS);
const WORKER = process.env.FLUX_WORKER ?? 'http://127.0.0.1:8799';
const INPUT = process.env.AI_INPUT ?? 'test-results/product-representation/real/input';
if (!(BUDGET > 0)) throw new Error('AI_BUDGET_NEURONS를 정해 주세요.');

const VIEW_NAMES: Record<DirectionPhotoView, string> = {
  front: '정면',
  left: '왼쪽',
  right: '오른쪽',
  back: '뒤',
};

/** The products as the screen would be set for them now, and their photos. */
const PRODUCTS: Record<string, { spec: Omit<DirectionPhotoSpec, 'direction'>; photos: string[] }> = {
  // One piece, ears on the tank, a face printed on its front, the lever on its right side, a seat.
  bear: {
    spec: {
      category: 'toilet',
      form: 'one-piece',
      lid: 'seat',
      installation: 'floor',
      sizeMm: [370, 660, 640],
      photoAngles: ['front-right'],
    },
    photos: ['62-bear-toilet-3q.png'],
  },
  // No tank, a square body, a bidet seat unit with its lid closed, its buttons on its right side.
  smart: {
    spec: {
      category: 'toilet',
      form: 'tankless',
      lid: 'closed',
      installation: 'floor',
      sizeMm: [400, 520, 700],
      photoAngles: ['front-right'],
    },
    photos: ['57-toilet-3q-small.png'],
  },
  // The 2026-10-13 bath, to see the new photo sentence does not hurt it.
  bath: {
    spec: {
      category: 'bath',
      form: 'oval-freestanding',
      installation: 'floor',
      sizeMm: [1700, 560, 750],
    },
    // The white catalogue photo only: the staged one needs the screen's background removal.
    photos: ['61-bathtub-3q-white.png'],
  },
};

// After the runner and this file (node tests/run-browser-test.mjs <this file> ...).
const args = process.argv.slice(3);
const productName = args[0] ?? '';
const product = PRODUCTS[productName];
if (!product) throw new Error(`제품: ${Object.keys(PRODUCTS).join(', ')}`);
const mode = args[1];
if (mode !== 'app' && mode !== 'replay') throw new Error('app 또는 replay');
const REPLAY = process.env.REPLAY;
if (mode === 'replay' && !(REPLAY && existsSync(REPLAY))) throw new Error('REPLAY에 실행 폴더를 주세요.');
const views = (args[2]?.split(',') ?? ['front', 'left', 'right']) as DirectionPhotoView[];
const label = args[3] ?? (mode === 'replay' ? `replay-${REPLAY!.split('/').pop()}` : 'app');
// A look at the guides only (GUIDES_ONLY) goes to its own folder, never over a run's records.
const OUT = process.env.GUIDES_ONLY
  ? `${ROOT}/guides-preview/${productName}-${label}`
  : `${ROOT}/${productName}-${label}`;
mkdirSync(`${OUT}/answers`, { recursive: true });
const seeds = (process.env.SEEDS ?? '1001,1002').split(',').map(Number);

type Row = { at?: string; status: number | string; neurons?: number; n?: number };
const ledger = (): Row[] =>
  existsSync(LEDGER)
    ? readFileSync(LEDGER, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Row)
    : [];
// The free allowance is daily (00:00 UTC): the budget counts today's requests only.
const today = new Date().toISOString().slice(0, 10);
const spent = () => ledger().filter((row) => row.status !== 'refused' && String(row.at).startsWith(today));

/** The app's guide renderer and photo preparation, in the person's Chrome on the GPU. */
async function inBrowser(
  guideInput: Record<string, unknown>,
  photos: string[],
): Promise<{ guides: Record<string, Buffer>; photos: Buffer[] }> {
  const bundle = await build({
    stdin: {
      contents: `export { renderDirectionGuides } from './src/lib/direction-photo/guide-render';
        export { prepareReferenceImage } from './src/lib/ai-export/client';`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    globalName: 'App',
  });
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--enable-gpu'],
  });
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><body></body>');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const made = await page.evaluate(
      async ({ guideInput, photos }) => {
        const app = (
          window as unknown as {
            App: {
              renderDirectionGuides: (
                input: unknown,
                directions: string[],
              ) => Promise<{ direction: string; blob: Blob }[]>;
              prepareReferenceImage: (photo: Blob) => Promise<Blob>;
            };
          }
        ).App;
        const encode = async (blob: Blob) => {
          const bytes = new Uint8Array(await blob.arrayBuffer());
          let text = '';
          for (let i = 0; i < bytes.length; i += 0x8000)
            text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          return btoa(text);
        };
        const guides: Record<string, string> = {};
        for (const guide of await app.renderDirectionGuides(guideInput, ['정면', '왼쪽', '오른쪽', '뒤']))
          guides[guide.direction] = await encode(guide.blob);
        const prepared: string[] = [];
        for (const photo of photos) {
          const bytes = Uint8Array.from(atob(photo), (c) => c.charCodeAt(0));
          prepared.push(await encode(await app.prepareReferenceImage(new Blob([bytes]))));
        }
        return { guides, photos: prepared };
      },
      { guideInput, photos: photos.map((file) => readFileSync(file).toString('base64')) },
    );
    return {
      guides: Object.fromEntries(
        Object.entries(made.guides).map(([key, value]) => [key, Buffer.from(value, 'base64')]),
      ),
      photos: made.photos.map((value) => Buffer.from(value, 'base64')),
    };
  } finally {
    await browser.close();
  }
}

// What each direction sends: drawn and written now (app), or read from the recorded run (replay).
const sends: Record<string, { guide: Buffer; prompt: string }> = {};
let photoFiles: string[];
if (mode === 'app') {
  const { spec } = product;
  const made = await inBrowser(
    {
      category: spec.category,
      form: spec.form,
      lid: spec.lid,
      sizeMm: spec.sizeMm,
      installation: spec.installation,
    },
    product.photos.map((name) => `${INPUT}/${name}`),
  );
  for (const [direction, png] of Object.entries(made.guides))
    writeFileSync(`${OUT}/guide-${direction}.png`, png);
  if (process.env.GUIDES_ONLY) {
    console.log(`${OUT}: 가이드만 그림(호출 없음)`);
    process.exit(0);
  }
  photoFiles = made.photos.map((png, index) => {
    const file = `${OUT}/sent-ref-${index + 1}.png`;
    writeFileSync(file, png);
    return file;
  });
  for (const view of views) {
    const full = directionPhotoSpecSchema.parse({ ...spec, direction: view });
    sends[view] = {
      guide: made.guides[VIEW_NAMES[view]],
      prompt: buildDirectionPhotoPrompt(full, photoFiles.length),
    };
  }
} else {
  photoFiles = readdirSync(REPLAY!)
    .filter((file) => /^sent-ref-\d+\.png$/.test(file))
    .sort()
    .map((file, index) => {
      writeFileSync(`${OUT}/sent-ref-${index + 1}.png`, readFileSync(`${REPLAY}/${file}`));
      return `${OUT}/sent-ref-${index + 1}.png`;
    });
  for (const view of views) {
    const guide = readFileSync(`${REPLAY}/sent-guide-${view}.png`);
    writeFileSync(`${OUT}/guide-${VIEW_NAMES[view]}.png`, guide);
    sends[view] = { guide, prompt: readFileSync(`${REPLAY}/prompt-${view}.txt`, 'utf8') };
  }
}

let n = ledger().filter((row) => typeof row.n === 'number').length;
const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);
log(`${productName} ${label}: ${views.join(',')} × seeds ${seeds.join(',')}`);
for (const view of views) {
  const { guide, prompt } = sends[view];
  writeFileSync(`${OUT}/sent-guide-${view}.png`, guide);
  writeFileSync(`${OUT}/prompt-${view}.txt`, prompt);
  const meta = await sharp(guide).metadata();
  const cost = callNeurons({ width: meta.width!, height: meta.height! }, photoFiles.length);
  for (const seed of seeds) {
    const used = spent().reduce((sum, row) => sum + (row.neurons ?? 0), 0);
    if (used + cost > BUDGET * 0.9) {
      appendFileSync(
        LEDGER,
        JSON.stringify({ at: new Date().toISOString(), status: 'refused', run: OUT, direction: view, seed }) +
          '\n',
      );
      log(`예산 90%에 닿아 멈춤: ~${Math.round(used)} / ${BUDGET}`);
      process.exit(2);
    }
    const row: Record<string, unknown> = {
      at: new Date().toISOString(),
      n: ++n,
      run: OUT,
      variant: label,
      direction: view,
      seed: String(seed),
      refs: photoFiles.length,
      guide: [meta.width, meta.height],
      neurons: Number(cost.toFixed(2)),
    };
    const started = Date.now();
    try {
      const response = await fetch(WORKER, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'flux-2-klein-4b',
          image: guide.toString('base64'),
          refs: photoFiles.map((file) => readFileSync(file).toString('base64')),
          prompt,
          width: meta.width! * 2,
          height: meta.height! * 2,
          seed,
        }),
        signal: AbortSignal.timeout(200_000),
      });
      const body = (await response.json()) as { image?: string; error?: string; status?: number };
      row.status = response.ok && body.image ? 200 : (body.status ?? response.status);
      if (body.image) {
        const png = Buffer.from(body.image, 'base64');
        const answer = await sharp(png).metadata();
        row.size = [answer.width, answer.height];
        writeFileSync(`${OUT}/answers/${String(row.n).padStart(3, '0')}-${view}-${seed}.png`, png);
      } else row.error = String(body.error).slice(0, 400);
    } catch (error) {
      row.status = 'error';
      row.error = String(error).slice(0, 300);
    }
    row.ms = Date.now() - started;
    appendFileSync(LEDGER, JSON.stringify(row) + '\n');
    const total = spent().reduce((sum, r) => sum + (r.neurons ?? 0), 0);
    log(
      'call',
      row.n,
      view,
      seed,
      row.status,
      `${((row.ms as number) / 1000).toFixed(1)}s`,
      `~${Math.round(total)}`,
    );
    if (row.status !== 200) process.exit(1);
  }
}
writeFileSync(
  `${OUT}/variant.json`,
  JSON.stringify(
    { product: productName, mode, label, replay: REPLAY, spec: product.spec, views, seeds },
    null,
    2,
  ),
);
