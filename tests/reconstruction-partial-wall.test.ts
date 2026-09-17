import { describe, expect, it } from 'vitest';
import { inferPartialBackWall, type ObservedCeiling } from '../src/lib/reconstruction/partial-wall-geometry';
import { reviewFromSegmentation } from '../src/lib/reconstruction/analysis';
import { buildCandidatePipeline } from '../src/lib/reconstruction/candidate-pipeline';
import { reconstructionReviewSchema } from '../src/lib/storage/validation';
import { DEFAULT_ROOM } from '../src/lib/room-geometry';
import type { SceneUnderstanding } from '../src/lib/reconstruction/pipeline-contract';

const ceiling: ObservedCeiling = {
  rearLeft: 0.25,
  rearRight: 0.75,
  level: 0.12,
  vanishing: { x: 0.5, y: 0.24 },
};
function room(flat = false) {
  const width = 240,
    height = 200;
  const wall = new Uint8Array(width * height),
    floor = wall.slice();
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width,
        v = (y + 0.5) / height,
        i = y * width + x;
      const ceilingY = u < 0.25 ? u * 0.48 : u > 0.75 ? (1 - u) * 0.48 : 0.12;
      const floorY = u < 0.25 ? 0.72 + (0.25 - u) : u > 0.75 ? 0.72 + (u - 0.75) : 0.72;
      // A cabinet hides the left wall-floor corner. Its front is not a room boundary.
      const cabinet = u > 0.08 && u < 0.4 && v > 0.5 && v < 0.94;
      const mirror = u > 0.43 && u < 0.57 && v > 0.25 && v < 0.45;
      wall[i] = v >= ceilingY && v < floorY && !cabinet && !mirror ? 255 : 0;
      floor[i] = v >= floorY && !cabinet ? 255 : 0;
      const color = flat
        ? 180
        : cabinet
          ? 60
          : mirror
            ? 25
            : v < ceilingY
              ? 235
              : v >= floorY
                ? 80
                : u < 0.25
                  ? 115
                  : u > 0.75
                    ? 145
                    : 200;
      rgba.set([color, color, color, 255], i * 4);
    }
  return { width, height, wall, floor, rgba };
}

describe('partial rear-wall geometry from independently observed lines', () => {
  it('recovers only the back plane while a cabinet hides the side-floor corner', () => {
    const input = room(),
      original = input.wall.slice();
    const result = inferPartialBackWall(input, ceiling)!;
    expect(result).toBeDefined();
    expect(result.quad[0].x).toBeCloseTo(0.25, 1);
    expect(result.quad[1].x).toBeCloseTo(0.75, 1);
    expect(result.quad[2].y).toBeCloseTo(0.72, 1);
    expect(result.quad[3].y).toBeCloseTo(0.72, 1);
    expect(result.evidence.cornerSource).toBe('line-intersections');
    expect(result.evidence.lines.map((p) => p.role)).toEqual([
      'ceiling',
      'floor',
      'left-junction',
      'right-junction',
    ]);
    expect(result.evidence.lines.find((line) => line.role === 'floor')!.a.x).toBeGreaterThan(0.39);
    expect(input.wall).toEqual(original);
  });

  it('does not infer a wall from semantic masks without RGB junction support', () => {
    expect(inferPartialBackWall(room(true), ceiling)).toBeUndefined();
  });

  it('does not fabricate a cropped ceiling or accept a missing observation', () => {
    expect(inferPartialBackWall(room())).toBeUndefined();
    expect(inferPartialBackWall(room(), { ...ceiling, level: 0 })).toBeUndefined();
    const input = room();
    for (let y = 0; y < input.height * 0.14; y++)
      input.wall.fill(255, y * input.width, (y + 1) * input.width);
    expect(inferPartialBackWall(input, ceiling)).toBeUndefined();
  });

  it('requires a broad floor junction rather than a small furniture-foot gap', () => {
    const input = room();
    for (let i = 0; i < input.floor.length; i++)
      if ((i % input.width) / input.width < 0.49 || (i % input.width) / input.width > 0.53)
        input.floor[i] = 0;
    expect(inferPartialBackWall(input, ceiling)).toBeUndefined();
  });

  it('requires both independently supported wall junctions', () => {
    const input = room();
    for (let y = 0; y < input.height; y++)
      for (let x = Math.floor(input.width * 0.7); x < input.width; x++) input.wall[y * input.width + x] = 0;
    expect(inferPartialBackWall(input, ceiling)).toBeUndefined();
  });

  it('keeps malformed raster data and out-of-frame ceiling evidence out', () => {
    expect(inferPartialBackWall({ ...room(), width: 800 }, ceiling)).toBeUndefined();
    expect(inferPartialBackWall(room(), { ...ceiling, rearLeft: -0.2 })).toBeUndefined();
    expect(inferPartialBackWall(room(), { ...ceiling, vanishing: { x: NaN, y: 0 } })).toBeUndefined();
  });

  it('connects a recovered back wall to placement while source camera and side walls remain unresolved', () => {
    const input = room();
    const object = {
      id: 'synthetic-window',
      kind: 'window' as const,
      source: 'deeplab' as const,
      bounds: { left: 0.44, top: 0.26, right: 0.56, bottom: 0.44 },
      foot: { x: 0.5, y: 0.44 },
      pixels: 1000,
      color: '#eeeeee',
      status: 'unplaced' as const,
      evidence: { semanticPixels: 1000, meanMargin: 4 },
    };
    const review = reviewFromSegmentation({ ...input, objects: [object] }, input.rgba, DEFAULT_ROOM);
    const plane = review.planes.find((p) => p.face === 'back')!;
    expect(plane.geometryEvidence?.method).toBe('ceiling-wall-floor-lines');
    expect(plane.geometrySource).toBe('room-boundaries');
    expect(plane.confirmed).toBe(false);
    expect(
      reconstructionReviewSchema.parse(review).planes.find((p) => p.face === 'back')?.geometryEvidence,
    ).toEqual(plane.geometryEvidence);
    expect(plane.verticalStart).toBe(0);
    expect(plane.verticalEnd).toBe(1);
    expect(
      review.planes
        .filter((p) => ['left', 'right'].includes(p.face))
        .every((p) => p.geometrySource === 'appearance-region'),
    ).toBe(true);
    const understanding: SceneUnderstanding = {
      schemaVersion: 1,
      candidates: [
        {
          id: 'window',
          kind: 'window',
          bounds: { ...object.bounds },
          mounting: 'wall',
          wall: 'unknown',
          basinStyle: 'unknown',
          shape: 'rectangular',
          reflection: 'physical',
          evidence: ['synthetic fixture'],
          uncertainty: [],
        },
      ],
      relations: [],
      roomLayout: {
        orthogonal: 'unknown',
        backWallQuad: null,
        corners: [],
        lines: [],
        evidence: [],
        uncertainty: [],
      },
    };
    const result = buildCandidatePipeline(understanding, review, DEFAULT_ROOM, input);
    expect(result.pipeline.camera.status).toBe('held');
    expect(result.plans.window).toMatchObject({
      kind: 'window',
      face: 'back',
      provenance: { position: 'inferred' },
    });
    expect(result.pipeline.understanding.candidates[0].wall).toBe('unknown');
    expect(result.pipeline.placements[0].derivedInstallation).toMatchObject({
      wall: 'back',
      source: 'geometry',
    });
  });
});
