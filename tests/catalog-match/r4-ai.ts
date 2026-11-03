/**
 * Round 4: the main AI run (photos go to Cloudflare) with the two models kept in round 3 (Gemma,
 * Clef-flash) and Moondream for boxes. Parts, each run on its own:
 *
 *   boxes     development photos: Gemma finds products (bbox_2d), Moondream detects toilet/sink/bathtub;
 *             with --split fifteen (round 9, ② 가리는 것 빼기) Gemma alone on the fifteen
 *   tiles     every face of the fifteen and the development photos: 12-candidate board, plus the
 *             tile's colour and finish names (method 10)
 *   split     the fifteen's faces as three boards of four in one Gemma request
 *   products  every product: up to 12 public products of its kind, plus the product's form
 *   position  every photo with numbered product boxes: wall and third
 *   order     five photos, the same tile and product boards in two more orders (position bias)
 *   synth     60 synthetic development faces (public tiles only), so board picks can be scored
 *   colour    every product's cut-out: Gemma names the body colour (a "no match" test)
 *
 * Before sending, a part's calls × the round 3 cost per call is printed and checked against what is
 * left; every call still goes through the ledger's own check. Prompts carry no answer.
 *
 * Needs the temporary Worker (see ai-worker/worker.ts).
 * Usage: node tests/run-browser-test.mjs tests/catalog-match/r4-ai.ts --part tiles [--dry] [--limit N]
 *          [--split corpus-dev|fifteen --round r4|r9]
 *          [--tiles r1-tiles-q8 --tile-method "clean.rect.raw|..."] [--product-method dinov2.pooled.box]
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ACCOUNT_DAILY, BUDGET, callAi, spent, StopRun } from './ai';
import { out, readJson } from './data';
import { SNAPSHOT } from './paths.mjs';
import {
  clefChoices,
  clefInput,
  COLOURS,
  FINISHES,
  gemmaImages,
  gemmaInput,
  INVENTORY_TEXT,
  inventorySchema,
  PRODUCT_COLOUR_TEXT,
  productColourSchema,
  POSITION_TEXT,
  positionSchema,
  PRODUCT_TEXT,
  productSchema,
  SHAPE_TEXT,
  SHAPES,
  SPLIT_TILE_TEXT,
  TILE_NAMES_TEXT,
  TILE_TEXT,
  tileSchema,
} from './questions';
import { openHarness } from './browser/harness';
import type * as Page from './browser/page';

const arg = (name: string, fallback: string) => {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? fallback : process.argv[at + 1];
};
const PART = arg('part', '');
const DRY = process.argv.includes('--dry');
const LIMIT = Number(arg('limit', '0'));
const BOX_SPLIT = arg('split', 'corpus-dev');
const ROUND = arg('round', 'r4');
const TILES_DIR = join(out, arg('tiles', 'r1-tiles-q8'));
const TILE_METHOD = arg('tile-method', '');
const PRODUCT_METHOD = arg('product-method', 'dinov2.pooled.box');
const MODELS = arg('models', 'gemma,clef-flash').split(',');
const MODEL_ID: Record<string, string> = {
  gemma: '@cf/google/gemma-4-26b-a4b-it',
  'clef-flash': '@cf/cloudflare/clef-flash',
  moondream: '@cf/moondream/moondream3.1-9B-A2B',
};
/** Round 3's measured cost per call (neurons), a little up; the ledger checks each call too. */
const COST: Record<string, number> = { gemma: 6, 'clef-flash': 6, moondream: 22 };
const target = join(out, 'r4-ai');
mkdirSync(join(target, 'boards'), { recursive: true });
const answersFile = join(target, 'answers.jsonl');

