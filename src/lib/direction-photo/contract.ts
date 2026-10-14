import { z } from 'zod';
import type { ProductDirection } from '../product-direction';
import type { MaterialInput } from '../types';

/**
 * What a direction photo is made of, shared by the guide (guide-render.ts), the prompt (prompt.ts),
 * the server route (server.ts) and the material form: the kinds that have a guide, their shapes, the
 * directions and the request's facts. Enums and numbers only.
 */

export const DIRECTION_PHOTO_CATEGORIES = ['bath', 'toilet', 'basin'] as const;
export type DirectionPhotoCategory = (typeof DIRECTION_PHOTO_CATEGORIES)[number];
export const isDirectionPhotoCategory = (value: unknown): value is DirectionPhotoCategory =>
  (DIRECTION_PHOTO_CATEGORIES as readonly unknown[]).includes(value);

/** The shapes a guide can take, per kind (the standard models' options, plus the oval bath). */
export const DIRECTION_PHOTO_FORMS = {
  bath: ['oval-freestanding', 'rectangular'],
  toilet: ['lid-closed', 'lid-open'],
  basin: ['wall-round', 'wall-rectangular', 'pedestal-round', 'pedestal-rectangular'],
} as const satisfies Record<DirectionPhotoCategory, readonly string[]>;
export type DirectionPhotoForm = (typeof DIRECTION_PHOTO_FORMS)[DirectionPhotoCategory][number];
const FORM_VALUES = Object.values(DIRECTION_PHOTO_FORMS).flat() as [
  DirectionPhotoForm,
  ...DirectionPhotoForm[],
];

/** The direction on the wire (the app's names, in the camera's words). */
export const DIRECTION_PHOTO_VIEWS = ['front', 'left', 'right', 'back'] as const;
export type DirectionPhotoView = (typeof DIRECTION_PHOTO_VIEWS)[number];
const VIEW_OF: Record<ProductDirection, DirectionPhotoView> = {
  정면: 'front',
  왼쪽: 'left',
  오른쪽: 'right',
  뒤: 'back',
};
export const directionPhotoView = (direction: ProductDirection): DirectionPhotoView => VIEW_OF[direction];

const INSTALLATIONS = [
  'floor',
  'wall',
  'embedded',
  'suspended',
] as const satisfies readonly MaterialInput['installation'][];
/** A product that stands on the floor (its back can be seen in a room; it gets a contact shadow). */
export const standsOnFloor = (installation: MaterialInput['installation']) =>
  installation === 'floor' || installation === 'embedded';

/** The sizes the route takes, in whole mm (the form checks the same before drawing a guide). */
export const DIRECTION_PHOTO_MIN_MM = 10;
export const DIRECTION_PHOTO_MAX_MM = 10000;
export const directionPhotoSizeOk = (sizeMm: readonly number[]) =>
  sizeMm.every(
    (value) =>
      Number.isFinite(value) &&
      Math.round(value) >= DIRECTION_PHOTO_MIN_MM &&
      Math.round(value) <= DIRECTION_PHOTO_MAX_MM,
  );
const mm = z.number().int().min(DIRECTION_PHOTO_MIN_MM).max(DIRECTION_PHOTO_MAX_MM);
/**
 * The request's facts: the kind and its shape, the direction, how it is installed and its size
 * (width × height × depth, mm). Nothing else, and no free text.
 */
export const directionPhotoSpecSchema = z
  .strictObject({
    category: z.enum(DIRECTION_PHOTO_CATEGORIES),
    form: z.enum(FORM_VALUES),
    direction: z.enum(DIRECTION_PHOTO_VIEWS),
    installation: z.enum(INSTALLATIONS),
    sizeMm: z.tuple([mm, mm, mm]),
  })
  .superRefine((spec, context) => {
    if (!(DIRECTION_PHOTO_FORMS[spec.category] as readonly string[]).includes(spec.form))
      context.addIssue({ code: 'custom', message: '제품 종류에 없는 형태예요.', path: ['form'] });
    // A wall product's back is against the wall: no room view shows it, so none is made.
    if (spec.direction === 'back' && !standsOnFloor(spec.installation))
      context.addIssue({
        code: 'custom',
        message: '벽에 거는 제품의 뒤 사진은 만들지 않아요.',
        path: ['direction'],
      });
    // The toilet model stands on a foot: a wall-hung toilet has no guide yet.
    if (spec.category === 'toilet' && !standsOnFloor(spec.installation))
      context.addIssue({
        code: 'custom',
        message: '벽걸이 변기는 아직 만들 수 없어요.',
        path: ['installation'],
      });
  });
export type DirectionPhotoSpec = z.infer<typeof directionPhotoSpecSchema>;
export const DIRECTION_PHOTO_MAX_SPEC_BYTES = 1024;
