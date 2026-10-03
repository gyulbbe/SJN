import { describe, expect, it } from 'vitest';
import {
  SOURCE_CAMERA,
  fitPhotoCamera,
  outlineIou,
  projectVertices,
  validPhotoCamera,
  type PhotoCamera,
} from '../src/lib/product3d/photo-camera';
import {
  edgeDistance,
  paintFromPhoto,
  paintFailureMessage,
  samplePhotoColors,
  type ProductPhoto,
} from '../src/lib/product3d/photo-color';
import { photoGradient, refineByPhoto } from '../src/lib/product3d/photo-refine';
import { mixedSurface } from '../src/lib/product3d/mixed-color';
import { registerPainted } from '../src/lib/product3d/painted';
import { productSurface } from '../src/lib/product3d/shading';
import type { ProductMesh } from '../src/lib/product3d/state-types';
import { SIZE, alphaOf, concat, onFront, photoOf, sheet, toiletMesh } from './helpers/product3d-photo-shapes';

describe('fitPhotoCamera', () => {
  it('finds the camera a photo was taken from by the outline alone', () => {
    const mesh = toiletMesh(70);
    const truth: PhotoCamera = {
      azimuth: 22,
      elevation: 9,
      distance: 2.2,
      focal: 3.1,
      shift: [0.04, -0.03],
    };
    const photo = photoOf(mesh, truth);
    const found = fitPhotoCamera(mesh.positions, alphaOf(photo), SIZE);
    expect(found.iou).toBeGreaterThan(0.97);
    expect(Math.abs(found.camera.azimuth - truth.azimuth)).toBeLessThan(4);
    expect(Math.abs(found.camera.elevation - truth.elevation)).toBeLessThan(4);
    expect(Math.abs(found.camera.shift[0] - truth.shift[0])).toBeLessThan(0.03);
    expect(Math.abs(found.camera.shift[1] - truth.shift[1])).toBeLessThan(0.03);
    // The outline overlap is measurable again for a stored camera, and agrees.
    expect(outlineIou(mesh.positions, alphaOf(photo), SIZE, found.camera)).toBeGreaterThan(0.95);
  }, 60_000);

  it('starts from the camera TripoSR is built for and keeps it when it already fits', () => {
    const mesh = toiletMesh(70);
    const photo = photoOf(mesh, SOURCE_CAMERA);
    const found = fitPhotoCamera(mesh.positions, alphaOf(photo), SIZE);
    expect(found.iou).toBeGreaterThan(0.98);
    // A box-like product looks alike from a few degrees either side: the match is what counts.
    expect(Math.abs(found.camera.azimuth)).toBeLessThan(8);
    expect(Math.abs(found.camera.elevation)).toBeLessThan(8);
  }, 60_000);

  it('accepts only cameras inside the limits', () => {
    expect(validPhotoCamera(SOURCE_CAMERA)).toBe(true);
    expect(validPhotoCamera({ ...SOURCE_CAMERA, distance: 0.5 })).toBe(false);
    expect(validPhotoCamera({ ...SOURCE_CAMERA, azimuth: Number.NaN })).toBe(false);
    expect(validPhotoCamera({ ...SOURCE_CAMERA, shift: [2, 0] })).toBe(false);
  });
});

describe('paintFromPhoto', () => {
  it('does not paint when the photo and the model outline disagree', () => {
    const mesh = toiletMesh(60);
    // A photo of a wide flat disc: nothing like a toilet from any camera.
    const photo = photoOf(mesh, SOURCE_CAMERA);
    for (let y = 0; y < SIZE; y++)
      for (let x = 0; x < SIZE; x++) {
        const inside = ((x - 256) / 230) ** 2 + ((y - 400) / 40) ** 2 < 1;
        photo.data[(y * SIZE + x) * 4 + 3] = inside ? 255 : 0;
      }
    const result = paintFromPhoto(mesh, photo);
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.reason).toBe('outline');
      expect(result.iou).toBeLessThan(0.85);
    }
    expect(paintFailureMessage('outline', 0.4)).toContain('40%');
  }, 60_000);

  it('does not paint an empty photo', () => {
    const empty: ProductPhoto = { size: SIZE, data: new Uint8ClampedArray(SIZE * SIZE * 4) };
    const result = paintFromPhoto(toiletMesh(20), empty);
    expect(result).toMatchObject({ status: 'failed', reason: 'empty' });
  });

  it('uses a stored camera without searching and measures how well it fits', () => {
    const mesh = sheet(0.3, 0.3, 60);
    const photo = photoOf(mesh, onFront);
    const result = paintFromPhoto(mesh, photo, onFront, { refine: false });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.camera).toEqual(onFront);
      expect(result.iou).toBeGreaterThan(0.95);
    }
    // A stored camera that does not fit is not trusted either.
    const wrong = paintFromPhoto(
      mesh,
      photo,
      { ...onFront, azimuth: 60, shift: [0.3, 0] },
      { refine: false },
    );
    expect(wrong.status).toBe('failed');
  });
});

