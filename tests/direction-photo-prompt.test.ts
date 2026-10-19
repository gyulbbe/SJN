import { describe, expect, it } from 'vitest';
import {
  buildDirectionPhotoPrompt as buildPrompt,
  hiddenParts,
  photoAngleSentence,
} from '../src/lib/direction-photo/prompt';
import {
  DIRECTION_PHOTO_FORMS,
  directionPhotoSpecSchema,
  type DirectionPhotoSpec,
} from '../src/lib/direction-photo/contract';

const BATH: [number, number, number] = [1700, 560, 750];
const spec = (edit: Partial<DirectionPhotoSpec> = {}): DirectionPhotoSpec => ({
  category: 'bath',
  form: 'oval-freestanding',
  direction: 'front',
  installation: 'floor',
  sizeMm: BATH,
  ...edit,
});
const onePiece = (edit: Partial<DirectionPhotoSpec> = {}) =>
  spec({
    category: 'toilet',
    form: 'one-piece',
    lid: 'seat',
    sizeMm: [370, 660, 640],
    photoAngles: ['unknown'],
    ...edit,
  });
/** The prompt for this many photos (a spec with angles: each unknown unless it says). */
const buildDirectionPhotoPrompt = (value: DirectionPhotoSpec, photos: number) =>
  buildPrompt(
    {
      ...value,
      photoAngles:
        !value.photoAngles || value.photoAngles.length === photos
          ? value.photoAngles
          : Array(Math.max(0, photos)).fill('unknown'),
    },
    photos,
  );