type Box = { left: number; top: number; right: number; bottom: number };
type Photo = {
  id: string;
  split: string;
  locked?: boolean;
  path: string;
  candidates: { id?: string; kind: string; box: Box }[];
  truth?: { id: string; kind: string; box: Box }[];
};
const index = readJson<{ photos: Photo[] }>(join(out, 'photos', 'index.json'));
const photos = index.photos.filter((p) => !p.locked && p.split !== 'heldout');
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
}>(join(SNAPSHOT, 'catalog.json'));
const files = new Map(readdirSync(join(SNAPSHOT, 'images')).map((f) => [f.replace(/\.[a-z]+$/, ''), f]));
const placement = new Map(snapshot.placements.map((p) => [p.materialId, p]));
const imagePath = (assetId: string) => join(SNAPSHOT, 'images', files.get(assetId)!);
const tileRef = (id: string) => {
  const p = placement.get(id)!;
  return {
    id,
    path: imagePath(p.textureAssetIds[0]),
    widthMm: p.widthMm,
    heightMm: p.heightMm,
    groutMm: p.defaultGroutWidth,
    groutColor: p.defaultGroutColor,
  };
};
const productRef = (id: string) => {
  const views = placement.get(id)!.views;
  return { id, path: imagePath((views.find((v) => v.direction === '정면') ?? views[0]).assetId) };
};
const PRODUCT = new Set(['toilet', 'basin', 'vanity', 'bath']);
const kindOf = (kind: string) => (kind === 'vanity' ? 'basin' : kind);
/** The products whose place is asked: the saved Gemma boxes (fifteen), the annotation's (development). */
const productBoxes = (photo: Photo) =>
  photo.split === 'corpus-dev'
    ? (photo.truth ?? [])
        .filter((t) => PRODUCT.has(t.kind))
        .map((t) => ({ id: t.id, kind: kindOf(t.kind), box: t.box }))
    : photo.candidates
        .map((c, i) => ({ id: c.id ?? `c${i}`, kind: c.kind, box: c.box }))
        .filter((c) => PRODUCT.has(c.kind))
        .map((c) => ({ ...c, kind: kindOf(c.kind) }));