describe('samplePhotoColors', () => {
  it('reads the colours of what the camera sees and leaves the hidden behind it alone', () => {
    // A big sheet at x = 0.2 with a small sheet in front of it (x = 0.5): the part behind is hidden.
    const behind = sheet(0.2, 0.4, 80),
      front = sheet(0.5, 0.1, 30);
    const mesh = concat(behind, front);
    const photo = photoOf(mesh, onFront, (x) => (x < 256 ? [220, 40, 40] : [40, 40, 220]));
    const sampled = samplePhotoColors(mesh, photo, onFront);
    /** The vertex of `m` nearest to (y, z). */
    const weightAt = (m: ProductMesh, y: number, z: number) => {
      let best = 0,
        gap = Infinity;
      for (let v = 0; v < m.positions.length / 3; v++) {
        const d = Math.hypot(m.positions[v * 3 + 1] - y, m.positions[v * 3 + 2] - z);
        if (d < gap) {
          gap = d;
          best = v;
        }
      }
      return best;
    };
    const behindVertices = behind.positions.length / 3;
    // Behind the small sheet (y, z near 0) is hidden; at the side (y = ±0.3) it is seen.
    const hidden = weightAt(behind, 0, 0);
    expect(sampled.weight[hidden]).toBe(0);
    const seen = weightAt(behind, 0.3, 0.2);
    expect(sampled.weight[seen]).toBeGreaterThan(0.9);
    // Right of centre (+y is the image's right) the photo is blue, left is red.
    expect(sampled.colors[seen * 3 + 2]).toBeGreaterThan(0.7);
    expect(sampled.colors[seen * 3]).toBeLessThan(0.3);
    const seenLeft = weightAt(behind, -0.3, 0.2);
    expect(sampled.colors[seenLeft * 3]).toBeGreaterThan(0.7);
    // The small sheet in front is seen.
    const near = behindVertices + weightAt(front, 0.05, 0.05);
    expect(sampled.weight[near]).toBeGreaterThan(0.9);
  });

  it('does not use a face that turns away from the camera', () => {
    // A box seen from the front: its side wall (normal along y) is edge-on, its back faces away.
    const mesh = toiletMesh(60);
    const photo = photoOf(mesh, SOURCE_CAMERA);
    const sampled = samplePhotoColors(mesh, photo, SOURCE_CAMERA);
    const positions = mesh.positions;
    let sideSeen = 0,
      sideTotal = 0,
      backSeen = 0,
      frontSeen = 0;
    for (let v = 0; v < positions.length / 3; v++) {
      const x = positions[v * 3] + 0.35,
        y = positions[v * 3 + 1];
      if (Math.abs(Math.abs(y) - 0.18) < 1e-4 && x > 0.05 && x < 0.65) {
        sideTotal++;
        if (sampled.weight[v] > 0.1) sideSeen++;
      }
      if (Math.abs(x) < 1e-4 && sampled.weight[v] > 0) backSeen++;
      if (Math.abs(x - 0.7) < 1e-4 && positions[v * 3 + 2] + 0.42 > 0.5 && sampled.weight[v] > 0.9)
        frontSeen++;
    }
    expect(sideTotal).toBeGreaterThan(100);
    expect(sideSeen / sideTotal).toBeLessThan(0.05);
    expect(backSeen).toBe(0);
    expect(frontSeen).toBeGreaterThan(100);
  }, 60_000);

  it('keeps clear of the cut-out edge, where the photo is a blend with the removed background', () => {
    const mesh = sheet(0.3, 0.3, 70);
    // A grey rim two pixels wide all round, white inside.
    const clean = photoOf(mesh, onFront);
    const far = edgeDistance(clean);
    const photo = photoOf(mesh, onFront, () => [255, 255, 255]);
    for (let i = 0; i < SIZE * SIZE; i++)
      if (photo.data[i * 4 + 3] && far[i] < 2.5) photo.data.set([128, 128, 128], i * 4);
    const sampled = samplePhotoColors(mesh, photo, onFront);
    let strong = 0;
    for (let v = 0; v < sampled.weight.length; v++) {
      if (sampled.weight[v] > 0.5) {
        strong++;
        // Nothing near full trust has any of the grey rim in it.
        expect(sampled.colors[v * 3]).toBeGreaterThan(0.98);
      }
    }
    expect(strong).toBeGreaterThan(sampled.weight.length * 0.7);
    // The vertices at the very rim have no weight at all.
    const rim = sampled.weight.filter((w, v) => {
      const y = mesh.positions[v * 3 + 1],
        z = mesh.positions[v * 3 + 2];
      return Math.abs(Math.abs(y) - 0.3) < 1e-4 || Math.abs(Math.abs(z) - 0.3) < 1e-4;
    });
    expect(rim.length).toBeGreaterThan(100);
    expect(rim.every((w) => w === 0)).toBe(true);
  });
});

