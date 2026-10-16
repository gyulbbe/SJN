/**
 * Trial: can Gemma read a reference photo well enough to fill the direction-photo choices (toilet body,
 * lid, photo angle, bath and basin shape) and the product's features? Real, billed Gemma calls through
 * the test Worker's /gemma (the app's request shape, src/lib/ai-export/check-server.ts: the question,
 * the image and a strict JSON schema, temperature 0, no thinking), no retry, each photo twice to see
 * whether the answer holds. Answers are enums only, "unknown" when the photo does not show it.
 * `describe` asks instead for a short free description (the G3 variant, a trial only: the app never
 * puts free text in a prompt).
 *
 * Usage: node tests/run-browser-test.mjs tests/direction-photo-real/analysis.ts <run|describe|report> [photo ids]
 * Env: AI_BUDGET_NEURONS (required for run and describe), FLUX_WORKER (default http://127.0.0.1:8799),
 *   AI_ROOT (default test-results/direction-photo-gemma), AI_LEDGER (default <root>/ledger.jsonl),
 *   REPEATS (default 2).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';
import { z } from 'zod';
import { prepareCloudGemmaSchema } from '../../src/lib/reconstruction/cloud-gemma-coordinates';

const ROOT = process.env.AI_ROOT ?? 'test-results/direction-photo-gemma';
const LEDGER = process.env.AI_LEDGER ?? `${ROOT}/ledger.jsonl`;
const WORKER = process.env.FLUX_WORKER ?? 'http://127.0.0.1:8799';
const REPEATS = Number(process.env.REPEATS ?? 2);
const OUT = `${ROOT}/analysis`;

/** Gemma 4 26B on Workers AI: neurons per million input and output tokens (docs/cloudflare-ai-usage.md). */
const INPUT_NEURONS_PER_M = 9091;
const OUTPUT_NEURONS_PER_M = 27273;
/** Counted before a call whose usage is not known yet, and kept when it fails. */
const GEMMA_GUESS = 30;

const NA = 'not-applicable';
export const ANALYSIS_ENUMS = {
  category: ['toilet', 'bath', 'basin', 'other'],
  photoAngle: ['front', 'front-right', 'front-left', 'right', 'left', 'back', 'top', 'unknown'],
  background: ['none', 'plain', 'scene', 'unknown'],
  props: ['yes', 'no', 'unknown'],
  cropped: ['yes', 'no', 'unknown'],
  lowResolution: ['yes', 'no', 'unknown'],
  toiletBody: ['two-piece', 'one-piece', 'tankless-bidet', 'unknown', NA],
  toiletLid: ['closed', 'open', 'seat-only', 'unknown', NA],
  topFeature: ['none', 'ears', 'buttons', 'other', 'unknown', NA],
  printLocation: ['none', 'tank-front', 'lid-top', 'body-side', 'unknown', NA],
  printKind: ['none', 'face', 'logo', 'pattern', 'unknown', NA],
  controlSide: ['left-side', 'right-side', 'top', 'front', 'none', 'unknown', NA],
  bidetUnit: ['present', 'absent', 'unknown', NA],
  finish: ['glossy', 'matte', 'unknown'],
  bathShape: ['oval-freestanding', 'rectangular', 'other', 'unknown', NA],
  freestanding: ['yes', 'no', 'unknown', NA],
  overflow: ['long-side', 'narrow-end', 'none-visible', 'unknown', NA],
  basinMount: ['wall', 'pedestal', 'countertop', 'unknown', NA],
  basinBowl: ['round', 'rectangular', 'unknown', NA],
} as const;
/**
 * v2: the side of the lever or buttons is not asked by the product's own sides (v1 mirrored it for the
 * bear and the smart toilet): whether it is on the side the camera sees, the server then naming that
 * side from the photo angle.
 */
/** An enum table without some of its items. */
const without = <T extends Record<string, readonly string[]>, K extends keyof T>(enums: T, ...keys: K[]) =>
  Object.fromEntries(Object.entries(enums).filter(([key]) => !keys.includes(key as K))) as Omit<T, K>;
