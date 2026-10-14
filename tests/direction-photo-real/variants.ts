/**
 * Real, billed comparison of variants of the direction photo (guide or prompt), one change at a
 * time, the same seeds as a real screen run (tests/direction-photo-real/run.mjs). The app's own
 * prompt (buildDirectionPhotoPrompt), estimate (callNeurons) and spec check run here; the guides are
 * the app's renderer (renderDirectionGuides) in a real browser, or the very files a screen run sent.
 * Each request is the route's model call (guide as image 0, photos as images 1–3, width and height
 * twice the guide's, the seed) through the test Worker
 * (test-results/product-representation/real/gen/tools/flux-test-worker.js, run with `wrangler dev`
 * and its remote AI binding, never committed), klein 4B only, no retry. Every call goes to the
 * ledger with its estimated neurons, and none is sent past 90% of AI_BUDGET_NEURONS (counted across
 * the whole ledger; a failure counts as spent).
 *
 * Usage: node tests/run-browser-test.mjs tests/direction-photo-real/variants.ts <bear|smart> <variant> [directions]
 *   e.g. ... variants.ts bear baseline-replay front
 * Env: AI_BUDGET_NEURONS (required), FLUX_WORKER (default http://127.0.0.1:8799),
 *   AI_ROOT (default test-results/direction-photo-bear), AI_LEDGER (default <root>/ledger.jsonl),
 *   SEEDS_FROM (a run folder whose answers give each direction's seeds; default <root>/<product>-baseline).
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
if (!(BUDGET > 0)) throw new Error('AI_BUDGET_NEURONS를 정해 주세요.');

const VIEW_NAMES: Record<DirectionPhotoView, string> = {
  front: '정면',
  left: '왼쪽',
  right: '오른쪽',
  back: '뒤',
};

/** The products as their screen runs sent them (tests/direction-photo-real/run.mjs). */
const PRODUCTS: Record<string, Omit<DirectionPhotoSpec, 'direction'>> = {
  bear: { category: 'toilet', form: 'lid-open', installation: 'floor', sizeMm: [370, 660, 640] },
  smart: { category: 'toilet', form: 'lid-closed', installation: 'floor', sizeMm: [400, 520, 700] },
};

type Variant = {
  /** What it changes, for the sheet and the report. */
  note: string;
  spec?: Partial<Omit<DirectionPhotoSpec, 'direction'>>;
  /** The guides: the files a screen run sent (default the seeds' run), or drawn again. */
  guide?: { from: string } | { render: Record<string, unknown> };
  /** The photos sent: the files a screen run sent (default the seeds' run), or these files made ready. */
  photosFrom?: string;
  photos?: string[];
  /** The prompt from the app's one. */
  prompt?: (base: string, spec: DirectionPhotoSpec, photos: number) => string;
  /** More photos after the screen run's ones (paths), e.g. a chosen front answer cut out. */
  morePhotos?: (view: DirectionPhotoView) => string[];
};

const INPUT = process.env.AI_INPUT ?? 'test-results/product-representation/real/input';
const PHOTOS: Record<string, string> = {
  bear: `${INPUT}/62-bear-toilet-3q.png`,
  smart: `${INPUT}/57-toilet-3q-small.png`,
};

/** One sentence of the app's prompt for another; the sentence must be there. */
function swap(prompt: string, from: string, to: string): string {
  if (!prompt.includes(from)) throw new Error(`프롬프트에 없는 문장: ${from.slice(0, 60)}`);
  return prompt.replace(from, to);
}
const FORM_NOUNS: Record<string, string> = {
  'lid-closed': 'a floor-standing toilet with its lid closed',
  'lid-open': 'a floor-standing toilet with its lid open',
};
const imageZero = (spec: DirectionPhotoSpec) =>
  `Image 0 is a plain grey 3D render of ${FORM_NOUNS[spec.form]}. It fixes the exact shape, outline, proportions, camera angle, size and position in the frame: keep all of these exactly as in image 0.`;
const PHOTO_ROLE =
  'Image 1 is a photo of the real product taken from another angle: use it only for the material, colour and small details, never for the shape, the camera angle or the position.';
const PHOTO_FEATURES =
  'Image 1 is a photo of the real product taken from another angle: keep the overall outline from image 0, but take the small shape features of the real product (such as ears or bumps on the tank, a flush lever or buttons on a side) and its material, colour and printed patterns from image 1, each where it is on the real product. Never take the camera angle or the position from image 1.';
