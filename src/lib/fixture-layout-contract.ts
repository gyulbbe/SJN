import { z } from 'zod';
import { publicPlacementSchema, type PublicPlacement } from './catalog/placement-contract';
import { roomFaceSchema } from './room-validation';

/**
 * 기본 배치 as stored and sent (migration 0013, docs/fixture-layouts-results-20261101.md): the place of
 * each product on a face of the room it was registered in. Material ids, not version ids: a press
 * places the current version. What drawing makes again (occlusion, position, projectedQuad, id,
 * locked) is not here. No geometry code: the server reads this too.
 */
export const MAX_FIXTURE_LAYOUTS = 30;
export const MAX_LAYOUT_ITEMS = 20;

const unit = z.number().finite().min(0).max(1);
const bounded = (min: number, max: number) => z.number().finite().min(min).max(max);
export const layoutItemSchema = z
  .object({
    materialId: z.string().uuid(),
    face: roomFaceSchema,
    u: unit,
    v: unit,
    scale: bounded(0.1, 5),
    againstWall: z.literal(true).optional(),
    rotation: bounded(-36000, 36000),
    /** The photo's angle name: a product against a wall faces away from that wall by it. */
    direction: z.string().max(200),
    // The bounds a saved fixture has (storage/validation.ts).
    color: z
      .object({
        exposure: bounded(-8, 8),
        contrast: bounded(0, 4),
        saturation: bounded(0, 4),
        warmth: bounded(-2, 2),
      })
      .strict(),
    shadow: z
      .object({
        x: bounded(-10, 10),
        y: bounded(-10, 10),
        opacity: bounded(0, 1),
        blur: bounded(0, 1),
        scale: bounded(0, 10),
      })
      .strict(),
  })
  .strict();
export type LayoutItem = z.infer<typeof layoutItemSchema>;

export const layoutRoomSchema = z
  .object({
    widthMm: bounded(500, 20000),
    depthMm: bounded(500, 20000),
    heightMm: bounded(1000, 6000),
  })
  .strict();
export type LayoutRoom = z.infer<typeof layoutRoomSchema>;

export const layoutItemsSchema = z.array(layoutItemSchema).min(1).max(MAX_LAYOUT_ITEMS);
export const layoutNameSchema = z.string().trim().min(1).max(100);
/** 표시 순서: a whole number 0–9999, or null for none (then by name). */
export const layoutOrderSchema = z.number().int().min(0).max(9999).nullable();

/** One layout as anyone reads it. `missing`: its products that can no longer be placed (left out of `items`). */
export const publicLayoutSchema = z
  .object({
    id: z.string().uuid(),
    name: layoutNameSchema,
    room: layoutRoomSchema,
    items: layoutItemsSchema,
    missing: z.number().int().min(0),
  })
  .strict();
export type PublicLayout = z.infer<typeof publicLayoutSchema>;

/** GET /api/catalog/layouts: the layouts in order, and what is needed to place their products. */
export const publicLayoutsSchema = z
  .object({ layouts: z.array(publicLayoutSchema), placements: z.array(publicPlacementSchema) })
  .strict();
export type PublicLayouts = z.infer<typeof publicLayoutsSchema>;

/** One layout as an administrator manages it: hidden ones too, and which products have gone. */
export type ManagedLayout = {
  id: string;
  name: string;
  sortOrder: number | null;
  active: boolean;
  revision: number;
  room: LayoutRoom;
  items: LayoutItem[];
  /** The name of each product still public, in order. */
  products: string[];
  missing: number;
};
/** An administrator's list, with what is needed to open a layout (a hidden one too). */
export type ManagedLayouts = { layouts: ManagedLayout[]; placements: PublicPlacement[] };
