import { describe, expect, it } from 'vitest';
import { estimateAlbedo, labToSrgb, srgbToLab, vertexNormals } from '../src/lib/product3d/albedo';
import { icosphere } from './helpers/product3d-meshes';

/** Paint a base colour lit by one light, the way a photo bakes shading into TripoSR colours. */
function shaded(base: (x: number, y: number, z: number) => [number, number, number]) {
  const sphere = icosphere(4);
  const normals = vertexNormals(sphere.positions, sphere.indices);
  const light = [0.8, 0.3, 0.5].map((v, _, all) => v / Math.hypot(...all));
  const colors = new Float32Array(sphere.positions.length);
  for (let v = 0; v < colors.length; v += 3) {
    const dot = normals[v] * light[0] + normals[v + 1] * light[1] + normals[v + 2] * light[2];
    const shade = 0.3 + 0.7 * Math.max(0, dot);
    const albedo = base(sphere.positions[v], sphere.positions[v + 1], sphere.positions[v + 2]);
    for (let c = 0; c < 3; c++) colors[v + c] = albedo[c] * shade;
  }
  return { ...sphere, colors };
}
const groups = (albedo: Float32Array) => {
  const seen = new Map<string, number>();
  for (let v = 0; v < albedo.length; v += 3) {
    const key = [...albedo.subarray(v, v + 3)].map((c) => c.toFixed(3)).join(',');
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return seen;
};
const lightness = (rgb: ArrayLike<number>) => srgbToLab(rgb[0], rgb[1], rgb[2])[0];

describe('product3d albedo', () => {
  it('round-trips colours through Lab', () => {
    for (const rgb of [
      [0.9, 0.9, 0.88],
      [0.55, 0.35, 0.2],
      [0.1, 0.2, 0.8],
    ] as [number, number, number][])
      labToSrgb(srgbToLab(...rgb)).forEach((c, i) => expect(c).toBeCloseTo(rgb[i], 3));
  });

  it('flattens the shading on a single glazed material into one bright colour', () => {
    const mesh = shaded(() => [0.93, 0.93, 0.91]);
    const albedo = estimateAlbedo(mesh.positions, mesh.indices, mesh.colors);
    const colours = groups(albedo);
    expect(colours.size).toBe(1);
    // The shadowed side no longer darkens the product.
    expect(lightness(albedo)).toBeGreaterThan(80);
  });

  it('keeps a differently coloured part, even where it lies in shadow', () => {
    const mesh = shaded((_, y) => (y < -0.5 ? [0.55, 0.35, 0.2] : [0.93, 0.93, 0.91]));
    const albedo = estimateAlbedo(mesh.positions, mesh.indices, mesh.colors);
    expect(groups(albedo).size).toBe(2);
    const at = (predicate: (x: number, y: number, z: number) => boolean) => {
      for (let v = 0; v < mesh.positions.length; v += 3)
        if (predicate(mesh.positions[v], mesh.positions[v + 1], mesh.positions[v + 2]))
          return albedo.subarray(v, v + 3);
      throw new Error('no vertex');
    };
    const body = at((x, y, z) => x > 0.9 && Math.abs(z) < 0.3 && y > -0.3);
    const wood = at((x, y) => y < -0.9);
    expect(lightness(body)).toBeGreaterThan(80);
    expect(wood[0]).toBeGreaterThan(wood[2] + 0.15);
  });

  it('keeps a black product dark and merges neutral parts that differ only in lightness', () => {
    const black = shaded(() => [0.12, 0.12, 0.13]);
    const dark = estimateAlbedo(black.positions, black.indices, black.colors);
    expect(groups(dark).size).toBe(1);
    expect(lightness(dark)).toBeLessThan(35);
    // A chrome-grey cap is indistinguishable from shadow in one photo, so it joins the glaze.
    const capped = shaded((_, __, z) => (z > 0.6 ? [0.35, 0.35, 0.37] : [0.93, 0.93, 0.91]));
    expect(groups(estimateAlbedo(capped.positions, capped.indices, capped.colors)).size).toBe(1);
  });

  it('keeps a deep shadow on the far side the glaze colour of the lit side', () => {
    const sphere = icosphere(4);
    const normals = vertexNormals(sphere.positions, sphere.indices);
    const colors = new Float32Array(sphere.positions.length);
    // Lit from the camera (+x); the far side falls almost to black.
    for (let v = 0; v < colors.length; v += 3)
      colors.fill(0.93 * (0.02 + 0.98 * Math.max(0, normals[v])), v, v + 3);
    const albedo = estimateAlbedo(sphere.positions, sphere.indices, colors);
    expect(groups(albedo).size).toBe(1);
    expect(lightness(albedo)).toBeGreaterThan(80);
  });

  it('does not let glints on a coloured part seed white patches', () => {
    let n = 0;
    const mesh = shaded((_, y) =>
      y < -0.5 ? (n++ % 5 === 0 ? [0.95, 0.94, 0.92] : [0.55, 0.35, 0.2]) : [0.93, 0.93, 0.91],
    );
    const albedo = estimateAlbedo(mesh.positions, mesh.indices, mesh.colors);
    let brown = 0,
      part = 0;
    for (let v = 0; v < mesh.positions.length; v += 3)
      if (mesh.positions[v + 1] < -0.6) {
        part++;
        if (albedo[v] > albedo[v + 2] + 0.15) brown++;
      }
    expect(brown / part).toBeGreaterThan(0.95);
  });

  it('returns nothing for an empty mesh', () => {
    expect(estimateAlbedo(new Float32Array(), new Uint32Array(), new Float32Array()).length).toBe(0);
  });
});
