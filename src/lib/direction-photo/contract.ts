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

/**
 * The shapes a guide can take, per kind (the standard models' options, plus the oval bath and the
 * toilet's one-piece and tankless bodies). A toilet's form is its body; its lid is said apart (lid).
 * The 2026-10-15 trial: the model draws the guide's shape, so a two-piece guide turned a one-piece or
 * a tankless toilet into a two-piece one (docs/direction-photo-results-20261013.md).
 */
export const DIRECTION_PHOTO_FORMS = {
  bath: ['oval-freestanding', 'rectangular'],
  toilet: ['two-piece', 'one-piece', 'tankless'],
  basin: ['wall-round', 'wall-rectangular', 'pedestal-round', 'pedestal-rectangular'],
} as const satisfies Record<DirectionPhotoCategory, readonly string[]>;
export type DirectionPhotoForm = (typeof DIRECTION_PHOTO_FORMS)[DirectionPhotoCategory][number];
const FORM_VALUES = Object.values(DIRECTION_PHOTO_FORMS).flat() as [
  DirectionPhotoForm,
  ...DirectionPhotoForm[],
];

/** A toilet's lid: closed, open, or a seat alone (no lid). */
export const DIRECTION_PHOTO_LIDS = ['closed', 'open', 'seat'] as const;
export type DirectionPhotoLid = (typeof DIRECTION_PHOTO_LIDS)[number];
/** The lids a toilet body can show: a tankless toilet's open lid would stand above its seat unit. */
export const toiletLids = (form: DirectionPhotoForm): readonly DirectionPhotoLid[] =>
  form === 'tankless' ? ['closed', 'seat'] : DIRECTION_PHOTO_LIDS;

/**
 * Where each photo was taken from, said as the slots name a photo: the way the product's front points
 * in it (front-right: between 정면 and 오른쪽, the product's front and right side seen). Asked only for
 * a one-piece or tankless toilet (photoAngleTold): with a guide shaped like the product the model
 * copied the photo's angle in 9 of 10 answers, and the sentence brought the view back; the bath's
 * guide held its view without it and lost it with it (4 of 4 answers, 2026-10-15).
 */
export const DIRECTION_PHOTO_PHOTO_ANGLES = [
  'unknown',
  'front',
  'front-right',
  'front-left',
  'right',
  'left',
] as const;
export type DirectionPhotoPhotoAngle = (typeof DIRECTION_PHOTO_PHOTO_ANGLES)[number];
/** Whether the photos' angles are asked for and told to the model: a toilet shaped like the product. */
export const photoAngleTold = (category: DirectionPhotoCategory, form: DirectionPhotoForm) =>
  category === 'toilet' && form !== 'two-piece';

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
 * The request's facts: the kind and its shape (a toilet's lid too), the direction, how it is
 * installed, its size (width × height × depth, mm) and, for a one-piece or tankless toilet only,
 * where each photo was taken from in the photos' order. Nothing else, and no free text.
 */
export const directionPhotoSpecSchema = z
  .strictObject({
    category: z.enum(DIRECTION_PHOTO_CATEGORIES),
    form: z.enum(FORM_VALUES),
    lid: z.enum(DIRECTION_PHOTO_LIDS).optional(),
    direction: z.enum(DIRECTION_PHOTO_VIEWS),
    installation: z.enum(INSTALLATIONS),
    sizeMm: z.tuple([mm, mm, mm]),
    photoAngles: z.array(z.enum(DIRECTION_PHOTO_PHOTO_ANGLES)).min(1).max(3).optional(),
  })
  .superRefine((spec, context) => {
    if (!(DIRECTION_PHOTO_FORMS[spec.category] as readonly string[]).includes(spec.form))
      context.addIssue({ code: 'custom', message: '제품 종류에 없는 형태예요.', path: ['form'] });
    if (spec.category === 'toilet' ? !spec.lid : spec.lid)
      context.addIssue({ code: 'custom', message: '뚜껑은 변기에만 정해요.', path: ['lid'] });
    if (photoAngleTold(spec.category, spec.form) ? !spec.photoAngles : spec.photoAngles)
      context.addIssue({
        code: 'custom',
        message: '찍은 각도는 일체형·비데 일체형 변기에만 보내요.',
        path: ['photoAngles'],
      });
    if (spec.category === 'toilet' && spec.lid && !toiletLids(spec.form).includes(spec.lid))
      context.addIssue({ code: 'custom', message: '이 몸통에 없는 뚜껑이에요.', path: ['lid'] });
    // A toilet stands against the wall, and its back came out as its front in nearly every trial.
    if (spec.category === 'toilet' && spec.direction === 'back')
      context.addIssue({ code: 'custom', message: '변기는 뒤 사진을 만들지 않아요.', path: ['direction'] });
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
