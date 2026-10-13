import { directionAngle, type ProductDirection } from '../product-direction';
import { FLUX_INPUT_EDGE } from '../ai-export/contract';

/**
 * Where the guide's camera stands for each direction, and how big the guide is.
 *
 * The product model faces +z (its front; the toilet's tank, the basin's and the bath's taps are at
 * −z). A photo's name is the way the product faces in it (product-direction.ts): 정면 faces the
 * camera, 왼쪽 faces the room's −x, so a camera in front of the room sees its front pointing to the
 * picture's left and its own left side. Turned so that the product faces +z, that camera stands at
 * the product's +x: the camera's azimuth is minus the direction's angle (정면 0°, 왼쪽 +90°,
 * 오른쪽 −90°, 뒤 180°), measured from +z towards +x. The 2026-10-13 trial renderer put its 왼쪽
 * camera at +x (90°) too.
 */

/** How far above level the guide's camera looks down (the trial's value; see the docs). */
export const GUIDE_ELEVATION_DEGREES = 10;

export type Vec3 = [number, number, number];
export type GuideCamera = {
  azimuthDegrees: number;
  elevationDegrees: number;
  /** Unit vector from the product to the camera. */
  toCamera: Vec3;
  /** The picture's right and up, as unit vectors in the product's frame. */
  right: Vec3;
  up: Vec3;
};

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const unit = (a: Vec3): Vec3 => {
  const length = Math.hypot(...a) || 1;
  return [a[0] / length, a[1] / length, a[2] / length];
};

/** The camera's azimuth for a direction (degrees, −180 < a ≤ 180). */
export function guideAzimuth(direction: ProductDirection): number {
  const a = -directionAngle(direction);
  return a <= -180 ? a + 360 : a > 180 ? a - 360 : a + 0;
}

export function guideCamera(
  direction: ProductDirection,
  elevationDegrees = GUIDE_ELEVATION_DEGREES,
): GuideCamera {
  const azimuth = (guideAzimuth(direction) * Math.PI) / 180,
    elevation = (elevationDegrees * Math.PI) / 180;
  const toCamera: Vec3 = [
    Math.sin(azimuth) * Math.cos(elevation),
    Math.sin(elevation),
    Math.cos(azimuth) * Math.cos(elevation),
  ];
  const forward: Vec3 = [-toCamera[0], -toCamera[1], -toCamera[2]];
  const right = unit(cross(forward, [0, 1, 0]));
  return {
    azimuthDegrees: guideAzimuth(direction),
    elevationDegrees,
    toCamera,
    right,
    up: cross(right, forward),
  };
}

/** A point of the product (mm, product frame) on the picture: x to the right, y up (orthographic). */
export function projectGuidePoint(camera: GuideCamera, point: Vec3): [number, number] {
  return [dot(point, camera.right), dot(point, camera.up)];
}

/**
 * The picture's width and height (mm) of a box of the product's size seen by the guide's camera:
 * the face it looks at, plus the top the elevation shows. The model's own outline is at most this.
 */
export function guideBoxExtent(
  sizeMm: readonly [number, number, number],
  direction: ProductDirection,
  elevationDegrees = GUIDE_ELEVATION_DEGREES,
): { width: number; height: number } {
  const [w, h, d] = sizeMm;
  const e = (elevationDegrees * Math.PI) / 180;
  const side = direction === '왼쪽' || direction === '오른쪽';
  return {
    width: side ? d : w,
    height: h * Math.cos(e) + (side ? w : d) * Math.sin(e),
  };
}

const step16 = (value: number) => Math.round(value / 16) * 16;
/**
 * The guide's size in pixels for an outline of this aspect: the long side FLUX's 496, the other in
 * 16 px steps (at least 128), so the model takes it as it is and answers twice as large.
 */
export function guideSize(extent: { width: number; height: number }): { width: number; height: number } {
  const aspect = extent.width / extent.height;
  if (!(aspect > 0) || !Number.isFinite(aspect)) throw new Error('가이드 크기를 계산할 수 없어요.');
  const short = (long: number) => Math.max(128, Math.min(FLUX_INPUT_EDGE, step16(long)));
  return aspect >= 1
    ? { width: FLUX_INPUT_EDGE, height: short(FLUX_INPUT_EDGE / aspect) }
    : { width: short(FLUX_INPUT_EDGE * aspect), height: FLUX_INPUT_EDGE };
}

/**
 * How large the room draws the product from this photo, as a share of its registered size: the
 * room fits the photo's outline, keeping its ratio, inside width × height (정면·뒤) or depth × height
 * (왼쪽·오른쪽) (photoPlaneSize). The top the camera sees makes the outline taller than the product,
 * so the product comes out smaller: 1 when nothing shows above, 0.82 for a 560 mm high, 750 mm deep
 * box from the front at 10°.
 */
export function planeShare(
  sizeMm: readonly [number, number, number],
  direction: ProductDirection,
  outline: { width: number; height: number },
): number {
  const [w, h, d] = sizeMm;
  const plane = direction === '왼쪽' || direction === '오른쪽' ? d : w;
  return Math.min(1, plane / outline.width, h / outline.height);
}
