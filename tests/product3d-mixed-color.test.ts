import { describe, expect, it } from 'vitest';
import { estimateAlbedo, srgbToLab, vertexNormals } from '../src/lib/product3d/albedo';
import { localAverage, mixedSurface, photographedWeight, MIXED } from '../src/lib/product3d/mixed-color';
import { isLitShading, productSurface } from '../src/lib/product3d/shading';
import { shadingNormals } from '../src/lib/product3d/mesh-cleanup';
import {
  BATCH_MESHES,
  compareWithPhotographedSide,
  hasBatchMesh,
  photographedSphere,
  readBatchMesh,
} from './helpers/mixed-metrics';
import { icosphere } from './helpers/product3d-meshes';

const lab = (colors: ArrayLike<number>, v: number) =>
  srgbToLab(colors[v * 3], colors[v * 3 + 1], colors[v * 3 + 2]);

describe('photographedWeight: how much of a vertex the photo shows', () => {
  const normals = (...vectors: [number, number, number][]) => new Float32Array(vectors.flat());
  it('is 1 facing the photo, 0 turned away, and 0 behind', () => {
    const w = photographedWeight(
      normals([1, 0, 0], [0, 1, 0], [0, 0, -1], [-1, 0, 0], [Math.SQRT1_2, Math.SQRT1_2, 0]),
    );
    expect(w[0]).toBe(1);
    expect(w[1]).toBe(0);
    expect(w[2]).toBe(0);
    expect(w[3]).toBe(0);
    // 45° from the camera is still well within the photographed face.
    expect(w[4]).toBeGreaterThan(0.9);
  });

  it('rises smoothly and never jumps between the two limits', () => {
    const steps = 400;
    const w = photographedWeight(
      new Float32Array(
        Array.from({ length: steps + 1 }, (_, i) => {
          const angle = (i / steps) * Math.PI; // from facing the photo to facing away
          return [Math.cos(angle), Math.sin(angle), 0];
        }).flat(),
      ),
    );
    let jump = 0;
    for (let i = 1; i < w.length; i++) {
      expect(w[i]).toBeLessThanOrEqual(w[i - 1] + 1e-9);
      jump = Math.max(jump, w[i - 1] - w[i]);
    }
    // The largest step over 0.45° of turn: a smooth curve, not an edge.
    expect(jump).toBeLessThan(0.03);
    expect(w.some((x) => x > 0 && x < 1)).toBe(true);
  });

  it('follows the direction the photo was taken from', () => {
    const w = photographedWeight(normals([0, 0, 1], [1, 0, 0]), [0, 0, 1]);
    expect(w[0]).toBe(1);
    expect(w[1]).toBe(0);
  });
});

describe('localAverage: the broad shading of a photo', () => {
  const sphere = icosphere(4);
  const normals = vertexNormals(sphere.positions, sphere.indices);
  const vertices = sphere.positions.length / 3;

  it('leaves a single colour as it is', () => {
    const values = new Float32Array(vertices * 3);
    for (let v = 0; v < vertices; v++) values.set([0.31, 0.62, 0.93], v * 3);
    const weights = new Float32Array(vertices).fill(1);
    const average = localAverage(sphere.positions, normals, values, weights, 0.05);
    for (let i = 0; i < average.length; i++) expect(average[i]).toBeCloseTo(values[i], 5);
  });

  it('stays within the colours it averages', () => {
    const values = new Float32Array(vertices * 3);
    for (let v = 0; v < vertices; v++) values.fill(0.2 + 0.6 * (v % 7 === 0 ? 1 : 0), v * 3, v * 3 + 3);
    const weights = new Float32Array(vertices).fill(1);
    const average = localAverage(sphere.positions, normals, values, weights, 0.1);
    for (const a of average) {
      expect(a).toBeGreaterThanOrEqual(0.2 - 1e-5);
      expect(a).toBeLessThanOrEqual(0.8 + 1e-5);
    }
  });

  it('gives a vertex nothing to average from back its own colour', () => {
    const values = new Float32Array(vertices * 3).map((_, i) => (i % 5) / 5);
    const average = localAverage(sphere.positions, normals, values, new Float32Array(vertices), 0.1);
    expect(Array.from(average)).toEqual(Array.from(values));
  });

  it('ignores vertices without weight and weighs the others', () => {
    const values = new Float32Array(vertices * 3);
    const weights = new Float32Array(vertices);
    // The unweighted half is black, the weighted half white: a vertex on the black half sees only white.
    for (let v = 0; v < vertices; v++) {
      const weighted = sphere.positions[v * 3] > 0;
      weights[v] = weighted ? 1 : 0;
      values.fill(weighted ? 1 : 0, v * 3, v * 3 + 3);
    }
    const average = localAverage(sphere.positions, normals, values, weights, 0.15);
    for (let v = 0; v < vertices; v++)
      if (sphere.positions[v * 3] > 0.25) expect(average[v * 3]).toBeGreaterThan(0.999);
  });

  it('keeps faces turned away from each other apart', () => {
    // Two parallel sheets one grid cell apart, facing opposite ways: each averages only with its own.
    const points: number[] = [],
      facing: number[] = [],
      value: number[] = [];
    for (let i = 0; i < 40; i++)
      for (let j = 0; j < 40; j++) {
        points.push(i * 0.02, j * 0.02, 0.05, i * 0.02, j * 0.02, 0);
        facing.push(0, 0, 1, 0, 0, -1);
        value.push(0.9, 0.9, 0.9, 0.1, 0.1, 0.1);
      }
    const average = localAverage(
      new Float32Array(points),
      new Float32Array(facing),
      new Float32Array(value),
      new Float32Array(1600 * 2).fill(1),
      0.05,
    );
    for (let v = 0; v < 1600 * 2; v += 2) {
      expect(average[v * 3]).toBeCloseTo(0.9, 4);
      expect(average[(v + 1) * 3]).toBeCloseTo(0.1, 4);
    }
  });
});

