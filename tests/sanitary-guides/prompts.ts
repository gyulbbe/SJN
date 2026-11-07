/**
 * What the AI direction-photo trial of the sanitary-ware classes (docs/sanitary-direction-photos-20261107.md)
 * sends for a class, a view and a method. Pure: no I/O.
 *
 * - G: the class's guide (classes.ts) and the app's prompt for the closest kind, with the class's
 *   shape named where the app names its own (and, for a few classes, the sentences that would say a
 *   part the shape has not: a tankless bowl's tank, a squat pan's seat).
 * - C0: what the app does now: its closest standard model and its prompt, unchanged.
 * - G2 (2026-11-07, after Cloudflare turned 30 of 41 views to the photo's angle): G and, for a
 *   basin, a urinal or a bath, the two sentences the app gives a toilet only: where the photo was
 *   taken from and that its angle is not the one to make (photoAngleSentence), and, for a side or the
 *   back, an orthographic elevation (TOILET_SIDE_ELEVATION; the methods trial's back sentence). A
 *   toilet's G2 is its G: the app already says both.
 *
 * Every change is found exactly once in the app's text or the prompt is not made (`once`, as the
 * direction-photo methods trial did), so a class never drifts silently from the app.
 */
import { buildDirectionPhotoPrompt, photoAngleSentence } from '../../src/lib/direction-photo/prompt';
import {
  directionPhotoSpecSchema,
  type DirectionPhotoPhotoAngle,
  type DirectionPhotoSpec,
  type DirectionPhotoView,
} from '../../src/lib/direction-photo/contract';
import { TOILET_SIDE_ELEVATION, toiletInImageZero } from '../../src/lib/direction-photo/categories/toilet';
import { B2_NOUNS, once } from '../direction-photo-methods/methods';
import type { SanitaryClass } from './classes';
import type { SanitaryShape } from './shapes';

/**
 * G the class guide, C0 the app's nearest model, G2 the class guide with the side sentences, and
 * G2E0·G2E5 G2's text on the class guide drawn from 0° or 5° above instead of the app's 10°
 * (2026-11-07, the user's "안 된 가이드 고쳐 다시 시험": a long counter's side and a bath's end read as
 * a front from 10°, the top being as tall as the side).
 */
export const TRIAL_METHODS = ['G', 'C0', 'G2', 'G2E0', 'G2E5'] as const;
export type TrialMethod = (typeof TRIAL_METHODS)[number];
/** The guide a method sends (prep/manifest.json `guides` key). */
export const guideOf = (method: TrialMethod) =>
  method === 'C0' ? 'C0' : method === 'G2E0' ? 'E0' : method === 'G2E5' ? 'E5' : 'G';

export const KOREAN_VIEW: Record<DirectionPhotoView, '정면' | '왼쪽' | '오른쪽' | '뒤'> = {
  front: '정면',
  left: '왼쪽',
  right: '오른쪽',
  back: '뒤',
};

/** Classes whose left and right sides differ (a shelf or a deck at one end, an L stand, a raised end). */
export const ASYMMETRIC = new Set(['B9', 'B10', 'B11', 'B24', 'A4', 'A5']);

/**
 * The views the app makes (planDirections): the front and the left; the right only when the sides
 * differ (else it mirrors the left) and always for a toilet, as the methods trial made both of its
 * sides; the back for a product that stands on the floor, but never a toilet's (TOILET_NO_BACK).
 */
export function viewsOf(c: SanitaryClass): DirectionPhotoView[] {
  const toilet = c.category === 'toilet';
  const views: DirectionPhotoView[] = ['front', 'left'];
  if (toilet || ASYMMETRIC.has(c.id)) views.push('right');
  if (!toilet && c.installation !== 'wall') views.push('back');
  return views;
}

type AppForm = DirectionPhotoSpec['form'];
/**
 * The app's closest standard form for each class (the methods trial's choice for its products, the
 * same for the new shapes): what C0 draws, and the kind whose sentences G starts from. Urinals and the
 * squat pan have none in the app; their G starts from a basin's and a two-piece toilet's text.
 */