const SHARED_ENUMS = without(ANALYSIS_ENUMS, 'controlSide');
export const ANALYSIS_ENUMS_V2 = {
  ...SHARED_ENUMS,
  controlSeen: ['side-facing-camera', 'top', 'front', 'not-visible', 'unknown', NA],
} as const;
export type AnalysisKey = keyof typeof ANALYSIS_ENUMS;
export type Analysis = Record<string, string>;
const schemas = (enums: Record<string, readonly string[]>) => {
  const keys = Object.keys(enums);
  return {
    zod: z.strictObject(
      Object.fromEntries(keys.map((key) => [key, z.enum(enums[key] as [string, ...string[]])])),
    ),
    json: {
      type: 'object',
      additionalProperties: false,
      required: keys,
      properties: Object.fromEntries(keys.map((key) => [key, { type: 'string', enum: enums[key] }])),
    },
  };
};
/** The product's side of its lever or buttons, from where v2 saw it and the photo angle. */
export function controlSideOf(answer: Analysis): string {
  if (answer.controlSide) return answer.controlSide;
  const seen = answer.controlSeen;
  if (seen === 'side-facing-camera')
    return ['front-right', 'right'].includes(answer.photoAngle)
      ? 'right-side'
      : ['front-left', 'left'].includes(answer.photoAngle)
        ? 'left-side'
        : 'unknown';
  return seen === 'not-visible' ? 'none' : seen;
}

export const ANALYSIS_PROMPT = `You are reading one product photo for a bathroom fixture catalogue. Answer with the JSON object the schema asks for, nothing else. Answer "unknown" when the photo does not show it clearly, and "${NA}" for the items of another kind of product.

- category: toilet, bath (a bathtub), basin (a washbasin) or other (anything else, such as a mirror).
- The product's front: a toilet's front is the bowl end, away from the tank or the back unit; a basin's front is the side away from the wall and the tap; a bath's front is one of its long sides.
- The product's own left and right are named as by someone standing behind it and facing the way its front faces. Seen from the front, the product's own right side is on the viewer's left.
- photoAngle: which way the product's front points in the photo. front: the front faces the camera. right: the camera sees the product's own right side and its front points to the right edge of the photo. left: the camera sees its own left side and its front points to the left edge. front-right: between the two, the front and the product's own right side are both seen. front-left: the front and its own left side are both seen. back: the back faces the camera. top: seen from straight above.
- background: none (transparent or plain white, the product cut out), plain (a studio colour or gradient), scene (a room or a surface with other things).
- props: other objects in the photo besides the product. cropped: the photo's edge cuts off part of the product. lowResolution: the product looks blurry or very small.
- Toilet only. toiletBody: two-piece (a separate cistern sits on the bowl, with a seam between them), one-piece (cistern and bowl are one piece), tankless-bidet (no cistern; a low electronic bidet unit at the back). toiletLid: closed, open (lid raised) or seat-only (a seat and no lid). topFeature: what sits on or sticks up from the top of the tank or the back unit: none, ears (two small rounded ears), buttons or other. printLocation and printKind: a printed or drawn picture, logo or pattern on the product, where and what; none when it is plain. controlSide: where the flush lever or the control buttons are, by the product's own sides: left-side, right-side, top, front or none. bidetUnit: present when it has an electronic bidet unit. finish: glossy or matte.
- Bath only. bathShape: oval-freestanding, rectangular or other. freestanding: yes when it is finished all round to stand apart from the walls. overflow: where the overflow opening is: long-side, narrow-end or none-visible.
- Basin only. basinMount: wall (hung on the wall, even with a short half column), pedestal (a column down to the floor) or countertop. basinBowl: round or rectangular.`;

