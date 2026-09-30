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
   * Which way a product on the left or right wall faces in the 3D room (the space viewer and the AI
   * export). Absent (or 'wall'): into the room, as before. 'front': towards the open front, fixed
   * to the room, so it does not follow the camera. Only written when 'front'; the 2D editor draws
   * the product the same either way.
   */
  facing?: ProductFacing;
};
export type ProductFacing = 'wall' | 'front';