describe('direction photo prompt', () => {
  it('follows the trial’s frame: image 0 fixes the shape and angle, the photos only the material', () => {
    const text = buildDirectionPhotoPrompt(spec(), 2);
    expect(text).toMatch(
      /^Image 0 is a plain grey 3D render of an oval freestanding bathtub with rounded ends\. It fixes the exact shape, outline, proportions, camera angle, size and position in the frame: keep all of these exactly as in image 0\./,
    );
    expect(text).toContain(
      'Images 1–2 are photos of the real product taken from other angles: use them only for the material, colour and small details, never for the shape, the camera angle or the position.',
    );
    expect(text).toContain(
      'Turn image 0 into a photorealistic studio product photograph of that real bathtub: pure white seamless background (#FFFFFF), soft even studio lighting, at most a very faint soft contact shadow directly under it, no props, no floor texture, no text, no watermark.',
    );
    expect(text).toContain(
      'Its front is the long side facing the room; its back is the long side placed along the wall.',
    );
    expect(text).toContain('The real bathtub is about 1700 × 560 × 750 mm (width × height × depth).');
    expect(buildDirectionPhotoPrompt(spec(), 1)).toContain(
      'Image 1 is a photo of the real product taken from another angle:',
    );
    expect(buildDirectionPhotoPrompt(spec(), 3)).toContain('Images 1–3 are photos');
    expect(() => buildDirectionPhotoPrompt(spec(), 0)).toThrow();
    expect(() => buildDirectionPhotoPrompt(spec(), 4)).toThrow();
  });

  it('says what each view shows, per kind', () => {
    const view = (edit: Partial<DirectionPhotoSpec>) => buildDirectionPhotoPrompt(spec(edit), 1);
    expect(view({})).toContain('The view shows the long side of the tub.');
    expect(view({ direction: 'left' })).toContain(
      'The view shows the narrow rounded end of the tub; the long sides are not visible.',
    );
    expect(view({ direction: 'right', form: 'rectangular' })).toContain(
      'The view shows the narrow end of the tub; the long sides are not visible.',
    );
    expect(view({ direction: 'back' })).toContain('The view shows the long back side of the tub.');
    const toilet: Partial<DirectionPhotoSpec> = {
      category: 'toilet',
      form: 'two-piece',
      lid: 'closed',
      sizeMm: [380, 760, 700],
    };
    expect(view({ ...toilet, direction: 'left' })).toContain(
      'the bowl points to the left of the picture and the tank is on the right.',
    );
    expect(view({ ...toilet, direction: 'right' })).toContain(
      'the bowl points to the right of the picture and the tank is on the left.',
    );
    expect(view({ ...toilet })).toContain("Its front is the bowl end, where a seated person's legs go");
    expect(view({ ...toilet })).toContain('a floor-standing toilet with its lid closed');
    const basin: Partial<DirectionPhotoSpec> = {
      category: 'basin',
      form: 'wall-round',
      installation: 'wall',
      sizeMm: [500, 180, 420],
    };
    expect(view({ ...basin, direction: 'left' })).toContain(
      'its front points to the left of the picture and its back, the wall side, is on the right.',
    );
    expect(view({ ...basin })).toContain('no cast shadow');
    expect(view({ ...basin })).not.toContain('contact shadow');
  });

  it('names what the view cannot show, so it is not drawn there', () => {
    for (const direction of ['front', 'left', 'right', 'back'] as const)
      expect(buildDirectionPhotoPrompt(spec({ direction }), 1)).toContain(
        'In this view the drain in the bottom of the tub is not visible; do not draw it. Draw no hole, drain or overflow on the outside of the tub.',
      );
    expect(
      buildDirectionPhotoPrompt(
        spec({ category: 'toilet', form: 'two-piece', lid: 'open', sizeMm: [380, 760, 700] }),
        1,
      ),
    ).toContain(
      'In this view the back of the tank, the waste pipe and the water in the bowl are not visible; do not draw them.',
    );
    // A tankless toilet has no tank behind its seat unit.
    expect(hiddenParts(spec({ category: 'toilet', form: 'tankless', lid: 'closed' }))).toEqual([
      'the waste pipe',
      'the water in the bowl',
    ]);
    expect(hiddenParts(spec({ category: 'basin', form: 'wall-round', installation: 'wall' }))).toEqual([
      'the drain hole in the bowl',
      'the waste pipe and the wall fixings',
    ]);
    expect(hiddenParts(spec({ category: 'basin', form: 'pedestal-round', direction: 'back' }))).toEqual([
      'the inside of the bowl',
    ]);
    // Every kind and view has its sentence.
    for (const [category, forms] of Object.entries(DIRECTION_PHOTO_FORMS))
      for (const form of forms)
        for (const direction of ['front', 'left', 'right', 'back'] as const)
          expect(
            hiddenParts({ ...spec(), category, form, direction } as DirectionPhotoSpec).length,
          ).toBeGreaterThan(0);
  });

  it('names the toilet in image 0 by its body and lid, in the words the trial sent', () => {
    const named = (form: DirectionPhotoSpec['form'], lid: DirectionPhotoSpec['lid']) =>
      buildDirectionPhotoPrompt(spec({ category: 'toilet', form, lid, sizeMm: [370, 660, 640] }), 1);
    expect(named('two-piece', 'closed')).toContain(
      'Image 0 is a plain grey 3D render of a floor-standing toilet with its lid closed.',
    );
    expect(named('two-piece', 'open')).toContain('render of a floor-standing toilet with its lid open.');
    expect(named('one-piece', 'seat')).toContain(
      'render of a one-piece floor-standing toilet with a seat and no lid.',
    );
    expect(named('tankless', 'closed')).toContain(
      'render of a tankless floor-standing toilet with its seat unit at the back and its lid closed.',
    );
  });

  it('says where each photo was taken from and that its angle is not the one to make', () => {
    // The trial's sentences, word for word (one photo; its angle known, then unknown).
    expect(photoAngleSentence(['front-right'], 'left')).toBe(
      'Image 1 was taken from the front right of the product, from above: that is not the view to make. Turn the product to the view of image 0 and do not copy the angle, the perspective or the framing of image 1.',
    );
    expect(photoAngleSentence(['unknown'], 'front')).toBe(
      'Image 1 was taken from another angle: that is not the view to make. Turn the product to the view of image 0 and do not copy the angle, the perspective or the framing of image 1.',
    );
    // A photo from the view being made is not called another view.
    expect(photoAngleSentence(['front'], 'front')).toBe(
      'Image 1 was taken from straight in front of the product, close to the view to make: still keep the outline, the camera angle and the position exactly as in image 0.',
    );
    expect(photoAngleSentence(['front-left', 'unknown'], 'right')).toBe(
      'Image 1 was taken from the front left of the product, from above and image 2 from another angle: none of them is the view to make. Turn the product to the view of image 0 and do not copy the angle, the perspective or the framing of images 1–2.',
    );
    expect(photoAngleSentence(['left', 'front', 'right'], 'left')).toBe(
      "Image 1 was taken from the product's left side, image 2 from straight in front of the product and image 3 from the product's right side. Image 1 is close to the view to make; still keep the outline, the camera angle and the position exactly as in image 0, and do not copy the angle, the perspective or the framing of image 2 and image 3.",
    );
    // It follows the photos' sentence, for a toilet shaped like the product only.
    const text = buildDirectionPhotoPrompt(onePiece({ direction: 'left', photoAngles: ['front-right'] }), 1);
    expect(text).toContain(
      'never for the shape, the camera angle or the position. Image 1 was taken from the front right of the product, from above:',
    );
    expect(() => buildPrompt(onePiece({ photoAngles: ['front', 'left'] }), 1)).toThrow();
    // The bath's guide held its view without the sentence and lost it with it: none for a bath.
    expect(buildDirectionPhotoPrompt(spec({ direction: 'left' }), 1)).not.toContain('was taken from');
    expect(directionPhotoSpecSchema.safeParse(onePiece()).success).toBe(true);
  });

  it('keeps the bath’s, the basin’s and the toilets’ texts word for word when nothing new is said', () => {
    // The texts before the toilet's own module (2026-10-18), byte for byte.
    expect(buildDirectionPhotoPrompt(spec(), 1)).toBe(
      'Image 0 is a plain grey 3D render of an oval freestanding bathtub with rounded ends. It fixes the exact shape, outline, proportions, camera angle, size and position in the frame: keep all of these exactly as in image 0. Its front is the long side facing the room; its back is the long side placed along the wall. The view shows the long side of the tub. In this view the drain in the bottom of the tub is not visible; do not draw it. Draw no hole, drain or overflow on the outside of the tub. The real bathtub is about 1700 × 560 × 750 mm (width × height × depth). Image 1 is a photo of the real product taken from another angle: use it only for the material, colour and small details, never for the shape, the camera angle or the position. Turn image 0 into a photorealistic studio product photograph of that real bathtub: pure white seamless background (#FFFFFF), soft even studio lighting, at most a very faint soft contact shadow directly under it, no props, no floor texture, no text, no watermark.',
    );
    expect(
      buildDirectionPhotoPrompt(
        spec({
          category: 'basin',
          form: 'wall-round',
          direction: 'left',
          installation: 'wall',
          sizeMm: [500, 180, 420],
        }),
        1,
      ),
    ).toBe(
      'Image 0 is a plain grey 3D render of a wall-hung washbasin with a round bowl. It fixes the exact shape, outline, proportions, camera angle, size and position in the frame: keep all of these exactly as in image 0. Its front is the side a person stands at; its back mounts to the wall. The view shows the washbasin from its left side: its front points to the left of the picture and its back, the wall side, is on the right. In this view the drain hole in the bowl is not visible; do not draw it. The real washbasin is about 500 × 180 × 420 mm (width × height × depth). Image 1 is a photo of the real product taken from another angle: use it only for the material, colour and small details, never for the shape, the camera angle or the position. Turn image 0 into a photorealistic studio product photograph of that real washbasin: pure white seamless background (#FFFFFF), soft even studio lighting, no cast shadow, no props, no floor texture, no text, no watermark.',
    );
    const twoPiece = spec({ category: 'toilet', form: 'two-piece', lid: 'closed', sizeMm: [380, 760, 700] });
    const twoPieceText =
      "Image 0 is a plain grey 3D render of a floor-standing toilet with its lid closed. It fixes the exact shape, outline, proportions, camera angle, size and position in the frame: keep all of these exactly as in image 0. Its front is the bowl end, where a seated person's legs go; the tank or rear housing is its back. The view shows the toilet from the front: the bowl faces the camera and the tank is behind it. In this view the back of the tank, the waste pipe and the water in the bowl are not visible; do not draw them. The real toilet is about 380 × 760 × 700 mm (width × height × depth). Image 1 is a photo of the real product taken from another angle: use it only for the material, colour and small details, never for the shape, the camera angle or the position. Turn image 0 into a photorealistic studio product photograph of that real toilet: pure white seamless background (#FFFFFF), soft even studio lighting, at most a very faint soft contact shadow directly under it, no props, no floor texture, no text, no watermark.";
    expect(buildDirectionPhotoPrompt(twoPiece, 1)).toBe(twoPieceText);
    // A skirted two-piece changes the guide only (the 2026-10-17 trial): the same text.
    expect(buildDirectionPhotoPrompt({ ...twoPiece, skirt: 'skirted' }, 1)).toBe(twoPieceText);
    expect(
      buildDirectionPhotoPrompt(
        onePiece({
          lid: 'closed',
          direction: 'right',
          sizeMm: [380, 700, 700],
          photoAngles: ['front-right'],
        }),
        1,
      ),
    ).toBe(
      "Image 0 is a plain grey 3D render of a one-piece floor-standing toilet with its lid closed. It fixes the exact shape, outline, proportions, camera angle, size and position in the frame: keep all of these exactly as in image 0. Its front is the bowl end, where a seated person's legs go; the tank or rear housing is its back. The view shows the toilet from its right side: the bowl points to the right of the picture and the tank is on the left. In this view the waste pipe and the water in the bowl are not visible; do not draw them. The real toilet is about 380 × 700 × 700 mm (width × height × depth). Image 1 is a photo of the real product taken from another angle: use it only for the material, colour and small details, never for the shape, the camera angle or the position. Image 1 was taken from the front right of the product, from above: that is not the view to make. Turn the product to the view of image 0 and do not copy the angle, the perspective or the framing of image 1. Turn image 0 into a photorealistic studio product photograph of that real toilet: pure white seamless background (#FFFFFF), soft even studio lighting, at most a very faint soft contact shadow directly under it, no props, no floor texture, no text, no watermark.",
    );
  });

  it('speaks of a tankless toilet’s seat unit, never of a tank (the 2026-10-18 trial’s words)', () => {
    const tankless = (direction: DirectionPhotoSpec['direction']) =>
      buildDirectionPhotoPrompt(
        spec({
          category: 'toilet',
          form: 'tankless',
          lid: 'closed',
          direction,
          sizeMm: [400, 500, 680],
          photoAngles: ['front-right'],
        }),
        1,
      );
    for (const direction of ['front', 'left', 'right'] as const) {
      const text = tankless(direction);
      expect(text).toContain(
        "Its front is the bowl end, where a seated person's legs go; the seat unit at the back is its back. It has no water tank.",
      );
      expect(text).not.toMatch(/the tank\b/);
    }
    expect(tankless('front')).toContain(
      'The view shows the toilet from the front: the bowl faces the camera and the low seat unit is behind it.',
    );
    expect(tankless('left')).toContain(
      'the bowl points to the left of the picture and the seat unit is on the right.',
    );
    expect(tankless('right')).toContain(
      'the bowl points to the right of the picture and the seat unit is on the left.',
    );
  });

  it('says the colours the person picked for a toilet, after the photos’ role, and none unsaid', () => {
    const toilet = (edit: Partial<DirectionPhotoSpec>) =>
      buildDirectionPhotoPrompt(onePiece({ lid: 'closed', photoAngles: ['front-right'], ...edit }), 1);
    const colour = (edit: Partial<DirectionPhotoSpec>) =>
      toilet(edit).match(
        /never for the shape, the camera angle or the position\. (.*?) Image 1 was taken/,
      )?.[1];
    expect(colour({ bodyColor: 'black', seatColor: 'black' })).toBe(
      'The body, the seat and the lid are black.',
    );
    expect(colour({ bodyColor: 'white', seatColor: 'blue' })).toBe(
      'The body is white; the seat and the lid are blue.',
    );
    expect(colour({ bodyColor: 'ivory' })).toBe('The body is ivory.');
    expect(colour({ seatColor: 'pink' })).toBe('The seat and the lid are pink.');
    expect(colour({ lid: 'seat', bodyColor: 'grey', seatColor: 'grey' })).toBe(
      'The body and the seat are grey.',
    );
    expect(colour({ lid: 'seat', bodyColor: 'white', seatColor: 'black' })).toBe(
      'The body is white; the seat is black.',
    );
    expect(colour({ lid: 'seat', seatColor: 'blue' })).toBe('The seat is blue.');
    expect(
      directionPhotoSpecSchema.safeParse(onePiece({ bodyColor: 'ivory', seatColor: 'pink' })).success,
    ).toBe(true);
    expect(
      directionPhotoSpecSchema.safeParse(
        spec({ category: 'toilet', form: 'two-piece', lid: 'open', skirt: 'skirted', bodyColor: 'black' }),
      ).success,
    ).toBe(true);
    // Nothing said: no colour sentence at all.
    expect(toilet({})).toContain(
      'never for the shape, the camera angle or the position. Image 1 was taken from the front right',
    );
  });

  it('gives the same text for the same spec, and none of it comes from the person', () => {
    expect(buildDirectionPhotoPrompt(spec({ direction: 'left' }), 2)).toBe(
      buildDirectionPhotoPrompt(spec({ direction: 'left' }), 2),
    );
    expect(buildDirectionPhotoPrompt(spec(), 1).length).toBeLessThan(2000);
  });

  it.each([
    ['an unknown field', { ...spec(), note: 'make it gold' }],
    ['a free form', { ...spec(), form: 'a golden tub' }],
    ['a form of another kind', { ...spec(), form: 'two-piece' }],
    ['a toilet without a lid said', { ...spec(), category: 'toilet', form: 'one-piece' }],
    ['a lid on a bath', { ...spec(), lid: 'closed' }],
    ['an open lid on a tankless toilet', { ...spec(), category: 'toilet', form: 'tankless', lid: 'open' }],
    [
      'a toilet’s back',
      { ...spec(), category: 'toilet', form: 'two-piece', lid: 'closed', direction: 'back' },
    ],
    ['photo angles on a bath', { ...spec(), photoAngles: ['front'] }],
    ['a one-piece toilet without photo angles', { ...onePiece(), photoAngles: undefined }],
    ['no photo angle', { ...onePiece(), photoAngles: [] }],
    ['four photo angles', { ...onePiece(), photoAngles: ['front', 'front', 'left', 'right'] }],
    ['a free photo angle', { ...onePiece(), photoAngles: ['from the top'] }],
    ['an unknown category', { ...spec(), category: 'vanity' }],
    ['a Korean direction', { ...spec(), direction: '정면' }],
    [
      'a wall product’s back',
      { ...spec(), category: 'basin', form: 'wall-round', installation: 'wall', direction: 'back' },
    ],
    [
      'a wall-hung toilet',
      { ...spec(), category: 'toilet', form: 'two-piece', lid: 'closed', installation: 'wall' },
    ],
    ['a skirt on a one-piece toilet', { ...onePiece(), skirt: 'skirted' }],
    ['a skirt on a tankless toilet', { ...onePiece(), form: 'tankless', lid: 'closed', skirt: 'exposed' }],
    ['a skirt on a bath', { ...spec(), skirt: 'skirted' }],
    ['a colour on a bath', { ...spec(), bodyColor: 'white' }],
    [
      'a seat colour on a basin',
      { ...spec(), category: 'basin', form: 'wall-round', installation: 'wall', seatColor: 'blue' },
    ],
    ['a free colour', { ...onePiece(), bodyColor: 'gold' }],
    ['a body colour the seats have only', { ...onePiece(), bodyColor: 'pink' }],
    ['a seat colour said as the body’s', { ...onePiece(), seatColor: 'body' }],
    ['a fractional size', { ...spec(), sizeMm: [1700.5, 560, 750] }],
    ['a size below 10 mm', { ...spec(), sizeMm: [1700, 5, 750] }],
    ['a missing depth', { ...spec(), sizeMm: [1700, 560] }],
  ])('refuses %s', (_label, value) => {
    expect(directionPhotoSpecSchema.safeParse(value).success).toBe(false);
  });
});