export const ANALYSIS_PROMPT_V2 = `You are reading one product photo for a bathroom fixture catalogue. Fill in the JSON object the schema asks for. Answer "unknown" only when the photo does not show it, and "${NA}" for the items that belong to another kind of product. After the last property, close the object and stop: no extra spaces, lines or text.

- category: toilet, bath (a bathtub), basin (a washbasin) or other (anything else, such as a mirror).
- The product's front: a toilet's front is the rim of the bowl, at the opposite end from the tank or the back unit; a basin's front is the edge away from the wall and the tap; a bath's front is one of its two long sides.
- photoAngle: where the product's front points in the photo, read from the photo's edges. front: straight at the camera. front-right: at the camera and toward the photo's right edge, so one side of the product is also seen, on the photo's left. front-left: at the camera and toward the photo's left edge, a side seen on the photo's right. right: toward the photo's right edge (a side view). left: toward the photo's left edge. back: away from the camera. top: the camera looks straight down and no side of the product is seen. A photo taken from above at a slant is still front, front-right, front-left, right or left by where the front points.
- background: none (transparent or plain white, the product cut out), plain (a studio colour or gradient), scene (a floor, a wall or other things around it).
- props: yes when other objects are in the photo. cropped: yes when the photo's edge cuts off part of the product. lowResolution: yes when the product looks blurry or very small.
- Toilet only:
  - toiletBody: one-piece when the tank and the bowl are a single smooth moulding with no gap or joint between them, even when the tank is tall; two-piece when a separate tank sits on the back of the bowl with a visible joint or gap; tankless-bidet when there is no tank at all: behind the seat there is only a low electronic housing, about as high as the back of the closed lid.
  - toiletLid: closed, open (the lid stands up) or seat-only (a seat ring and no lid).
  - topFeature: what sits on or sticks up from the top of the tank or the back housing: none, ears (two small rounded ears), buttons or other.
  - printLocation and printKind: a printed or drawn picture, logo or pattern on the product: where it is and what it is; none when the product is plain.
  - controlSeen: where the flush lever or the control buttons are seen: side-facing-camera (on the side of the product that the camera sees), top, front or not-visible.
  - bidetUnit: for every toilet, present (an electronic bidet seat or housing) or absent.
  - finish: glossy or matte.
- Bath only: bathShape (oval-freestanding, rectangular or other); freestanding (yes when it is finished all round to stand apart from the walls); overflow: where the overflow opening is: long-side, narrow-end or none-visible.
- Basin only: basinMount: wall (fixed to the wall with nothing reaching the floor, including a basin with a short half column under it), pedestal (a column standing on the floor) or countertop; basinBowl: round or rectangular.`;
const VERSIONS = {
  v1: { prompt: ANALYSIS_PROMPT, ...schemas(ANALYSIS_ENUMS), suffix: '' },
  v2: { prompt: ANALYSIS_PROMPT_V2, ...schemas(ANALYSIS_ENUMS_V2), suffix: '-v2' },
  // Per kind (V3 below); these are not used.
  v3: { prompt: '', ...schemas(ANALYSIS_ENUMS_V2), suffix: '-v3' },
  v4: { prompt: '', ...schemas(ANALYSIS_ENUMS_V2), suffix: '-v4' },
};
const VERSION = (process.env.ANALYSIS ?? 'v1') as keyof typeof VERSIONS;
if (!VERSIONS[VERSION]) throw new Error('ANALYSIS는 v1 또는 v2');
const { prompt: QUESTION, zod: answerSchema, json: jsonSchema, suffix: SUFFIX } = VERSIONS[VERSION];

/**
 * v3: the kind is known (the material form has it), so one small question per kind, and nothing asked
 * as a direction: what is where in the photo, the server deriving the photo angle, the body and the
 * lever's side from it (v1 and v2 mirrored the toilets' angle and broke a long answer in 9 of 52).
 */
