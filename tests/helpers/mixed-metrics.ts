import { existsSync, readFileSync } from 'node:fs';
import { srgbToLab, srgbToLinear, vertexNormals } from '../../src/lib/product3d/albedo';
import { localAverage, photographedWeight } from '../../src/lib/product3d/mixed-color';
import { shadingNormals } from '../../src/lib/product3d/mesh-cleanup';
import type { ProductMesh } from '../../src/lib/product3d/state-types';
import { icosphere } from './product3d-meshes';

export const BATCH_MESHES = [
  '01-shelf',
  '02-smart-toilet',
  '03-bathtub-rect',
  '04-bathtub-scene',
  '05-bathtub-top',
  '06-paper-holder',
  '07-stool',
  '08-mirror',
];
const batchDirectory = 'test-results/product3d-batch';
export const hasBatchMesh = (name: string) => existsSync(`${batchDirectory}/${name}/mesh-positions.bin`);
/** A saved TripoSR mesh of the real-product batch (test-results is not committed). */
export function readBatchMesh(name: string): ProductMesh {
  const floats = (file: string) => {
    const bytes = readFileSync(`${batchDirectory}/${name}/${file}`);
    return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  };
  const bytes = readFileSync(`${batchDirectory}/${name}/mesh-indices.bin`);
  return {
    positions: floats('mesh-positions.bin'),
    colors: floats('mesh-colors.bin'),
    indices: new Uint32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
  };
}

const smoothstep = (from: number, to: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - from) / (to - from)));
  return t * t * (3 - 2 * t);
};

/**
 * A sphere the way TripoSR returns a photographed product: lit from the photo's camera (+x), so the
 * photographed side carries the photo's shading, and a guessed colour (a dull brown here) where the
 * photo shows nothing. Optionally a thin dark line across the photographed side.
 */
export function photographedSphere({
  base = [0.93, 0.93, 0.91] as [number, number, number],
  guess = [0.42, 0.34, 0.3] as [number, number, number],
  line = false,
  subdivisions = 5,
} = {}) {
  const sphere = icosphere(subdivisions);
  const normals = vertexNormals(sphere.positions, sphere.indices);
  const colors = new Float32Array(sphere.positions.length);
  const onLine = new Uint8Array(colors.length / 3);
  for (let v = 0; v < onLine.length; v++) {
    const facing = normals[v * 3];
    const shade = 0.4 + 0.6 * Math.max(0, facing);
    const unseen = 1 - smoothstep(0.05, 0.45, facing);
    const stripe = line && facing > 0.3 && Math.abs(sphere.positions[v * 3 + 1] - 0.1) < 0.02;
    onLine[v] = stripe ? 1 : 0;
    for (let c = 0; c < 3; c++)
      colors[v * 3 + c] = (1 - unseen) * base[c] * shade * (stripe ? 0.4 : 1) + unseen * guess[c];
  }
  return { ...sphere, colors, normals, onLine };
}

const lab = (colors: Float32Array, v: number) =>
  srgbToLab(colors[v * 3], colors[v * 3 + 1], colors[v * 3 + 2]);
const median = (values: number[]) => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

/**
 * How a colouring compares with what the photographed side shows: the median colour of the big
 * face turned to the photo (the reference), how far the vertices the photo does not show are from
 * it (lightness, and the distance in the a·b plane), and how many dark marks of the photographed
 * side (at least 35% darker than their surroundings) are still marks (at least 28% darker than the
 * reference) in `colors`.
 */
export function compareWithPhotographedSide(mesh: ProductMesh, colors: Float32Array, original = mesh.colors) {
  const { positions, indices } = mesh;
  const normals = shadingNormals(positions, indices, { iterations: 12 });
  const shown = photographedWeight(normals);
  const vertices = shown.length;
  const front: number[] = [],
    back: number[] = [];
  for (let v = 0; v < vertices; v++) {
    if (shown[v] >= 0.95) front.push(v);
    else if (shown[v] === 0) back.push(v);
  }
  const reference = [0, 1, 2].map((c) => median(front.map((v) => lab(colors, v)[c])));
  let lightness = 0,
    chroma = 0;
  for (const v of back) {
    const [l, a, b] = lab(colors, v);
    lightness += Math.abs(l - reference[0]);
    chroma += Math.hypot(a - reference[1], b - reference[2]);
  }
  // The dark marks of the photographed side, read from the original colours.
  const linear = new Float32Array(original.length);
  for (let i = 0; i < linear.length; i++) linear[i] = srgbToLinear(original[i]);
  const luminance = new Float32Array(vertices * 3);
  for (let v = 0; v < vertices; v++)
    luminance.fill(
      0.2126 * linear[v * 3] + 0.7152 * linear[v * 3 + 1] + 0.0722 * linear[v * 3 + 2],
      v * 3,
      v * 3 + 3,
    );
  const weights = new Float32Array(vertices);
  for (let v = 0; v < vertices; v++) weights[v] = shown[v];
  let diagonal = 0;
  {
    const min = [Infinity, Infinity, Infinity],
      max = [-Infinity, -Infinity, -Infinity];
    for (let v = 0; v < positions.length; v += 3)
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], positions[v + k]);
        max[k] = Math.max(max[k], positions[v + k]);
      }
    diagonal = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  }
  const around = localAverage(positions, normals, luminance, weights, (0.03 * diagonal) / 2);
  const referenceLuminance = (() => {
    const [l] = reference;
    return ((l + 16) / 116) ** 3;
  })();
  let marks = 0,
    kept = 0;
  for (let v = 0; v < vertices; v++) {
    if (shown[v] < 0.9 || luminance[v * 3] > 0.65 * around[v * 3]) continue;
    marks++;
    const [l] = lab(colors, v);
    if (((l + 16) / 116) ** 3 <= 0.72 * referenceLuminance) kept++;
  }
  return {
    vertices,
    shownShare: front.length / vertices,
    unseenShare: back.length / vertices,
    reference,
    /** Mean |ΔL*| of the vertices the photo does not show, against the reference. */
    lightness: back.length ? lightness / back.length : 0,
    /** Mean distance in the a*·b* plane of the vertices the photo does not show. */
    chroma: back.length ? chroma / back.length : 0,
    marks,
    kept: marks ? kept / marks : 1,
  };
}
