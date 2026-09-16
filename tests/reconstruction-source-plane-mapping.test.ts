import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { homography, transformPoint } from '../src/lib/render/math';
import { DEFAULT_ROOM } from '../src/lib/room-geometry';
import { estimateCandidateFixture } from '../src/lib/reconstruction';
import {
  inspectReconstructionCandidateMapping,
  mapReconstructionCandidate,
} from '../src/lib/reconstruction/installation';
import {
  hasPhysicalFloorExtent,
  projectSourcePlanePoint,
} from '../src/lib/reconstruction/source-plane-mapping';
import type {
  ReconstructionCandidate,
  ReconstructionPlane,
  ReconstructionReview,
} from '../src/lib/reconstruction/types';
import type { Quad } from '../src/lib/types';

const quad: Quad = [
  { x: 0.15, y: 0.3 },
  { x: 0.75, y: 0.25 },
  { x: 0.9, y: 0.9 },
  { x: 0.05, y: 0.95 },
];
const floor = (patch: Partial<ReconstructionPlane> = {}): ReconstructionPlane => ({
  id: 'floor',
  face: 'floor',
  quad,
  geometrySource: 'room-boundaries',
  depthStart: 0.1,
  depthEnd: 0.8,
  horizontalStart: 0.2,
  horizontalEnd: 0.9,
  confirmed: false,
  tile: { color: '#aaaaaa', widthMm: 300, heightMm: 300, groutWidth: 2, estimated: true },
  ...patch,
});
const candidate = (patch: Partial<ReconstructionCandidate> = {}): ReconstructionCandidate => ({
  id: 'toilet',
  kind: 'toilet',
  source: 'deeplab',
  bounds: { left: 0.2, top: 0.2, right: 0.6, bottom: 0.8 },
  foot: { x: 0.4, y: 0.7 },
  pixels: 1000,
  evidence: { semanticPixels: 1000, meanMargin: 5 },
  color: '#eeeedd',
  status: 'unplaced',
  installation: { mode: 'floor', source: 'inferred', reason: 'category floor estimate' },
  ...patch,
});
const review = (planes: ReconstructionPlane[]): ReconstructionReview => ({
  version: 2,
  analysis: 'partial',
  planes,
  candidates: [],
  warnings: [],
});

