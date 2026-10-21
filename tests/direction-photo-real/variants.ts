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
 *
 * FLUX_ENGINE=local sends the same request to the local FLUX.2 klein 4B server instead
 * (tests/direction-photo-real/local-flux/server.py, default http://127.0.0.1:8798): no
 * AI_BUDGET_NEURONS is needed, the ledger gets 0 neurons, the engine and its settings, and an answer
 * that does not say `meta.engine: 'local'` stops the run (the budget counts Cloudflare's calls only).
 * Trial-only changes to what is sent (docs/toilet-side-view-results-20261021.md):
 *   PHOTOS (comma-separated photo paths in place of the product's), REF_EDGE (the photos' long side
 *   shrunk to this many px after the screen's preparation, on white), REF_FLIP=1 (the photos turned
 *   over), REF_ADD_FLIP=1 (each photo followed by itself turned over), GUIDE_FILES (a JSON file
 *   {"left": {"file": "...", "flip": true}}: that picture, at the guide's size, as image 0), GUIDE_EDIT
 *   (contrast:<factor> or outline: the guide drawn stronger).
 * And the wide screen's (docs/direction-photo-explore-results-20261021.md):
 *   GUIDE_ELEVATION (the guides' camera this many degrees above level, the app's 10), GUIDE_LOOK
 *   (level:<grey 0-1>,rough:<0-1>,tint:<hex>,ambient:<n>,key:<n>: the guides' material and lights,
 *   written into guide-render.ts as it is bundled), GUIDE_FRAME (the outline's share of the guide's
 *   long side, the app's 0.9), GUIDE_EDGE (the guide's long side in px, 16 px steps, after the rest),
 *   GUIDE_FILES' blend (0-1: the picture over the guide at that opacity, in place of it) and lever
 *   ([x, y, w, h] fractions of the guide: a grey lever drawn there), REF_CROP (x,y,w,h fractions: the
 *   part of each photo sent), PHOTOS=none (no photo: PROMPT_FILE then writes the whole prompt),
 *   PREPEND_REFS (a JSON file {"right": [{"file": "...", "flip": true}]}: pictures sent before the
 *   photos, image 1 on), PROMPT_FILE (a JSON file of whole prompts per direction or for all ("*"),
 *   {app} standing for the app's), PROMPT_EDIT=renumber (images counted from 1: the guide image 1),
 *   FLUX_GUIDANCE (Cloudflare's guidance field sent; the local distilled model has no use for it).
 *   A file path in GUIDE_FILES or PREPEND_REFS may hold {seed} (each seed its own picture) and one *
 *   in its name (the one answer in that folder matching it, e.g. answers/*-left-{seed}.png); such a
 *   run writes each seed's guide as sent-guide-<view>-<seed>.png and the app's as sent-guide-<view>.png.
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
import sharp, { type Sharp } from 'sharp';
import { buildDirectionPhotoPrompt } from '../../src/lib/direction-photo/prompt';
import { callNeurons } from '../../src/lib/direction-photo/plan';
import { FLUX_INPUT_EDGE } from '../../src/lib/ai-export/contract';
import {
  directionPhotoSpecSchema,
  type DirectionPhotoSpec,
  type DirectionPhotoView,
} from '../../src/lib/direction-photo/contract';

const ROOT = process.env.AI_ROOT ?? 'test-results/direction-photo-bear';
const LEDGER = process.env.AI_LEDGER ?? `${ROOT}/ledger.jsonl`;
const LOCAL = process.env.FLUX_ENGINE === 'local';
if (process.env.FLUX_ENGINE && !LOCAL) throw new Error('FLUX_ENGINE은 local만 받아요(없으면 Cloudflare).');
const BUDGET = Number(process.env.AI_BUDGET_NEURONS);
const WORKER = process.env.FLUX_WORKER ?? (LOCAL ? 'http://127.0.0.1:8798' : 'http://127.0.0.1:8799');
const INPUT = process.env.AI_INPUT ?? 'test-results/product-representation/real/input';
if (!LOCAL && !(BUDGET > 0)) throw new Error('AI_BUDGET_NEURONS를 정해 주세요.');

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
  // The 2026-10-21 side-view trial (docs/toilet-side-view-results-20261021.md): the bear and the smart
  // toilet turned over, so the side nearer the photo is the left (their levers and buttons too), and
  // the person's photos (test-results/toilet-side/input/extra, sizes assumed). A photo name with a
  // slash is a path from the repository's root.
  'bear-m': {
    spec: {
      category: 'toilet',
      form: 'one-piece',
      lid: 'seat',
      installation: 'floor',
      sizeMm: [370, 660, 640],
      photoAngles: ['front-left'],
    },
    photos: ['test-results/product-representation/input/bear-toilet-cutout-mirrored.png'],
  },
  'smart-m': {
    spec: {
      category: 'toilet',
      form: 'tankless',
      lid: 'closed',
      installation: 'floor',
      sizeMm: [400, 520, 700],
      photoAngles: ['front-left'],
    },
    photos: ['test-results/product-representation/input/smart-toilet-cutout-mirrored.png'],
  },
  // The smart toilet's photo with its grey backdrop (57 is its cut-out): the screen's background removal.
  u4: {
    spec: {
      category: 'toilet',
      form: 'tankless',
      lid: 'closed',
      installation: 'floor',
      sizeMm: [400, 520, 700],
      photoAngles: ['front-right'],
    },
    photos: ['test-results/toilet-side/input/extra/u4.jpg'],
    cutout: true,
  },
  // One piece, lid closed, a chrome button on the tank's right side.
  u5: {
    spec: {
      category: 'toilet',
      form: 'one-piece',
      lid: 'closed',
      installation: 'floor',
      sizeMm: [380, 700, 700],
      photoAngles: ['front-right'],
    },
    photos: ['test-results/toilet-side/input/extra/u5.jpg'],
    cutout: true,
  },
  // One piece with a low tank, lid closed, a chrome button on its right side.
  u6: {
    spec: {
      category: 'toilet',
      form: 'one-piece',
      lid: 'closed',
      installation: 'floor',
      sizeMm: [380, 620, 700],
      photoAngles: ['front-right'],
    },
    photos: ['test-results/toilet-side/input/extra/u6.jpg'],
    cutout: true,
  },
  // Two piece, the foot in the open, lid closed, the lever at the left end of the tank's front (its right).
  u9: {
    spec: {
      category: 'toilet',
      form: 'two-piece',
      lid: 'closed',
      installation: 'floor',
      sizeMm: [380, 760, 700],
    },
    photos: ['test-results/toilet-side/input/extra/u9.jpg'],
    cutout: true,
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
      // The guides' look and frame as a trial asks (GUIDE_LOOK, GUIDE_FRAME); as they are without.
      plugin.onLoad({ filter: /direction-photo[\\/]guide-render\.ts$/ }, ({ path: file }) => {
        let source = readFileSync(file, 'utf8');
        const swap = (from: string, to: string) => {
          if (source.split(from).length !== 2) throw new Error(`${file}: 한 번 나오지 않음: ${from}`);
          source = source.replace(from, () => to);
        };
        const look = Object.fromEntries(
          (process.env.GUIDE_LOOK ?? '')
            .split(',')
            .filter(Boolean)
            .map((pair) => pair.split(':') as [string, string]),
        );
        const unknown = Object.keys(look).filter(
          (key) => !['level', 'rough', 'tint', 'ambient', 'key'].includes(key),
        );
        if (unknown.length) throw new Error(`GUIDE_LOOK: ${unknown.join(', ')}`);
        if (look.level)
          swap(
            ': Math.min(0.9, Math.max(0.45, source.color?.getHSL({ h: 0, s: 0, l: 0 }).l ?? 0.8));',
            `: ${Number(look.level)};`,
          );
        if (look.rough)
          swap('roughness: metal ? 0.55 : 0.9', `roughness: metal ? 0.55 : ${Number(look.rough)}`);
        if (look.tint) {
          const [r, g, b] = [1, 3, 5].map((i) => parseInt(look.tint.slice(i, i + 2), 16) / 255);
          swap(
            'grey.color.setRGB(level, level, level * 1.01);',
            `grey.color.setRGB(level * ${r}, level * ${g}, level * ${b});`,
          );
        }
        if (look.ambient)
          swap("new AmbientLight('#ffffff', 1.6)", `new AmbientLight('#ffffff', ${Number(look.ambient)})`);
        if (look.key)
          swap(
            "new DirectionalLight('#ffffff', 2.3)",
            `new DirectionalLight('#ffffff', ${Number(look.key)})`,
          );
        const frame = process.env.GUIDE_FRAME;
        if (frame)
          swap(
            '(size.width * 0.9) / extent.width, (size.height * 0.9) / extent.height',
            `(size.width * ${Number(frame)}) / extent.width, (size.height * ${Number(frame)}) / extent.height`,
          );
        return { contents: source, loader: 'ts' as const };
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
      async ({ guideInput, photos, cutout, elevation }) => {
        type App = {
          renderDirectionGuides: (
            input: unknown,
            directions: string[],
            elevation?: number,
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
        for (const guide of await app.renderDirectionGuides(
          guideInput,
          ['정면', '왼쪽', '오른쪽', '뒤'],
          elevation ?? undefined,
        ))
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
      {
        guideInput,
        photos: photos.map((file) => readFileSync(file).toString('base64')),
        cutout,
        // The app's 10° unless a trial asks otherwise (undefined does not cross into the page).
        elevation: process.env.GUIDE_ELEVATION ? Number(process.env.GUIDE_ELEVATION) : null,
      },
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
/** A long side cut to `edge` px, both sides in 16 px steps (a route-sized PNG). */
async function toEdge(png: Buffer, edge: number): Promise<Buffer> {
  const { width = 0, height = 0 } = await sharp(png).metadata();
  const scale = edge / Math.max(width, height);
  return sharp(png)
    .resize(Math.round((width * scale) / 16) * 16, Math.round((height * scale) / 16) * 16, { fit: 'fill' })
    .png()
    .toBuffer();
}

/** The photos as a trial sends them (REF_CROP, REF_EDGE, REF_FLIP, REF_ADD_FLIP); the screen's without them. */
async function trialRefs(photos: Buffer[]): Promise<Buffer[]> {
  const edge = Number(process.env.REF_EDGE ?? 0);
  const crop = process.env.REF_CROP?.split(',').map(Number);
  const out: Buffer[] = [];
  for (const photo of photos) {
    let png = photo;
    if (crop) {
      // That part only, as large as the photo was.
      const { width = 0, height = 0 } = await sharp(png).metadata();
      const [x, y, w, h] = crop;
      const part = await sharp(png)
        .extract({
          left: Math.round(x * width),
          top: Math.round(y * height),
          width: Math.round(w * width),
          height: Math.round(h * height),
        })
        .png()
        .toBuffer();
      png = await toEdge(part, Math.max(width, height));
    }
    if (edge) png = await toEdge(png, edge);
    const flipped = await sharp(png).flop().png().toBuffer();
    if (process.env.REF_FLIP) out.push(flipped);
    else out.push(png, ...(process.env.REF_ADD_FLIP ? [flipped] : []));
  }
  return out;
}

type TrialPicture = { file: string; flip?: boolean };
const guideFiles: Partial<
  Record<DirectionPhotoView, TrialPicture & { blend?: number; lever?: [number, number, number, number] }>
> = process.env.GUIDE_FILES ? JSON.parse(readFileSync(process.env.GUIDE_FILES, 'utf8')) : {};
const prepends: Partial<Record<DirectionPhotoView, TrialPicture[]>> = process.env.PREPEND_REFS
  ? JSON.parse(readFileSync(process.env.PREPEND_REFS, 'utf8'))
  : {};
const bySeed = (pictures: (TrialPicture | undefined)[] = []) =>
  pictures.some((picture) => picture?.file.includes('{seed}'));

/** A trial picture's file for a seed: {seed} filled in, and one * matched to the one file it names. */
function trialFile(pattern: string, seed?: number): string {
  const file = seed === undefined ? pattern : pattern.replaceAll('{seed}', String(seed));
  if (file.includes('{seed}')) throw new Error(`${pattern}: seed마다 다른 그림이에요.`);
  if (!file.includes('*')) return file;
  const folder = path.dirname(file);
  const name = new RegExp(
    `^${path
      .basename(file)
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`,
  );
  const found = readdirSync(folder).filter((entry) => name.test(entry));
  if (found.length !== 1) throw new Error(`${file}: ${found.length}개가 맞아요(1개여야 해요).`);
  return `${folder}/${found[0]}`;
}

/**
 * Image 0 as a trial sends it for a view (GUIDE_FILES, GUIDE_EDIT, GUIDE_EDGE), from the app's guide;
 * undefined when the trial leaves it as it is.
 */
async function trialGuide(view: DirectionPhotoView, guide: Buffer, seed?: number) {
  const { width = 0, height = 0 } = await sharp(guide).metadata();
  const edit = process.env.GUIDE_EDIT;
  const swap = guideFiles[view];
  let changed: Buffer | undefined;
  if (swap) {
    let picture = sharp(readFileSync(trialFile(swap.file, seed))).resize(width, height, { fit: 'fill' });
    if (swap.flip) picture = picture.flop();
    changed = await picture.flatten({ background: '#ffffff' }).png().toBuffer();
    if (swap.blend !== undefined) {
      // The picture at that opacity over the app's guide.
      const over = await sharp(changed).ensureAlpha(swap.blend).png().toBuffer();
      changed = await sharp(guide)
        .flatten({ background: '#ffffff' })
        .composite([{ input: over }])
        .png()
        .toBuffer();
    }
    if (swap.lever) {
      // A small grey handle with rounded ends, as the guide's grey would draw it.
      const [x, y, w, h] = swap.lever;
      const box = { x: x * width, y: y * height, w: w * width, h: h * height };
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" rx="${Math.min(box.w, box.h) / 2}" fill="#8f8f8f" stroke="#6a6a6a" stroke-width="1"/></svg>`;
      changed = await sharp(changed)
        .composite([{ input: Buffer.from(svg) }])
        .png()
        .toBuffer();
    }
  } else if (edit?.startsWith('contrast:')) {
    // Around the middle grey, the white background staying white.
    const factor = Number(edit.slice('contrast:'.length));
    changed = await sharp(guide)
      .linear(factor, 128 * (1 - factor))
      .png()
      .toBuffer();
  } else if (edit === 'outline') {
    // A dark line where the grey meets the white, over the guide as it is. One step per sharp
    // instance: sharp runs its operations in its own fixed order, and a second threshold replaces
    // the first.
    const step = async (input: Buffer, apply: (image: Sharp) => Sharp) =>
      apply(sharp(input)).png().toBuffer();
    const solid = await step(guide, (image) => image.removeAlpha().greyscale().threshold(250).negate());
    const edges = await step(solid, (image) =>
      image.convolve({ width: 3, height: 3, kernel: [-1, -1, -1, -1, 8, -1, -1, -1, -1] }),
    );
    // About 3 px wide: the 1 px edge blurred and cut again (sharp's dilate left nothing here).
    const thin = await step(edges, (image) => image.threshold(1));
    const lines = await step(await step(thin, (image) => image.blur(1)), (image) => image.threshold(20));
    const mask = await step(lines, (image) => image.negate());
    changed = await sharp(guide)
      .composite([{ input: mask, blend: 'multiply' }])
      .png()
      .toBuffer();
  } else if (edit) throw new Error('GUIDE_EDIT는 contrast:<배수> 또는 outline');
  const edge = Number(process.env.GUIDE_EDGE ?? 0);
  if (edge)
    changed = await toEdge(
      await sharp(changed ?? guide)
        .flatten({ background: '#ffffff' })
        .png()
        .toBuffer(),
      edge,
    );
  return changed;
}

/** The pictures a trial sends before the photos for a view and seed (PREPEND_REFS), on white. */
async function prependedRefs(view: DirectionPhotoView, seed: number): Promise<Buffer[]> {
  const out: Buffer[] = [];
  for (const { file, flip } of prepends[view] ?? []) {
    let picture = sharp(readFileSync(trialFile(file, seed))).flatten({ background: '#ffffff' });
    if (flip) picture = picture.flop();
    out.push(await toEdge(await picture.png().toBuffer(), FLUX_INPUT_EDGE));
  }
  return out;
}

const promptFiles: Partial<Record<DirectionPhotoView | '*', string>> = process.env.PROMPT_FILE
  ? JSON.parse(readFileSync(process.env.PROMPT_FILE, 'utf8'))
  : {};
if (process.env.PROMPT_EDIT && process.env.PROMPT_EDIT !== 'renumber')
  throw new Error('PROMPT_EDIT는 renumber');
/** The images counted from 1: image 0 becomes image 1, images 1–3 images 2–4. */
const renumbered = (prompt: string) =>
  prompt.replace(
    /\b(Images?|images?) (\d)(?:–(\d))?/g,
    (_, word: string, from: string, to?: string) =>
      `${word} ${Number(from) + 1}${to ? `–${Number(to) + 1}` : ''}`,
  );
/** A view's prompt: the app's with REPLACE and APPEND, or PROMPT_FILE's around it, then PROMPT_EDIT. */
function trialPrompt(view: DirectionPhotoView, photos: number): string {
  const app = () =>
    [
      replaced(
        buildDirectionPhotoPrompt(directionPhotoSpecSchema.parse({ ...spec, direction: view }), photos),
        view,
      ),
      append[view],
    ]
      .filter(Boolean)
      .join(' ');
  const template = promptFiles[view] ?? promptFiles['*'];
  const prompt = template ? template.replace('{app}', () => app()) : app();
  return process.env.PROMPT_EDIT === 'renumber' ? renumbered(prompt) : prompt;
}

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
    (process.env.PHOTOS === 'none' ? [] : (process.env.PHOTOS?.split(',') ?? product.photos)).map((name) =>
      name.includes('/') ? name : `${INPUT}/${name}`,
    ),
    !!product.cutout,
  );
  for (const [direction, png] of Object.entries(made.guides))
    writeFileSync(`${OUT}/guide-${direction}.png`, png);
  made.cutouts.forEach((png, index) => writeFileSync(`${OUT}/cutout-ref-${index + 1}.png`, png));
  if (made.removal.length) writeFileSync(`${OUT}/removal.json`, JSON.stringify(made.removal, null, 2));
  const refs = await trialRefs(made.photos);
  photoFiles = refs.map((png, index) => {
    const file = `${OUT}/sent-ref-${index + 1}.png`;
    writeFileSync(file, png);
    return file;
  });
  for (const view of views) {
    // A picture of each seed's own is made in the calls' loop: the app's guide stays here.
    if (bySeed([guideFiles[view]])) continue;
    const changed = await trialGuide(view, made.guides[VIEW_NAMES[view]]);
    if (changed) made.guides[VIEW_NAMES[view]] = changed;
  }
  if (process.env.GUIDES_ONLY) {
    console.log(`${OUT}: 가이드·보낼 사진만 만듦(호출 없음)`);
    process.exit(0);
  }
  for (const view of views)
    sends[view] = { guide: made.guides[VIEW_NAMES[view]], prompt: trialPrompt(view, photoFiles.length) };
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
  const seedGuides = mode === 'app' && bySeed([guideFiles[view]]);
  const seedRefs = bySeed(prepends[view]);
  for (const seed of seeds) {
    // This seed's image 0 and pictures before the photos, when the trial gives each seed its own.
    const sent = seedGuides ? ((await trialGuide(view, guide, seed)) ?? guide) : guide;
    if (seedGuides) writeFileSync(`${OUT}/sent-guide-${view}-${seed}.png`, sent);
    const before = await prependedRefs(view, seed);
    before.forEach((png, index) =>
      writeFileSync(`${OUT}/sent-pre-${view}${seedRefs ? `-${seed}` : ''}-${index + 1}.png`, png),
    );
    if (process.env.DRY) continue;
    const meta = await sharp(sent).metadata();
    const refs = [...before, ...photoFiles.map((file) => readFileSync(file))];
    // A local answer costs nothing on the account: only Cloudflare's calls count against the budget.
    const cost = LOCAL ? 0 : callNeurons({ width: meta.width!, height: meta.height! }, refs.length);
    const used = spent().reduce((sum, row) => sum + (row.neurons ?? 0), 0);
    if (!LOCAL && used + cost > BUDGET * 0.9) {
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
      refs: refs.length,
      guide: [meta.width, meta.height],
      neurons: Number(cost.toFixed(2)),
      engine: LOCAL ? 'local' : 'cloudflare',
    };
    const started = Date.now();
    try {
      const response = await fetch(WORKER, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'flux-2-klein-4b',
          image: sent.toString('base64'),
          refs: refs.map((png) => png.toString('base64')),
          prompt,
          width: meta.width! * 2,
          height: meta.height! * 2,
          seed,
          // Cloudflare's guidance field, sent only when a trial sets it (the route never sends it).
          ...(process.env.FLUX_GUIDANCE && { guidance: Number(process.env.FLUX_GUIDANCE) }),
        }),
        signal: AbortSignal.timeout(LOCAL ? 900_000 : 200_000),
      });
      const body = (await response.json()) as {
        image?: string;
        error?: string;
        status?: number;
        meta?: Record<string, unknown>;
      };
      row.status = response.ok && body.image ? 200 : (body.status ?? response.status);
      if (LOCAL) {
        row.meta = body.meta;
        // Never a Cloudflare answer counted as free.
        if (body.meta?.engine !== 'local') {
          row.status = 'not-local';
          row.error = `로컬 서버가 아닌 응답이에요: ${JSON.stringify(body.meta ?? null).slice(0, 200)}`;
          delete body.image;
        }
      }
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
      engine: LOCAL ? 'local' : 'cloudflare',
      trial: Object.fromEntries(
        [
          'PHOTOS',
          'REF_EDGE',
          'REF_FLIP',
          'REF_ADD_FLIP',
          'REF_CROP',
          'GUIDE_FILES',
          'GUIDE_EDIT',
          'GUIDE_ELEVATION',
          'GUIDE_LOOK',
          'GUIDE_FRAME',
          'GUIDE_EDGE',
          'PREPEND_REFS',
          'PROMPT_FILE',
          'PROMPT_EDIT',
          'FLUX_GUIDANCE',
        ].flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : [])),
      ),
      views,
      seeds,
    },
    null,
    2,
  ),
);
