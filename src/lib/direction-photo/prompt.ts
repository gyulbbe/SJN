import { productFrontSentence, productNoun } from '../product-photo-prompt';
import { standsOnFloor, type DirectionPhotoForm, type DirectionPhotoSpec } from './contract';

/**
 * "AI로 방향 사진 만들기": the material form makes the 정면·왼쪽·오른쪽·뒤 photos of a product with
 * FLUX.2 klein 4B. Image 0 is a plain grey 3D render of the product's kind at the registered size,
 * seen from that direction (the guide, src/lib/direction-photo/guide-render.ts); images 1–3 are the
 * person's photos of the real product, on white. A photo and a sentence alone did not turn the
 * product sideways in the 2026-10-13 trial (all three models drew the long side when asked for the
 * end); a guide in image 0 fixed the angle in 8 of 8 answers (docs/direction-photo-results-20261013.md).
 *
 * What travels is a few enums and three numbers (contract.ts); the server writes every
 * sentence here. Same spec, same text.
 */

/** The product as image 0 shows it, with its article. */
const FORM_NOUNS: Record<DirectionPhotoForm, string> = {
  'oval-freestanding': 'an oval freestanding bathtub with rounded ends',
  rectangular: 'a rectangular built-in bathtub',
  'lid-closed': 'a floor-standing toilet with its lid closed',
  'lid-open': 'a floor-standing toilet with its lid open',
  'wall-round': 'a wall-hung washbasin with a round bowl',
  'wall-rectangular': 'a wall-hung washbasin with a rectangular bowl',
  'pedestal-round': 'a pedestal washbasin with a round bowl',
  'pedestal-rectangular': 'a pedestal washbasin with a rectangular bowl',
};

/** What the view shows, said from the camera (the guide shows the same). */
function viewSentence(spec: DirectionPhotoSpec): string {
  const { category, direction } = spec;
  if (category === 'bath') {
    if (direction === 'front') return 'The view shows the long side of the tub.';
    if (direction === 'back') return 'The view shows the long back side of the tub.';
    return spec.form === 'oval-freestanding'
      ? 'The view shows the narrow rounded end of the tub; the long sides are not visible.'
      : 'The view shows the narrow end of the tub; the long sides are not visible.';
  }
  if (category === 'toilet')
    return {
      front: 'The view shows the toilet from the front: the bowl faces the camera and the tank is behind it.',
      left: 'The view shows the toilet from its left side: the bowl points to the left of the picture and the tank is on the right.',
      right:
        'The view shows the toilet from its right side: the bowl points to the right of the picture and the tank is on the left.',
      back: 'The view shows the back of the toilet: the tank faces the camera and the bowl is behind it.',
    }[direction];
  return {
    front: 'The view shows the washbasin from the front, where a person stands.',
    left: 'The view shows the washbasin from its left side: its front points to the left of the picture and its back, the wall side, is on the right.',
    right:
      'The view shows the washbasin from its right side: its front points to the right of the picture and its back, the wall side, is on the left.',
    back: 'The view shows the back of the washbasin, the side that goes against the wall.',
  }[direction];
}

/**
 * The parts this view cannot show, so the model does not paint them where they are not (the trial
 * drew the overflow and the drain where the view could not see them, 4 of 8 answers). Only what the
 * geometry hides at about 10° above: a tub's or a bowl's bottom, the back of a tank, the pipes.
 */
export function hiddenParts(spec: DirectionPhotoSpec): string[] {
  const { category, direction, form } = spec;
  if (category === 'bath') return ['the drain in the bottom of the tub'];
  // A toilet's water sits low in the bowl: from 10° above the rim hides it, lid open or closed.
  if (category === 'toilet')
    return [
      ...{
        front: ['the back of the tank', 'the waste pipe'],
        left: ['the waste pipe'],
        right: ['the waste pipe'],
        back: ['the front of the bowl'],
      }[direction],
      'the water in the bowl',
    ];
  const wall = form.startsWith('wall-');
  return {
    front: ['the drain hole in the bowl', wall ? 'the waste pipe and the wall fixings' : 'the waste pipe'],
    left: ['the drain hole in the bowl'],
    right: ['the drain hole in the bowl'],
    back: ['the inside of the bowl'],
  }[direction];
}
function hiddenSentence(parts: string[]): string {
  if (!parts.length) return '';
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
  return `In this view ${list} ${parts.length === 1 ? 'is' : 'are'} not visible; do not draw ${parts.length === 1 ? 'it' : 'them'}.`;
}
/** Said for a bath whatever the view: the trial drew a drain on its outer wall (1 of 8). */
const BATH_OUTSIDE = 'Draw no hole, drain or overflow on the outside of the tub.';

/**
 * The prompt for one direction. Deterministic: the same spec and number of photos give the same
 * text. The frame, the order and the photo-only role of images 1–n are the trial's (8 of 8 kept the
 * guide's angle, shape and proportions).
 */
export function buildDirectionPhotoPrompt(spec: DirectionPhotoSpec, photos: number): string {
  if (!Number.isInteger(photos) || photos < 1 || photos > 3) throw new Error('참고 사진은 1~3장이에요.');
  const noun = productNoun(spec.category);
  const [w, h, d] = spec.sizeMm;
  const shadow = standsOnFloor(spec.installation)
    ? 'at most a very faint soft contact shadow directly under it'
    : 'no cast shadow';
  const photosSentence =
    photos === 1
      ? 'Image 1 is a photo of the real product taken from another angle: use it only for the material, colour and small details, never for the shape, the camera angle or the position.'
      : `Images 1–${photos} are photos of the real product taken from other angles: use them only for the material, colour and small details, never for the shape, the camera angle or the position.`;
  return [
    `Image 0 is a plain grey 3D render of ${FORM_NOUNS[spec.form]}. It fixes the exact shape, outline, proportions, camera angle, size and position in the frame: keep all of these exactly as in image 0.`,
    productFrontSentence(spec.category),
    viewSentence(spec),
    hiddenSentence(hiddenParts(spec)),
    spec.category === 'bath' ? BATH_OUTSIDE : '',
    `The real ${noun} is about ${w} × ${h} × ${d} mm (width × height × depth).`,
    photosSentence,
    `Turn image 0 into a photorealistic studio product photograph of that real ${noun}: pure white seamless background (#FFFFFF), soft even studio lighting, ${shadow}, no props, no floor texture, no text, no watermark.`,
  ]
    .filter(Boolean)
    .join(' ');
}
