/**
 * The methods of the direction-photo methods trial (docs/direction-photo-methods-results-20261105.md):
 * for a product, a view and a method, which image 0, which photos and which prompt go out. Pure: the
 * pictures are files the runner reads (prep/ from prepare.ts, earlier answers from runs/).
 *
 * Every prompt starts from the app's own (buildDirectionPhotoPrompt for the product's spec) and changes
 * one thing; a sentence to change that is not found exactly once throws, so a method never drifts
 * silently from the app.
 */
import { buildDirectionPhotoPrompt, photoAngleSentence } from '../../src/lib/direction-photo/prompt';
import { directionPhotoSpecSchema, type DirectionPhotoView } from '../../src/lib/direction-photo/contract';
import { TOILET_SIDE_ELEVATION } from '../../src/lib/direction-photo/categories/toilet';
import type { B2Shape, Product } from './products';

export const METHODS = [
  'C0',
  'B2',
  'B3',
  'B2B3',
  'B4',
  'B2B4',
  'C3',
  'B2C3',
  'C1s1',
  'C1',
  'B2C1s1',
  'B2C1',
  'C2',
  'A1',
  'B6',
] as const;
export type Method = (typeof METHODS)[number];

/** What each method changes from the app (C0), for the record. */
export const METHOD_NOTES: Record<Method, string> = {
  C0: '지금 방식(앱 그대로)',
  B2: '새 형태 가이드(시험 도구의 모양) + 그 형태 이름',
  B3: '지금 가이드의 윤곽선만',
  B2B3: '새 형태의 윤곽선만',
  B4: '지금 가이드를 0°(정확한 옆면도)로',
  B2B4: '새 형태를 0°로',
  C3: '정투상 문장(옆·뒤)',
  B2C3: '새 형태 + 정투상 문장',
  C1s1: '두 단계 1단계: 사진 없이 모양만',
  C1: '두 단계 2단계: 1단계 결과를 image 0으로 + 사진',
  B2C1s1: '새 형태로 두 단계 1단계',
  B2C1: '새 형태로 두 단계 2단계',
  C2: '정면 결과(같은 seed)를 사진으로 더함',
  A1: '사선 대표 사진과 정면 사진을 함께(변기)',
  B6: 'R4: 먼 쪽 결과를 반전해 가까운 쪽 image 0으로(변기)',
};

/** The app's noun for each basin form (prompt.ts FORM_NOUNS), to find it in the prompt. */
const APP_NOUNS: Record<string, string> = {
  'wall-round': 'a wall-hung washbasin with a round bowl',
  'wall-rectangular': 'a wall-hung washbasin with a rectangular bowl',
  'pedestal-round': 'a pedestal washbasin with a round bowl',
  'pedestal-rectangular': 'a pedestal washbasin with a rectangular bowl',
  'oval-freestanding': 'an oval freestanding bathtub with rounded ends',
  rectangular: 'a rectangular built-in bathtub',
};
/** The trial shapes' nouns (no left or right: the view sentence says where the front points). */
export const B2_NOUNS: Record<B2Shape, string> = {
  'vessel-rect': 'a rectangular vessel washbasin with straight walls that sits on a counter',
  'vessel-soft': 'a vessel washbasin with softly rounded corners and thin walls that sits on a counter',
  'counter-shelf-right': 'a long rectangular wall-hung washbasin with an open shelf box at one end',
  'counter-shelf-left': 'a long rectangular wall-hung washbasin with an open shelf box at one end',
  'column-rect': 'a freestanding rectangular column washbasin, one solid block from the floor to its bowl',
  'column-round':
    'a freestanding cylindrical column washbasin, one solid cylinder from the floor to its bowl',
  'stand-bowl': 'a round vessel bowl on a freestanding L-shaped stand',
  'semi-round': 'a wall-hung washbasin whose rounded front continues down into a half pedestal',
  'semi-taper': 'a wall-hung washbasin whose body slopes back to the wall below its bowl',
  cube: 'a wall-hung cube-shaped washbasin',
};

const once = (text: string, from: string, to: string) => {
  if (text.split(from).length !== 2) throw new Error(`not found exactly once: ${from.slice(0, 80)}`);
  return text.replace(from, () => to);
};
const ORTHO: Record<'side' | 'back', string> = {
  side: TOILET_SIDE_ELEVATION,
  back: 'Draw it as an orthographic back elevation, like a product drawing: no perspective, no turn toward the camera, the outline exactly that of image 0.',
};

export type Job = {
  product: string;
  view: DirectionPhotoView;
  method: Method;
  seed: number;
  /** prep/<product>/<variant>/<view>.png, or an earlier answer ("run:<method>:<view>", mirrored with "!"). */
  image0: string;
  /** prep/<product>/refs/<n>.png, or an earlier answer. */
  refs: string[];
  prompt: string;
};

