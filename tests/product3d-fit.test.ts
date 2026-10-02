import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import {
  buildFit,
  computeFit,
  estimateProductFit,
  fitChangesMesh,
  fitProductMesh,
  fittedFrom,
  fittedPhotoDirection,
  sizeMismatch,
  startingFit,
  validProductSize,
  type ProductFit,
} from '../src/lib/product3d/fit';
import { estimateSymmetry } from '../src/lib/product3d/symmetry';
import { meshVolume } from '../src/lib/product3d/mesh-cleanup';
import { productSurface } from '../src/lib/product3d/shading';
import { prepareFittedMesh, prepareProductFit } from '../src/lib/product3d/surface';
import { sourceViewAngle, createDefaultPose } from '../src/lib/product3d/pose';
import type { ProductMesh } from '../src/lib/product3d/state-types';
import {
  IDENTITY,
  around,
  placed,
  radians,
  roundPoints,
  toilet,
  withColours,
} from './helpers/product3d-fit-shapes';

describe('fitProductMesh: the real size, the front and the mirror', () => {
  const size = { widthMm: 400, depthMm: 800, heightMm: 600 };
  /** The extent of a mesh along the standing frame's x, y, z after `fit.upright` (and the front turn if asked). */
  const extent = (mesh: ProductMesh, fit: ProductFit, turn = 0) => {
    const q = new Quaternion(...fit.upright);
    const t = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), radians(-turn));
    const low = [Infinity, Infinity, Infinity],
      high = [-Infinity, -Infinity, -Infinity];
    const v = new Vector3();
    for (let i = 0; i < mesh.positions.length; i += 3) {
      v.set(mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2])
        .applyQuaternion(q)
        .applyQuaternion(t);
      for (let k = 0; k < 3; k++) {
        low[k] = Math.min(low[k], v.getComponent(k));
        high[k] = Math.max(high[k], v.getComponent(k));
      }
    }
    return high.map((h, k) => h - low[k]);
  };

  it('stretches the product along its own axes to the typed size (±2%), a diagonal photo or not', () => {
    const mesh = withColours(placed(toilet(), 35, [0.1, 0.2, 0]));
    const found = estimateProductFit(mesh, IDENTITY, { size });
    expect(found.symmetric).toBe(true);
    const fit = buildFit(found, { size: true, mirror: false, flip: false })!;
    // The front is turned to +x: 35° plus the half turn to the low end.
    expect(around(fit.front, 35 + 180)).toBeLessThan(1.5);
    const fitted = fitProductMesh(mesh, fit, size);
    const [depth, width, height] = extent(fitted, fit);
    expect(depth / height).toBeCloseTo(size.depthMm / size.heightMm, 1);
    expect(width / height / (size.widthMm / size.heightMm)).toBeGreaterThan(0.98);
    expect(width / height / (size.widthMm / size.heightMm)).toBeLessThan(1.02);
    expect(depth / height / (size.depthMm / size.heightMm)).toBeGreaterThan(0.98);
    expect(depth / height / (size.depthMm / size.heightMm)).toBeLessThan(1.02);
  });

  it('keeps the size of the mesh and its volume (the stretch has a mean of 1), and its colours and triangles', () => {
    const mesh = withColours(placed(toilet(), 20, [0, 0, 0]));
    const fit = buildFit(estimateProductFit(mesh, IDENTITY, { size }), {
      size: true,
      mirror: false,
      flip: false,
    })!;
    const fitted = fitProductMesh(mesh, fit, size);
    expect(fitted.indices).toBe(mesh.indices);
    expect(fitted.colors).toBe(mesh.colors);
    expect(fitted.positions).toHaveLength(mesh.positions.length);
    const ratio = meshVolume(fitted.positions, fitted.indices) / meshVolume(mesh.positions, mesh.indices);
    expect(ratio).toBeGreaterThan(0.97);
    expect(ratio).toBeLessThan(1.03);
  });

  it('does not stretch when the size is missing, is the tile default, or is out of range', () => {
    const mesh = withColours(placed(toilet(), 20, [0, 0, 0]));
    const fit: ProductFit = { upright: IDENTITY, front: 0, size: true };
    for (const bad of [
      undefined,
      { widthMm: 400, depthMm: 9, heightMm: 600 },
      { widthMm: 400, depthMm: 800, heightMm: 60_000 },
      { widthMm: 0, depthMm: 800, heightMm: 600 },
      { widthMm: NaN, depthMm: 800, heightMm: 600 },
    ]) {
      expect(validProductSize(bad)).toBe(false);
      expect(fitChangesMesh(fit, bad)).toBe(false);
    }
    expect(validProductSize(size)).toBe(true);
    expect(fitChangesMesh(fit, size)).toBe(true);
    // A fit that asks for nothing changes nothing.
    expect(fitChangesMesh({ ...fit, size: false }, size)).toBe(false);
    expect(fitChangesMesh(undefined, size)).toBe(false);
    const unchanged = computeFit(mesh, { ...fit, size: true }, { widthMm: 400, depthMm: 9, heightMm: 600 });
    for (let i = 0; i < unchanged.positions.length; i++)
      expect(unchanged.positions[i]).toBeCloseTo(mesh.positions[i], 5);
  });

  it('measures how far the photo is from the typed size, and calls 40% a mismatch', () => {
    const mesh = withColours(placed(toilet(), 35, [0, 0, 0]));
    const found = estimateProductFit(mesh, IDENTITY, { size });
    // The model is 0.7 deep × 0.36 wide × 0.85 high: close to 800 × 400 × 600 in the depth, 40% off in the height.
    const close = sizeMismatch(mesh, found.fit, { widthMm: 360, depthMm: 700, heightMm: 850 });
    expect(close.worst).toBeLessThan(0.05);
    const far = sizeMismatch(mesh, found.fit, { widthMm: 360, depthMm: 1400, heightMm: 850 });
    expect(far.depth).toBeGreaterThan(0.4);
    const start = startingFit(mesh, found, {
      size: { widthMm: 360, depthMm: 1400, heightMm: 850 },
      symmetricKind: true,
    });
    // A size the photo disagrees with by that much is asked about, not applied (the mirror part still is).
    expect(start.ask?.worst).toBeGreaterThan(0.4);
    expect(start.fit?.size).toBe(false);
    expect(start.fit?.mirror).toBeDefined();
    const fine = startingFit(mesh, found, {
      size: { widthMm: 360, depthMm: 700, heightMm: 850 },
      symmetricKind: false,
    });
    expect(fine.ask).toBeUndefined();
    expect(fine.fit?.size).toBe(true);
    // Not a symmetric kind: no mirror evening-out by default.
    expect(fine.fit?.mirror).toBeUndefined();
  });

  it('evens out the mirror about the plane the fit names, turned with the front', () => {
    const base = toilet(22);
    // Push one side of the body in a little, then turn the whole model.
    const lumpy = new Float32Array(base.positions);
    for (let i = 0; i < lumpy.length; i += 3)
      if (lumpy[i + 1] > 0.1 && lumpy[i + 2] < 0.38) lumpy[i + 1] *= 1.12;
    const mesh = withColours(placed({ positions: lumpy, indices: base.indices }, 52, [0.2, 0.1, 0]));
    const found = estimateProductFit(mesh, IDENTITY);
    expect(found.symmetric).toBe(true);
    const fit = buildFit(found, { size: false, mirror: true, flip: false })!;
    expect(fit.mirror).toBeDefined();
    const fitted = fitProductMesh(mesh, fit);
    const before = estimateSymmetry(mesh.positions, { maxError: 1, minDominance: 0 })!.error;
    const after = estimateSymmetry(fitted.positions, { maxError: 1, minDominance: 0 })!.error;
    expect(after).toBeLessThan(before * 0.95);
  });

  it('flips the front by half a turn and keeps the mirror plane', () => {
    const mesh = withColours(placed(toilet(), 30, [0, 0, 0]));
    const found = estimateProductFit(mesh, IDENTITY, { size });
    const a = buildFit(found, { size: true, mirror: true, flip: false })!;
    const b = buildFit(found, { size: true, mirror: true, flip: true })!;
    expect(around(b.front, a.front + 180)).toBeLessThan(1e-6);
    expect(b.mirror).toBeCloseTo(-a.mirror!, 9);
    const fitted = fitProductMesh(mesh, b, size);
    // Turned the other way: the tank that was at +x of the front axis is at −x now.
    const direction = fittedPhotoDirection(b);
    expect(Math.hypot(...direction)).toBeCloseTo(1, 6);
    expect(fitted.positions).toHaveLength(mesh.positions.length);
  });

  it('offers only the size when there is no mirror plane, and nothing is turned', () => {
    const ball = withColours({ ...roundPoints(), indices: new Uint32Array([0, 1, 2]) });
    ball.colors = new Float32Array(ball.positions.length).fill(0.8);
    const found = estimateProductFit(ball, IDENTITY, { size });
    expect(found.symmetric).toBe(false);
    expect(found.fit.front).toBe(0);
    expect(found.fit.mirror).toBeUndefined();
    expect(buildFit(found, { size: false, mirror: true, flip: false })).toBeUndefined();
  });

  it('gives a fitted mesh the colours of its source and normals that follow the stretch', () => {
    const mesh = withColours(placed(toilet(16), 30, [0, 0, 0]));
    mesh.colors = new Float32Array(mesh.colors).map((_, i) => 0.4 + (i % 7) * 0.05);
    const fit = buildFit(estimateProductFit(mesh, IDENTITY, { size }), {
      size: true,
      mirror: false,
      flip: false,
    })!;
    const fitted = fitProductMesh(mesh, fit, size);
    expect(fittedFrom(fitted)?.source).toBe(mesh);
    for (const mode of ['lit', 'mixed'] as const) {
      const own = productSurface(mode, mesh);
      const surface = productSurface(mode, fitted);
      expect(surface.colors).toBe(own.colors);
      expect(surface.normals).toHaveLength(mesh.positions.length);
      for (let i = 0; i < surface.normals!.length; i += 3)
        expect(Math.hypot(surface.normals![i], surface.normals![i + 1], surface.normals![i + 2])).toBeCloseTo(
          1,
          4,
        );
    }
    expect(productSurface('baked', fitted).colors).toBe(mesh.colors);
  });
});