export const APP_FORM: Record<string, AppForm> = {
  T1: 'one-piece',
  T2: 'one-piece',
  T3: 'two-piece',
  T4: 'two-piece',
  T5: 'tankless',
  T6: 'two-piece',
  T7: 'two-piece',
  T8: 'two-piece',
  B1: 'wall-rectangular',
  B2: 'wall-rectangular',
  B3: 'wall-round',
  B4: 'wall-round',
  B5: 'wall-round',
  B6: 'wall-rectangular',
  B7: 'wall-rectangular',
  B8: 'wall-round',
  B9: 'wall-rectangular',
  B10: 'wall-rectangular',
  B11: 'wall-rectangular',
  B12: 'wall-rectangular',
  B13: 'wall-round',
  B14: 'wall-rectangular',
  B15: 'wall-rectangular',
  B16: 'wall-rectangular',
  B17: 'wall-round',
  B18: 'wall-rectangular',
  B19: 'pedestal-round',
  B20: 'pedestal-rectangular',
  B21: 'pedestal-round',
  B22: 'pedestal-rectangular',
  B23: 'pedestal-round',
  B24: 'pedestal-round',
  B25: 'wall-round',
  B26: 'wall-rectangular',
  U1: 'pedestal-rectangular',
  U2: 'pedestal-rectangular',
  U3: 'wall-round',
  A1: 'oval-freestanding',
  A2: 'oval-freestanding',
  A3: 'rectangular',
  A4: 'oval-freestanding',
  A5: 'oval-freestanding',
};
/** The classes with no C0: the app has nothing like them. */
export const NO_C0 = new Set(['T8', 'U1', 'U2', 'U3']);

/**
 * Where the representative photo was taken from, for the toilets the app asks it of (one-piece and
 * tankless: photoAngleTold). Read from the photos (2026-11-07): the bowl points to the picture's right
 * and the side on the left of the picture is seen, the product's right side.
 */
const PHOTO_ANGLE: Record<string, DirectionPhotoSpec['photoAngles']> = {
  T1: ['front-right'],
  T2: ['front-right'],
  T5: ['front-right'],
};

/**
 * Where each basin's, urinal's and bath's representative photo was taken from (G2), read from the
 * site's renders on 2026-11-07: LAUCHE's basins and the baths from the front left (the product's left
 * end shows on the picture's right), the CLINS pedestal and semi-pedestal basins and two urinals
 * straight in front, the sensor urinal from the front right; the drop-in bowl from above (unknown).
 */
export const PHOTO_FROM: Record<string, DirectionPhotoPhotoAngle> = {
  ...Object.fromEntries(
    ['B1', 'B2', 'B3', 'B5', 'B6', 'B7', 'B8', 'B9', 'B10', 'B11', 'B12', 'B13', 'B14', 'B15', 'B16']
      .concat(['B22', 'B23', 'B24', 'B26', 'A1', 'A2', 'A3', 'A4', 'A5'])
      .map((id) => [id, 'front-left']),
  ),
  ...Object.fromEntries(['B4', 'B17', 'B18', 'B19', 'B20', 'B21', 'U1', 'U3'].map((id) => [id, 'front'])),
  U2: 'front-right',
  B25: 'unknown',
};
/** The methods trial's back sentence (methods.ts ORTHO.back), for a back view in G2. */
export const BACK_ELEVATION =
  'Draw it as an orthographic back elevation, like a product drawing: no perspective, no turn toward the camera, the outline exactly that of image 0.';
const STUDIO = 'Turn image 0 into a photorealistic studio product photograph';

