import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { estimateUprightQuaternion } from '../src/lib/product3d/upright';
import { boxSurfacePoints, icosphere } from './helpers/product3d-meshes';

const tilt = (pitch: number, roll: number, yaw = 0) =>
  new Quaternion()
    .setFromAxisAngle(new Vector3(0, 0, 1), (yaw * Math.PI) / 180)
    .multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), (pitch * Math.PI) / 180))
    .multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), (roll * Math.PI) / 180));
const rotate = (points: Float32Array, rotation: Quaternion) => {
  const out = new Float32Array(points.length);
  const v = new Vector3();
  for (let i = 0; i < points.length; i += 3) {
    v.set(points[i], points[i + 1], points[i + 2]).applyQuaternion(rotation);
    out.set([v.x, v.y, v.z], i);
  }
  return out;
};
const degrees = (radians: number) => (radians * 180) / Math.PI;
const upError = (correction: Quaternion, tilted: Quaternion) =>
  degrees(
    new Vector3(0, 0, 1).applyQuaternion(correction.clone().multiply(tilted)).angleTo(new Vector3(0, 0, 1)),
  );

describe('product3d upright estimate', () => {
  // A toilet-like box: deeper than wide, taller than both.
  const box = boxSurfacePoints([0.7, 0.4, 0.8]);

  it('stands a tilted box back up within one degree', () => {
    for (const [pitch, roll] of [
      [12, -7],
      [-9, 4],
      [0, 15],
    ]) {
      const tilted = tilt(pitch, roll);
      const correction = new Quaternion(...estimateUprightQuaternion(rotate(box, tilted)));
      expect(upError(correction, tilted)).toBeLessThan(1);
    }
  });

  it('keeps the facing direction: only pitch and roll are corrected', () => {
    const tilted = tilt(10, -6, 20);
    const correction = new Quaternion(...estimateUprightQuaternion(rotate(box, tilted)));
    const facing = new Vector3(1, 0, 0).applyQuaternion(correction);
    expect(degrees(Math.atan2(facing.y, facing.x))).toBeCloseTo(0, 0);
    expect(upError(correction, tilted)).toBeLessThan(1.5);
  });

  it('never rotates more than the allowed range', () => {
    const correction = new Quaternion(...estimateUprightQuaternion(rotate(box, tilt(40, 0))));
    const angle = degrees(2 * Math.acos(Math.min(1, Math.abs(correction.w))));
    expect(angle).toBeLessThanOrEqual(25 + 0.5);
  });

  it('leaves upright boxes and round shapes as reconstructed', () => {
    expect(estimateUprightQuaternion(box)).toEqual([0, 0, 0, 1]);
    expect(estimateUprightQuaternion(icosphere(3).positions)).toEqual([0, 0, 0, 1]);
  });
});