const IMAGE_ZERO_STAND_IN =
  'Image 0 is a plain grey 3D render of a generic toilet standing in for the real product. It fixes the camera angle, the view direction, the overall size and the position in the frame: keep these exactly as in image 0. Its parts are only stand-ins.';
const PHOTO_BODY =
  "Image 1 is a photo of the real product taken from another angle: draw the real product's own body, parts and proportions, its small shape features, material, colour and printed patterns from image 1, turned to the view of image 0. Never take the camera angle or the position from image 1.";

const VARIANTS: Record<string, Variant> = {
  // The app as it is: its guide for the shape the screen offers, the photo made ready as the screen
  // does (already cut out: the screen's BiRefNet pass is left out), its prompt.
  baseline: { note: '앱 그대로(지금 가이드·프롬프트)', guide: { render: {} }, photos: ['<product>'] },
  // The control: the screen run's guide, photo, prompt and seed again, to see the harness gives the
  // same model call as the route.
  'baseline-replay': { note: '기준(화면 실행)과 같은 입력을 하네스로 다시 보냄' },
  // The photo's role, the guides and seeds of the baseline unchanged.
  // The guide's shape as the product's (and the sentence naming it), the prompt otherwise the app's.
  'guide-one-piece-seat': {
    note: '가이드: 일체형 몸통 + 시트만(뚜껑 없음), 이름 문장도 맞춤',
    guide: { render: { model: { toiletBody: 'one-piece', toiletLidState: null } } },
    prompt: (prompt) =>
      swap(
        prompt,
        'a floor-standing toilet with its lid open',
        'a one-piece floor-standing toilet with a seat and no lid',
      ),
  },
  'guide-tankless': {
    note: '가이드: 물탱크 없는 몸통 + 뒤쪽 비데 덮개 + 뚜껑 닫힘, 이름 문장도 맞춤',
    guide: { render: { model: { toiletBody: 'tankless' } } },
    prompt: (prompt) =>
      swap(
        prompt,
        'a floor-standing toilet with its lid closed',
        'a tankless floor-standing toilet with its seat unit at the back and its lid closed',
      ),
  },
  'photo-features': {
    note: '사진 역할: 전체 윤곽은 image 0, 작은 모양 특징·재질·무늬는 image 1',
    prompt: (prompt) => swap(prompt, PHOTO_ROLE, PHOTO_FEATURES),
  },
  'photo-body': {
    note: '사진 역할: image 0은 시점·크기·위치만, 몸통 모양·부분·특징·무늬는 image 1',
    prompt: (prompt, spec) =>
      swap(swap(prompt, imageZero(spec), IMAGE_ZERO_STAND_IN), PHOTO_ROLE, PHOTO_BODY),
  },
};

// After the runner and this file (node tests/run-browser-test.mjs <this file> ...).
const args = process.argv.slice(3);
const productName = args[0] ?? '';
const product = PRODUCTS[productName];
if (!product) throw new Error(`제품: ${Object.keys(PRODUCTS).join(', ')}`);
const SEEDS_FROM = process.env.SEEDS_FROM ?? `${ROOT}/${productName}-baseline`;
const name = args[1] ?? '';
const variant = VARIANTS[name];
if (!variant) throw new Error(`변형 이름: ${Object.keys(VARIANTS).join(', ')}`);
const views = (args[2]?.split(',') ?? ['front', 'left', 'right', 'back']) as DirectionPhotoView[];
const OUT = `${ROOT}/${productName}-${name}`;
mkdirSync(`${OUT}/answers`, { recursive: true });

type Row = { status: number | string; neurons?: number; n?: number };
const ledger = (): Row[] =>
  existsSync(LEDGER)
    ? readFileSync(LEDGER, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Row)
    : [];
const spent = () => ledger().filter((row) => row.status !== 'refused');
// Each direction's seeds: those of the run in SEEDS_FROM, or SEEDS (default 1001,1002) for a first run.
const seedsOf = (view: DirectionPhotoView) =>
  existsSync(`${SEEDS_FROM}/answers`) && SEEDS_FROM !== OUT
    ? readdirSync(`${SEEDS_FROM}/answers`)
        .filter((file) => file.includes(`-${view}-`))
        .sort()
        .map((file) =>
          Number(
            file
              .replace(/\.png$/, '')
              .split('-')
              .at(-1),
          ),
        )
    : (process.env.SEEDS ?? '1001,1002').split(',').map(Number);