describe('mixed colours from the photo', () => {
  const lineColour = (x: number): [number, number, number] =>
    Math.abs(x - 256) < 2.5 ? [30, 30, 30] : [215, 215, 215];

  it('draw a line the model colours had lost, and change nothing where the photo shows nothing', () => {
    const mesh = sheet(0.3, 0.3, 90);
    const photo = photoOf(mesh, onFront, lineColour);
    const sampled = samplePhotoColors(mesh, photo, onFront);
    const without = mixedSurface(mesh.positions, mesh.indices, mesh.colors).colors;
    const withPhoto = mixedSurface(mesh.positions, mesh.indices, mesh.colors, { photo: sampled }).colors;
    // Find a vertex on the line (its y projects to x = 256) and one beside it.
    const lineVertex = (offset: number) => {
      let best = 0,
        bestGap = Infinity;
      const projected = projectVertices(mesh.positions, onFront, SIZE);
      for (let v = 0; v < projected.x.length; v++) {
        if (Math.abs(projected.y[v] - 256 + offset * 0) > 60) continue;
        const gap = Math.abs(projected.x[v] - (256 + offset));
        if (gap < bestGap && sampled.weight[v] > 0.9) {
          best = v;
          bestGap = gap;
        }
      }
      return best;
    };
    const onLine = lineVertex(0),
      beside = lineVertex(30);
    expect(withPhoto[onLine * 3]).toBeLessThan(0.5 * withPhoto[beside * 3]);
    // The model colours alone show no line.
    expect(without[onLine * 3]).toBeGreaterThan(0.9 * without[beside * 3]);
    // Without weight the photo changes nothing.
    const none = { colors: sampled.colors, weight: new Float32Array(sampled.weight.length) };
    const same = mixedSurface(mesh.positions, mesh.indices, mesh.colors, { photo: none }).colors;
    let drift = 0;
    for (let i = 0; i < same.length; i++) drift = Math.max(drift, Math.abs(same[i] - without[i]));
    expect(drift).toBeLessThan(1e-3);
  }, 60_000);

  it('are used for the original colours and the mixed ones through productSurface, not for the lit ones', () => {
    const mesh = sheet(0.3, 0.3, 40);
    const photo = photoOf(mesh, onFront, () => [60, 120, 200]);
    const sampled = samplePhotoColors(mesh, photo, onFront);
    const painted: ProductMesh = { ...mesh };
    registerPainted(painted, sampled);
    const plain: ProductMesh = { ...mesh };
    const centre = Math.floor(sampled.weight.length / 2);
    expect(sampled.weight[centre]).toBeGreaterThan(0.9);
    // The original colours: the photo's blue over the model's grey where the photo shows the sheet.
    expect(productSurface('baked', painted).colors[centre * 3 + 2]).toBeGreaterThan(0.7);
    expect(productSurface('baked', plain).colors[centre * 3 + 2]).toBeCloseTo(0.8, 5);
    expect(productSurface('baked', plain).colors).toBe(plain.colors);
    // The lighting-corrected colours are the model's, whatever the photo says.
    const litPainted = productSurface('lit', painted).colors;
    const litPlain = productSurface('lit', plain).colors;
    expect(Array.from(litPainted.subarray(0, 60))).toEqual(Array.from(litPlain.subarray(0, 60)));
    // The mixed colours take the photo's tint where it is shown.
    expect(productSurface('mixed', painted).colors).not.toEqual(productSurface('mixed', plain).colors);
  }, 60_000);
});