const V3_END = 'After the closing brace, stop: no extra spaces, lines or text.';
const V3 = {
  toilet: {
    prompt: `This photo shows a toilet. Fill in the JSON object the schema asks for. Answer unknown only when the photo does not show it. ${V3_END}
- tankSide: where the tank or the back housing is in the photo, compared with the bowl: left-of-bowl (nearer the photo's left edge than the bowl), right-of-bowl, or behind-bowl (the bowl is in front of it and both are in the middle).
- bowlFrontSeen: yes when the curved front of the bowl, under the seat, faces the camera at least partly; no in a plain side view.
- behindSeat: tall-tank (a cistern rising well above the seat), low-housing (a low housing no higher than the back of the closed lid, often with buttons) or nothing.
- tankJoint: yes when a gap or a joint line separates the tank from the bowl; no when tank and bowl are one smooth moulding.
- lid: closed, open (the lid stands up) or seat-only (a seat ring and no lid).
- topFeature: what sits on or sticks up from the top of the tank or the housing: none, ears (two small rounded ears), buttons or other.
- printLocation and printKind: a printed or drawn picture, logo or pattern on the toilet, where (none, tank-front, lid-top, body-side) and what (none, face, logo, pattern).
- controlSeen: where the flush lever or the buttons are: side-facing-camera (on the side of the toilet the camera sees), top, front or not-visible.
- bidetUnit: present (an electronic bidet seat or housing) or absent.
- finish: glossy or matte.`,
    enums: {
      tankSide: ['left-of-bowl', 'right-of-bowl', 'behind-bowl', 'unknown'],
      bowlFrontSeen: ['yes', 'no', 'unknown'],
      behindSeat: ['tall-tank', 'low-housing', 'nothing', 'unknown'],
      tankJoint: ['yes', 'no', 'unknown'],
      lid: ['closed', 'open', 'seat-only', 'unknown'],
      topFeature: ['none', 'ears', 'buttons', 'other', 'unknown'],
      printLocation: ['none', 'tank-front', 'lid-top', 'body-side', 'unknown'],
      printKind: ['none', 'face', 'logo', 'pattern', 'unknown'],
      controlSeen: ['side-facing-camera', 'top', 'front', 'not-visible', 'unknown'],
      bidetUnit: ['present', 'absent', 'unknown'],
      finish: ['glossy', 'matte', 'unknown'],
    },
  },
  bath: {
    prompt: `This photo shows a bathtub. Fill in the JSON object the schema asks for. Answer unknown only when the photo does not show it. ${V3_END}
- shape: oval (rounded all round, in plan a long oval or a rectangle with fully rounded ends) or rectangular (straight sides and corners) or other.
- freestanding: yes when it is finished all round to stand apart from the walls; no when it is made to stand against walls.
- overflow: where the overflow opening is: long-side (on the inside of a long side), narrow-end or none-visible.
- finish: glossy or matte.`,
    enums: {
      shape: ['oval', 'rectangular', 'other', 'unknown'],
      freestanding: ['yes', 'no', 'unknown'],
      overflow: ['long-side', 'narrow-end', 'none-visible', 'unknown'],
      finish: ['glossy', 'matte', 'unknown'],
    },
  },
  basin: {
    prompt: `This photo shows a washbasin. Fill in the JSON object the schema asks for. Answer unknown only when the photo does not show it. ${V3_END}
- onCounter: yes when the basin sits on or in a counter top.
- columnToFloor: yes when a column or pedestal under the basin stands on the floor; no when nothing under it reaches the floor (a short half column that stops in the air is no).
- bowl: round (a rounded front) or rectangular.
- finish: glossy or matte.`,
    enums: {
      onCounter: ['yes', 'no', 'unknown'],
      columnToFloor: ['yes', 'no', 'unknown'],
      bowl: ['round', 'rectangular', 'unknown'],
      finish: ['glossy', 'matte', 'unknown'],
    },
  },
} as const;
/**
 * v4 (toilets): v3 read "behind-bowl" for every photo, so where the tank is across the photo comes
 * from two boxes instead (Gemma's native bbox_2d), the server comparing their centres.
 */
const V4_ENUMS = without(V3.toilet.enums, 'tankSide');
const box = z.array(z.number().int().min(0).max(1000)).length(4);
const boxJson = {
  type: 'array',
  items: { type: 'integer', minimum: 0, maximum: 1000 },
  minItems: 4,
  maxItems: 4,
};
const v4Enums = schemas(V4_ENUMS);
export const V4 = {
  prompt: `This photo shows a toilet. Fill in the JSON object the schema asks for. Answer unknown only when the photo does not show it. ${V3_END}
- tank.bbox_2d: the box around the tank or the back housing (the part behind the seat). bowl.bbox_2d: the box around the bowl and the seat in front of it. A box is [ymin,xmin,ymax,xmax], integers 0..1000 on the whole photo; xmin and xmax measure from the photo's left edge.
${V3.toilet.prompt.split('\n').slice(2).join('\n')}`,
  zod: v4Enums.zod.extend({ tank: z.strictObject({ bbox_2d: box }), bowl: z.strictObject({ bbox_2d: box }) }),
  json: prepareCloudGemmaSchema({
    ...v4Enums.json,
    required: ['tank', 'bowl', ...v4Enums.json.required],
    properties: {
      tank: {
        type: 'object',
        additionalProperties: false,
        required: ['bbox_2d'],
        properties: { bbox_2d: boxJson },
      },
      bowl: {
        type: 'object',
        additionalProperties: false,
        required: ['bbox_2d'],
        properties: { bbox_2d: boxJson },
      },
      ...v4Enums.json.properties,
    },
  }),
};
/** Where the tank is across the photo from the two boxes' centres (a tenth of the width counts as level). */
export function tankSideOf(tank: number[], bowl: number[]) {
  const across = (tank[1] + tank[3]) / 2 - (bowl[1] + bowl[3]) / 2;
  return Math.abs(across) < 100 ? 'behind-bowl' : across < 0 ? 'left-of-bowl' : 'right-of-bowl';
}
/** The v3 observations as the shared items (the photo angle, the body, the lever's side...). */
export function fromV3(category: string, seen: Analysis): Analysis {
  if (category === 'toilet') {
    const photoAngle =
      seen.tankSide === 'behind-bowl'
        ? 'front'
        : seen.tankSide === 'left-of-bowl'
          ? seen.bowlFrontSeen === 'yes'
            ? 'front-right'
            : seen.bowlFrontSeen === 'no'
              ? 'right'
              : 'unknown'
          : seen.tankSide === 'right-of-bowl'
            ? seen.bowlFrontSeen === 'yes'
              ? 'front-left'
              : seen.bowlFrontSeen === 'no'
                ? 'left'
                : 'unknown'
            : 'unknown';
    const toiletBody =
      seen.behindSeat === 'low-housing'
        ? 'tankless-bidet'
        : seen.behindSeat === 'tall-tank'
          ? seen.tankJoint === 'yes'
            ? 'two-piece'
            : seen.tankJoint === 'no'
              ? 'one-piece'
              : 'unknown'
          : 'unknown';
    const shared: Analysis = {
      category,
      photoAngle,
      toiletBody,
      toiletLid: seen.lid,
      topFeature: seen.topFeature,
      printLocation: seen.printLocation,
      printKind: seen.printKind,
      controlSeen: seen.controlSeen,
      bidetUnit: seen.bidetUnit,
      finish: seen.finish,
    };
    return { ...shared, controlSide: controlSideOf(shared) };
  }
  if (category === 'bath')
    return {
      category,
      bathShape:
        seen.shape === 'oval' && seen.freestanding === 'yes'
          ? 'oval-freestanding'
          : seen.shape === 'rectangular'
            ? 'rectangular'
            : seen.shape === 'unknown'
              ? 'unknown'
              : 'other',
      freestanding: seen.freestanding,
      overflow: seen.overflow,
      finish: seen.finish,
    };
  return {
    category,
    basinMount:
      seen.onCounter === 'yes'
        ? 'countertop'
        : seen.columnToFloor === 'yes'
          ? 'pedestal'
          : seen.columnToFloor === 'no'
            ? 'wall'
            : 'unknown',
    basinBowl: seen.bowl,
    finish: seen.finish,
  };
}

