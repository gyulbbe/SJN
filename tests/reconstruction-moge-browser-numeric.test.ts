import { describe, expect, it } from 'vitest';
import reference from './fixtures/moge-browser-python-reference.json';
import {
  postprocessMoge,
  sampleFocalPoints,
  type MogeRawPrediction,
  type MogeDensePrediction,
} from '../src/lib/reconstruction/moge-browser/postprocess';
import {
  extractMogePlanes,
  symmetricEigen3,
  type MogeSemanticInput,
} from '../src/lib/reconstruction/moge-browser/planes';

function raw(width: number, height: number, kind: string): MogeRawPrediction {
  const points = new Float32Array(width * height * 3),
    normal = new Float32Array(points.length),
    mask = new Float32Array(width * height).fill(1),
    a = width / height,
    sx = a / Math.sqrt(1 + a * a),
    sy = 1 / Math.sqrt(1 + a * a);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x,
        z = 1.3 + 0.009 * x + 0.014 * y + 0.045 * Math.sin(x * 0.7 + y * 0.2),
        u = sx * ((2 * (x + 0.5)) / width - 1),
        v = sy * ((2 * (y + 0.5)) / height - 1);
      points.set([(u * (z + 0.27)) / 0.93, (v * (z + 0.27)) / 0.93, z], i * 3);
      normal[i * 3 + 2] = -1;
      if (kind === 'holes') {
        if ((x + 2 * y) % 7 === 0) mask[i] = 0.5;
        if ((x + y) % 19 === 0) mask[i] = 0.1;
      }
      if (kind === 'empty') mask[i] = 0.4;
      if (kind === 'noise') points[i * 3] += Math.fround(0.003 * Math.sin(x * 3 + y));
    }
  return { width, height, points, normal, mask, metricScale: 1.7 };
}
function planeFixture(kind: string) {
  const width = 80,
    height = 64,
    n = width * height,
    points = new Float32Array(n * 3),
    normal = new Float32Array(n * 3),
    mask = new Uint8Array(n).fill(1),
    floor = new Uint8Array(n),
    wall = new Uint8Array(n);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x,
        f = y >= 32;
      floor[i] = f ? 255 : 0;
      wall[i] = f ? 0 : 255;
      points.set([(x - 40) * 0.025, f ? 1.3 : (y - 32) * 0.035, f ? 0.7 + (y - 32) * 0.04 : 2], i * 3);
      normal.set(f ? [0, -1, 0] : [0, 0, -1], i * 3);
      if (['corner', 'exclusions', 'outliers'].includes(kind) && x >= 45 && !f) {
        points[i * 3] = 0.85;
        points[i * 3 + 2] = 0.6 + (x - 40) * 0.04;
        normal.set([-1, 0, 0], i * 3);
      }
      if (kind === 'outliers' && (x * 7 + y * 11) % 47 === 0) points[i * 3 + 2] += 0.17;
      if (kind === 'empty') mask[i] = 0;
    }
  const dense = {
    width,
    height,
    points,
    normal,
    mask,
    depth: new Float32Array(n),
    intrinsics: { fx: 1, fy: 1, cx: 0.5, cy: 0.5 },
    diagnostics: {},
  } as MogeDensePrediction;
  const semantic: MogeSemanticInput = {
    width,
    height,
    floor,
    wall,
    regions:
      kind === 'exclusions'
        ? [
            {
              id: 'fixture',
              kind: 'mirror',
              source: 'inventory',
              bounds: { left: 0.4, top: 0.1, right: 0.6, bottom: 0.3 },
            },
          ]
        : [],
  };
  return { dense, semantic };
}
describe('MoGe browser postprocessing against actual offline Python reference execution', () => {
  for (const r of reference.postprocess)
    it(r.kind + ' ' + r.width + 'x' + r.height + ' known=' + r.known, () => {
      const input = raw(r.width, r.height, r.kind),
        before = input.points.slice(),
        a = r.width / r.height;
      const fov = r.known ? (2 * Math.atan(a / Math.sqrt(1 + a * a) / 0.93) * 180) / Math.PI : undefined;
      const actual = postprocessMoge(input, { fovXDegrees: fov });
      expect(input.points).toEqual(before);
      expect(actual.mask).toEqual(Uint8Array.from(r.mask));
      // scipy's ftol=1e-3 vs bounded scalar LM: 0.2% shift tolerance; FP32 arrays 0.5mm max.
      expect(Math.abs(actual.diagnostics.focal - r.focal)).toBeLessThan(0.0005);
      expect(Math.abs(actual.diagnostics.shift - r.shift)).toBeLessThan(0.0006);
      expect(actual.intrinsics.fx).toBeCloseTo(r.intrinsics[0][0], 3);
      expect(actual.intrinsics.fy).toBeCloseTo(r.intrinsics[1][1], 3);
      for (let i = 0; i < actual.mask.length; i++)
        if (actual.mask[i]) {
          expect(Math.abs(actual.depth[i] - r.depth[i])).toBeLessThan(0.0011);
          for (let j = 0; j < 3; j++) {
            expect(Math.abs(actual.points[i * 3 + j] - r.points[i * 3 + j])).toBeLessThan(0.0011);
            expect(actual.normal[i * 3 + j]).toBe(r.normal[i * 3 + j]);
          }
        } else {
          expect(actual.depth[i]).toBe(Infinity);
          expect(actual.points[i * 3]).toBe(Infinity);
          expect(actual.normal[i * 3 + 2]).toBe(0);
        }
    });
  it('torch nearest convention differs from semantic centre sampling', () => {
    const input = raw(128, 128, 'clean');
    const s = sampleFocalPoints(input);
    expect(s[0].z).toBe(input.points[2]);
    expect(s[1].z).toBe(input.points[2 * 3 + 2]);
    expect(s[64].z).toBe(input.points[2 * 128 * 3 + 2]);
  });
  it('scale exactly once and no second sigmoid/normalization', () => {
    const input = raw(24, 24, 'clean');
    input.mask[0] = 0.5;
    input.normal[5] = -0.98;
    const a = postprocessMoge({ ...input, metricScale: 1 }),
      b = postprocessMoge({ ...input, metricScale: 2 });
    expect(a.mask[0]).toBe(0);
    expect(b.depth[1]).toBe(Math.fround(a.depth[1] * 2));
    expect(b.normal[5]).toBe(input.normal[5]);
  });
  it('rejects wrong output activation/shape/fov; invalid pixels stay masked', () => {
    const input = raw(24, 24, 'clean');
    expect(() => postprocessMoge({ ...input, metricScale: 0 })).toThrow();
    expect(() => postprocessMoge({ ...input, mask: new Float32Array(1) })).toThrow();
    const p = input.mask.slice();
    p[0] = 2;
    expect(() => postprocessMoge({ ...input, mask: p })).toThrow();
    expect(() => postprocessMoge(input, { fovXDegrees: 180 })).toThrow();
  });
});
describe('semantic plane extraction port', () => {
  for (const r of reference.planes)
    it('Python plane/support reference: ' + r.kind, () => {
      const { dense, semantic } = planeFixture(r.kind),
        before = dense.points.slice(),
        actual = extractMogePlanes(dense, semantic),
        expected = r.observation;
      expect(dense.points).toEqual(before);
      expect(actual.evidence.candidateFiltering).toEqual(r.filtering);
      expect(!!actual.floor).toBe(!!expected.floor);
      expect(actual.walls).toHaveLength(expected.walls.length);
      const wanted = [...(expected.floor ? [expected.floor] : []), ...expected.walls],
        got = [...(actual.floor ? [actual.floor] : []), ...actual.walls];
      for (const p of wanted) {
        const nearest = got.reduce((a, b) =>
          Math.abs(b.normalCamera.reduce((s, v, i) => s + v * p.normalCamera[i], 0)) >
          Math.abs(a.normalCamera.reduce((s, v, i) => s + v * p.normalCamera[i], 0))
            ? b
            : a,
        );
        const dot = nearest.normalCamera.reduce((s, v, i) => s + v * p.normalCamera[i], 0);
        expect(dot).toBeGreaterThan(0.999999);
        expect(nearest.offset).toBeCloseTo(p.offset, 5);
        expect(nearest.inlierCount).toBe(p.inlierCount);
        expect(nearest.inlierFraction).toBeCloseTo(p.inlierFraction, 8);
        expect(nearest.rmsResidual).toBeCloseTo(p.rmsResidual, 6);
        expect(nearest.imageSupport).toEqual(p.imageSupport);
        nearest.medianPointCamera.forEach((v, i) => expect(v).toBeCloseTo(p.medianPointCamera[i], 6));
      }
    });
  it('eigensolver preserves a tilted plane normal and repeated eigenvalues', () => {
    const e = symmetricEigen3([2, -1, -1, -1, 2, -1, -1, -1, 2]);
    expect(e.values[0]).toBeCloseTo(0, 12);
    expect(e.values[1]).toBeCloseTo(3, 12);
    expect(Math.abs(e.vectors[0].reduce((s, v) => s + v / Math.sqrt(3), 0))).toBeCloseTo(1, 12);
    expect(symmetricEigen3([0, 0, 0, 0, 0, 0, 0, 0, 0]).values).toEqual([0, 0, 0]);
  });
  it('semantic conflicts and exclusions cannot add support', () => {
    const { dense, semantic } = planeFixture('single');
    semantic.wall.fill(255);
    const p = extractMogePlanes(dense, semantic);
    expect(p.floor).toBeNull();
    const fields = p.evidence.candidateFiltering as { cleanFloorPixels: number };
    expect(fields.cleanFloorPixels).toBe(0);
  });
  it('requires full-frame alignment and bounded binary masks', () => {
    const { dense, semantic } = planeFixture('single');
    expect(() => extractMogePlanes(dense, { ...semantic, width: 40 })).toThrow();
    semantic.floor[0] = 99;
    expect(() => extractMogePlanes(dense, semantic)).toThrow();
  });
});

it('rejects invalid map dimensions, bad normals and collinear support without inventing planes', () => {
  const { dense, semantic } = planeFixture('single');
  expect(() => extractMogePlanes({ ...dense, width: NaN }, semantic)).toThrow();
  const bad = { ...dense, normal: new Float32Array(dense.normal.length) };
  expect(extractMogePlanes(bad, semantic).floor).toBeNull();
  expect(extractMogePlanes(bad, semantic).walls).toHaveLength(0);
  const line = { ...dense, points: new Float32Array(dense.points.length) };
  for (let i = 0; i < dense.width * dense.height; i++) line.points.set([i * 0.001, 0, 2], i * 3);
  expect(extractMogePlanes(line, semantic).floor).toBeNull();
  expect(extractMogePlanes(line, semantic).walls).toHaveLength(0);
});
it('restarts deterministic browser sampling for each independent call', () => {
  const { dense, semantic } = planeFixture('outliers');
  const a = extractMogePlanes(dense, semantic),
    b = extractMogePlanes(dense, semantic);
  expect(a.floor).toEqual(b.floor);
  expect(a.walls).toEqual(b.walls);
  expect(a.labels).toEqual(b.labels);
  expect(a.evidence).toEqual(b.evidence);
});
