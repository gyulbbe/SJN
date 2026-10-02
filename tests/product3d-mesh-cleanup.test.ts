import { describe, expect, it } from 'vitest';
import {
  bilateralSmooth,
  bumpiness,
  meanEdgeLength,
  sharpVertexCount,
  removeSmallPieces,
  meshVolume,
  shadingNormals,
  shadingNormalSteps,
  surfaceRoughness,
  taubinSmooth,
} from '../src/lib/product3d/mesh-cleanup';
import { icosphere } from './helpers/product3d-meshes';

describe('product3d mesh cleanup', () => {
  it('drops a floating fragment and remaps positions, colors and crossing edges together', () => {
    const body = icosphere(2);
    const bodyVertices = body.positions.length / 3;
    // A floating triangle far away from the body.
    const positions = new Float32Array([...body.positions, 5, 5, 5, 5.1, 5, 5, 5, 5.1, 5]);
    const indices = new Uint32Array([...body.indices, bodyVertices, bodyVertices + 1, bodyVertices + 2]);
    const vertices = positions.length / 3;
    const crossingEdges = new Uint32Array(vertices * 2).map((_, i) => i * 10);
    const colors = new Float32Array(vertices * 3).map((_, i) => (i % 7) / 7);
    const kept = removeSmallPieces({ positions, indices, crossingEdges, colors });
    expect(kept.positions.length / 3).toBe(bodyVertices);
    expect(kept.indices.length).toBe(body.indices.length);
    expect(Math.max(...kept.indices)).toBe(bodyVertices - 1);
    // Every kept vertex still points at its own original position, color and grid edge.
    for (let v = 0; v < bodyVertices; v++) {
      const original = [...body.positions.subarray(v * 3, v * 3 + 3)];
      const match = [...Array(bodyVertices).keys()].find((i) =>
        original.every((value, axis) => kept.positions[i * 3 + axis] === value),
      )!;
      expect(kept.crossingEdges[match * 2]).toBe(v * 2 * 10);
      expect(kept.colors![match * 3]).toBeCloseTo(((v * 3) % 7) / 7, 6);
    }
  });

  it('returns the same mesh when it is already a single piece', () => {
    const body = icosphere(1);
    const mesh = { ...body, crossingEdges: new Uint32Array((body.positions.length / 3) * 2) };
    expect(removeSmallPieces(mesh)).toBe(mesh);
  });

  it('keeps a separate piece that is a real part of the product', () => {
    // A roll whose thin holder arm did not reconstruct: separate, but far from a speck.
    const body = icosphere(3),
      roll = icosphere(2);
    const offset = body.positions.length / 3;
    const positions = new Float32Array([...body.positions, ...roll.positions.map((v) => v * 0.3 + 3)]);
    const indices = new Uint32Array([...body.indices, ...roll.indices.map((i) => i + offset)]);
    const crossingEdges = new Uint32Array((positions.length / 3) * 2);
    const kept = removeSmallPieces({ positions, indices, crossingEdges });
    expect(kept.indices.length).toBe(indices.length);
  });

  it('smooths lumps without shrinking the volume like plain averaging', () => {
    const sphere = icosphere(4);
    const bumpy = new Float32Array(sphere.positions);
    let seed = 3;
    for (let i = 0; i < bumpy.length; i += 3) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      const scale = 1 + ((seed / 2147483648) * 2 - 1) * 0.03;
      bumpy[i] *= scale;
      bumpy[i + 1] *= scale;
      bumpy[i + 2] *= scale;
    }
    const before = surfaceRoughness(bumpy, sphere.indices);
    const smooth = taubinSmooth(bumpy, sphere.indices, { iterations: 6 });
    expect(surfaceRoughness(smooth, sphere.indices)).toBeLessThan(before * 0.6);
    const volume = meshVolume(bumpy, sphere.indices);
    expect(Math.abs(meshVolume(smooth, sphere.indices) - volume) / volume).toBeLessThan(0.02);
    // Plain Laplacian (μ = 0) visibly shrinks the same surface.
    const shrunk = taubinSmooth(bumpy, sphere.indices, { iterations: 6, mu: 0 });
    expect(meshVolume(shrunk, sphere.indices)).toBeLessThan(volume * 0.98);
  });

  it('gives the normals after several numbers of smoothing rounds from one run', () => {
    const sphere = icosphere(3);
    // The surface is bumpy so that the rounds change the normals.
    const bumpy = sphere.positions.map((n, i) => n * (1 + 0.04 * Math.sin(i * 7.3)));
    const steps = [12, 0, 40, 12];
    const results = shadingNormalSteps(bumpy, sphere.indices, steps);
    expect(results).toHaveLength(steps.length);
    steps.forEach((step, i) => {
      const single = shadingNormals(bumpy, sphere.indices, { iterations: step });
      for (let k = 0; k < single.length; k++) expect(results[i][k]).toBeCloseTo(single[k], 6);
    });
    // More rounds, smoother: neighbours' normals differ less after 12 and 40 rounds than the raw ones.
    const spread = (normals: Float32Array) => {
      let sum = 0;
      for (let t = 0; t < sphere.indices.length; t += 3) {
        const [a, b] = [sphere.indices[t] * 3, sphere.indices[t + 1] * 3];
        sum +=
          1 - (normals[a] * normals[b] + normals[a + 1] * normals[b + 1] + normals[a + 2] * normals[b + 2]);
      }
      return sum;
    };
    expect(spread(results[0])).toBeLessThan(spread(results[1]) * 0.5);
    expect(spread(results[2])).toBeLessThan(spread(results[1]) * 0.5);
  });

  describe('bilateralSmooth: flat faces are flattened, edges stay', () => {
    /** A plate with a hammered pattern and a 0.2 high step across the middle, `cells` × `cells` squares. */
    function plate(cells = 60, spacing = 0.02, noise = 0.004) {
      let seed = 5;
      const random = () => {
        seed = (seed * 1664525 + 1013904223) % 4294967296;
        return seed / 4294967296;
      };
      const positions: number[] = [];
      const indices: number[] = [];
      for (let j = 0; j <= cells; j++)
        for (let i = 0; i <= cells; i++) {
          const x = (i - cells / 2) * spacing;
          positions.push(x, (j - cells / 2) * spacing, (x > 0 ? 0.2 : 0) + (random() * 2 - 1) * noise);
        }
      for (let j = 0; j < cells; j++)
        for (let i = 0; i < cells; i++) {
          const a = j * (cells + 1) + i,
            b = a + 1,
            c = a + cells + 1,
            d = c + 1;
          indices.push(a, b, c, b, d, c);
        }
      return { positions: new Float32Array(positions), indices: new Uint32Array(indices), cells };
    }
    const side = (positions: Float32Array, cells: number, left: boolean) => {
      let sum = 0,
        count = 0;
      for (let j = 8; j <= cells - 8; j++)
        for (let i = left ? 8 : cells / 2 + 8; i <= (left ? cells / 2 - 8 : cells - 8); i++) {
          sum += positions[(j * (cells + 1) + i) * 3 + 2];
          count++;
        }
      return sum / count;
    };

    it('takes the pattern off a flat patch and keeps the step between two levels', () => {
      const { positions, indices, cells } = plate();
      const smooth = bilateralSmooth(positions, indices);
      // (The step itself counts as a bump, so the whole plate gets less bumpy by less than each level does.)
      expect(bumpiness(smooth, indices)).toBeLessThan(bumpiness(positions, indices) * 0.85);
      // The step is as high as it was (a mean of the two levels well away from the edge).
      const step = side(smooth, cells, false) - side(smooth, cells, true);
      expect(step).toBeGreaterThan(0.2 * 0.9);
      expect(step).toBeLessThan(0.2 * 1.1);
      // Each level is flatter than before.
      const spread = (p: Float32Array, left: boolean) => {
        const mean = side(p, cells, left);
        let sum = 0,
          n = 0;
        for (let j = 8; j <= cells - 8; j++)
          for (let i = left ? 8 : cells / 2 + 8; i <= (left ? cells / 2 - 8 : cells - 8); i++) {
            sum += (p[(j * (cells + 1) + i) * 3 + 2] - mean) ** 2;
            n++;
          }
        return Math.sqrt(sum / n);
      };
      expect(spread(smooth, true)).toBeLessThan(spread(positions, true) * 0.6);
      expect(spread(smooth, false)).toBeLessThan(spread(positions, false) * 0.6);
    });

    it('keeps the creases that Taubin smoothing rounds off', () => {
      const { positions, indices } = plate();
      const edges = sharpVertexCount(positions, indices, 60);
      expect(edges).toBeGreaterThan(50);
      expect(sharpVertexCount(bilateralSmooth(positions, indices), indices, 60)).toBeGreaterThanOrEqual(
        edges * 0.9,
      );
      // Taubin (the earlier smoothing) is no help: it rounds the step off.
      const rounded = taubinSmooth(positions, indices, { iterations: 12 });
      expect(sharpVertexCount(rounded, indices, 60)).toBeLessThan(edges * 0.9);
    });

    it('keeps the volume of a rounded body to 5% and leaves a clean surface as it is', () => {
      const sphere = icosphere(4);
      const bumpy = sphere.positions.map((n, i) => n * (1 + 0.01 * Math.sin(i * 12.9898)));
      const smooth = bilateralSmooth(bumpy, sphere.indices);
      const volume = meshVolume(bumpy, sphere.indices);
      expect(Math.abs(meshVolume(smooth, sphere.indices) - volume) / volume).toBeLessThan(0.05);
      const clean = bilateralSmooth(sphere.positions, sphere.indices);
      let moved = 0;
      for (let i = 0; i < clean.length; i++)
        moved = Math.max(moved, Math.abs(clean[i] - sphere.positions[i]));
      expect(moved).toBeLessThan(0.02);
    });

    it('measures edges, bumps and size on a flat grid', () => {
      const flat = plate(30, 0.02, 0);
      const level = new Float32Array(flat.positions);
      for (let i = 0; i < level.length; i += 3) level[i + 2] = 0;
      expect(bumpiness(level, flat.indices)).toBeLessThan(1e-6);
      expect(sharpVertexCount(level, flat.indices, 40)).toBe(0);
      expect(meanEdgeLength(level, flat.indices)).toBeGreaterThan(0.02);
      expect(meanEdgeLength(level, flat.indices)).toBeLessThan(0.03);
    });
  });
});
