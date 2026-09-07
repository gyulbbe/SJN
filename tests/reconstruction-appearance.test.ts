import { describe, expect, it } from 'vitest';
import {
  analyzePlaneAppearanceDetails,
  alignedReconstructionFloor,
  continueObservedWallBands,
  mapReconstructionCandidate,
  observedWallPlanes,
  periodicLineSpacing,
  reviewFromSegmentation,
} from '../src/lib/reconstruction/analysis';
import { DEFAULT_ROOM } from '../src/lib/room-geometry';
import type { ReconstructionCandidate, ReconstructionPlane } from '../src/lib/reconstruction/types';

const base: ReconstructionPlane = {
  id: 'wall',
  face: 'back',
  quad: [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ],
  depthStart: 0,
  depthEnd: 1,
  confirmed: false,
  tile: { color: '#bbbbbb', widthMm: 300, heightMm: 600, groutWidth: 0, estimated: true },
};
function halfTiledWall() {
  const width = 192,
    height = 192,
    rgba = new Uint8ClampedArray(width * height * 4),
    mask = new Uint8Array(width * height).fill(255);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const tiled = y >= 96,
        grout = tiled && (x % 12 === 6 || y % 12 === 6);
      rgba.set(
        grout ? [186, 213, 202, 255] : tiled ? [116, 151, 144, 255] : [153, 179, 171, 255],
        (y * width + x) * 4,
      );
      if (x >= 66 && x < 126 && y > 20 && y < 135) mask[y * width + x] = 0;
    }
  return { width, height, rgba, mask };
}
describe('observed wall appearance reconstruction', () => {
  it('detects bright grout as well as dark grout while rejecting isolated trim lines', () => {
    expect(
      periodicLineSpacing(Array.from({ length: 192 }, (_, i) => (i % 16 === 8 ? 210 : 170))),
    ).toBeCloseTo(16 / 192, 2);
    expect(
      periodicLineSpacing(Array.from({ length: 192 }, (_, i) => (i % 16 === 8 ? 140 : 170))),
    ).toBeCloseTo(16 / 192, 2);
    expect(
      periodicLineSpacing(Array.from({ length: 192 }, (_, i) => (i === 95 ? 230 : 170))),
    ).toBeUndefined();
  });
  it('preserves a plain upper wall and small bright-grout tiles below despite a large occluding window', () => {
    const result = analyzePlaneAppearanceDetails({ plane: base, room: DEFAULT_ROOM, ...halfTiledWall() });
    expect(result.tile.groutWidth).toBe(2);
    expect(result.tile.widthMm).toBeCloseTo(150, -1);
    expect(result.bands).toHaveLength(2);
    const [top, bottom] = result.bands!;
    expect(top.tile.groutWidth).toBe(0);
    expect(bottom.tile.groutWidth).toBe(2);
    expect(top.to).toBeGreaterThan(0.42);
    expect(top.to).toBeLessThan(0.6);
    expect(top.tile.color).toBe('#99b3ab');
    expect(bottom.tile.color).toBe('#749790');
    expect(bottom.tile.groutColor).not.toBe(bottom.tile.color);
  });
  it('keeps visible wall colours and a mapped window when floor corner inference is unavailable', () => {
    const width = 160,
      height = 160,
      rgba = new Uint8ClampedArray(width * height * 4),
      wall = new Uint8Array(width * height),
      floor = new Uint8Array(width * height);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        rgba.set([141, 175, 171, 255], (y * width + x) * 4);
        if (y >= 15 && y < 112 && !(x > 53 && x < 105 && y > 25 && y < 70)) wall[y * width + x] = 255;
      }
    const candidate: ReconstructionCandidate = {
      id: 'window',
      kind: 'window',
      bounds: { left: 0.34, right: 0.66, top: 0.16, bottom: 0.44 },
      foot: { x: 0.5, y: 0.44 },
      pixels: 2300,
      evidence: { semanticPixels: 2300, meanMargin: 8 },
      color: '#eeeedd',
      status: 'unplaced',
    };
    const review = reviewFromSegmentation(
      { width, height, wall, floor, objects: [candidate] },
      rgba,
      DEFAULT_ROOM,
    );
    expect(review.analysis).toBe('partial');
    expect(review.planes.some((p) => p.face === 'back' && p.tile.color === '#8dafab')).toBe(true);
    expect(mapReconstructionCandidate(candidate, review)?.face).toBe('back');
    expect(review.warnings.some((w) => w.includes('관측된 벽 색'))).toBe(true);
    expect(mapReconstructionCandidate({ ...candidate, requiresReview: true }, review)).toBeUndefined();
  });
  it('uses the visible ceiling junctions before stronger local lamp or mirror colour boundaries', () => {
    const width = 200,
      height = 200,
      rgba = new Uint8ClampedArray(width * height * 4),
      wall = new Uint8Array(width * height),
      floor = new Uint8Array(width * height);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const ceiling = x < 40 || x > 160 ? 0 : 12;
        rgba.set(
          x < 15
            ? [218, 216, 165, 255]
            : x < 40
              ? [145, 180, 169, 255]
              : x > 160
                ? [130, 164, 159, 255]
                : [140, 172, 167, 255],
          (y * width + x) * 4,
        );
        if (y >= ceiling && y < 145) wall[y * width + x] = 255;
      }
    const result = observedWallPlanes({ width, height, wall, floor }, rgba);
    expect(result.map((p) => p.face)).toEqual(['left', 'back', 'right']);
    const back = result.find((p) => p.face === 'back')!;
    expect(back.quad[0].x).toBeCloseTo(0.2, 1);
    expect(back.quad[1].x).toBeCloseTo(0.8, 1);
  });
  it('does not invent a wall or grid from an empty mask', () => {
    expect(
      observedWallPlanes(
        { width: 64, height: 64, wall: new Uint8Array(4096), floor: new Uint8Array(4096) },
        new Uint8ClampedArray(4096 * 4),
      ),
    ).toEqual([]);
  });
  it('uses ceiling perspective and observed floor contact instead of a furniture silhouette for physical placement', () => {
    const width = 240,
      height = 240,
      wall = new Uint8Array(width * height),
      floor = new Uint8Array(width * height);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const u = x / width,
          v = y / height;
        const ceiling = u < 0.22 ? 0.08 + (u - 0.22) * 1.1 : u > 0.8 ? 0.08 - (u - 0.8) * 1.05 : 0.08;
        if (v >= Math.max(0, ceiling) && v < 0.7) wall[y * width + x] = 255;
        if (v >= 0.7 && !(u > 0.15 && u < 0.4 && v < 0.88)) floor[y * width + x] = 255;
      }
    const back = {
      ...structuredClone(base),
      quad: [
        { x: 0.22, y: 0.08 },
        { x: 0.8, y: 0.08 },
        { x: 0.8, y: 0.7 },
        { x: 0.22, y: 0.7 },
      ] as ReconstructionPlane['quad'],
    };
    const original = {
      ...structuredClone(base),
      face: 'floor' as const,
      depthEnd: 0.65,
      quad: [
        { x: 0.4, y: 0.7 },
        { x: 0.88, y: 0.7 },
        { x: 1, y: 1 },
        { x: 0.25, y: 1 },
      ] as ReconstructionPlane['quad'],
    };
    const aligned = alignedReconstructionFloor({ width, height, wall, floor }, [back], original);
    expect(aligned).not.toEqual(original);
    expect(aligned.horizontalStart).toBeGreaterThanOrEqual(0);
    expect(aligned.horizontalEnd).toBeLessThanOrEqual(1);
    expect(aligned.quad.every((p) => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1)).toBe(true);
    const candidate: ReconstructionCandidate = {
      id: 'toilet',
      kind: 'toilet',
      bounds: { left: 0.6, right: 0.72, top: 0.4, bottom: 0.75 },
      foot: { x: 0.67, y: 0.75 },
      pixels: 900,
      evidence: { semanticPixels: 900, meanMargin: 9 },
      color: '#eeeeee',
      status: 'unplaced',
    };
    const mapped = mapReconstructionCandidate(candidate, {
      version: 1,
      planes: [aligned],
      candidates: [candidate],
      warnings: [],
      analysis: 'partial',
    });
    expect(mapped?.u).toBeGreaterThan(0.65);
    expect(
      alignedReconstructionFloor(
        { width, height, wall: new Uint8Array(width * height), floor },
        [back],
        original,
      ),
    ).toEqual(original);
  });
  it('recovers faint floor grout despite a rug and compression-scale subpeaks', () => {
    const width = 192,
      height = 192,
      rgba = new Uint8ClampedArray(width * height * 4),
      mask = new Uint8Array(width * height).fill(255);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const ridge =
          Math.max(
            Math.exp(-Math.pow(((x % 12) - 6) / 1.2, 2)),
            Math.exp(-Math.pow(((y % 12) - 6) / 1.2, 2)),
          ) * 6;
        const noise = Math.sin(x * 2.1 + y * 1.7) * 0.8;
        const rug = x > 15 && x < 95 && y > 20 && y < 151;
        const rgb = rug
          ? [157 + Math.sin(y * 0.3) * 3, 165, 151]
          : [190 + ridge + noise, 181 + ridge + noise, 168 + ridge + noise];
        rgba.set([...rgb, 255], (y * width + x) * 4);
      }
    const result = analyzePlaneAppearanceDetails({
      plane: { ...structuredClone(base), face: 'floor' },
      room: DEFAULT_ROOM,
      rgba,
      width,
      height,
      mask,
    });
    expect(result.tile.groutWidth).toBe(2);
    expect(result.tile.widthMm).toBeGreaterThan(100);
    expect(result.tile.widthMm).toBeLessThan(220);
    expect(result.tile.heightMm).toBeGreaterThan(100);
    expect(result.tile.heightMm).toBeLessThan(220);
  });
  it('requires a visible matching cap strip before extending a neighbouring tile band', () => {
    const input = halfTiledWall();
    const appearance = analyzePlaneAppearanceDetails({ plane: base, room: DEFAULT_ROOM, ...input });
    const rear = { ...structuredClone(base), bands: appearance.bands };
    const side = { ...structuredClone(base), id: 'side', face: 'left' as const };
    continueObservedWallBands([rear, side], input.rgba, {
      width: input.width,
      height: input.height,
      wall: input.mask,
      floor: new Uint8Array(input.mask.length),
    });
    expect(side.bands).toHaveLength(2);
    const plain = new Uint8ClampedArray(input.rgba.length);
    for (let i = 0; i < input.mask.length; i++) plain.set([153, 179, 171, 255], i * 4);
    const unobserved = { ...structuredClone(base), id: 'plain-side', face: 'left' as const };
    continueObservedWallBands([rear, unobserved], plain, {
      width: input.width,
      height: input.height,
      wall: input.mask,
      floor: new Uint8Array(input.mask.length),
    });
    expect(unobserved.bands).toBeUndefined();
  });
});
