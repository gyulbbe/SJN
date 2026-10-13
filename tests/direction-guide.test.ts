import { describe, expect, it } from 'vitest';
import { directionAngle, PRODUCT_DIRECTIONS, type ProductDirection } from '../src/lib/product-direction';
import {
  GUIDE_ELEVATION_DEGREES,
  guideAzimuth,
  guideBoxExtent,
  guideCamera,
  guideSize,
  planeShare,
  projectGuidePoint,
  type Vec3,
} from '../src/lib/direction-photo/guide-geometry';

const BATH: [number, number, number] = [1700, 560, 750];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
/** The product model faces +z: its front is +z, up is +y, so its own right hand is −x and its left +x. */
const FRONT: Vec3 = [0, 280, 375],
  BACK: Vec3 = [0, 280, -375],
  LEFT_SIDE: Vec3 = [1, 0, 0];
/** A point of the product turned to face `direction` in the room (directionAngle, +z towards +x). */
function turned(point: Vec3, direction: ProductDirection): Vec3 {
  const a = (directionAngle(direction) * Math.PI) / 180;
  return [
    point[0] * Math.cos(a) + point[2] * Math.sin(a),
    point[1],
    -point[0] * Math.sin(a) + point[2] * Math.cos(a),
  ];
}

describe('guide camera and the direction names', () => {
  it('stands opposite the way the product faces: 정면 +z, 왼쪽 +x, 오른쪽 −x, 뒤 −z', () => {
    expect(PRODUCT_DIRECTIONS.map(guideAzimuth)).toEqual([0, 90, -90, 180]);
    const at = (direction: ProductDirection) => guideCamera(direction).toCamera;
    expect(at('정면')[2]).toBeGreaterThan(0.98);
    expect(at('왼쪽')[0]).toBeGreaterThan(0.98);
    expect(at('오른쪽')[0]).toBeLessThan(-0.98);
    expect(at('뒤')[2]).toBeLessThan(-0.98);
    for (const direction of PRODUCT_DIRECTIONS) {
      const camera = guideCamera(direction);
      expect(camera.elevationDegrees).toBe(GUIDE_ELEVATION_DEGREES);
      expect(camera.toCamera[1]).toBeCloseTo(Math.sin((10 * Math.PI) / 180), 6);
      // Upright: the picture's up leans towards +y, its right stays level.
      expect(camera.up[1]).toBeGreaterThan(0.98);
      expect(camera.right[1]).toBeCloseTo(0, 9);
    }
  });

  it('왼쪽: the front points to the picture’s left and the camera sees the product’s left side', () => {
    const camera = guideCamera('왼쪽');
    expect(projectGuidePoint(camera, FRONT)[0]).toBeLessThan(-300);
    expect(projectGuidePoint(camera, BACK)[0]).toBeGreaterThan(300);
    expect(dot(camera.toCamera, LEFT_SIDE)).toBeGreaterThan(0.98);
  });

  it('오른쪽: the front points to the picture’s right and the camera sees the product’s right side', () => {
    const camera = guideCamera('오른쪽');
    expect(projectGuidePoint(camera, FRONT)[0]).toBeGreaterThan(300);
    expect(projectGuidePoint(camera, BACK)[0]).toBeLessThan(-300);
    expect(dot(camera.toCamera, [-1, 0, 0])).toBeGreaterThan(0.98);
  });

  it('정면 shows the front nearest the camera, 뒤 the back', () => {
    for (const [direction, near, far] of [
      ['정면', FRONT, BACK],
      ['뒤', BACK, FRONT],
    ] as const) {
      const camera = guideCamera(direction);
      expect(dot(near, camera.toCamera)).toBeGreaterThan(dot(far, camera.toCamera));
      expect(projectGuidePoint(camera, near)[0]).toBeCloseTo(0, 6);
    }
  });

  it('draws the product as the room shows its photo of that name from the front of the room', () => {
    // The room turns a product with a 왼쪽 photo to face −x and looks at it from +z: the guide of 왼쪽
    // must be that picture (orthographic, so equal coordinates).
    const front = guideCamera('정면');
    const points: Vec3[] = [FRONT, BACK, [850, 0, 375], [-850, 560, -375], [300, 120, -90]];
    for (const direction of PRODUCT_DIRECTIONS) {
      const camera = guideCamera(direction);
      for (const point of points) {
        const [x, y] = projectGuidePoint(camera, point);
        const [rx, ry] = projectGuidePoint(front, turned(point, direction));
        expect(x).toBeCloseTo(rx, 6);
        expect(y).toBeCloseTo(ry, 6);
      }
    }
  });
});

describe('guide size and how large the room draws it', () => {
  it('is the face plus the top seen from 10° above', () => {
    const front = guideBoxExtent(BATH, '정면');
    expect(front.width).toBe(1700);
    expect(front.height).toBeCloseTo(560 * Math.cos(Math.PI / 18) + 750 * Math.sin(Math.PI / 18), 6);
    const left = guideBoxExtent(BATH, '왼쪽');
    expect(left.width).toBe(750);
    expect(left.height).toBeCloseTo(560 * Math.cos(Math.PI / 18) + 1700 * Math.sin(Math.PI / 18), 6);
    expect(guideBoxExtent(BATH, '뒤')).toEqual(front);
    expect(guideBoxExtent(BATH, '오른쪽')).toEqual(left);
  });

  it('has a long side of 496 and 16 px steps, keeping the ratio (a 1700 × 560 × 750 box: 496×192 and 432×496)', () => {
    expect(guideSize(guideBoxExtent(BATH, '정면'))).toEqual({ width: 496, height: 192 });
    expect(guideSize(guideBoxExtent(BATH, '왼쪽'))).toEqual({ width: 432, height: 496 });
    for (const extent of [
      { width: 400, height: 1000 },
      { width: 1000, height: 999 },
      { width: 5000, height: 100 },
      { width: 100, height: 5000 },
    ]) {
      const size = guideSize(extent);
      expect(Math.max(size.width, size.height)).toBe(496);
      expect(Math.min(size.width, size.height)).toBeGreaterThanOrEqual(128);
      expect(size.width % 16).toBe(0);
      expect(size.height % 16).toBe(0);
    }
    expect(guideSize({ width: 5000, height: 100 })).toEqual({ width: 496, height: 128 });
    expect(() => guideSize({ width: 0, height: 0 })).toThrow();
  });

  it('draws the product smaller by the top it shows (a 560 × 750 mm box: 18% from the front, 34% from the end)', () => {
    expect(planeShare(BATH, '정면', guideBoxExtent(BATH, '정면'))).toBeCloseTo(0.821, 3);
    expect(planeShare(BATH, '왼쪽', guideBoxExtent(BATH, '왼쪽'))).toBeCloseTo(0.661, 3);
    expect(planeShare(BATH, '정면', guideBoxExtent(BATH, '정면', 0))).toBe(1);
  });
});
