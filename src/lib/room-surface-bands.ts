import type { Surface } from './types';
import { homography, inverseHomography, transformPoint } from './render/math';
/** A wall's material band shares the complete wall's mm coordinates and perspective. */
export function applyRoomSurfaceBand(surface: Surface, band?: Surface['reconstructionBand']): Surface {
  if (!band) return surface;
  if (
    surface.kind !== 'wall' ||
    !Number.isFinite(band.from) ||
    !Number.isFinite(band.to) ||
    band.from < 0 ||
    band.to > 1 ||
    band.from >= band.to
  )
    throw new Error('벽의 높이 구간을 확인해 주세요.');
  const forward = inverseHomography(homography(surface.quad));
  return {
    ...surface,
    reconstructionBand: { ...band },
    mask: {
      polygon: [
        { x: 0, y: band.from },
        { x: 1, y: band.from },
        { x: 1, y: band.to },
        { x: 0, y: band.to },
      ].map((p) => transformPoint(forward, p)),
      strokes: [],
    },
  };
}