export const DESCRIBE_PROMPT = `Describe the product in this photo for someone who will draw it from other angles: its overall shape, its parts, any printed pictures or decorations and where they are, and where its lever or buttons are. Write at most 60 words in English, in plain sentences, and do not mention the background or the camera.`;
const describeSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['description'],
  properties: { description: { type: 'string', maxLength: 500 } },
};

/** The photos, and what they show (checked by eye before the trial; several values when either is right). */
type Truth = Partial<Record<AnalysisKey, string[]>>;
export const PHOTOS: Record<string, { file: string; product: string; truth: Truth }> = {
  'bear-62': {
    file: 'test-results/product-representation/real/input/62-bear-toilet-3q.png',
    product: 'bear',
    truth: {
      category: ['toilet'],
      photoAngle: ['front-right'],
      background: ['none'],
      props: ['no'],
      cropped: ['no'],
      toiletBody: ['one-piece'],
      toiletLid: ['seat-only'],
      topFeature: ['ears'],
      printLocation: ['tank-front'],
      printKind: ['face'],
      controlSide: ['right-side'],
      bidetUnit: ['absent'],
      finish: ['glossy'],
    },
  },
  'smart-57': {
    file: 'test-results/product-representation/real/input/57-toilet-3q-small.png',
    product: 'smart',
    truth: {
      category: ['toilet'],
      photoAngle: ['front-right'],
      background: ['none'],
      props: ['no'],
      cropped: ['no'],
      toiletBody: ['tankless-bidet'],
      toiletLid: ['closed'],
      topFeature: ['none', 'buttons'],
      printLocation: ['none'],
      printKind: ['none'],
      controlSide: ['right-side'],
      bidetUnit: ['present'],
      finish: ['glossy'],
    },
  },
  'smart-53': {
    file: 'test-results/product-representation/real/input/53-toilet-front.webp',
    product: 'smart',
    truth: {
      category: ['toilet'],
      photoAngle: ['front'],
      background: ['none', 'plain'],
      props: ['no'],
      cropped: ['no'],
      toiletBody: ['tankless-bidet'],
      toiletLid: ['closed'],
      topFeature: ['buttons', 'none'],
      printLocation: ['none', 'lid-top'],
      printKind: ['none', 'logo'],
      controlSide: ['top'],
      bidetUnit: ['present'],
      finish: ['glossy'],
    },
  },
  'smart-52': {
    file: 'test-results/product-representation/real/input/52-toilet-side-faces-left.webp',
    product: 'smart',
    truth: {
      category: ['toilet'],
      photoAngle: ['left'],
      background: ['none', 'plain'],
      props: ['no'],
      cropped: ['no'],
      toiletBody: ['tankless-bidet'],
      toiletLid: ['closed'],
      topFeature: ['none', 'buttons'],
      printLocation: ['none'],
      printKind: ['none'],
      // Its buttons are on the other side: any answer but its left side.
      controlSide: ['none', 'unknown', 'top', 'right-side'],
      bidetUnit: ['present'],
      finish: ['glossy'],
    },
  },
  'smart-60': {
    file: 'test-results/product-representation/real/input/60-toilet-side-faces-right.webp',
    product: 'smart',
    truth: {
      category: ['toilet'],
      photoAngle: ['right'],
      background: ['none', 'plain'],
      props: ['no'],
      cropped: ['no'],
      toiletBody: ['tankless-bidet'],
      toiletLid: ['closed'],
      topFeature: ['none', 'buttons'],
      printLocation: ['none'],
      printKind: ['none'],
      controlSide: ['right-side'],
      bidetUnit: ['present'],
      finish: ['glossy'],
    },
  },
  'bath-61': {
    file: 'test-results/product-representation/real/input/61-bathtub-3q-white.png',
    product: 'bath',
    truth: {
      category: ['bath'],
      photoAngle: ['front'],
      background: ['none'],
      props: ['no'],
      cropped: ['no'],
      bathShape: ['oval-freestanding'],
      freestanding: ['yes'],
      overflow: ['long-side'],
      finish: ['glossy', 'matte'],
    },
  },
  'bath-54': {
    file: 'test-results/product-representation/real/input/54-bathtub-top.webp',
    product: 'bath',
    truth: {
      category: ['bath'],
      photoAngle: ['top'],
      background: ['scene'],
      props: ['yes'],
      bathShape: ['oval-freestanding'],
      freestanding: ['yes'],
      overflow: ['long-side'],
      finish: ['glossy', 'matte'],
    },
  },
  'bath-55': {
    file: 'test-results/product-representation/real/input/55-bathtub-3q-top.webp',
    product: 'bath',
    truth: {
      category: ['bath'],
      photoAngle: ['front'],
      background: ['scene'],
      props: ['yes'],
      cropped: ['no'],
      bathShape: ['oval-freestanding'],
      freestanding: ['yes'],
      overflow: ['long-side', 'none-visible'],
      finish: ['glossy', 'matte'],
    },
  },
  'bath-58': {
    file: 'test-results/product-representation/real/input/58-bathtub-3q-small-tray-artifact.png',
    product: 'bath',
    truth: {
      category: ['bath'],
      // A symmetric tub: either corner is right.
      photoAngle: ['front-left', 'front-right'],
      background: ['none'],
      props: ['yes'],
      cropped: ['no'],
      bathShape: ['oval-freestanding'],
      freestanding: ['yes'],
      overflow: ['long-side', 'none-visible'],
      finish: ['glossy', 'matte'],
    },
  },
  'tub-rect': {
    file: 'test-results/product-representation/input/bathtub-cutout.png',
    product: 'rectangular bath',
    truth: {
      category: ['bath'],
      photoAngle: ['front-left', 'front-right'],
      background: ['none'],
      props: ['no'],
      cropped: ['no'],
      bathShape: ['rectangular'],
      overflow: ['none-visible', 'unknown', 'narrow-end'],
    },
  },
  basin: {
    file: 'test-results/product-representation/input/basin-cutout.png',
    product: 'basin',
    truth: {
      category: ['basin'],
      photoAngle: ['front-left', 'front-right'],
      background: ['none'],
      props: ['no'],
      cropped: ['no'],
      basinMount: ['wall'],
      basinBowl: ['round'],
      finish: ['glossy'],
    },
  },
  'mirror-59': {
    file: 'test-results/product-representation/real/input/59-mirror-3q.png',
    product: 'mirror',
    truth: { category: ['other'] },
  },
  'mirror-56': {
    file: 'test-results/product-representation/real/input/56-mirror-3q-small.png',
    product: 'mirror',
    truth: { category: ['other'] },
  },
};

