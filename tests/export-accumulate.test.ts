import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import { exportJitter, halton, jitterProjection } from '../src/lib/room-viewer/accumulate';

describe('export sample offsets', () => {
  it('follow the fixed Halton sequence', () => {
    expect([1, 2, 3, 4].map((i) => halton(i, 2))).toEqual([0.5, 0.25, 0.75, 0.125]);
    expect([1, 2, 3].map((i) => halton(i, 3))).toEqual([1 / 3, 2 / 3, 1 / 9]);
    expect(exportJitter(5)).toEqual(exportJitter(5));
    // The first sample is the plain frame, so a one-sample export matches it.
    expect(exportJitter(0)).toEqual({ camera: [0, 0], light: [0, 0] });
  });

  it('stay inside one pixel and the light panel, spread over every quadrant', () => {
    const quadrants = new Set<string>();
    for (let k = 0; k < 32; k++) {
      const { camera, light } = exportJitter(k);
      for (const value of [...camera, ...light]) {
        expect(value).toBeGreaterThanOrEqual(-0.5);
        expect(value).toBeLessThan(0.5);
      }
      const side = (value: number) => (value < 0 ? '-' : '+');
      quadrants.add(`camera${side(camera[0])}${side(camera[1])}`);
      quadrants.add(`light${side(light[0])}${side(light[1])}`);
    }
    expect(quadrants.size).toBe(8);
    // The camera and light offsets use different bases, so they do not move together.
    expect(exportJitter(1).camera).not.toEqual(exportJitter(1).light);
  });

  it('moves the image by a sub-pixel without moving the camera', () => {
    const camera = new PerspectiveCamera(50, 1.5, 10, 10000);
    camera.position.set(0, 1500, 3000);
    camera.updateMatrixWorld(true);
    const point = new Vector3(300, 1200, 0);
    const before = point.clone().project(camera);
    jitterProjection(camera, 0.5, -0.25, 1200, 800);
    const after = point.clone().project(camera);
    expect(((after.x - before.x) * 1200) / 2).toBeCloseTo(0.5, 6);
    expect(((after.y - before.y) * 800) / 2).toBeCloseTo(-0.25, 6);
    expect(camera.position.toArray()).toEqual([0, 1500, 3000]);
    // The inverse follows, so unprojection stays consistent.
    expect(after.clone().unproject(camera).distanceTo(point)).toBeLessThan(1e-6);
  });
});
