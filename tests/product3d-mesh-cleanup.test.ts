import { describe, expect, it } from 'vitest';
import {
  removeSmallPieces,
  meshVolume,
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
});