/**
 * A job: the method's image 0, photos and prompt. `refs` are the prepared photos (prep/<id>/refs); a
 * toilet's A1 adds the catalogue's front photo, prepared as the others (refs[1]).
 */
export function jobFor(
  product: Product,
  view: DirectionPhotoView,
  method: Method,
  seed: number,
  refs: string[],
): Job {
  const spec = directionPhotoSpecSchema.parse({ ...product.spec, direction: view });
  const side = view === 'left' || view === 'right';
  const ortho = side ? ORTHO.side : view === 'back' ? ORTHO.back : '';
  const b2 = product.b2;
  const needsB2 = method.startsWith('B2');
  if (needsB2 && !b2) throw new Error(`${product.id}: no trial shape for ${method}`);
  const appNoun = APP_NOUNS[product.spec.form];
  const withB2 = (text: string) =>
    needsB2 && b2 ? once(text, `of ${appNoun}.`, `of ${B2_NOUNS[b2]}.`) : text;
  const lineDrawing = (text: string) =>
    once(text, 'Image 0 is a plain grey 3D render of', 'Image 0 is a black line drawing of the outline of');
  const photoAtView = (text: string) =>
    once(
      once(text, 'Image 0 is a plain grey 3D render of', 'Image 0 is a studio photograph of'),
      'keep all of these exactly as in image 0.',
      'keep all of these exactly as in image 0, and take the material, colour and details from the photos below.',
    );
  const photoRefs = method === 'A1' ? refs : refs.slice(0, 1);
  // The app's prompt for that many photos; an added photo is a front one (A1's catalogue front, C2's answer).
  const app = (photos: number) =>
    buildDirectionPhotoPrompt(
      spec.photoAngles
        ? {
            ...spec,
            photoAngles: [...spec.photoAngles, ...Array(photos - spec.photoAngles.length).fill('front')],
          }
        : spec,
      photos,
    );
  const job = (image0: string, jobRefs: string[], prompt: string): Job => ({
    product: product.id,
    view,
    method,
    seed,
    image0,
    refs: jobRefs,
    prompt,
  });
  const prep = (variant: string) => `prep:${variant}:${view}`;
  switch (method) {
    case 'C0':
      return job(prep('b0'), photoRefs, app(1));
    case 'B2':
      return job(prep('b2'), photoRefs, withB2(app(1)));
    case 'B3':
      return job(prep('b3'), photoRefs, lineDrawing(app(1)));
    case 'B2B3':
      return job(prep('b2b3'), photoRefs, lineDrawing(withB2(app(1))));
    case 'B4':
    case 'B2B4':
      if (view === 'front') throw new Error('B4 is for the side and back views');
      return job(prep(method === 'B4' ? 'b4' : 'b2b4'), photoRefs, withB2(app(1)));
    case 'C3':
    case 'B2C3':
      if (!ortho) throw new Error('C3 is for the side and back views');
      if (product.category === 'toilet') throw new Error('a toilet side already has T4');
      return job(prep(method === 'C3' ? 'b0' : 'b2'), photoRefs, `${withB2(app(1))} ${ortho}`);
    case 'C1s1':
    case 'B2C1s1': {
      // The app's prompt without the photos: the shape alone, in white ceramic.
      let prompt = withB2(app(1));
      prompt = once(
        prompt,
        'Image 1 is a photo of the real product taken from another angle: use it only for the material, colour and small details, never for the shape, the camera angle or the position. ',
        '',
      );
      if (spec.photoAngles) prompt = once(prompt, photoAngleSentence(spec.photoAngles, view) + ' ', '');
      prompt = once(
        prompt,
        'Turn image 0 into a photorealistic studio product photograph of that real',
        'Turn image 0 into a photorealistic studio product photograph, in white glossy ceramic, of that real',
      );
      return job(prep(method === 'C1s1' ? 'b0' : 'b2'), [], prompt);
    }
    case 'C1':
    case 'B2C1':
      return job(
        `run:${method === 'C1' ? 'C1s1' : 'B2C1s1'}:${view}`,
        photoRefs,
        photoAtView(withB2(app(1))),
      );
    case 'C2':
      if (view === 'front') throw new Error('C2 makes the front first (C0) and adds it to the sides');
      return job(prep('b0'), [...photoRefs, 'run:C0:front'], app(2));
    case 'A1':
      if (refs.length < 2) throw new Error(`${product.id}: A1 needs a second photo`);
      return job(prep('b0'), refs.slice(0, 2), app(2));
    case 'B6': {
      if (product.category !== 'toilet' || !side || !product.near)
        throw new Error('B6 is for a toilet near side');
      if (view !== product.near) throw new Error(`B6 makes the near side (${product.near})`);
      const far = view === 'left' ? 'right' : 'left';
      return job(`run!:C0:${far}`, photoRefs, photoAtView(app(1)));
    }
  }
}