describe('declared source plane coordinate contract', () => {
  it.each([0, 1, 2, 3])(
    'respects declared corner order even when photo is rotated %i quarter turns',
    (turns) => {
      const rotated = quad.map((point) => {
        let p = point;
        for (let i = 0; i < turns; i++) p = { x: 1 - p.y, y: p.x };
        return p;
      }) as Quad;
      const source = transformPoint(
        homography(
          [
            { x: 0, y: 0 },
            { x: 1, y: 0 },
            { x: 1, y: 1 },
            { x: 0, y: 1 },
          ],
          rotated,
        ),
        { x: 0.3, y: 0.65 },
      );
      const result = projectSourcePlanePoint(floor({ quad: rotated }), source)!;
      expect(result.uv.x).toBeCloseTo(0.3, 10);
      expect(result.uv.y).toBeCloseTo(0.65, 10);
      expect(result.position.u).toBeCloseTo(0.41, 10);
      expect(result.position.v).toBeCloseTo(0.555, 10);
      expect(result.inside).toBe(true);
    },
  );
  it.each(['floor', 'back', 'left', 'right'] as const)(
    'keeps out-of-plane values exact without clipping: %s',
    (face) => {
      const p = floor({ face, verticalStart: 0.2, verticalEnd: 0.8 });
      const point = transformPoint(
        homography(
          [
            { x: 0, y: 0 },
            { x: 1, y: 0 },
            { x: 1, y: 1 },
            { x: 0, y: 1 },
          ],
          quad,
        ),
        { x: -0.02, y: 1.02 },
      );
      const result = projectSourcePlanePoint(p, point)!;
      expect(result.uv.x).toBeCloseTo(-0.02, 10);
      expect(result.uv.y).toBeCloseTo(1.02, 10);
      expect(result.inside).toBe(false);
      if (face === 'floor') {
        expect(result.position.u).toBeCloseTo(0.186);
        expect(result.position.v).toBeCloseTo(0.814);
      } else expect(result.position.v).toBeCloseTo(0.812);
    },
  );
  it('maps a declared partial back wall width, height and opposing side-wall depth consistently', () => {
    const point = transformPoint(
      homography(
        [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 1, y: 1 },
          { x: 0, y: 1 },
        ],
        quad,
      ),
      { x: 0.25, y: 0.5 },
    );
    const back = projectSourcePlanePoint(
      floor({ face: 'back', verticalStart: 0.2, verticalEnd: 0.6 }),
      point,
    )!.position;
    expect(back.face).toBe('back');
    expect(back.u).toBeCloseTo(0.375, 10);
    expect(back.v).toBeCloseTo(0.4, 10);
    const left = projectSourcePlanePoint(floor({ face: 'left' }), point)!.position;
    const right = projectSourcePlanePoint(floor({ face: 'right' }), point)!.position;
    expect(left.u).toBeCloseTo(0.375);
    expect(right.u).toBeCloseTo(0.275);
  });
  it.each([undefined, 'visible-floor-region', 'appearance-region'] as const)(
    'does not promote %s floor extent to a room mapping',
    (geometrySource) => {
      const p = floor({ geometrySource });
      const c = candidate();
      const r = review([p]);
      const snapshot = structuredClone({ c, r });
      const result = inspectReconstructionCandidateMapping(c, r);
      expect(hasPhysicalFloorExtent(p)).toBe(false);
      expect(result.placement).toBeUndefined();
      expect(result.provisionalPlacement).toEqual(projectSourcePlanePoint(p, c.foot)!.position);
      expect(result.reasons.join(' ')).toContain('대응 범위는 미확정');
      expect({ c, r }).toEqual(snapshot);
      expect(mapReconstructionCandidate(c, review([{ ...p, confirmed: true }]))).toEqual(
        result.provisionalPlacement,
      );
    },
  );
  it('does not infer a front floor contact from the bottom of a cropped photograph', () => {
    const c = candidate({ bounds: { left: 0.2, top: 0.2, right: 0.6, bottom: 1 } });
    const result = inspectReconstructionCandidateMapping(c, review([floor()]));
    expect(result.placement).toBeUndefined();
    expect(result.provisionalPlacement).toBeDefined();
    expect(result.reasons.join(' ')).toContain('사진 경계');
  });
  it('keeps an out-of-plane projection for review but refuses it as a placement', () => {
    const c = candidate({
      foot: transformPoint(
        homography(
          [
            { x: 0, y: 0 },
            { x: 1, y: 0 },
            { x: 1, y: 1 },
            { x: 0, y: 1 },
          ],
          quad,
        ),
        { x: -0.02, y: 0.5 },
      ),
    });
    const result = inspectReconstructionCandidateMapping(c, review([floor()]));
    expect(result.placement).toBeUndefined();
    expect(result.provisionalPlacement!.u).toBeCloseTo(0.186);
    expect(result.reasons.join(' ')).toContain('평면 밖');
  });
  it('does not infer fixture orientation from an overlapping appearance rectangle', () => {
    const c = candidate();
    const appearance = floor({ face: 'right', geometrySource: 'appearance-region' });
    const estimate = estimateCandidateFixture(c, review([floor(), appearance]), DEFAULT_ROOM, {
      face: 'floor',
      u: 0.5,
      v: 0.5,
    });
    expect(estimate.orientation).toBe('back');
    expect(estimate.provenance.wall).toBe('default');
    expect(estimate.u).toBe(0.5);
    expect(estimate.v).toBeCloseTo(0.5 - estimate.depthMm / 4800);
  });
  it('applies half-depth once along an explicitly supported installation direction', () => {
    for (const face of ['left', 'back', 'right'] as const) {
      const c = candidate({
        installation: { mode: 'floor', wall: face, source: 'inferred', reason: 'independent wall evidence' },
      });
      const estimate = estimateCandidateFixture(c, review([floor(), floor({ face })]), DEFAULT_ROOM, {
        face: 'floor',
        u: 0.5,
        v: 0.5,
      });
      expect(estimate.orientation).toBe(face);
      expect(estimate.provenance.wall).toBe('inferred');
      expect(estimate.u).toBeCloseTo(
        0.5 + ((face === 'left' ? -1 : face === 'right' ? 1 : 0) * estimate.depthMm) / 4800,
      );
      expect(estimate.v).toBeCloseTo(0.5 - (face === 'back' ? estimate.depthMm / 4800 : 0));
    }
  });
  it('respects user-confirmed orientation even when that wall has no photographed plane', () => {
    const c = candidate({
      installation: { mode: 'floor', wall: 'left', source: 'user', reason: 'selected left wall' },
    });
    const result = estimateCandidateFixture(c, review([floor()]), DEFAULT_ROOM, {
      face: 'floor',
      u: 0.5,
      v: 0.5,
    });
    expect(result.orientation).toBe('left');
    expect(result.provenance.wall).toBe('user');
    expect(result.u).toBeCloseTo(0.5 - result.depthMm / 4800);
    expect(result.v).toBe(0.5);
  });
  it('estimates a mirror width from the declared partial back-wall width instead of the whole room', () => {
    const p = floor({
      face: 'back',
      horizontalStart: 0.2,
      horizontalEnd: 0.8,
      quad: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
        { x: 0, y: 1 },
      ],
    });
    const c = candidate({
      kind: 'mirror',
      bounds: { left: 0.2, right: 0.5, top: 0.2, bottom: 0.6 },
      installation: { mode: 'wall', wall: 'back', source: 'inferred', reason: 'physical back wall' },
    });
    const placement = mapReconstructionCandidate(c, review([p]))!;
    const result = estimateCandidateFixture(c, review([p]), DEFAULT_ROOM, placement);
    // 0.3 of a 0.6 * 2400 mm declared interval, rounded to the existing 10 mm template increment.
    expect(result.widthMm).toBe(430);
    expect(result.provenance.width).toBe('inferred');
    expect(placement.u).toBeCloseTo(0.2 + 0.35 * 0.6);
  });
  it.each([
    { depthStart: 0.8, depthEnd: 0.1 },
    { horizontalStart: NaN },
    { quad: [quad[0], quad[0], quad[2], quad[3]] as Quad },
  ])('rejects invalid plane data instead of normalizing it', (patch) =>
    expect(projectSourcePlanePoint(floor(patch), { x: 0.5, y: 0.5 })).toBeUndefined(),
  );
});

describe('saved actual observations, no new AI inference', () => {
  it.each(['user-01', 'user-02', 'user-03', 'user-04', 'prospective-03'])(
    'records the unconfirmed source-floor cause without changing %s',
    (id) => {
      const data = JSON.parse(
        readFileSync(
          `test-results/reconstruction-product-color-20260914/actual-baseline/${id}/baseline.json`,
          'utf8',
        ),
      );
      const r = data.rawReview as ReconstructionReview;
      const before = JSON.stringify(r);
      const candidates = r.candidates.filter((c) => !c.requiresReview && c.installation?.mode === 'floor');
      expect(candidates.length).toBeGreaterThan(0);
      for (const c of candidates) {
        const result = inspectReconstructionCandidateMapping(c, r);
        expect(result.placement).toBeUndefined();
        expect(result.provisionalPlacement).toBeDefined();
        expect(result.reasons.join(' ')).toContain('대응 범위는 미확정');
      }
      expect(JSON.stringify(r)).toBe(before);
    },
  );
});
