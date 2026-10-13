import { describe, expect, it } from 'vitest';
import { buildDirectionPhotoPrompt, hiddenParts } from '../src/lib/direction-photo/prompt';
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
      form: 'lid-closed',
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
      buildDirectionPhotoPrompt(spec({ category: 'toilet', form: 'lid-open', sizeMm: [380, 760, 700] }), 1),
    ).toContain(
      'In this view the back of the tank, the waste pipe and the water in the bowl are not visible; do not draw them.',
    );
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

  it('gives the same text for the same spec, and none of it comes from the person', () => {
    expect(buildDirectionPhotoPrompt(spec({ direction: 'left' }), 2)).toBe(
      buildDirectionPhotoPrompt(spec({ direction: 'left' }), 2),
    );
    expect(buildDirectionPhotoPrompt(spec(), 1).length).toBeLessThan(2000);
  });

  it.each([
    ['an unknown field', { ...spec(), note: 'make it gold' }],
    ['a free form', { ...spec(), form: 'a golden tub' }],
    ['a form of another kind', { ...spec(), form: 'lid-closed' }],
    ['an unknown category', { ...spec(), category: 'vanity' }],
    ['a Korean direction', { ...spec(), direction: '정면' }],
    [
      'a wall product’s back',
      { ...spec(), category: 'basin', form: 'wall-round', installation: 'wall', direction: 'back' },
    ],
    ['a wall-hung toilet', { ...spec(), category: 'toilet', form: 'lid-closed', installation: 'wall' }],
    ['a fractional size', { ...spec(), sizeMm: [1700.5, 560, 750] }],
    ['a size below 10 mm', { ...spec(), sizeMm: [1700, 5, 750] }],
    ['a missing depth', { ...spec(), sizeMm: [1700, 560] }],
  ])('refuses %s', (_label, value) => {
    expect(directionPhotoSpecSchema.safeParse(value).success).toBe(false);
  });
});