/** The app's spec for a class at a view (its closest kind and form, at the given size). */
export function specOf(
  c: SanitaryClass,
  view: DirectionPhotoView,
  sizeMm: [number, number, number] = c.sizeMm,
): DirectionPhotoSpec {
  const form = APP_FORM[c.id];
  const toilet = c.category === 'toilet';
  const category = toilet ? 'toilet' : c.category === 'bath' ? 'bath' : 'basin';
  return directionPhotoSpecSchema.parse({
    category,
    form,
    direction: view,
    installation: c.installation,
    sizeMm,
    ...(toilet && { lid: 'closed' }),
    ...(toilet &&
      form === 'two-piece' && { skirt: c.model.from === 'app' && c.model.skirt ? 'skirted' : 'exposed' }),
    ...(PHOTO_ANGLE[c.id] && { photoAngles: PHOTO_ANGLE[c.id] }),
  });
}

/** The class's shape as image 0 shows it, said as the app says its own (an article, no left or right). */
export const NOUNS: Record<SanitaryShape, string> = {
  'toilet-low-tank':
    'a one-piece floor-standing toilet whose low tank rises only a little above the seat, with its lid closed',
  'toilet-bowl': 'a floor-standing toilet bowl with no tank, with its lid closed',
  'squat-pan':
    'a squat toilet pan set into the floor: a long open ceramic pan with a raised hood at its front end',
  'vessel-round': 'a round vessel washbasin with straight cylindrical walls that sits on a counter',
  'vessel-bowl': 'a round bowl-shaped vessel washbasin that sits on a counter',
  'vessel-oval': 'an oval vessel washbasin with gently curved sides that sits on a counter',
  'wall-towelbar':
    'a rectangular wall-hung washbasin with a towel rail round its front and sides below the bowl',
  'wall-box-under': 'a rectangular wall-hung washbasin over an open box of the same width',
  'counter-deck-right':
    'a wide wall-hung countertop washbasin: one thick slab with its bowl sunk into one part and a flat deck beside it',
  'semi-square':
    'a wall-hung washbasin whose square body continues down into a half pedestal, a little narrower at its foot',
  'semi-skirt-round': 'a wide wall-hung washbasin with a rounded front over a narrower rounded half pedestal',
  'semi-skirt-rect': 'a wide rectangular wall-hung washbasin over a narrower square half pedestal',
  'pedestal-oval': 'a washbasin with a rounded bowl on a full pedestal that stands on the floor',
  'pedestal-rect': 'a washbasin with a rectangular bowl on a full pedestal that stands on the floor',
  undermount: 'an undermount washbasin bowl with a flat flange round its rim, made to sit under a counter',
  'utility-sink': 'a deep wall-hung utility sink with a high splashback at its back',
  'urinal-floor': 'a tall floor-standing urinal, open at its front',
  'urinal-floor-sensor': 'a tall floor-standing urinal, open at its front, with a sensor box on its top',
  'urinal-wall': 'a small wall-hung urinal with a rounded body and an oval opening at its front',
  'bath-egg': 'an egg-shaped freestanding bathtub whose sides flare out toward the rim',
  'bath-rect': 'a rectangular freestanding bathtub with rounded corners',
  'bath-slipper': 'an oval freestanding slipper bathtub whose rim rises toward one end',
  'bath-clawfoot': 'an oval clawfoot bathtub on four feet whose rim rises toward one end',
};

const APP_NOUNS: Partial<Record<AppForm, string>> = {
  'oval-freestanding': 'an oval freestanding bathtub with rounded ends',
  rectangular: 'a rectangular built-in bathtub',
  'wall-round': 'a wall-hung washbasin with a round bowl',
  'wall-rectangular': 'a wall-hung washbasin with a rectangular bowl',
  'pedestal-round': 'a pedestal washbasin with a round bowl',
  'pedestal-rectangular': 'a pedestal washbasin with a rectangular bowl',
};
/** What the app's prompt calls the product in its first sentence. */
const appNoun = (spec: DirectionPhotoSpec) =>
  spec.category === 'toilet' ? toiletInImageZero(spec) : APP_NOUNS[spec.form]!;

type Edit = [from: string, to: string];
const TOILET_FRONT =
  "Its front is the bowl end, where a seated person's legs go; the tank or rear housing is its back.";