// The app's guide renderer and photo preparation (prepareReferenceImage), in a real browser.
type BrowserWork = { guideInput?: Record<string, unknown>; photos?: string[] };
async function inBrowser(work: BrowserWork): Promise<{ guides: Record<string, Buffer>; photos: Buffer[] }> {
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
  // The person's Chrome on the GPU, as the screen draws the guides (tests/direction-guide-browser.ts).
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
        if (guideInput)
          for (const guide of await app.renderDirectionGuides(guideInput, ['정면', '왼쪽', '오른쪽', '뒤']))
            guides[guide.direction] = await encode(guide.blob);
        const prepared: string[] = [];
        for (const photo of photos) {
          const bytes = Uint8Array.from(atob(photo), (c) => c.charCodeAt(0));
          prepared.push(await encode(await app.prepareReferenceImage(new Blob([bytes]))));
        }
        return { guides, photos: prepared };
      },
      {
        guideInput: work.guideInput,
        photos: (work.photos ?? []).map((file) => readFileSync(file).toString('base64')),
      },
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

const base = { ...product, ...variant.spec };
const guideFrom = variant.guide && 'from' in variant.guide ? variant.guide.from : SEEDS_FROM;
const photoInputs = variant.photos?.map((file) => (file === '<product>' ? PHOTOS[productName] : file));
const work = await inBrowser({
  guideInput:
    variant.guide && 'render' in variant.guide
      ? {
          category: base.category,
          form: base.form,
          sizeMm: base.sizeMm,
          installation: base.installation,
          ...variant.guide.render,
        }
      : undefined,
  photos: photoInputs,
});
const drawn = Object.keys(work.guides).length ? work.guides : undefined;
// The photos as sent: made ready here as the screen does (on white, FLUX's input size), or the files
// another run sent.
const photosFrom = variant.photosFrom ?? SEEDS_FROM;
const sources = photoInputs
  ? work.photos
  : readdirSync(photosFrom)
      .filter((file) => /^sent-ref-\d+\.png$/.test(file))
      .sort()
      .map((file) => readFileSync(`${photosFrom}/${file}`));
const photoFiles = sources.map((png, index) => {
  const file = `${OUT}/sent-ref-${index + 1}.png`;
  writeFileSync(file, png);
  return file;
});

if (process.env.GUIDES_ONLY) {
  // A look at the guides before any call.
  for (const [direction, png] of Object.entries(drawn ?? {}))
    writeFileSync(`${OUT}/guide-${direction}.png`, png);
  console.log(`${OUT}: 가이드만 그림(호출 없음)`);
  process.exit(0);
}

let n = ledger().filter((row) => typeof row.n === 'number').length;
const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);
log(`${name}: ${variant.note}`);
for (const view of views) {
  const spec = directionPhotoSpecSchema.parse({ ...base, direction: view });
  const guide = drawn ? drawn[VIEW_NAMES[view]] : readFileSync(`${guideFrom}/sent-guide-${view}.png`);
  writeFileSync(`${OUT}/guide-${VIEW_NAMES[view]}.png`, guide);
  writeFileSync(`${OUT}/sent-guide-${view}.png`, guide);
  const photos = [...photoFiles, ...(variant.morePhotos?.(view) ?? [])];
  if (photos.length > 3) throw new Error('사진은 3장까지예요.');
  const appPrompt = buildDirectionPhotoPrompt(spec, photos.length);
  const prompt = variant.prompt ? variant.prompt(appPrompt, spec, photos.length) : appPrompt;
  writeFileSync(`${OUT}/prompt-${view}.txt`, prompt);
  const meta = await sharp(guide).metadata();
  const cost = callNeurons({ width: meta.width!, height: meta.height! }, photos.length);
  for (const seed of seedsOf(view)) {
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
      variant: name,
      direction: view,
      seed: String(seed),
      refs: photos.length,
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
          refs: photos.map((file) => readFileSync(file).toString('base64')),
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
  JSON.stringify({ product: productName, name, note: variant.note, spec: base, views }, null, 2),
);
