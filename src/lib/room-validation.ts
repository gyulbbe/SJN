import { z } from 'zod';
export const roomFaceSchema = z.enum(['floor', 'left', 'back', 'right']);
const dimension = z.number().int().finite();
export const roomDefinitionSchema = z.object({
  kind: z.literal('parametric'),
  version: z.literal(1),
  widthMm: dimension.min(500).max(20000),
  depthMm: dimension.min(500).max(20000),
  heightMm: dimension.min(1000).max(6000),
});
const unit = z.number().finite().min(0).max(1);
export const roomPlacementSchema = z.object({
  face: roomFaceSchema,
  u: unit,
  v: unit,
  scale: z.number().finite().min(0.1).max(5),
  widthMm: z.number().finite().positive().max(100000),
  heightMm: z.number().finite().positive().max(100000),
  imageAspect: z.number().finite().positive().max(100000),
  contentBounds: z
    .object({ left: unit, top: unit, right: unit, bottom: unit })
    .refine((b) => b.right > b.left && b.bottom > b.top, '제품 이미지 영역을 확인해 주세요.'),
});