describe('estimateAlbedo with the photo’s visibility', () => {
  it('does not let the model’s guess behind the product pick a material', () => {
    const mesh = photographedSphere();
    const normals = shadingNormals(mesh.positions, mesh.indices, { iterations: 12 });
    const plain = estimateAlbedo(mesh.positions, mesh.indices, mesh.colors);
    const aware = estimateAlbedo(mesh.positions, mesh.indices, mesh.colors, {
      visibility: photographedWeight(normals),
    });
    const kinds = (albedo: Float32Array) =>
      new Set(Array.from({ length: albedo.length / 3 }, (_, v) => lab(albedo, v)[0].toFixed(0))).size;
    // Left alone, the brown guess is taken for a second material; told what the photo shows, it is not.
    expect(kinds(plain)).toBeGreaterThan(1);
    expect(kinds(aware)).toBe(1);
  });

  it('lets the back of a coloured part keep its colour and not the main material’s', () => {
    // A wooden lower half and a white upper half, both photographed; the back of each stays itself.
    const sphere = icosphere(5);
    const normals = vertexNormals(sphere.positions, sphere.indices);
    const colors = new Float32Array(sphere.positions.length);
    for (let v = 0; v < colors.length / 3; v++) {
      const seen = Math.max(0, normals[v * 3]);
      const wood = sphere.positions[v * 3 + 1] < -0.4;
      const paint = wood ? [0.55, 0.35, 0.2] : [0.93, 0.93, 0.91];
      // The guess behind the product is grey, whatever the part.
      const guessed = 1 - Math.min(1, seen * 3);
      for (let c = 0; c < 3; c++)
        colors[v * 3 + c] = (1 - guessed) * paint[c] * (0.5 + 0.5 * seen) + guessed * 0.35;
    }
    const albedo = estimateAlbedo(sphere.positions, sphere.indices, colors, {
      visibility: photographedWeight(shadingNormals(sphere.positions, sphere.indices, { iterations: 12 })),
    });
    let wood = 0,
      woodBack = 0,
      whiteBack = 0,
      whiteBackWhite = 0;
    for (let v = 0; v < colors.length / 3; v++) {
      if (normals[v * 3] > 0) continue;
      const brown = albedo[v * 3] > albedo[v * 3 + 2] + 0.15;
      if (sphere.positions[v * 3 + 1] < -0.6) {
        woodBack++;
        if (brown) wood++;
      } else if (sphere.positions[v * 3 + 1] > 0) {
        whiteBack++;
        if (!brown) whiteBackWhite++;
      }
    }
    expect(wood / woodBack).toBeGreaterThan(0.9);
    expect(whiteBackWhite / whiteBack).toBeGreaterThan(0.95);
  });

  it('is unchanged when no visibility is given', () => {
    const mesh = photographedSphere({ subdivisions: 3 });
    expect(Array.from(estimateAlbedo(mesh.positions, mesh.indices, mesh.colors))).toEqual(
      Array.from(estimateAlbedo(mesh.positions, mesh.indices, mesh.colors, { visibility: undefined })),
    );
  });
});

