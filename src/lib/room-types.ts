export type RoomDimensions = { widthMm: number; depthMm: number; heightMm: number };
export type RoomDefinition = RoomDimensions & { kind: 'parametric'; version: 1 };
export type RoomFace = 'floor' | 'left' | 'back' | 'right';
export type ProductBounds = { left: number; top: number; right: number; bottom: number };
/** Position is relative to the installation face. Physical size and image bounds are snapshots. */
export type RoomPlacement = {
  face: RoomFace;
  u: number;
  v: number;
  scale: number;
  widthMm: number;
  heightMm: number;
  imageAspect: number;
  contentBounds: ProductBounds;
  /**
   * @deprecated No longer set or used (2026-10-01): the direction a product faces comes from its
   * photo's angle name (product-direction.ts). Older saved projects may still carry 'front'; it is
   * read and ignored.
   */
  facing?: 'wall' | 'front';
};
