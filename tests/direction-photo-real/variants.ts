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
 * Photos with a background (the toilet trial's t1–t6, 2026-10-17) go through the screen's background
 * removal first (BiRefNet, src/lib/background-removal, the model file served from tmp/background-model
 * and the runtime from node_modules), then its photo preparation; the cut-outs are kept as
 * `cutout-ref-N.png` beside the photos sent (`sent-ref-N.png`).
 *
 * Usage: node tests/run-browser-test.mjs tests/direction-photo-real/variants.ts <product> <app|replay> [directions] [label]
 *   e.g. ... variants.ts bear app front,left,right after
 * Env: AI_BUDGET_NEURONS (required), FLUX_WORKER (default http://127.0.0.1:8799),
 *   AI_ROOT (default test-results/direction-photo-bear), AI_LEDGER (default <root>/ledger.jsonl),
 *   AI_INPUT (the photos' folder), SEEDS (default 1001,1002), REPLAY (replay's run folder),
 *   GUIDES_ONLY=1 (draw the guides into <root>/guides-preview, no call), DRY=1 (write the guides, photos
 *   and prompts of the run, no call), SPEC (JSON over the product's settings, null removing one: the
 *   choices Gemma made, docs/direction-photo-results-20261013.md section 5), APPEND (a JSON file of
 *   sentences per direction, {"front": "..."}, written after the app's prompt: a trial only),
 *   REPLACE (a JSON file of [from, to] pairs per direction or for all ("*"), {"*": [["...", "..."]]},
 *   each `from` found exactly once in the app's prompt: a trial only).
 */
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import {
  appendFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
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

/**
 * The products as the screen would be set for them now, and their photos. `cutout`: the photo has a
 * background, taken off as the screen does before it is sent.
 */
const PRODUCTS: Record<
  string,
  { spec: Omit<DirectionPhotoSpec, 'direction'>; photos: string[]; cutout?: boolean }
> = {
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
  // The 2026-10-17 toilet trial (test-results/toilet-direction/truth.md, confirmed by the person; the
  // sizes are assumed, the photos have none). Sides are the product's own (a seated person's right).
  // One piece, white, blue seat and lid, a blue whale lever on the tank's right side; staged room, a mark.
  t1: {
    spec: {
      category: 'toilet',
      form: 'one-piece',
      lid: 'closed',
      installation: 'floor',
      sizeMm: [380, 700, 700],
      photoAngles: ['front-right'],
    },
    photos: ['t1-onepiece-blue-seat.webp'],
    cutout: true,
  },
  // Tankless, all black, a squared box; the back cover is two low slabs, a small panel on its right.
  t2: {
    spec: {
      category: 'toilet',
      form: 'tankless',
      lid: 'closed',
      installation: 'floor',
      sizeMm: [400, 500, 680],
      photoAngles: ['front-right'],
    },
    photos: ['t2-tankless-black-square.webp'],
    cutout: true,
  },
  // Tankless, white, a rounded body narrowing down, a tall boxy unit at the back, vents on its left.
  t3: {
    spec: {
      category: 'toilet',
      form: 'tankless',
      lid: 'closed',
      installation: 'floor',
      sizeMm: [400, 560, 700],
      photoAngles: ['front-left'],
    },
    photos: ['t3-tankless-white-vents.webp'],
    cutout: true,
  },
  // One piece, white, a smooth skirted body, a thin lid, a chrome lever on the tank's right side.
  t4: {
    spec: {
      category: 'toilet',
      form: 'one-piece',
      lid: 'closed',
      installation: 'floor',
      sizeMm: [380, 700, 700],
      photoAngles: ['front-right'],
    },
    photos: ['t4-onepiece-white-slim.webp'],
    cutout: true,
  },
  // Two piece (a seam under the tank), skirted below, a lever at the right end of the tank's front (no angle sent).
  t5: {
    spec: {
      category: 'toilet',
      form: 'two-piece',
      lid: 'closed',
      installation: 'floor',
      sizeMm: [380, 760, 700],
    },
    photos: ['t5-tank-white-k.webp'],
    cutout: true,
  },
  // Tankless, white, rounded, buttons on the unit's right side; a remote panel drawn at the top right.
  t6: {
    spec: {
      category: 'toilet',
      form: 'tankless',
      lid: 'closed',
      installation: 'floor',
      sizeMm: [400, 500, 680],
      photoAngles: ['front-right'],
    },
    photos: ['t6-tankless-white-remote.webp'],
    cutout: true,
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

/** The app's guide renderer, background removal and photo preparation, in Chrome on the GPU. */
async function inBrowser(
  guideInput: Record<string, unknown>,
  photos: string[],
  cutout: boolean,
): Promise<{ guides: Record<string, Buffer>; photos: Buffer[]; cutouts: Buffer[]; removal: unknown[] }> {
  // Served from a local page: the background removal runs in a module worker beside the bundle. The
  // model file and the runtime the screen downloads come from this computer: their addresses are
  // written into the bundles (intercepting the page's requests kept the worker from loading), and
  // the worker is served as .js.
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const rewrite = (file: string, from: string, to: string) => {
    const source = readFileSync(file, 'utf8');
    if (!source.includes(from)) throw new Error(`${file}: ${from} 없음`);
    return { contents: source.replace(from, to), loader: 'ts' as const };
  };
  const local = {
    name: 'local-background-removal',
    setup(plugin: {
      onLoad: (
        options: { filter: RegExp },
        load: (args: { path: string }) => { contents: string; loader: 'ts' },
      ) => void;
    }) {
      plugin.onLoad({ filter: /background-removal[\\/]client\.ts$/ }, ({ path: file }) =>
        rewrite(file, "new URL('./worker.ts', import.meta.url)", "new URL('./worker.js', import.meta.url)"),
      );
      plugin.onLoad({ filter: /background-removal[\\/]model\.ts$/ }, ({ path: file }) => {
        const runtimeUrl = rewrite(
          file,
          "'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.29.0/dist/'",
          `'${origin}/'`,
        ).contents;
        const modelUrl =
          '`https://huggingface.co/${BACKGROUND_MODEL_ID}/resolve/${BACKGROUND_MODEL_REVISION}/onnx/';
        if (!runtimeUrl.includes(modelUrl)) throw new Error(`${file}: 모델 주소 없음`);
        return { contents: runtimeUrl.replace(modelUrl, '`' + origin + '/'), loader: 'ts' as const };
      });
    },
  };
  const bundles = new Map<string, string>();
  const entries: [string, Parameters<typeof build>[0]][] = [
    [
      '/bg/app.js',
      {
        stdin: {
          contents: `export { renderDirectionGuides } from './src/lib/direction-photo/guide-render';
            export { prepareReferenceImage } from './src/lib/ai-export/client';
            export { BackgroundRemovalClient } from './src/lib/background-removal/client';`,
          resolveDir: process.cwd(),
        },
      },
    ],
    ['/bg/worker.js', { entryPoints: ['src/lib/background-removal/worker.ts'] }],
  ];
  for (const [route, options] of entries) {
    const result = await build({
      ...options,
      bundle: true,
      write: false,
      platform: 'browser',
      format: 'esm',
      logLevel: 'warning',
      plugins: [local],
    });
    bundles.set(route, result.outputFiles[0].text);
  }
  const models = path.resolve('tmp/background-model');
  const runtime = path.resolve('node_modules/onnxruntime-web/dist');
  server.on('request', (req, res) => {
    const route = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (bundles.has(route)) {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      res.end(bundles.get(route));
      return;
    }
    if (route === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
      return;
    }
    const name = path.basename(route);
    const file = path.join(name.endsWith('.onnx') ? models : runtime, name);
    if (!existsSync(file)) {
      if (process.env.DEBUG_BROWSER) console.log('404', route);
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': file.endsWith('.wasm')
        ? 'application/wasm'
        : /\.m?js$/.test(file)
          ? 'text/javascript'
          : 'application/octet-stream',
      'Content-Length': statSync(file).size,
      'Access-Control-Allow-Origin': '*',
    });
    createReadStream(file).pipe(res);
  });
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: [
      '--enable-webgl',
      '--ignore-gpu-blocklist',
      '--use-angle=d3d11',
      '--enable-gpu',
      '--enable-unsafe-webgpu',
    ],
  });
  try {
    const page = await browser.newPage();
    if (process.env.DEBUG_BROWSER) {
      page.on('console', (message) => console.log('[page]', message.type(), message.text().slice(0, 300)));
      page.on('worker', (worker) => console.log('[worker]', worker.url()));
      page.on('requestfailed', (request) =>
        console.log('[failed]', request.url(), request.failure()?.errorText),
      );
    }
    await page.goto(`${origin}/`);
    const made = await page.evaluate(
      async ({ guideInput, photos, cutout }) => {
        type App = {
          renderDirectionGuides: (
            input: unknown,
            directions: string[],
          ) => Promise<{ direction: string; blob: Blob }[]>;
          prepareReferenceImage: (photo: Blob) => Promise<Blob>;
          BackgroundRemovalClient: new () => {
            run: (blob: Blob, onProgress: () => void) => Promise<{ blob: Blob } & Record<string, unknown>>;
            dispose: () => void;
          };
        };
        const url = '/bg/app.js';
        const app = (await import(url)) as App;
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
        const prepared: string[] = [],
          cutouts: string[] = [],
          removal: unknown[] = [];
        const client = cutout ? new app.BackgroundRemovalClient() : undefined;
        try {
          for (const photo of photos) {
            let blob = new Blob([Uint8Array.from(atob(photo), (c) => c.charCodeAt(0))]);
            if (client) {
              const result = await client.run(blob, () => {});
              const { backend, precision, processingMs, fallbackReason } = result;
              removal.push({ backend, precision, processingMs, fallbackReason });
              cutouts.push(await encode(result.blob));
              blob = result.blob;
            }
            prepared.push(await encode(await app.prepareReferenceImage(blob)));
          }
        } finally {
          client?.dispose();
        }
        return { guides, photos: prepared, cutouts, removal };
      },
      { guideInput, photos: photos.map((file) => readFileSync(file).toString('base64')), cutout },
    );
    const decode = (value: string) => Buffer.from(value, 'base64');
    return {
      guides: Object.fromEntries(Object.entries(made.guides).map(([key, value]) => [key, decode(value)])),
      photos: made.photos.map(decode),
      cutouts: made.cutouts.map(decode),
      removal: made.removal,
    };
  } finally {
    await browser.close();
    server.close();
  }
}

// What each direction sends: drawn and written now (app), or read from the recorded run (replay).
const sends: Record<string, { guide: Buffer; prompt: string }> = {};
let photoFiles: string[];
// The settings of this run: the product's, or the ones SPEC changes (null drops one).
const spec = Object.fromEntries(
  Object.entries({ ...product.spec, ...(process.env.SPEC ? JSON.parse(process.env.SPEC) : {}) }).filter(
    ([, value]) => value !== null,
  ),
) as Omit<DirectionPhotoSpec, 'direction'>;
const append: Partial<Record<DirectionPhotoView, string>> = process.env.APPEND
  ? JSON.parse(readFileSync(process.env.APPEND, 'utf8'))
  : {};
const replacements: Partial<Record<DirectionPhotoView | '*', [string, string][]>> = process.env.REPLACE
  ? JSON.parse(readFileSync(process.env.REPLACE, 'utf8'))
  : {};
// A trial's sentences in place of the app's; a `from` not found exactly once stops the run.
const replaced = (prompt: string, view: DirectionPhotoView) =>
  [...(replacements['*'] ?? []), ...(replacements[view] ?? [])].reduce((text, [from, to]) => {
    if (text.split(from).length !== 2) throw new Error(`REPLACE: ${view}에서 한 번 나오지 않음: ${from}`);
    return text.replace(from, () => to);
  }, prompt);
if (mode === 'app') {
  const made = await inBrowser(
    {
      category: spec.category,
      form: spec.form,
      lid: spec.lid,
      sizeMm: spec.sizeMm,
      installation: spec.installation,
      skirt: spec.skirt,
    },
    product.photos.map((name) => `${INPUT}/${name}`),
    !!product.cutout,
  );
  for (const [direction, png] of Object.entries(made.guides))
    writeFileSync(`${OUT}/guide-${direction}.png`, png);
  made.cutouts.forEach((png, index) => writeFileSync(`${OUT}/cutout-ref-${index + 1}.png`, png));
  if (made.removal.length) writeFileSync(`${OUT}/removal.json`, JSON.stringify(made.removal, null, 2));
  photoFiles = made.photos.map((png, index) => {
    const file = `${OUT}/sent-ref-${index + 1}.png`;
    writeFileSync(file, png);
    return file;
  });
  if (process.env.GUIDES_ONLY) {
    console.log(`${OUT}: 가이드·보낼 사진만 만듦(호출 없음)`);
    process.exit(0);
  }
  for (const view of views) {
    const full = directionPhotoSpecSchema.parse({ ...spec, direction: view });
    sends[view] = {
      guide: made.guides[VIEW_NAMES[view]],
      prompt: [replaced(buildDirectionPhotoPrompt(full, photoFiles.length), view), append[view]]
        .filter(Boolean)
        .join(' '),
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
  if (process.env.DRY) continue;
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
    {
      product: productName,
      mode,
      label,
      replay: REPLAY,
      spec,
      append: process.env.APPEND,
      replace: process.env.REPLACE,
      views,
      seeds,
    },
    null,
    2,
  ),
);