/** The sentences a class changes beyond its noun: parts its shape has not, at this view. */
function extraEdits(c: SanitaryClass, view: DirectionPhotoView): Edit[] {
  if (c.id === 'T7')
    return [
      [
        TOILET_FRONT,
        "Its front is the bowl end, where a seated person's legs go; the narrow back of the bowl is its back. It has no water tank; draw no flush valve and no pipe.",
      ],
      ...(
        {
          front: [
            [
              'the bowl faces the camera and the tank is behind it.',
              'the bowl faces the camera and nothing is behind it.',
            ],
            ['the back of the tank, ', ''],
          ],
          left: [['and the tank is on the right.', 'and its narrow back is on the right.']],
          right: [['and the tank is on the left.', 'and its narrow back is on the left.']],
          back: [],
        } as Record<DirectionPhotoView, Edit[]>
      )[view],
    ];
  if (c.id === 'T8')
    return [
      [
        TOILET_FRONT,
        'Its front is the hooded end; the open end, where the feet go, is its back. It has no seat, no lid and no tank.',
      ],
      ...(
        {
          front: [
            [
              'The view shows the toilet from the front: the bowl faces the camera and the tank is behind it.',
              'The view shows the squat pan from its hooded front end, along its length.',
            ],
            [
              'the back of the tank, the waste pipe and the water in the bowl are',
              'the waste pipe and the water in the pan are',
            ],
          ],
          left: [
            [
              'The view shows the toilet from its left side: the bowl points to the left of the picture and the tank is on the right.',
              'The view shows the squat pan from its left side: its hooded front points to the left of the picture.',
            ],
            ['the waste pipe and the water in the bowl are', 'the waste pipe and the water in the pan are'],
          ],
          right: [
            [
              'The view shows the toilet from its right side: the bowl points to the right of the picture and the tank is on the left.',
              'The view shows the squat pan from its right side: its hooded front points to the right of the picture.',
            ],
            ['the waste pipe and the water in the bowl are', 'the waste pipe and the water in the pan are'],
          ],
          back: [],
        } as Record<DirectionPhotoView, Edit[]>
      )[view],
      ['photograph of that real toilet:', 'photograph of that real squat toilet pan:'],
    ];
  return [];
}

/**
 * The prompt of a class at a view for a method, at the product's size. C0 is the app's own text; G
 * names the class's shape (an app-model class is the app's text too: its guide is the app's).
 */
export function promptFor(
  c: SanitaryClass,
  view: DirectionPhotoView,
  method: TrialMethod,
  sizeMm: [number, number, number] = c.sizeMm,
): string {
  if (!viewsOf(c).includes(view)) throw new Error(`${c.id}: the app makes no ${view} view`);
  if (method === 'G2E0' || method === 'G2E5') return promptFor(c, view, 'G2', sizeMm);
  if (method === 'G2') {
    const g = promptFor(c, view, 'G', sizeMm);
    if (c.category === 'toilet') return g;
    const from = PHOTO_FROM[c.id];
    if (!from) throw new Error(`${c.id}: where its photo was taken from is not said`);
    const withAngle = once(g, STUDIO, `${photoAngleSentence([from], view)} ${STUDIO}`);
    const elevation = view === 'back' ? BACK_ELEVATION : view === 'front' ? '' : TOILET_SIDE_ELEVATION;
    return elevation ? `${withAngle} ${elevation}` : withAngle;
  }
  const spec = specOf(c, view, sizeMm);
  let text = buildDirectionPhotoPrompt(spec, 1);
  if (method === 'C0') {
    if (NO_C0.has(c.id)) throw new Error(`${c.id}: the app has nothing like it`);
    return text;
  }
  if (c.model.from === 'app') return text;
  const noun = c.model.from === 'trial' ? B2_NOUNS[c.model.shape] : NOUNS[c.model.shape];
  text = once(text, `of ${appNoun(spec)}.`, `of ${noun}.`);
  for (const [from, to] of extraEdits(c, view)) text = once(text, from, to);
  if (c.category === 'urinal') text = text.replaceAll('washbasin', 'urinal');
  return text;
}
