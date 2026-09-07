import { DEFAULT_COLOR, DEFAULT_TILE, type Point, type Quad, type Surface } from './types';

export const BASE_ROOM_IMAGE = '/backgrounds/empty-room.png';

// Authored only for the bundled 1536 × 1024 empty room, never used to detect a user's photo.
const point = (x: number, y: number): Point => ({ x: x / 1536, y: y / 1024 });
const backTopLeft = point(306, 94);
const backTopRight = point(1233, 94);
const backBottomLeft = point(306, 718);
const backBottomRight = point(1233, 718);
const frontBottomLeft = point(0, 877);
const frontBottomRight = point(1536, 878);
const roomHeightMm = 2400;
const visibleDepthMm = 1600;
const wallReferenceFraction = 0.25;

/** Fresh editable planes with estimated dimensions; no product or material is pre-applied. */
export function createBaseRoomSurfaces(): Surface[] {
  const surface = (
    name: string,
    kind: Surface['kind'],
    polygon: Point[],
    quad: Quad,
    widthMm: number,
    heightMm: number,
    offsetY = 0,
  ): Surface => ({
    id: crypto.randomUUID(),
    name,
    kind,
    mask: { polygon: polygon.map((p) => ({ ...p })), strokes: [] },
    quad: quad.map((p) => ({ ...p })) as Quad,
    widthMm,
    heightMm,
    calibrated: false,
    tile: { ...DEFAULT_TILE, shading: kind === 'wall' ? 0.55 : 0.4, offsetY },
    color: { ...DEFAULT_COLOR },
  });

  // Side ceilings extend above the photograph. A lower, shared physical reference row
  // keeps all perspective handles inside the image; masks and the texture extend above it.
  const leftCeilingAtFrame = -(94 * 198) / (306 - 198);
  const rightCeilingAtFrame = -(94 * (1536 - 1338)) / (1338 - 1233);
  const referenceY = 94 + (718 - 94) * wallReferenceFraction;
  const leftReferenceY = leftCeilingAtFrame + (877 - leftCeilingAtFrame) * wallReferenceFraction;
  const rightReferenceY = rightCeilingAtFrame + (878 - rightCeilingAtFrame) * wallReferenceFraction;
  const sideHeight = roomHeightMm * (1 - wallReferenceFraction);
  const sideOffset = -roomHeightMm * wallReferenceFraction;

  return [
    surface(
      '바닥',
      'floor',
      [backBottomLeft, backBottomRight, frontBottomRight, point(1536, 1024), point(0, 1024), frontBottomLeft],
      [backBottomLeft, backBottomRight, frontBottomRight, frontBottomLeft],
      3600,
      visibleDepthMm,
    ),
    surface(
      '왼쪽 벽',
      'wall',
      [point(0, 0), point(198, 0), backTopLeft, backBottomLeft, frontBottomLeft],
      [point(0, leftReferenceY), point(306, referenceY), backBottomLeft, frontBottomLeft],
      visibleDepthMm,
      sideHeight,
      sideOffset,
    ),
    surface(
      '정면 벽',
      'wall',
      [backTopLeft, backTopRight, backBottomRight, backBottomLeft],
      [backTopLeft, backTopRight, backBottomRight, backBottomLeft],
      3600,
      roomHeightMm,
    ),
    surface(
      '오른쪽 벽',
      'wall',
      [point(1338, 0), point(1536, 0), frontBottomRight, backBottomRight, backTopRight],
      [point(1233, referenceY), point(1536, rightReferenceY), frontBottomRight, backBottomRight],
      visibleDepthMm,
      sideHeight,
      sideOffset,
    ),
  ];
}