describe('refineByPhoto', () => {
  /** Interior edges (used by two triangles) and open edges (one) of a mesh. */
  const edgeUse = (indices: Uint32Array) => {
    const uses = new Map<string, number>();
    for (let t = 0; t < indices.length; t += 3)
      for (const [a, b] of [
        [indices[t], indices[t + 1]],
        [indices[t + 1], indices[t + 2]],
        [indices[t + 2], indices[t]],
      ]) {
        const key = a < b ? `${a}-${b}` : `${b}-${a}`;
        uses.set(key, (uses.get(key) ?? 0) + 1);
      }
    return uses;
  };

  it('splits the triangles on a fine line without cracks and without moving the surface', () => {
    const mesh = sheet(0.3, 0.3, 50);
    const photo = photoOf(mesh, onFront, (x) => (Math.abs(x - 256) < 1.5 ? [20, 20, 20] : [220, 220, 220]));
    const result = paintFromPhoto(mesh, photo, onFront);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    const before = mesh.positions.length / 3;
    expect(result.added).toBeGreaterThan(0);
    expect(result.mesh.positions.length / 3).toBe(before + result.added);
    expect(result.mesh.colors.length).toBe(result.mesh.positions.length);
    expect(result.photo.weight.length).toBe(result.mesh.positions.length / 3);
    // The new corners sit on the sheet: the shape is the same.
    for (let v = before; v < result.mesh.positions.length / 3; v++)
      expect(result.mesh.positions[v * 3]).toBeCloseTo(0.3, 5);
    // No T-junction cracks: an edge is used by one triangle only on the sheet's rim (together
    // 4 × 0.6 long, as before), by two everywhere else.
    const after = edgeUse(result.mesh.indices);
    expect([...after.values()].every((count) => count <= 2)).toBe(true);
    let rim = 0;
    for (const [key, count] of after) {
      if (count !== 1) continue;
      const [a, b] = key.split('-').map(Number);
      rim += Math.hypot(
        result.mesh.positions[a * 3 + 1] - result.mesh.positions[b * 3 + 1],
        result.mesh.positions[a * 3 + 2] - result.mesh.positions[b * 3 + 2],
      );
    }
    expect(rim).toBeCloseTo(2.4, 4);
    for (const index of result.mesh.indices) expect(index).toBeLessThan(result.mesh.positions.length / 3);
    // Area is kept: the sheet is still 0.6 × 0.6.
    let area = 0;
    const p = result.mesh.positions;
    for (let t = 0; t < result.mesh.indices.length; t += 3) {
      const [a, b, c] = [
        result.mesh.indices[t] * 3,
        result.mesh.indices[t + 1] * 3,
        result.mesh.indices[t + 2] * 3,
      ];
      const u = [p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]],
        w = [p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]];
      area += Math.abs(u[0] * w[1] - u[1] * w[0]) / 2;
    }
    expect(area).toBeCloseTo(0.36, 4);
  });

  it('leaves a smooth photo alone and never adds more than its budget', () => {
    const mesh = sheet(0.3, 0.3, 50);
    const smooth = photoOf(mesh, onFront, (x) => [150 + x / 8, 150, 150]);
    const result = paintFromPhoto(mesh, smooth, onFront);
    expect(result.status === 'ok' && result.added).toBe(0);
    // A busy photo hits the cap (a share of the vertices).
    const busy = photoOf(mesh, onFront, (x, y) => ((x + y) % 4 < 2 ? [20, 20, 20] : [230, 230, 230]));
    const projected = projectVertices(mesh.positions, onFront, SIZE);
    const sampled = samplePhotoColors(mesh, busy, onFront);
    const refined = refineByPhoto(mesh, projected, sampled.weight, photoGradient(busy), SIZE);
    expect(refined.added).toBeLessThanOrEqual(Math.floor((mesh.positions.length / 3) * 0.35));
    expect(refined.added).toBeGreaterThan(0);
  });
});