describe('prepare… without a Worker', () => {
  const size = { widthMm: 400, depthMm: 800, heightMm: 600 };
  it('gives the same mesh when the fit changes nothing, and one fitted mesh per mesh and fit', async () => {
    const mesh = withColours(placed(toilet(14), 30, [0, 0, 0]));
    expect(await prepareFittedMesh(mesh, undefined, size)).toBe(mesh);
    const fit: ProductFit = { upright: IDENTITY, front: 30, size: true };
    expect(await prepareFittedMesh(mesh, { ...fit, size: false, front: 0 }, size)).toBe(mesh);
    const once = await prepareFittedMesh(mesh, fit, size);
    expect(once).not.toBe(mesh);
    expect(await prepareFittedMesh(mesh, fit, size)).toBe(once);
    // Another size is another mesh.
    expect(await prepareFittedMesh(mesh, fit, { ...size, depthMm: 900 })).not.toBe(once);
    // And it is the same numbers as the direct call.
    const direct = fitProductMesh(mesh, fit, size);
    for (let i = 0; i < direct.positions.length; i++)
      expect(once.positions[i]).toBeCloseTo(direct.positions[i], 6);
  });

  it('searches the fit', async () => {
    const mesh = withColours(placed(toilet(14), 30, [0, 0, 0]));
    const found = await prepareProductFit(mesh, IDENTITY, { size, mirror: true });
    expect(found.symmetric).toBe(true);
  });
});

describe('the photographed side after a fit', () => {
  it('measures the 40° rule from where the photo was taken, wherever the fit turned the mesh', () => {
    const pose = createDefaultPose();
    const fit: ProductFit = { upright: IDENTITY, front: 40, size: true };
    // Without the fit the photographed side is +x, and the default camera looks at it.
    expect(sourceViewAngle(pose)).toBeLessThan(15);
    // The fit turned the mesh by −40° about z, so the photographed side is now 40° off the camera.
    const photo = fittedPhotoDirection(fit);
    expect(sourceViewAngle(pose, photo)).toBeGreaterThan(30);
  });
});