describe('mixedSurface', () => {
  it('returns a single colour unchanged', () => {
    const sphere = icosphere(4);
    const colors = new Float32Array(sphere.positions.length);
    for (let v = 0; v < colors.length; v += 3) colors.set([0.8, 0.78, 0.74], v);
    const { colors: out } = mixedSurface(sphere.positions, sphere.indices, colors);
    for (let v = 0; v < colors.length / 3; v++) {
      const [l, a, b] = lab(out, v),
        [l0, a0, b0] = lab(colors, v);
      expect(Math.abs(l - l0)).toBeLessThan(0.6);
      expect(Math.hypot(a - a0, b - b0)).toBeLessThan(0.6);
    }
  });

  it('paints what the photo does not show in the colour of the photographed big face', () => {
    const mesh = photographedSphere();
    const { colors } = mixedSurface(mesh.positions, mesh.indices, mesh.colors);
    const mixed = compareWithPhotographedSide(mesh, colors);
    const baked = compareWithPhotographedSide(mesh, mesh.colors);
    // The original colours drift to the brown guess; the mixed ones stay at the big face's colour.
    expect(baked.lightness).toBeGreaterThan(25);
    expect(baked.chroma).toBeGreaterThan(3);
    expect(mixed.lightness).toBeLessThan(4);
    expect(mixed.chroma).toBeLessThan(2);
  });

  it('takes the photo’s shading off the photographed side but keeps a thin dark line on it', () => {
    const mesh = photographedSphere({ line: true });
    const { colors } = mixedSurface(mesh.positions, mesh.indices, mesh.colors);
    const mixed = compareWithPhotographedSide(mesh, colors);
    expect(mixed.marks).toBeGreaterThan(20);
    expect(mixed.kept).toBeGreaterThanOrEqual(0.8);
    // The broad shading is gone: the photographed side outside the line is one colour.
    const lightness: number[] = [];
    for (let v = 0; v < mesh.onLine.length; v++)
      if (!mesh.onLine[v] && mesh.normals[v * 3] > 0.7 && Math.abs(mesh.positions[v * 3 + 1] - 0.1) > 0.15)
        lightness.push(lab(colors, v)[0]);
    const spread = (values: number[]) => Math.max(...values) - Math.min(...values);
    const original: number[] = [];
    for (let v = 0; v < mesh.onLine.length; v++)
      if (!mesh.onLine[v] && mesh.normals[v * 3] > 0.7 && Math.abs(mesh.positions[v * 3 + 1] - 0.1) > 0.15)
        original.push(lab(mesh.colors, v)[0]);
    expect(spread(original)).toBeGreaterThan(4);
    expect(spread(lightness)).toBeLessThan(2);
  });

  it('gives the same colours for the same product at any size', () => {
    const mesh = photographedSphere({ line: true, subdivisions: 4 });
    const small = mixedSurface(mesh.positions, mesh.indices, mesh.colors).colors;
    const large = mixedSurface(
      mesh.positions.map((n) => n * 37),
      mesh.indices,
      mesh.colors,
    ).colors;
    for (let i = 0; i < small.length; i++) expect(large[i]).toBeCloseTo(small[i], 3);
  });

  it('returns colours in range and unit normals', () => {
    const mesh = photographedSphere({ line: true, subdivisions: 4 });
    const { colors, normals } = mixedSurface(mesh.positions, mesh.indices, mesh.colors);
    expect(colors).toHaveLength(mesh.colors.length);
    for (const c of colors) {
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(1);
    }
    for (let v = 0; v < normals.length; v += 3)
      expect(Math.hypot(normals[v], normals[v + 1], normals[v + 2])).toBeCloseTo(1, 4);
  });

  it('darkens a groove but not a flat sheet', () => {
    // A flat plate (two triangles per cell) with a deep groove across it.
    const columns = 60,
      rows = 60,
      positions: number[] = [],
      indices: number[] = [];
    for (let j = 0; j <= rows; j++)
      for (let i = 0; i <= columns; i++) {
        const groove = Math.abs(i - columns / 2) <= 1 ? -0.06 : 0;
        // The photographed side faces +x, so the plate stands in the y-z plane with its front at +x.
        positions.push(groove, (i / columns) * 2 - 1, (j / rows) * 2 - 1);
      }
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < columns; i++) {
        const a = j * (columns + 1) + i,
          b = a + 1,
          c = a + columns + 1,
          d = c + 1;
        indices.push(a, b, c, b, d, c);
      }
    const colors = new Float32Array(positions.length).fill(0.9);
    const { colors: out } = mixedSurface(new Float32Array(positions), new Uint32Array(indices), colors);
    const at = (i: number, j: number) => lab(out, j * (columns + 1) + i)[0];
    // The middle of the groove is darker than the flat parts beside it.
    expect(at(columns / 2, rows / 2)).toBeLessThan(at(columns / 4, rows / 2) - 3);
    // Far from the groove the plate is untouched.
    expect(at(columns / 4, rows / 2)).toBeCloseTo(at(columns / 6, rows / 4), 1);
  });

  it('returns nothing for an empty mesh', () => {
    const empty = mixedSurface(new Float32Array(), new Uint32Array(), new Float32Array());
    expect(empty.colors).toHaveLength(0);
    expect(empty.normals).toHaveLength(0);
  });

  it('survives a mesh with no size without a number going bad', () => {
    // Three vertices at one point: nothing to measure a length by.
    const point = mixedSurface(
      new Float32Array(9).fill(2),
      new Uint32Array([0, 1, 2]),
      new Float32Array([0.8, 0.7, 0.6, 0.8, 0.7, 0.6, 0.8, 0.7, 0.6]),
    );
    for (const value of [...point.colors, ...point.normals]) expect(Number.isFinite(value)).toBe(true);
    for (const value of point.colors) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it('is deterministic', () => {
    const mesh = photographedSphere({ line: true, subdivisions: 3 });
    const a = mixedSurface(mesh.positions, mesh.indices, mesh.colors).colors;
    const b = mixedSurface(mesh.positions, mesh.indices, mesh.colors).colors;
    expect(Array.from(a)).toEqual(Array.from(b));
  });
});

describe('productSurface: the colours every consumer draws', () => {
  const mesh = photographedSphere({ line: true, subdivisions: 3 });
  it('hands the saved colours back for the original-colour mode and gives it no normals', () => {
    const surface = productSurface('baked', mesh);
    expect(surface.colors).toBe(mesh.colors);
    expect(surface.normals).toBeUndefined();
  });

  it('lights the lit modes: colours and normals for the lighting', () => {
    for (const mode of ['lit', 'mixed'] as const) {
      const surface = productSurface(mode, mesh);
      expect(surface.colors).toHaveLength(mesh.colors.length);
      expect(surface.normals).toHaveLength(mesh.positions.length);
    }
    expect(Array.from(productSurface('lit', mesh).colors)).toEqual(
      Array.from(estimateAlbedo(mesh.positions, mesh.indices, mesh.colors)),
    );
    expect(Array.from(productSurface('mixed', mesh).colors)).toEqual(
      Array.from(mixedSurface(mesh.positions, mesh.indices, mesh.colors).colors),
    );
  });

  it('computes each mode once per mesh', () => {
    expect(productSurface('mixed', mesh)).toBe(productSurface('mixed', mesh));
    expect(productSurface('lit', mesh)).toBe(productSurface('lit', mesh));
    expect(productSurface('mixed', mesh)).not.toBe(productSurface('lit', mesh));
  });

  it('knows which modes are lit', () => {
    expect(isLitShading('mixed')).toBe(true);
    expect(isLitShading('lit')).toBe(true);
    expect(isLitShading('baked')).toBe(false);
    expect(isLitShading(undefined)).toBe(false);
  });

  it('smooths the normals of the mixed mode as much as the tuning says', () => {
    expect(MIXED.normalIterations).toBeGreaterThan(0);
  });
});

// The saved TripoSR meshes of real products (test-results/product3d-batch, not committed): the same
// two checks on the real thing. They run only where those files are.
describe.each(BATCH_MESHES.filter(hasBatchMesh))('real mesh %s', (name) => {
  const mesh = readBatchMesh(name);
  const mixed = mixedSurface(mesh.positions, mesh.indices, mesh.colors).colors;
  const metrics = compareWithPhotographedSide(mesh, mixed);
  const baked = compareWithPhotographedSide(mesh, mesh.colors);

  it('paints the side the photo does not show in the colour of the big face', () => {
    // Two or more materials (a bottle, a faucet, a wooden part) are meant to differ from the big face.
    const mixedMaterials = !['06-paper-holder', '01-shelf'].includes(name);
    if (mixedMaterials) {
      expect(metrics.lightness, `${name} lightness`).toBeLessThan(8);
      expect(metrics.chroma, `${name} chroma`).toBeLessThan(5);
    }
    expect(metrics.lightness).toBeLessThanOrEqual(baked.lightness + 1);
    expect(metrics.chroma).toBeLessThanOrEqual(baked.chroma + 1);
  });

  it('keeps at least 80% of the dark marks of the photographed side', () => {
    expect(metrics.kept, `${name}: ${metrics.marks} marks`).toBeGreaterThanOrEqual(0.8);
  });
});
