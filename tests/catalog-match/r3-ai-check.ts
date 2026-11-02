/**
 * Round 3: a small real AI check (photos go to Cloudflare). Three of the fifteen photos (pc-01,
 * remote-02, pc-04), each model asked once per task: a tile board (the photo's face and 12 numbered
 * candidates), a product board (the cut-out product and up to 12 numbered public products of its
 * kind) and the position question (the photo with numbered product boxes: which wall, which third).
 * Moondream only detects. It measures request format, real tokens, neurons and answers, to keep two
 * models. Prompts carry no answer, no answer-sheet text and no per-photo branch.
 *
 * Needs the temporary Worker: npx wrangler dev --config tests/catalog-match/ai-worker/wrangler.jsonc --ip 127.0.0.1 --port 8799
 * Usage: node tests/run-browser-test.mjs tests/catalog-match/r3-ai-check.ts [--dry] [--models gemma,clef-flash,clef,llama,moondream]
 * Output: test-results/catalog-match/r3-ai/{boards/,answers.jsonl}; ledger.jsonl
 */
import { appendFileSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { callAi, spent, StopRun } from './ai';
import {
  choiceSchema,
  clefChoices,
  clefInput,
  gemmaInput,
  llamaInput,
  POSITION_TEXT,
  positionSchema,
  PRODUCT_TEXT,
  TILE_TEXT,
} from './questions';
import { out, readJson } from './data';
import { SNAPSHOT } from './paths.mjs';
import { openHarness } from './browser/harness';
import type * as Page from './browser/page';

const arg = (name: string, fallback: string) => {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? fallback : process.argv[at + 1];
};
const DRY = process.argv.includes('--dry');
const ROUND = arg('round', 'r3');
const PHOTOS = arg('photos', 'pc-01,remote-02,pc-04').split(',');
const MODELS = arg('models', 'gemma,clef-flash,clef,llama,moondream').split(',');
const TILE_METHOD = arg('tile-method', 'clean.rect.raw|fused(classic+siglip2.patchmean.repeat)');
const PRODUCT_METHOD = arg('product-method', 'dinov2.pooled.box');
const MODEL_ID: Record<string, string> = {
  gemma: '@cf/google/gemma-4-26b-a4b-it',
  'clef-flash': '@cf/cloudflare/clef-flash',
  clef: '@cf/cloudflare/clef',
  llama: '@cf/meta/llama-3.2-11b-vision-instruct',
  moondream: '@cf/moondream/moondream3.1-9B-A2B',
};
/** Conservative estimates checked against the budget before each call (neurons). */
const ESTIMATE: Record<string, number> = { gemma: 30, 'clef-flash': 10, clef: 60, llama: 40, moondream: 80 };
const target = join(out, ROUND === 'r3' ? 'r3-ai' : `${ROUND}-ai`);
mkdirSync(join(target, 'boards'), { recursive: true });
const answersFile = join(target, 'answers.jsonl');

// ---------- what goes on the boards ----------
type Box = { left: number; top: number; right: number; bottom: number };
const index = readJson<{
  photos: { id: string; path: string; candidates: { id?: string; kind: string; box: Box }[] }[];
}>(join(out, 'photos', 'index.json'));
const tileTop = readJson<Record<string, Record<string, string[]>>>(join(out, 'r1-tiles', 'photo-top12.json'));
const productTop = readJson<Record<string, Record<string, { id: string }[]>>>(
  join(out, 'r4-products', 'top12.json'),
);
const snapshot = readJson<{
  placements: {
    materialId: string;
    category: string;
    widthMm: number;
    heightMm: number;
    defaultGroutWidth: number;
    defaultGroutColor: string;
    textureAssetIds: string[];
    views: { assetId: string; direction: string }[];
  }[];
}>(join(SNAPSHOT as string, 'catalog.json'));
const files = new Map(
  readdirSync(join(SNAPSHOT as string, 'images')).map((f) => [f.replace(/\.[a-z]+$/, ''), f]),
);
const placement = new Map(snapshot.placements.map((p) => [p.materialId, p]));
const imagePath = (assetId: string) => join(SNAPSHOT as string, 'images', files.get(assetId)!);
const PRODUCT = new Set(['toilet', 'basin', 'vanity', 'bath']);

type Job = {
  photo: string;
  tile?: {
    face: string;
    crop: string;
    candidates: {
      id: string;
      path: string;
      widthMm: number;
      heightMm: number;
      groutMm: number;
      groutColor: string;
    }[];
  };
  product?: { query: string; kind: string; crop: string; candidates: { id: string; path: string }[] };
  position: { path: string; boxes: Box[]; kinds: string[] };
};
const jobs: Job[] = PHOTOS.map((id) => {
  const photo = index.photos.find((p) => p.id === id)!;
  const faces = Object.keys(tileTop).filter((key) => key.startsWith(`${id}:`));
  const face = faces.find((f) => f.endsWith(':back')) ?? faces[0];
  const products = photo.candidates
    .map((c, i) => ({ ...c, id: c.id ?? `c${i}` }))
    .filter((c) => PRODUCT.has(c.kind));
  const first = products.find((c) => c.kind === 'toilet') ?? products[0];
  const queryId = first && `${id}:${first.id}`;
  return {
    photo: id,
    tile: face
      ? {
          face,
          crop: join(out, 'crops', 'photos', `${face.replace(':', '-')}.jpg`),
          candidates: tileTop[face][TILE_METHOD].map((tileId) => {
            const p = placement.get(tileId)!;
            return {
              id: tileId,
              path: imagePath(p.textureAssetIds[0]),
              widthMm: p.widthMm,
              heightMm: p.heightMm,
              groutMm: p.defaultGroutWidth,
              groutColor: p.defaultGroutColor,
            };
          }),
        }
      : undefined,
    product:
      queryId && productTop[queryId]
        ? {
            query: queryId,
            kind: first.kind === 'vanity' ? 'basin' : first.kind,
            crop: join(out, 'crops', 'products', `${queryId.replace(':', '-')}.jpg`),
            candidates: productTop[queryId][PRODUCT_METHOD].map(({ id: productId }) => {
              const views = placement.get(productId)!.views;
              const front = views.find((v) => v.direction === '정면') ?? views[0];
              return { id: productId, path: imagePath(front.assetId) };
            }),
          }
        : undefined,
    position: { path: photo.path, boxes: products.map((c) => c.box), kinds: products.map((c) => c.kind) },
  };
});

// ---------- run ----------
const harness = await openHarness({ pageEntry: resolve('tests/catalog-match/browser/page.ts'), gpu: true });
console.log(`ledger before: ~${Math.round(spent())} neurons`);
try {
  const { page } = harness;
  for (const job of jobs) {
    const images = await page.evaluate(
      async ({ job, windowMm }) => {
        const CM = (window as unknown as { CM: typeof Page }).CM;
        const canvasFrom = async (path: string) => {
          const bitmap = await CM.loadBitmap(path);
          const canvas = CM.canvasOf(bitmap.width, bitmap.height);
          canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
          bitmap.close();
          return canvas;
        };
        const result: Record<string, string> = {};
        if (job.tile) {
          const left = await canvasFrom(job.tile.crop);
          const candidates = [];
          for (const c of job.tile.candidates)
            candidates.push(CM.repeatTile(CM.trimMargins(await CM.loadBitmap(c.path)), c, windowMm, 352));
          result.tile = CM.dataUrlOf(CM.board(left, candidates));
        }
        if (job.product) {
          const left = await canvasFrom(job.product.crop);
          const candidates = [];
          for (const c of job.product.candidates) candidates.push(CM.onWhite(await CM.loadBitmap(c.path)));
          result.product = CM.dataUrlOf(CM.board(left, candidates));
        }
        const photo = await CM.loadBitmap(job.position.path);
        result.position = CM.dataUrlOf(CM.markedPhoto(photo, job.position.boxes));
        photo.close();
        return result;
      },
      { job, windowMm: 900 },
    );
    for (const [name, url] of Object.entries(images))
      writeFileSync(
        join(target, 'boards', `${job.photo}-${name}.jpg`),
        Buffer.from(url.split(',')[1], 'base64'),
      );
    if (DRY) continue;
    const tasks: {
      task: string;
      image: string;
      gemma: object;
      llama: object;
      clef: (model: string) => object;
      candidates?: string[];
    }[] = [];
    if (job.tile && images.tile)
      tasks.push({
        task: 'tile-board',
        image: images.tile,
        candidates: job.tile.candidates.map((c) => c.id),
        gemma: gemmaInput(
          TILE_TEXT + ' Reply as JSON.',
          images.tile,
          choiceSchema(job.tile.candidates.length),
        ),
        llama: llamaInput(
          TILE_TEXT + ' Reply only with JSON: {"choice": <number>, "confidence": "low"|"medium"|"high"}.',
          images.tile,
        ),
        clef: (model) =>
          clefInput(model, 'A comparison board image.', images.tile, {
            tile: {
              type: 'choice',
              instructions: TILE_TEXT,
              criteria: clefChoices(job.tile!.candidates.length),
            },
          }),
      });
    if (job.product && images.product)
      tasks.push({
        task: 'product-board',
        image: images.product,
        candidates: job.product.candidates.map((c) => c.id),
        gemma: gemmaInput(
          PRODUCT_TEXT + ' Reply as JSON.',
          images.product,
          choiceSchema(job.product.candidates.length),
        ),
        llama: llamaInput(
          PRODUCT_TEXT + ' Reply only with JSON: {"choice": <number>, "confidence": "low"|"medium"|"high"}.',
          images.product,
        ),
        clef: (model) =>
          clefInput(model, 'A comparison board image.', images.product, {
            product: {
              type: 'choice',
              instructions: PRODUCT_TEXT,
              criteria: clefChoices(job.product!.candidates.length),
            },
          }),
      });
    if (job.position.boxes.length)
      tasks.push({
        task: 'position',
        image: images.position,
        gemma: gemmaInput(
          POSITION_TEXT + ' Reply as JSON.',
          images.position,
          positionSchema(job.position.boxes.length),
        ),
        llama: llamaInput(
          POSITION_TEXT +
            ' Reply only with JSON: {"items": [{"box": <number>, "wall": "back"|"left"|"right", "third": "left"|"middle"|"right"}]}.',
          images.position,
        ),
        clef: (model) =>
          clefInput(
            model,
            'A bathroom photo with numbered red boxes.',
            images.position,
            Object.fromEntries(
              job.position.boxes.flatMap((_, i) => [
                [
                  `wall_${i + 1}`,
                  {
                    type: 'choice',
                    instructions: `Box ${i + 1}: which wall is the product installed against? back is the wall the camera faces.`,
                    criteria: { back: null, left: null, right: null },
                  },
                ],
                [
                  `third_${i + 1}`,
                  {
                    type: 'choice',
                    instructions: `Box ${i + 1}: where along that wall, as the photo shows it?`,
                    criteria: { left: 'left third', middle: 'middle third', right: 'right third' },
                  },
                ],
              ]),
            ),
          ),
      });
    for (const model of MODELS) {
      const send = async (task: string, input: unknown, extra: Record<string, unknown> = {}) => {
        try {
          const { result, neurons, ms } = await callAi({
            round: ROUND,
            task,
            photo: job.photo,
            model: MODEL_ID[model],
            input,
            estimate: ESTIMATE[model],
          });
          appendFileSync(
            answersFile,
            JSON.stringify({
              at: new Date().toISOString(),
              round: ROUND,
              photo: job.photo,
              model,
              task,
              neurons,
              ms,
              ...extra,
              result,
            }) + '\n',
          );
          console.log(job.photo, model, task, `${neurons.toFixed(1)} neurons`, `${ms} ms`);
        } catch (error) {
          if (
            error instanceof StopRun &&
            /daily limit|refused: trial|refused: own|refused: extra/.test(error.message)
          )
            throw error;
          console.error(job.photo, model, task, error instanceof Error ? error.message : error);
        }
      };
      if (model === 'moondream') {
        for (const subject of arg('targets', 'toilet,sink,bathtub').split(','))
          await send(`detect-${subject}`, {
            task: 'detect',
            image: images.position,
            target: subject,
            stream: false,
          });
        continue;
      }
      for (const task of tasks) {
        const input = model === 'gemma' ? task.gemma : model === 'llama' ? task.llama : task.clef(model);
        await send(task.task, input, { candidates: task.candidates });
      }
    }
  }
} catch (error) {
  if (!(error instanceof StopRun)) throw error;
  console.error('STOPPED:', error.message);
} finally {
  console.log(`ledger after: ~${Math.round(spent())} neurons`);
  await harness.close();
}