/** A fixed reordering (for the position-bias check): seeded shuffle. */
function shuffled<T>(items: T[], seed: number): T[] {
  const out = [...items];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

type Ask = {
  part: string;
  photo: string;
  key: string;
  candidates?: string[];
  answer?: string;
  /** The images to draw: a tile or product board, a marked photo or the photo itself. */
  draw:
    | { kind: 'tile'; crop: string; tiles: ReturnType<typeof tileRef>[]; split?: boolean }
    | { kind: 'product'; crop: string; products: ReturnType<typeof productRef>[] }
    | { kind: 'marked'; path: string; boxes: Box[] }
    | { kind: 'photo'; path: string };
  productKind?: string;
  boxes?: number;
};
function asks(): Ask[] {
  if (!TILE_METHOD && ['tiles', 'split', 'order', 'synth'].includes(PART))
    throw new Error('--tile-method is needed');
  const tileMethod = TILE_METHOD;
  const photoTop = existsSync(join(TILES_DIR, 'photo-top12.json'))
    ? readJson<Record<string, Record<string, string[]>>>(join(TILES_DIR, 'photo-top12.json'))
    : {};
  const productTop = readJson<Record<string, Record<string, { id: string }[]>>>(
    join(out, 'r4-products', 'top12.json'),
  );
  const tileAsk = (faceId: string, top: string[], part: string, split = false): Ask => ({
    part,
    photo: faceId.split(':')[0],
    key: faceId,
    candidates: top,
    draw: {
      kind: 'tile',
      crop: join(out, 'crops', 'photos', `${faceId.replace(':', '-')}.jpg`),
      tiles: top.map(tileRef),
      split,
    },
  });
  const productAsk = (queryId: string, kind: string, top: string[], part: string): Ask => ({
    part,
    photo: queryId.split(':')[0],
    key: queryId,
    candidates: top,
    productKind: kind,
    draw: {
      kind: 'product',
      crop: join(out, 'crops', 'products', `${queryId.replace(/:/g, '-')}.jpg`),
      products: top.map(productRef),
    },
  });
  const faces = Object.entries(photoTop)
    .filter(([, methods]) => methods[tileMethod])
    .map(([faceId, methods]) => [faceId, methods[tileMethod]] as const);
  const products = readJson<{ id: string; kind: string }[]>(
    join(out, 'features', 'products', 'queries.json'),
  ).filter((q) => productTop[q.id]?.[PRODUCT_METHOD]?.length);
  const productTopIds = (id: string) => productTop[id][PRODUCT_METHOD].map((x) => x.id);
  switch (PART) {
    case 'tiles':
      return faces.map(([faceId, top]) => tileAsk(faceId, top, 'tiles'));
    case 'split':
      return faces
        .filter(([faceId]) => !faceId.startsWith('bath-'))
        .map(([faceId, top]) => tileAsk(faceId, top, 'split', true));
    case 'products':
      return products.map((q) => productAsk(q.id, q.kind, productTopIds(q.id), 'products'));
    case 'position':
      return photos
        .map((p) => ({ p, boxes: productBoxes(p) }))
        .filter(({ boxes }) => boxes.length)
        .map(({ p, boxes }) => ({
          part: 'position',
          photo: p.id,
          key: p.id,
          candidates: boxes.map((b) => b.id),
          boxes: boxes.length,
          draw: { kind: 'marked' as const, path: p.path, boxes: boxes.map((b) => b.box) },
        }));
    case 'order': {
      const chosen = ['pc-01', 'pc-02', 'remote-03', 'additional-05', 'additional-09'];
      return chosen.flatMap((photo) => {
        const face =
          faces.find(([faceId]) => faceId === `${photo}:back`) ??
          faces.find(([faceId]) => faceId.startsWith(`${photo}:`));
        const product = products.find((q) => q.id.startsWith(`${photo}:`));
        return [1, 2].flatMap((seed) => [
          ...(face
            ? [
                {
                  ...tileAsk(face[0], shuffled([...face[1]], seed * 7919), 'order'),
                  key: `${face[0]}#${seed}`,
                },
              ]
            : []),
          ...(product
            ? [
                {
                  ...productAsk(
                    product.id,
                    product.kind,
                    shuffled(productTopIds(product.id), seed * 7919),
                    'order',
                  ),
                  key: `${product.id}#${seed}`,
                },
              ]
            : []),
        ]);
      });
    }
    case 'synth': {
      const synthTop = readJson<Record<string, { answer: string; top: Record<string, string[]> }>>(
        join(TILES_DIR, 'synth-top12.json'),
      );
      const ids = shuffled(Object.keys(synthTop).sort(), 20261102).slice(0, 60);
      return ids.map((faceId) => ({
        part: 'synth',
        photo: faceId.split(':')[0],
        key: faceId,
        candidates: synthTop[faceId].top[tileMethod.split('|').pop()!],
        answer: synthTop[faceId].answer,
        draw: {
          kind: 'tile' as const,
          crop: join(out, 'crops', 'synth', `${faceId.replace(':', '-')}.jpg`),
          tiles: synthTop[faceId].top[tileMethod.split('|').pop()!].map(tileRef),
        },
      }));
    }
    case 'colour':
      return products.map((q) => ({
        part: 'colour',
        photo: q.id.split(':')[0],
        key: q.id,
        draw: {
          kind: 'photo' as const,
          path: join(out, 'crops', 'products', `${q.id.replace(/:/g, '-')}.jpg`),
        },
      }));
    case 'boxes':
      return photos
        .filter((p) => p.split === BOX_SPLIT)
        .map((p) => ({
          part: 'boxes',
          photo: p.id,
          key: p.id,
          draw: { kind: 'photo' as const, path: p.path },
        }));
    default:
      throw new Error(`unknown part ${PART}`);
  }
}

const models =
  PART === 'boxes'
    ? BOX_SPLIT === 'corpus-dev'
      ? ['gemma', 'moondream']
      : ['gemma']
    : PART === 'split' || PART === 'colour'
      ? ['gemma']
      : MODELS;
/** Asks already answered by every model of this part (a stopped run goes on where it stopped). */
const answered = new Set(
  existsSync(answersFile)
    ? readFileSync(answersFile, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { part: string; key: string; model: string })
        .filter((a) => a.part === PART)
        .map((a) => `${a.key}|${a.model}`)
    : [],
);
const pending = asks().filter((ask) => !models.every((m) => answered.has(`${ask.key}|${m}`)));
const list = LIMIT ? pending.slice(0, LIMIT) : pending;
const callsPer = (model: string) => (PART === 'boxes' && model === 'moondream' ? 3 : 1);
const expected = list.length * models.reduce((sum, m) => sum + callsPer(m) * COST[m], 0);
const left = Math.min(BUDGET * 0.9 - spent(), ACCOUNT_DAILY);
console.log(
  `${PART}: ${list.length} asks × ${models.join('+')} ≈ ${Math.round(expected)} neurons; spent so far ~${Math.round(spent())}`,
);
if (!DRY && expected > left)
  throw new Error(`expected ${Math.round(expected)} > what is left (${Math.round(left)})`);

const harness = await openHarness({ pageEntry: resolve('tests/catalog-match/browser/page.ts'), gpu: true });
try {
  const { page } = harness;
  for (const ask of list) {
    const images = await page.evaluate(
      async ({ draw, windowMm }) => {
        const CM = (window as unknown as { CM: typeof Page }).CM;
        const canvasFrom = async (path: string) => {
          const bitmap = await CM.loadBitmap(path);
          const canvas = CM.canvasOf(bitmap.width, bitmap.height);
          canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
          bitmap.close();
          return canvas;
        };
        if (draw.kind === 'tile') {
          const left = await canvasFrom(draw.crop);
          const tiles: HTMLCanvasElement[] = [];
          for (const t of draw.tiles)
            tiles.push(
              CM.repeatTile(CM.trimMargins(CM.shrink(await CM.loadBitmap(t.path), 512)), t, windowMm, 352),
            );
          if (!draw.split) return [CM.dataUrlOf(CM.board(left, tiles))];
          // Three boards of four, numbered 1–4, 5–8, 9–12.
          return [0, 1, 2].map((part) =>
            CM.dataUrlOf(CM.board(left, tiles.slice(part * 4, part * 4 + 4), part * 4)),
          );
        }
        if (draw.kind === 'product') {
          const left = await canvasFrom(draw.crop);
          const products: HTMLCanvasElement[] = [];
          for (const p of draw.products) products.push(CM.onWhite(await CM.loadBitmap(p.path)));
          return [CM.dataUrlOf(CM.board(left, products))];
        }
        const bitmap = await CM.loadBitmap(draw.path);
        const canvas =
          draw.kind === 'marked' ? CM.markedPhoto(bitmap, draw.boxes) : CM.markedPhoto(bitmap, []);
        bitmap.close();
        return [CM.dataUrlOf(canvas)];
      },
      { draw: ask.draw, windowMm: 900 },
    );
    images.forEach((url, i) =>
      writeFileSync(
        join(
          target,
          'boards',
          `${ask.part}-${ask.key.replace(/[:#]/g, '-')}${images.length > 1 ? `-${i + 1}` : ''}.jpg`,
        ),
        Buffer.from(url.split(',')[1], 'base64'),
      ),
    );
    if (DRY) continue;
    const n = ask.candidates?.length ?? 0;
    const send = async (model: string, task: string, input: unknown) => {
      try {
        const { result, neurons, ms } = await callAi({
          round: ROUND,
          task,
          photo: ask.photo,
          model: MODEL_ID[model],
          input,
          estimate: COST[model] * 1.5,
        });
        appendFileSync(
          answersFile,
          JSON.stringify({
            at: new Date().toISOString(),
            part: ask.part,
            photo: ask.photo,
            key: ask.key,
            model,
            task,
            candidates: ask.candidates,
            answer: ask.answer,
            neurons,
            ms,
            result,
          }) + '\n',
        );
      } catch (error) {
        if (error instanceof StopRun && !/stopped|refused \(/.test(error.message)) throw error;
        console.error(ask.key, model, task, error instanceof Error ? error.message : error);
      }
    };
    for (const model of models) {
      if (ask.part === 'colour') {
        await send(
          'gemma',
          'product-colour',
          gemmaInput(PRODUCT_COLOUR_TEXT + ' Reply as JSON.', images[0], productColourSchema),
        );
        continue;
      }
      if (ask.part === 'boxes') {
        if (model === 'gemma')
          await send(
            'gemma',
            'inventory',
            gemmaInput(INVENTORY_TEXT + ' Reply as JSON.', images[0], inventorySchema),
          );
        else
          for (const subject of ['toilet', 'sink', 'bathtub'])
            await send('moondream', `detect-${subject}`, {
              task: 'detect',
              image: images[0],
              target: subject,
              stream: false,
            });
        continue;
      }
      if (ask.draw.kind === 'tile') {
        const names = ` Colours: ${Object.keys(COLOURS).join(', ')}. Finishes: ${Object.keys(FINISHES).join(', ')}.`;
        if (ask.part === 'split')
          await send(
            'gemma',
            'tile-split',
            gemmaImages(SPLIT_TILE_TEXT + ' Reply as JSON.', images, tileSchema(n)),
          );
        else if (model === 'gemma')
          await send(
            'gemma',
            'tile-board',
            gemmaInput(TILE_TEXT + TILE_NAMES_TEXT + names + ' Reply as JSON.', images[0], tileSchema(n)),
          );
        else
          await send(
            model,
            'tile-board',
            clefInput(model, 'A comparison board image.', images[0], {
              tile: { type: 'choice', instructions: TILE_TEXT, criteria: clefChoices(n) },
              colour: {
                type: 'choice',
                instructions:
                  'The main colour of the tile in the PHOTO panel, as the tile itself is (not the light).',
                criteria: Object.fromEntries(Object.keys(COLOURS).map((c) => [c, null])),
              },
              finish: {
                type: 'choice',
                instructions: 'The surface finish of the tile in the PHOTO panel.',
                criteria: Object.fromEntries(Object.keys(FINISHES).map((f) => [f, null])),
              },
            }),
          );
      } else if (ask.draw.kind === 'product') {
        const shapes = SHAPES[ask.productKind!] ?? { unknown: 'cannot tell' };
        const list = ` Forms: ${Object.entries(shapes)
          .map(([k, v]) => `${k} (${v})`)
          .join('; ')}.`;
        if (model === 'gemma')
          await send(
            'gemma',
            'product-board',
            gemmaInput(
              PRODUCT_TEXT + SHAPE_TEXT + list + ' Reply as JSON.',
              images[0],
              productSchema(n, ask.productKind!),
            ),
          );
        else
          await send(
            model,
            'product-board',
            clefInput(model, 'A comparison board image.', images[0], {
              product: { type: 'choice', instructions: PRODUCT_TEXT, criteria: clefChoices(n) },
              form: {
                type: 'choice',
                instructions: 'The form of the product in the PHOTO panel.',
                criteria: shapes,
              },
            }),
          );
      } else if (ask.draw.kind === 'marked') {
        const count = ask.boxes!;
        if (model === 'gemma')
          await send(
            'gemma',
            'position',
            gemmaInput(POSITION_TEXT + ' Reply as JSON.', images[0], positionSchema(count)),
          );
        else
          await send(
            model,
            'position',
            clefInput(
              model,
              'A bathroom photo with numbered red boxes.',
              images[0],
              Object.fromEntries(
                Array.from({ length: count }, (_, i) => [
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
                ]).flat(),
              ),
            ),
          );
      }
    }
    process.stdout.write(
      `\r${PART} ${list.indexOf(ask) + 1}/${list.length} (~${Math.round(spent())} neurons)`,
    );
  }
} catch (error) {
  if (!(error instanceof StopRun)) throw error;
  console.error('\nSTOPPED:', error.message);
} finally {
  console.log(`\nledger: ~${Math.round(spent())} neurons`);
  await harness.close();
}
