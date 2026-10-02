import { describe, expect, it } from 'vitest';
import { estimateFront, estimateSymmetry, mirrorError, symmetrize } from '../src/lib/product3d/symmetry';
import { shadingNormals } from '../src/lib/product3d/mesh-cleanup';
import { gridBox, icosphere, mergeMeshes } from './helpers/product3d-meshes';
import {
  around,
  degrees,
  lineGap,
  placed,
  radians,
  roundPoints,
  toilet,
} from './helpers/product3d-fit-shapes';

describe('estimateSymmetry: the mirror plane of a product', () => {
  it('finds the plane of a toilet-like shape at any turn and shift, within 2.5°', () => {
    for (const yaw of [0, 37, 90, 123, 171]) {
      const mesh = placed(toilet(), yaw, [0.3, -0.2, 0.1]);
      const found = estimateSymmetry(mesh.positions);
      expect(found, `yaw ${yaw}`).toBeDefined();
      // The product's y axis, turned by `yaw`, is the plane's normal.
      expect(lineGap(found!.normal, radians(yaw + 90)), `yaw ${yaw}`).toBeLessThan(2.5);
      expect(found!.error).toBeLessThan(0.01);
      expect(found!.dominance).toBeGreaterThan(1.8);
      // The plane runs through the middle of the product: its distance from the shape's own y = 0.
      const nx = Math.cos(found!.normal),
        ny = Math.sin(found!.normal);
      const centre = 0.3 * nx - 0.2 * ny;
      expect(Math.abs(Math.abs(found!.offset) - Math.abs(centre))).toBeLessThan(0.02);
    }
  });

  it('says nothing for a round, a lopsided or a nearly empty shape', () => {
    expect(estimateSymmetry(roundPoints().positions)).toBeUndefined();
    // A body with a heavy, different lump on one side only.
    const lopsided = mergeMeshes(
      gridBox([0, 0, 0], [0.7, 0.4, 0.2], 18),
      gridBox([0.05, 0.3, 0.2], [0.3, 0.9, 0.7], 18),
      gridBox([0.5, -0.4, 0.2], [0.65, 0.1, 1.0], 18),
    );
    expect(estimateSymmetry(lopsided.positions)).toBeUndefined();
    expect(estimateSymmetry(new Float32Array(30))).toBeUndefined();
  });

  it('marks a rectangular box as symmetric both ways and offers the other plane', () => {
    const box = placed(gridBox([0, -0.2, 0], [1.2, 0.2, 0.5], 24), 25, [0, 0, 0]);
    const found = estimateSymmetry(box.positions);
    expect(found?.twofold).toBe(true);
    expect(found?.partner).toBeDefined();
    expect(lineGap(found!.partner!.normal, found!.normal + Math.PI / 2)).toBeLessThan(2);
  });
});

describe('estimateFront: which way along the plane the front points', () => {
  const mesh = placed(toilet(), 40, [0, 0, 0]);
  const plane = estimateSymmetry(mesh.positions)!;
  // The tank is at the product's +x, so its front is −x turned by 40°.
  const truth = 40 + 180;

  it('takes the low end (no tank) for the front, and agrees when the photo came from there', () => {
    const photo = estimateFront(mesh.positions, plane, radians(truth + 30));
    expect(around(degrees(photo.front), truth)).toBeLessThan(1.5);
    expect(photo.uncertain).toBe(false);
  });

  it('keeps the height cue when the photo seems to come from the other end, and says so', () => {
    const photo = estimateFront(mesh.positions, plane, radians(truth + 180 - 20));
    expect(around(degrees(photo.front), truth)).toBeLessThan(1.5);
    expect(photo.uncertain).toBe(true);
  });

  it('follows the photo when the two ends are alike', () => {
    const box = placed(gridBox([0, -0.2, 0], [1.2, 0.2, 0.5], 24), 25, [0, 0, 0]);
    const found = estimateSymmetry(box.positions)!;
    const front = estimateFront(box.positions, found, radians(100));
    expect(Math.cos(front.front - radians(100))).toBeGreaterThan(0);
    expect(front.uncertain).toBe(false);
  });
});

describe('symmetrize: evening out the lopsidedness about the plane', () => {
  it('brings the surface and its mirror image closer, and leaves a one-sided part alone', () => {
    const ball = icosphere(5);
    // An ellipsoid, one side pushed out a little (a dent of lumpiness the mirror image does not have).
    const lumpy = new Float32Array(ball.positions.length);
    for (let i = 0; i < lumpy.length; i += 3) {
      const [x, y, z] = [ball.positions[i], ball.positions[i + 1], ball.positions[i + 2]];
      const push = y > 0 ? 1 + 0.05 * Math.exp(-((x - 0.3) ** 2 + z * z) * 6) : 1;
      lumpy.set([x * 0.6 * push, y * push, z * 0.8 * push], i);
    }
    // A tap on one side: a small box floating off the +y side.
    const tap = gridBox([-0.05, 1.1, 0.2], [0.05, 1.3, 0.3], 4);
    const mesh = mergeMeshes({ positions: lumpy, indices: ball.indices }, tap);
    const plane = { normal: Math.PI / 2, offset: 0 };
    const normals = shadingNormals(mesh.positions, mesh.indices, { iterations: 6 });
    const before = mirrorError(mesh.positions, plane);
    const after = symmetrize(mesh.positions, mesh.indices, normals, plane);
    expect(mirrorError(after, plane)).toBeLessThan(before * 0.85);
    // The tap has no counterpart on the other side: it stays where it was.
    const tapStart = lumpy.length;
    for (let i = tapStart; i < after.length; i++) expect(after[i]).toBeCloseTo(mesh.positions[i], 6);
    // The mesh is not torn: every position is finite and close to where it was.
    for (let i = 0; i < lumpy.length; i++) expect(Math.abs(after[i] - mesh.positions[i])).toBeLessThan(0.1);
  });

  it('does not touch a surface that is symmetric already', () => {
    const ball = icosphere(4);
    const normals = shadingNormals(ball.positions, ball.indices, { iterations: 6 });
    const after = symmetrize(ball.positions, ball.indices, normals, { normal: 0, offset: 0 });
    let moved = 0;
    for (let i = 0; i < after.length; i++) moved = Math.max(moved, Math.abs(after[i] - ball.positions[i]));
    expect(moved).toBeLessThan(0.01);
  });
});
