import type { ProductBounds } from './room-types';
import { viewDirection } from './product-direction';

/**
 * How big a product photo is drawn in a room (docs/product-scale-results-20261024.md). The 3D room
 * (room-viewer/fixtures.ts photoPlaneSize) and the 2D editor (room-fixtures.ts projectRoomFixture)
 * both use it, so a product is the same size in both.
 *
 * The photo's visible area (`bounds`) is drawn at the registered height, and across it follows the
 * photo's own proportions (2026-10-24, the user's choice). Until then it was fitted into width ×
 * height (depth × height for a side photo, the width when there was no depth): a photo wider than
 * that box (taken at an angle) came out lower than the product, a smart toilet's 정면 at 82%, a side
 * photo without a depth at about 60%. Never smaller than before: the old fit was the smaller of this
 * and the width fit.
 */
export type PhotoAcross = {
  /** What the photo shows across: the width (정면·뒤) or the depth (옆). */
  across: 'width' | 'depth';
  /** A side photo of a material without a depth (the room uses half the width as the depth). */
  estimated: boolean;
};

/** What a photo of `direction` (a stored angle name; a retired or unknown one reads as 정면) shows across. */
export function photoAcross(direction: unknown, depthMm: number | undefined): PhotoAcross {
  const name = viewDirection(direction) ?? '정면';
  if (name !== '왼쪽' && name !== '오른쪽') return { across: 'width', estimated: false };
  const known = typeof depthMm === 'number' && Number.isFinite(depthMm) && depthMm > 0;
  return { across: 'depth', estimated: !known };
}

/** The whole picture's width (in the unit of `height`) when its visible area is `height` tall. */
export function fitPhotoWidth(height: number, bounds: ProductBounds, aspect: number): number {
  return (height * aspect) / (bounds.bottom - bounds.top);
}