/** The photo as an upload would reach the route: a PNG on white, its long edge at most 1024px. */
async function photoDataUrl(file: string) {
  const png = await sharp(file)
    .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .png()
    .toBuffer();
  return `data:image/png;base64,${png.toString('base64')}`;
}

const payload = (text: string, image: string, name: string, schema: object, maxTokens: number) => ({
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text },
        { type: 'image_url', image_url: { url: image } },
      ],
    },
  ],
  stream: false,
  temperature: 0,
  max_completion_tokens: maxTokens,
  chat_template_kwargs: { enable_thinking: false },
  response_format: { type: 'json_schema', json_schema: { name, strict: true, schema } },
});

type Row = { at?: string; status: number | string; neurons?: number; n?: number };
const ledger = (): Row[] =>
  existsSync(LEDGER)
    ? readFileSync(LEDGER, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Row)
    : [];
const today = new Date().toISOString().slice(0, 10);
const spentToday = () =>
  ledger()
    .filter((row) => row.status !== 'refused' && String(row.at).startsWith(today))
    .reduce((sum, row) => sum + (row.neurons ?? 0), 0);

/** One Gemma call, ledgered (a failure keeps the guess as spent); its parsed content or undefined. */
async function callGemma(body: object, record: Record<string, unknown>, budget: number) {
  const used = spentToday();
  if (used + GEMMA_GUESS > budget * 0.9) {
    appendFileSync(
      LEDGER,
      JSON.stringify({ at: new Date().toISOString(), status: 'refused', ...record }) + '\n',
    );
    console.log(`예산 90%에 닿아 멈춤: ~${Math.round(used)} / ${budget}`);
    process.exit(2);
  }
  const n = ledger().filter((row) => typeof row.n === 'number').length + 1;
  const row: Record<string, unknown> = { at: new Date().toISOString(), n, kind: 'gemma', ...record };
  const started = Date.now();
  let content: string | undefined;
  try {
    const response = await fetch(`${WORKER}/gemma`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ payload: body }),
      signal: AbortSignal.timeout(120_000),
    });
    const answer = (await response.json()) as {
      body?: {
        choices?: { finish_reason?: string; message?: { content?: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      error?: string;
      status?: number;
    };
    const usage = answer.body?.usage;
    if (usage?.prompt_tokens !== undefined) {
      row.inputTokens = usage.prompt_tokens;
      row.outputTokens = usage.completion_tokens ?? 0;
      row.neurons = Number(
        (
          (usage.prompt_tokens * INPUT_NEURONS_PER_M +
            (usage.completion_tokens ?? 0) * OUTPUT_NEURONS_PER_M) /
          1e6
        ).toFixed(2),
      );
    } else row.neurons = GEMMA_GUESS;
    const choice = answer.body?.choices?.[0];
    row.status = response.ok && choice?.finish_reason === 'stop' ? 200 : (answer.status ?? response.status);
    if (row.status === 200) content = choice?.message?.content;
    else row.error = String(answer.error ?? choice?.finish_reason).slice(0, 400);
  } catch (error) {
    row.status = 'error';
    row.neurons = GEMMA_GUESS;
    row.error = String(error).slice(0, 300);
  }
  row.ms = Date.now() - started;
  appendFileSync(LEDGER, JSON.stringify(row) + '\n');
  console.log(
    'gemma',
    row.n,
    record.photo,
    record.repeat ?? '',
    row.status,
    `${row.ms}ms`,
    `~${Math.round(spentToday())}`,
  );
  if (row.status !== 200) process.exit(1);
  return content;
}

const args = process.argv.slice(3);
const mode = args[0];
const ids = args[1]?.split(',') ?? Object.keys(PHOTOS);
for (const id of ids) if (!PHOTOS[id]) throw new Error(`사진: ${Object.keys(PHOTOS).join(', ')}`);
mkdirSync(OUT, { recursive: true });

if (mode === 'run' || mode === 'describe') {
  const budget = Number(process.env.AI_BUDGET_NEURONS);
  if (!(budget > 0)) throw new Error('AI_BUDGET_NEURONS를 정해 주세요.');
  for (const id of ids) {
    const image = await photoDataUrl(PHOTOS[id].file);
    if (mode === 'describe') {
      const content = await callGemma(
        payload(DESCRIBE_PROMPT, image, 'product_description', describeSchema, 256),
        { photo: id, task: 'describe' },
        budget,
      );
      const { description } = JSON.parse(content!) as { description: string };
      writeFileSync(`${OUT}/${id}-describe.json`, JSON.stringify({ id, description }, null, 2));
      console.log(id, description);
      continue;
    }
    // v3 asks the photo's kind its own question (a kind the app has no guide for is not asked).
    const category = PHOTOS[id].truth.category![0] as keyof typeof V3 | 'other';
    if (VERSION === 'v3' && category === 'other') continue;
    if (VERSION === 'v4' && category !== 'toilet') continue;
    const ask =
      VERSION === 'v4'
        ? (V4 as unknown as { prompt: string; zod: typeof answerSchema; json: object })
        : VERSION === 'v3'
          ? {
              prompt: V3[category as keyof typeof V3].prompt,
              ...schemas(V3[category as keyof typeof V3].enums),
            }
          : { prompt: QUESTION, zod: answerSchema, json: jsonSchema };
    for (let repeat = 1; repeat <= REPEATS; repeat++) {
      const file = `${OUT}/${id}${SUFFIX}-${repeat}.json`;
      if (existsSync(file)) continue;
      const content = await callGemma(
        payload(ask.prompt, image, 'direction_photo_analysis', ask.json, 512),
        { photo: id, task: 'analyze', version: VERSION, repeat },
        budget,
      );
      // A broken answer (cut at the token limit, or off the schema) is kept and counts as wrong.
      let parsed: ReturnType<typeof answerSchema.safeParse> | undefined;
      try {
        parsed = ask.zod.safeParse(JSON.parse(content!));
      } catch {
        parsed = undefined;
      }
      const seen = parsed?.success ? (parsed.data as Record<string, unknown>) : undefined;
      const answer = !seen
        ? null
        : VERSION === 'v4'
          ? fromV3(category, {
              ...(seen as Analysis),
              tankSide: tankSideOf(
                (seen.tank as { bbox_2d: number[] }).bbox_2d,
                (seen.bowl as { bbox_2d: number[] }).bbox_2d,
              ),
            })
          : VERSION === 'v3'
            ? fromV3(category, seen as Analysis)
            : (seen as Analysis);
      writeFileSync(
        file,
        JSON.stringify(
          {
            id,
            repeat,
            raw: content,
            ...((VERSION === 'v3' || VERSION === 'v4') && { observed: seen }),
            answer,
          },
          null,
          2,
        ),
      );
    }
  }
} else if (mode !== 'report') throw new Error('run, describe 또는 report');

// The report: per item, how often the answer was right (in the truth's set) and how often the two
// answers to the same photo differed.
const answers = ids.flatMap((id) =>
  Array.from({ length: REPEATS }, (_, i) => `${OUT}/${id}${SUFFIX}-${i + 1}.json`)
    .filter((file) => existsSync(file))
    .map(
      (file) =>
        JSON.parse(readFileSync(file, 'utf8')) as { id: string; repeat: number; answer: Analysis | null },
    ),
);
const lines: string[] = [];
lines.push('| 사진 | 항목 | 정답 | 답(1회 / 2회) | 맞음 |', '| --- | --- | --- | --- | --- |');
const perKey: Record<string, { right: number; total: number; flips: number; photos: number }> = {};
for (const id of ids) {
  const mine = answers.filter((answer) => answer.id === id);
  for (const key of Object.keys(PHOTOS[id].truth) as AnalysisKey[]) {
    const truth = PHOTOS[id].truth[key]!;
    // Items a version does not ask (v3: the photo's state, the kind for a mirror) are left out.
    if (
      !mine.length ||
      mine.every((answer) => answer.answer && !(key in answer.answer) && key !== 'controlSide')
    )
      continue;
    const values = mine.map((answer) =>
      !answer.answer
        ? '(형식 오류)'
        : key === 'controlSide'
          ? controlSideOf(answer.answer)
          : (answer.answer[key] ?? '(없음)'),
    );
    const right = values.filter((value) => truth.includes(value)).length;
    const stat = (perKey[key] ??= { right: 0, total: 0, flips: 0, photos: 0 });
    stat.right += right;
    stat.total += values.length;
    stat.photos += 1;
    if (new Set(values).size > 1) stat.flips += 1;
    lines.push(
      `| ${id} | ${key} | ${truth.join(' 또는 ')} | ${values.join(' / ')} | ${right}/${values.length} |`,
    );
  }
}
const summary = ['| 항목 | 맞음 | 흔들림(두 답이 다른 사진) |', '| --- | --- | --- |'];
for (const [key, stat] of Object.entries(perKey))
  summary.push(`| ${key} | ${stat.right}/${stat.total} | ${stat.flips}/${stat.photos} |`);
writeFileSync(`${OUT}/report${SUFFIX}.md`, `${summary.join('\n')}\n\n${lines.join('\n')}\n`);
console.log(summary.join('\n'));
