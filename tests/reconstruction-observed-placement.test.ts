import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { DEFAULT_ROOM, roomFacePoint } from '../src/lib/room-geometry';
import { buildCandidatePipeline } from '../src/lib/reconstruction/candidate-pipeline';
import {
  inspectObservedPlacement,
  inspectObservedInstallation,
  reuseObservedPlacement,
} from '../src/lib/reconstruction/observed-placement';
import type { SceneCandidate, SceneUnderstanding } from '../src/lib/reconstruction/pipeline-contract';
import { reconstructionDefaults, type ReconstructionReview } from '../src/lib/reconstruction/types';
import { reconstructionModelTransform } from '../src/lib/reconstruction/projection';

const room = { ...DEFAULT_ROOM };
function sample(wall = false) {
  const candidate: SceneCandidate = {
    id: 'qwen-observation',
    kind: wall ? 'basin' : 'toilet',
    bounds: { left: 0.4, top: wall ? 0.35 : 0.55, right: 0.6, bottom: wall ? 0.55 : 0.8 },
    mounting: wall ? 'wall' : 'floor',
    wall: wall ? 'back' : 'unknown',
    basinStyle: wall ? 'wall' : 'unknown',
    shape: wall ? 'round' : 'unknown',
    reflection: 'physical',
    evidence: ['synthetic independent observation'],
    uncertainty: [],
  };
  const baseline: ReconstructionReview = {
    version: 2,
    analysis: 'partial',
    warnings: [],
    candidates: [
      {
        id: 'semantic-observation',
        kind: candidate.kind as 'basin' | 'toilet',
        bounds: { ...candidate.bounds },
        foot: { x: 0.5, y: candidate.bounds.bottom },
        source: 'deeplab',
        status: 'unplaced',
        color: '#ddd',
        pixels: 1000,
        evidence: { semanticPixels: 1000, meanMargin: 3 },
        installation: {
          mode: wall ? 'wall' : 'floor',
          wall: wall ? 'back' : undefined,
          basinVariant: wall ? 'wall' : undefined,
          source: 'inferred',
          reason: 'observed support',
        },
      },
    ],
    planes: [
      {
        id: 'observed-room-plane',
        face: wall ? 'back' : 'floor',
        geometrySource: 'room-boundaries',
        quad: [
          { x: 0.1, y: wall ? 0.1 : 0.5 },
          { x: 0.9, y: wall ? 0.1 : 0.5 },
          { x: 0.9, y: 0.9 },
          { x: 0.1, y: 0.9 },
        ],
        depthStart: 0,
        depthEnd: 1,
        verticalStart: 0,
        verticalEnd: 1,
        confirmed: false,
        tile: { color: '#ddd', widthMm: 300, heightMm: 300, groutWidth: 2, estimated: true },
      },
    ],
  };
  const understanding: SceneUnderstanding = {
    schemaVersion: 1,
    candidates: [candidate],
    relations: [],
    roomLayout: {
      orthogonal: 'unknown',
      backWallQuad: null,
      evidence: [],
      uncertainty: [],
      lines: [],
      corners: [],
    },
  };
  return { candidate, baseline, understanding };
}

describe('reuse independent observed placement without claiming source camera recovery', () => {
  it('reuses a single matched floor contact and preserves the raw scene and held camera', () => {
    const { candidate, baseline, understanding } = sample();
    const original = structuredClone({ baseline, understanding });
    const result = buildCandidatePipeline(understanding, baseline, room, { width: 800, height: 800 });
    expect(result.pipeline.camera.status).toBe('held');
    expect(result.pipeline.camera.camera).toBeUndefined();
    expect(result.plans[candidate.id]).toMatchObject({
      kind: 'toilet',
      face: 'floor',
      baseHeightMm: 0,
      provenance: { kind: 'model', position: 'inferred', dimensions: 'default' },
    });
    expect(result.pipeline.placements[0].baselineEvidence).toMatchObject({
      candidateId: 'semantic-observation',
      planeId: 'observed-room-plane',
      intersectionOverUnion: 1,
    });
    expect(result.pipeline.placements[0].reprojectionErrorPx).toBeUndefined();
    expect(result.pipeline.modelChecks[0].source).toBe('room-only');
    expect({ baseline, understanding }).toEqual(original);
  });
  it('uses a wall observation with explicit extent for bottom height and keeps observed round shape', () => {
    const { candidate, baseline, understanding } = sample(true);
    const result = buildCandidatePipeline(understanding, baseline, room, { width: 800, height: 800 });
    expect(result.plans[candidate.id]).toMatchObject({
      face: 'back',
      basinVariant: 'wall',
      basinShape: 'round',
    });
    expect(result.plans[candidate.id]?.baseHeightMm).toBeCloseTo(room.heightMm * 0.4375);
  });
  it.each(['appearance-region', undefined] as const)('does not promote %s to room geometry', (source) => {
    const { candidate, baseline } = sample(true);
    baseline.planes[0].geometrySource = source;
    expect(reuseObservedPlacement(candidate, [candidate], baseline, room)).toBeUndefined();
  });
  it('requires actual wall extent and consistent known supporting wall', () => {
    const { candidate, baseline } = sample(true);
    candidate.wall = 'left';
    expect(reuseObservedPlacement(candidate, [candidate], baseline, room)).toBeUndefined();
    candidate.wall = 'back';
    delete baseline.planes[0].verticalStart;
    expect(reuseObservedPlacement(candidate, [candidate], baseline, room)).toBeUndefined();
  });
  it('does not use a cropped floor contact, incompatible support or a held semantic fragment', () => {
    for (const reason of ['crop', 'support', 'held', 'fragment'] as const) {
      const { candidate, baseline } = sample();
      if (reason === 'crop') candidate.bounds.bottom = 1;
      if (reason === 'support') candidate.mounting = 'ceiling';
      if (reason === 'held') baseline.candidates[0].requiresReview = true;
      if (reason === 'fragment') baseline.candidates[0].evidence.meanMargin = 0;
      expect(reuseObservedPlacement(candidate, [candidate], baseline, room), reason).toBeUndefined();
    }
  });
  it('requires one-to-one identity rather than sharing a single contact among two objects', () => {
    const { candidate, baseline } = sample();
    const other = { ...candidate, id: 'second-object' };
    expect(reuseObservedPlacement(candidate, [candidate, other], baseline, room)).toBeUndefined();
    baseline.candidates.push({ ...baseline.candidates[0], id: 'second-semantic' });
    expect(reuseObservedPlacement(candidate, [candidate], baseline, room)).toBeUndefined();
  });
  it('never resolves reflection, invalid observations or contradictory room geometry by fallback', () => {
    for (const reason of ['reflection', 'invalid', 'room'] as const) {
      const { candidate, baseline, understanding } = sample();
      if (reason === 'reflection') candidate.reflection = 'uncertain';
      if (reason === 'invalid')
        candidate.validation = {
          status: 'needs-review',
          issues: [{ code: 'test', message: 'invalid support' }],
        };
      if (reason === 'room') understanding.roomLayout.orthogonal = false;
      const result = buildCandidatePipeline(understanding, baseline, room, { width: 800, height: 800 });
      expect(result.plans[candidate.id], reason).toBeNull();
      expect(result.pipeline.placements[0].baselineEvidence).toBeUndefined();
    }
  });
  it('manual correction overrides reuse and removes the borrowed contact provenance', () => {
    const { candidate, baseline, understanding } = sample();
    const result = buildCandidatePipeline(
      understanding,
      baseline,
      room,
      { width: 800, height: 800 },
      { [candidate.id]: { face: 'floor', u: 0.6, v: 0.5, baseHeightMm: 0 } },
    );
    expect(result.plans[candidate.id]?.provenance?.position).toBe('user');
    expect(result.pipeline.placements[0].baselineEvidence).toBeUndefined();
  });
});

describe('uncalibrated visible floor regions', () => {
  it('keeps the observation and holds physical placement even when a semantic quad contains its foot', () => {
    const { candidate, baseline, understanding } = sample();
    baseline.planes[0].geometrySource = 'visible-floor-region';
    baseline.planes[0].depthEnd = 0.65;
    // A checkbox does not supply metric room correspondences.
    baseline.planes[0].confirmed = true;
    const before = structuredClone({ baseline, understanding });
    const result = buildCandidatePipeline(understanding, baseline, room, { width: 800, height: 800 });
    expect(result.plans[candidate.id]).toBeNull();
    expect(result.review.candidates.find((c) => c.id === candidate.id)?.status).toBe('unplaced');
    expect(result.pipeline.observedPlacementChecks?.[0].code).toBe('floor-extent-unconfirmed');
    expect(result.pipeline.placements[0].reasons.join(' ')).toContain('대응 범위');
    expect({ baseline, understanding }).toEqual(before);
  });
  it('allows an explicit user position without relabelling a visible patch as physical geometry', () => {
    const { candidate, baseline, understanding } = sample();
    baseline.planes[0].geometrySource = 'visible-floor-region';
    const result = buildCandidatePipeline(
      understanding,
      baseline,
      room,
      { width: 800, height: 800 },
      {
        [candidate.id]: { face: 'floor', u: 0.5, v: 0.6, baseHeightMm: 0 },
      },
    );
    expect(result.plans[candidate.id]?.provenance?.position).toBe('user');
    expect(result.pipeline.placements[0].baselineEvidence).toBeUndefined();
    expect(result.pipeline.baselineReview.planes[0].geometrySource).toBe('visible-floor-region');
  });
});

describe('observed point role, crop and orientation diagnostics', () => {
  it('records the assumed floor contour role and the exact mapping intervals without implying calibration', () => {
    const { candidate, baseline } = sample();
    baseline.planes[0].depthStart = 0.1;
    baseline.planes[0].depthEnd = 0.65;
    baseline.planes[0].horizontalStart = 0.2;
    baseline.planes[0].horizontalEnd = 0.9;
    const original = structuredClone(baseline);
    const result = reuseObservedPlacement(candidate, [candidate], baseline, room)!;
    expect(result.baselineEvidence).toMatchObject({
      pointRole: 'estimated-front-contact',
      assumedYawDegrees: 0,
      planeExtent: {
        face: 'floor',
        depthStart: 0.1,
        depthEnd: 0.65,
        horizontalStart: 0.2,
        horizontalEnd: 0.9,
        horizontalDefaulted: false,
        confirmed: false,
      },
    });
    expect(result.baselineEvidence!.planeExtent!.verticalStart).toBeUndefined();
    expect(result.reasons.join(' ')).toContain('가정');
    expect(result.reasons.join(' ')).toContain('기본 회전 0°');
    expect(result.reprojectionErrorPx).toBeUndefined();
    expect(baseline).toEqual(original);
    delete baseline.planes[0].horizontalStart;
    delete baseline.planes[0].horizontalEnd;
    expect(
      reuseObservedPlacement(candidate, [candidate], baseline, room)!.baselineEvidence!.planeExtent,
    ).toMatchObject({ horizontalStart: 0, horizontalEnd: 1, horizontalDefaulted: true });
  });

  it('distinguishes a wall lower contour from a whole-bounds centre and preserves explicit vertical extent', () => {
    const { candidate, baseline } = sample(true);
    baseline.planes[0].verticalStart = 0.25;
    baseline.planes[0].verticalEnd = 0.9;
    const lower = reuseObservedPlacement(candidate, [candidate], baseline, room)!;
    expect(lower.baselineEvidence!.pointRole).toBe('lower-contour');
    expect(lower.baselineEvidence!.planeExtent).toMatchObject({
      face: 'back',
      verticalStart: 0.25,
      verticalEnd: 0.9,
      horizontalDefaulted: true,
    });
    candidate.kind = 'mirror';
    candidate.basinStyle = 'unknown';
    baseline.candidates[0].kind = 'mirror';
    const centre = reuseObservedPlacement(candidate, [candidate], baseline, room)!;
    expect(centre.baselineEvidence!.pointRole).toBe('bounds-center');
    expect(centre.baselineEvidence!.point).toEqual({ x: 0.5, y: 0.45 });
    expect(centre.reasons.join(' ')).toContain('기본 높이의 절반');
    expect(centre.baselineEvidence!.assumedYawDegrees).toBeUndefined();
  });

  it.each(['model', 'baseline', 'both'] as const)(
    'holds a cropped wall bottom in the %s observation even when an attachment remains visible',
    (which) => {
      const { candidate, baseline } = sample(true);
      // Keep the cropped contact inside a real plane so the explicit crop guard is what rejects it.
      baseline.planes[0].quad[2].y = baseline.planes[0].quad[3].y = 1;
      candidate.bounds.top = baseline.candidates[0].bounds.top = 0.35;
      candidate.bounds.bottom = baseline.candidates[0].bounds.bottom = 0.9;
      baseline.candidates[0].foot.y = 0.9;
      candidate.anchor = {
        kind: 'wall-attachment',
        point: { x: 0.5, y: 0.6 },
        evidence: ['visible upper attachment'],
        uncertainty: [],
      };
      if (which !== 'baseline') candidate.bounds.bottom = 1;
      if (which !== 'model') {
        baseline.candidates[0].bounds.bottom = 1;
        baseline.candidates[0].foot.y = 0.999;
      }
      expect(reuseObservedPlacement(candidate, [candidate], baseline, room)).toBeUndefined();
    },
  );

  it.each(['top', 'left', 'right', 'bottom'] as const)(
    'does not use a %s-cropped mirror region as the centre of the complete mirror',
    (edge) => {
      const { candidate, baseline } = sample(true);
      candidate.kind = baseline.candidates[0].kind = 'mirror';
      candidate.basinStyle = 'unknown';
      candidate.bounds[edge] = baseline.candidates[0].bounds[edge] = ['top', 'left'].includes(edge) ? 0 : 1;
      expect(reuseObservedPlacement(candidate, [candidate], baseline, room)).toBeUndefined();
    },
  );

  it('can still use a visible wall lower contour when only the unrelated top is cropped', () => {
    const { candidate, baseline } = sample(true);
    candidate.bounds.top = baseline.candidates[0].bounds.top = 0;
    expect(reuseObservedPlacement(candidate, [candidate], baseline, room)?.baselineEvidence?.pointRole).toBe(
      'lower-contour',
    );
  });

  it.each(['reversed', 'outside', 'nonfinite'] as const)('rejects %s stored vertical intervals', (bad) => {
    const { candidate, baseline } = sample(true);
    baseline.planes[0].verticalStart = bad === 'reversed' ? 0.8 : bad === 'outside' ? -0.2 : Number.NaN;
    baseline.planes[0].verticalEnd = bad === 'reversed' ? 0.2 : 1;
    expect(reuseObservedPlacement(candidate, [candidate], baseline, room)).toBeUndefined();
  });

  it.each([
    ['bath', 'left', 0],
    ['glassPartition', 'unknown', 90],
    ['toilet', 'left', 90],
    ['toilet', 'right', -90],
  ] as const)('aligns the borrowed contact with the actual %s model yaw for wall=%s', (kind, wall, yaw) => {
    const { candidate, baseline, understanding } = sample();
    candidate.kind = baseline.candidates[0].kind = kind;
    candidate.wall = wall;
    const result = buildCandidatePipeline(understanding, baseline, room, { width: 800, height: 800 });
    const plan = result.plans[candidate.id]!;
    expect(plan, result.pipeline.placements[0].reasons.join(' ')).not.toBeNull();
    expect(plan.yawDegrees).toBe(yaw);
    expect(result.pipeline.placements[0].baselineEvidence!.assumedYawDegrees).toBe(yaw);
    const defaults = reconstructionDefaults(kind);
    const transform = reconstructionModelTransform(room, { ...defaults, ...plan });
    const front = new Vector3(0, 0, defaults.depthMm / 2)
      .applyAxisAngle(new Vector3(0, 1, 0), transform.angle)
      .add(transform.origin);
    const contact = roomFacePoint(room, 'floor', 0.5, 0.75);
    expect(front.distanceTo(contact)).toBeLessThan(1e-6);
    expect(result.pipeline.camera.status).toBe('held');
  });
});

describe('fill only unknown installation using independent observation', () => {
  it.each([false, true])(
    'fills unknown mounting from a valid observed placement with wall=%s and preserves model raw fields',
    (wall) => {
      const { candidate, baseline, understanding } = sample(wall);
      candidate.mounting = 'unknown';
      candidate.wall = 'unknown';
      const original = structuredClone({ understanding, baseline });
      const result = buildCandidatePipeline(understanding, baseline, room, { width: 800, height: 800 });
      expect(result.plans[candidate.id]).not.toBeNull();
      expect(result.pipeline.camera.status).toBe('held');
      expect(result.pipeline.placements[0].derivedInstallation).toMatchObject({
        mode: wall ? 'wall' : 'floor',
        source: 'geometry',
      });
      expect(result.review.candidates[0].installation!.source).toBe('inferred');
      expect(result.plans[candidate.id]!.provenance!.mounting).toBe('inferred');
      if (wall) {
        expect(result.pipeline.placements[0].derivedInstallation!.wall).toBe('back');
        expect(result.plans[candidate.id]!.provenance!.wall).toBe('inferred');
      }
      expect(result.pipeline.understanding).toEqual(original.understanding);
      expect(result.pipeline.automaticUnderstanding).toEqual(original.understanding);
      expect({ understanding, baseline }).toEqual(original);
    },
  );

  it('infers an unreported supporting wall only from a uniquely containing physical room plane', () => {
    const { candidate, baseline, understanding } = sample(true);
    candidate.kind = baseline.candidates[0].kind = 'mirror';
    candidate.basinStyle = 'unknown';
    candidate.mounting = 'unknown';
    candidate.wall = 'unknown';
    delete baseline.candidates[0].installation!.wall;
    baseline.planes.push({
      ...structuredClone(baseline.planes[0]),
      id: 'other-real-wall',
      face: 'right',
      quad: [
        { x: 0.75, y: 0.1 },
        { x: 0.95, y: 0.1 },
        { x: 0.95, y: 0.9 },
        { x: 0.75, y: 0.9 },
      ],
    });
    const result = buildCandidatePipeline(understanding, baseline, room, { width: 800, height: 800 });
    expect(result.plans[candidate.id]).toMatchObject({
      face: 'back',
      provenance: { wall: 'inferred', mounting: 'inferred' },
    });
    expect(result.pipeline.placements[0].derivedInstallation).toEqual({
      mode: 'wall',
      wall: 'back',
      source: 'geometry',
    });
    expect(result.pipeline.placements[0].reasons.join(' ')).toContain('모두 설치 벽을 명시하지');
    expect(result.pipeline.understanding.candidates[0]).toMatchObject({
      wall: 'unknown',
      mounting: 'unknown',
    });
    expect(baseline.candidates[0].installation!.wall).toBeUndefined();
  });

  it.each(['overlap', 'outside', 'appearance', 'missing-source'] as const)(
    'does not fill an unreported wall from %s geometry',
    (bad) => {
      const { candidate, baseline } = sample(true);
      candidate.wall = 'unknown';
      delete baseline.candidates[0].installation!.wall;
      if (bad === 'overlap')
        baseline.planes.push({ ...structuredClone(baseline.planes[0]), id: 'overlap-wall', face: 'right' });
      // A point just beyond the quad is inside the legacy 1% tolerance, but may not identify a wall here.
      if (bad === 'outside') baseline.planes[0].quad[1].x = baseline.planes[0].quad[2].x = 0.499;
      if (bad === 'appearance') baseline.planes[0].geometrySource = 'appearance-region';
      if (bad === 'missing-source') delete baseline.planes[0].geometrySource;
      expect(reuseObservedPlacement(candidate, [candidate], baseline, room)).toBeUndefined();
    },
  );

  it.each(['mounting', 'wall', 'basinStyle'] as const)(
    'never overwrites a nonunknown %s conflict',
    (field) => {
      const { candidate, baseline, understanding } = sample(true);
      if (field === 'mounting') candidate.mounting = 'floor';
      if (field === 'wall') candidate.wall = 'left';
      if (field === 'basinStyle') candidate.basinStyle = 'pedestal';
      const original = structuredClone(candidate);
      const result = buildCandidatePipeline(understanding, baseline, room, { width: 800, height: 800 });
      expect(result.plans[candidate.id]).toBeNull();
      expect(result.pipeline.placements[0].derivedInstallation).toBeUndefined();
      expect(candidate).toEqual(original);
    },
  );

  it('does not infer unknown basin support from a generic known kind', () => {
    const { candidate, baseline } = sample(true);
    candidate.mounting = 'unknown';
    candidate.basinStyle = 'unknown';
    expect(reuseObservedPlacement(candidate, [candidate], baseline, room)).toBeUndefined();
  });

  it('never uses reflected, ambiguous or user-corrected baseline installation as independent model evidence', () => {
    for (const problem of ['reflection', 'user', 'review', 'two-candidates'] as const) {
      const { candidate, baseline } = sample();
      candidate.mounting = 'unknown';
      if (problem === 'reflection') baseline.candidates[0].reflectionOf = 'mirror';
      if (problem === 'user') baseline.candidates[0].installation!.source = 'user';
      if (problem === 'review') baseline.candidates[0].requiresReview = true;
      if (problem === 'two-candidates')
        baseline.candidates.push({ ...baseline.candidates[0], id: 'another' });
      expect(reuseObservedPlacement(candidate, [candidate], baseline, room), problem).toBeUndefined();
    }
  });
});

function pedestalPartSample() {
  const data = sample();
  const { candidate, baseline } = data;
  candidate.kind = baseline.candidates[0].kind = 'basin';
  candidate.basinStyle = 'pedestal';
  candidate.mounting = 'unknown';
  candidate.bounds = { left: 0.4, top: 0.35, right: 0.6, bottom: 0.51 };
  baseline.candidates[0].bounds = { left: 0.4, top: 0.35, right: 0.6, bottom: 0.8 };
  baseline.candidates[0].foot = { x: 0.5, y: 0.8 };
  baseline.candidates[0].installation = {
    mode: 'floor',
    basinVariant: 'pedestal',
    source: 'inferred',
    reason: 'continuous narrow stem plus actual floor contact',
  };
  baseline.candidates[0].evidence.pedestalSupport = {
    stemWidthRatio: 0.3,
    stemHeightRatio: 0.5,
    coverage: 0.95,
  };
  return data;
}

describe('pedestal bowl-only observation matching', () => {
  it('uses a uniquely contained bowl plus actual continuous pedestal and floor observations', () => {
    const { candidate, baseline, understanding } = pedestalPartSample();
    const original = structuredClone({ candidate, baseline });
    const result = buildCandidatePipeline(
      understanding,
      baseline,
      room,
      { width: 800, height: 800 },
      {},
      understanding,
      {},
      undefined,
      { candidateInputFingerprint: 'a'.repeat(64), observationInputFingerprint: 'a'.repeat(64) },
    );
    expect(result.plans[candidate.id]).toMatchObject({
      kind: 'basin',
      face: 'floor',
      basinVariant: 'pedestal',
      baseHeightMm: 0,
    });
    expect(result.pipeline.placements[0].baselineEvidence).toMatchObject({
      matchMode: 'pedestal-bowl-part',
      candidateCoverage: 1,
      point: { x: 0.5, y: 0.8 },
    });
    const overlap = result.pipeline.placements[0].baselineEvidence!.intersectionOverUnion;
    expect(overlap).toBeGreaterThanOrEqual(0.25);
    expect(overlap).toBeLessThan(0.5);
    expect(result.pipeline.placements[0].derivedInstallation).toMatchObject({
      mode: 'floor',
      source: 'geometry',
    });
    expect(result.pipeline.placements[0].reasons.join(' ')).toContain('세면볼 부분만');
    expect(result.pipeline.understanding.candidates[0].bounds).toEqual(candidate.bounds);
    expect({ candidate, baseline }).toEqual(original);
  });

  it.each([
    'missing-stem',
    'thin-disconnected',
    'short-stem',
    'wide-stem',
    'not-contained',
    'too-small',
    'wrong-support',
    'crop',
    'no-floor-plane',
  ] as const)('does not borrow a pedestal contact with %s evidence', (bad) => {
    const { candidate, baseline } = pedestalPartSample();
    if (bad === 'missing-stem') delete baseline.candidates[0].evidence.pedestalSupport;
    if (bad === 'thin-disconnected') baseline.candidates[0].evidence.pedestalSupport!.coverage = 0.5;
    if (bad === 'short-stem') baseline.candidates[0].evidence.pedestalSupport!.stemHeightRatio = 0.2;
    if (bad === 'wide-stem') baseline.candidates[0].evidence.pedestalSupport!.stemWidthRatio = 0.8;
    if (bad === 'not-contained') {
      candidate.bounds.left -= 0.05;
      candidate.bounds.right -= 0.05;
    }
    if (bad === 'too-small') candidate.bounds.bottom = 0.4;
    if (bad === 'wrong-support') candidate.basinStyle = 'wall';
    if (bad === 'crop') baseline.candidates[0].bounds.bottom = 1;
    if (bad === 'no-floor-plane') baseline.planes[0].geometrySource = 'appearance-region';
    expect(reuseObservedPlacement(candidate, [candidate], baseline, room)).toBeUndefined();
  });

  it('requires one-to-one identity across partial and full observations in both directions', () => {
    const { candidate, baseline } = pedestalPartSample();
    const other = { ...candidate, id: 'full-observation', bounds: { ...baseline.candidates[0].bounds } };
    expect(reuseObservedPlacement(candidate, [candidate, other], baseline, room)).toBeUndefined();
    expect(reuseObservedPlacement(other, [candidate, other], baseline, room)).toBeUndefined();
    baseline.candidates.push({ ...structuredClone(baseline.candidates[0]), id: 'second-pedestal' });
    expect(reuseObservedPlacement(candidate, [candidate], baseline, room)).toBeUndefined();
  });
});

describe('observed reuse rejection diagnostics', () => {
  it('explains weak overlap separately from a missing observation and preserves the candidate', () => {
    const { candidate, baseline } = sample(true);
    baseline.candidates[0].bounds = { left: 0.4, top: 0.35, right: 0.5, bottom: 0.45 };
    const original = structuredClone({ candidate, baseline });
    const weak = inspectObservedPlacement(candidate, [candidate], baseline, room);
    expect(weak.placement).toBeUndefined();
    expect(weak.diagnostic).toMatchObject({
      code: 'observation-match-missing',
      matches: [{ candidateId: 'semantic-observation', eligible: true, intersectionOverUnion: 0.25 }],
    });
    expect(weak.diagnostic.message).toContain('0.250');
    expect({ candidate, baseline }).toEqual(original);
    baseline.candidates = [];
    const absent = inspectObservedPlacement(candidate, [candidate], baseline, room);
    expect(absent.diagnostic.code).toBe('observation-match-missing');
    expect(absent.diagnostic.message).toContain('기존 픽셀 관측이 없어');
    expect(absent.diagnostic.matches).toEqual([]);
  });

  it('preserves why a high-overlap baseline observation is excluded', () => {
    const { candidate, baseline } = sample();
    baseline.candidates[0].reflectionOf = 'physical-mirror';
    const result = inspectObservedPlacement(candidate, [candidate], baseline, room);
    expect(result.diagnostic).toMatchObject({
      code: 'observation-match-missing',
      matches: [{ intersectionOverUnion: 1, eligible: false, exclusions: ['reflection'] }],
    });
    expect(result.placement).toBeUndefined();
  });

  it.each([
    ['crop', 'candidate-cropped'],
    ['support', 'installation-conflict'],
    ['appearance', 'observed-plane-missing'],
    ['extent', 'plane-extent-invalid'],
    ['duplicate', 'observation-match-ambiguous'],
    ['shared', 'observation-shared'],
    ['user', 'installation-user-evidence'],
  ] as const)('reports the actual %s rejection without changing the success-only API', (problem, code) => {
    const { candidate, baseline } = sample(true);
    const eligible = [candidate];
    if (problem === 'crop') candidate.bounds.bottom = baseline.candidates[0].bounds.bottom = 1;
    if (problem === 'support') candidate.basinStyle = 'vanity';
    if (problem === 'appearance') baseline.planes[0].geometrySource = 'appearance-region';
    if (problem === 'extent') delete baseline.planes[0].verticalStart;
    if (problem === 'duplicate')
      baseline.candidates.push({ ...structuredClone(baseline.candidates[0]), id: 'another-observation' });
    if (problem === 'shared') eligible.push({ ...structuredClone(candidate), id: 'another-claim' });
    if (problem === 'user') baseline.candidates[0].installation!.source = 'user';
    const original = structuredClone({ candidate, baseline, eligible });
    const result = inspectObservedPlacement(candidate, eligible, baseline, room, { width: 400, height: 800 });
    expect(result.diagnostic.code).toBe(code);
    expect(result.placement).toBeUndefined();
    expect(reuseObservedPlacement(candidate, eligible, baseline, room)).toBeUndefined();
    expect({ candidate, baseline, eligible }).toEqual(original);
  });

  it('reports a subpixel outside boundary without clamping, changing tolerance or claiming millimetres', () => {
    const { candidate, baseline } = sample();
    candidate.kind = baseline.candidates[0].kind = 'bath';
    candidate.bounds = { left: 0.3, top: 0.3, right: 0.7, bottom: 0.499 };
    baseline.candidates[0].bounds = { ...candidate.bounds };
    baseline.candidates[0].foot = { x: 0.5, y: 0.499 };
    const original = structuredClone({ candidate, baseline });
    const inspected = inspectObservedPlacement(candidate, [candidate], baseline, room, {
      width: 400,
      height: 800,
    });
    expect(inspected.placement).toBeUndefined();
    expect(inspected.diagnostic).toMatchObject({
      code: 'point-outside-observed-plane',
      point: { x: 0.5, y: 0.499 },
      pointRole: 'estimated-front-contact',
      image: { width: 400, height: 800 },
      planes: [
        {
          planeId: 'observed-room-plane',
          eligible: true,
          inside: false,
          nearestBoundary: { edge: 'top', point: { x: 0.5, y: 0.5 } },
        },
      ],
    });
    expect(inspected.diagnostic.planes![0].nearestBoundary!.distancePx).toBeCloseTo(0.8);
    expect(inspected.diagnostic.message).toContain('약 0.80px');
    expect(inspected.diagnostic.message).toContain('실측 거리가 아니에요');
    expect(inspected.diagnostic.message).toContain('강제 이동하지');
    expect(inspected.diagnostic.planes![0].pointUv!.y).toBeLessThan(0);
    expect({ candidate, baseline }).toEqual(original);

    const noImage = inspectObservedPlacement(candidate, [candidate], baseline, room);
    expect(noImage.diagnostic.code).toBe('point-outside-observed-plane');
    expect(noImage.diagnostic.planes![0].nearestBoundary).toBeUndefined();
    expect(noImage.diagnostic.message).not.toContain('px');
  });

  it('uses the actual image axes for the nearest boundary distance', () => {
    const { candidate, baseline } = sample();
    baseline.candidates[0].foot = { x: 0.099, y: 0.7 };
    const result = inspectObservedPlacement(candidate, [candidate], baseline, room, {
      width: 1200,
      height: 400,
    });
    expect(result.diagnostic.code).toBe('point-outside-observed-plane');
    expect(result.diagnostic.planes![0].nearestBoundary!.edge).toBe('left');
    expect(result.diagnostic.planes![0].nearestBoundary!.distancePx).toBeCloseTo(1.2);
  });

  it('keeps the common camera reason and exposes the specific reuse rejection in the user row and report', () => {
    const { candidate, baseline, understanding } = sample(true);
    baseline.planes[0].geometrySource = 'appearance-region';
    const result = buildCandidatePipeline(understanding, baseline, room, { width: 400, height: 800 });
    const diagnostic = result.pipeline.observedPlacementChecks![0];
    expect(diagnostic.code).toBe('observed-plane-missing');
    expect(result.pipeline.placements[0].reasons).toContain(
      '원본 시점을 확정하지 못해 위치를 임의로 생성하지 않습니다.',
    );
    expect(result.pipeline.placements[0].reasons).toContain(diagnostic.message);
    expect(result.review.candidates[0].warning).toContain(diagnostic.message);
    expect(result.review.candidates[0].trace!.find((entry) => entry.stage === 'placement')!.reason).toContain(
      diagnostic.message,
    );
    expect(result.plans[candidate.id]).toBeNull();
    expect(JSON.parse(JSON.stringify(result.pipeline)).observedPlacementChecks[0].code).toBe(
      'observed-plane-missing',
    );
  });

  it('distinguishes successful observation reuse from a later model bounds rejection', () => {
    const { candidate, baseline, understanding } = sample();
    candidate.bounds = { left: 0.4, top: 0.3, right: 0.6, bottom: 0.51 };
    baseline.candidates[0].bounds = { ...candidate.bounds };
    baseline.candidates[0].foot.y = 0.51;
    const reused = reuseObservedPlacement(candidate, [candidate], baseline, room)!;
    const inspected = inspectObservedPlacement(candidate, [candidate], baseline, room, {
      width: 800,
      height: 800,
    });
    expect(inspected.placement).toEqual(reused);
    expect(inspected.diagnostic.code).toBe('reused');
    const result = buildCandidatePipeline(understanding, baseline, room, { width: 800, height: 800 });
    expect(result.pipeline.observedPlacementChecks![0].code).toBe('reused');
    expect(result.pipeline.modelChecks[0].result.valid).toBe(false);
    expect(result.pipeline.modelChecks[0].result.overflowMm!.back).toBeGreaterThan(0);
    expect(result.plans[candidate.id]).toBeNull();
  });

  it('does not record an attempted reuse when the pipeline skips it for manual placement', () => {
    const { candidate, baseline, understanding } = sample();
    const result = buildCandidatePipeline(
      understanding,
      baseline,
      room,
      { width: 800, height: 800 },
      {
        [candidate.id]: { face: 'floor', u: 0.5, v: 0.5, baseHeightMm: 0 },
      },
    );
    expect(result.pipeline.observedPlacementChecks).toBeUndefined();
    expect(result.plans[candidate.id]).not.toBeNull();
  });
});

describe('independent installation evidence without borrowed placement', () => {
  it('returns a matched floor installation even when the contact is cropped and no room mapping exists', () => {
    const { candidate, baseline } = sample();
    candidate.mounting = 'unknown';
    candidate.bounds.bottom = baseline.candidates[0].bounds.bottom = 1;
    baseline.candidates[0].foot.y = 1;
    baseline.planes[0].geometrySource = 'visible-floor-region';
    baseline.planes[0].depthEnd = 0.65;
    const before = structuredClone({ candidate, baseline });
    const result = inspectObservedInstallation(candidate, [candidate], baseline);
    expect(result.installation).toMatchObject({ mode: 'floor', source: 'geometry' });
    expect(result.baselineEvidence).toEqual({
      candidateId: 'semantic-observation',
      source: 'deeplab',
      intersectionOverUnion: 1,
      matchMode: 'bounds-overlap',
      candidateCoverage: undefined,
      positionBorrowed: false,
      wallGeometrySource: undefined,
    });
    expect(result.diagnostic).toMatchObject({
      status: 'reused',
      baselineCandidateId: 'semantic-observation',
    });
    expect(result.diagnostic.message).toContain('실측이 아니고');
    expect(result.diagnostic.point).toBeUndefined();
    expect(result.diagnostic.planes).toBeUndefined();
    expect(result).not.toHaveProperty('placement');
    expect(inspectObservedPlacement(candidate, [candidate], baseline, room).diagnostic.code).toBe(
      'candidate-cropped',
    );
    expect({ candidate, baseline }).toEqual(before);
  });

  it('can fill unknown basin support from an independent observation without relaxing the old placement path', () => {
    const { candidate, baseline } = sample(true);
    candidate.mounting = candidate.wall = candidate.basinStyle = 'unknown';
    const before = structuredClone({ candidate, baseline });
    const result = inspectObservedInstallation(candidate, [candidate], baseline);
    expect(result.installation).toEqual({
      mode: 'wall',
      wall: 'back',
      basinVariant: 'wall',
      source: 'geometry',
    });
    expect(result.baselineEvidence?.wallGeometrySource).toBe('room-boundaries');
    expect(result.diagnostic.details).toContain('observed support');
    expect(inspectObservedPlacement(candidate, [candidate], baseline, room).diagnostic.code).toBe(
      'installation-conflict',
    );
    expect({ candidate, baseline }).toEqual(before);
  });

  it.each(['appearance-region', 'visible-floor-region', undefined] as const)(
    'does not convert a stored photo-side wall on %s geometry into a physical supporting wall',
    (source) => {
      const { candidate, baseline } = sample();
      candidate.mounting = candidate.wall = 'unknown';
      baseline.candidates[0].installation!.wall = 'left';
      baseline.planes[0].face = 'left';
      baseline.planes[0].geometrySource = source;
      baseline.planes[0].confirmed = true;
      const original = structuredClone(baseline);
      const result = inspectObservedInstallation(candidate, [candidate], baseline);
      expect(result.installation).toMatchObject({ mode: 'floor', source: 'geometry' });
      expect(result.installation?.wall).toBeUndefined();
      expect(result.baselineEvidence?.wallGeometrySource).toBeUndefined();
      expect(result.diagnostic.details?.join(' ')).toContain('실제 설치 벽을 단정하지');
      expect(baseline).toEqual(original);
    },
  );

  it('preserves the kind-rule reason rather than calling a floor default a measured contact', () => {
    const { candidate, baseline } = sample();
    candidate.kind = baseline.candidates[0].kind = 'bath';
    candidate.mounting = 'unknown';
    delete baseline.candidates[0].installation;
    baseline.planes = [];
    const result = inspectObservedInstallation(candidate, [candidate], baseline);
    expect(result.installation?.mode).toBe('floor');
    expect(result.diagnostic.details?.join(' ')).toContain('설비 종류에 따른 바닥 설치');
    expect(result.diagnostic.message).toContain('추정');
    expect(result.baselineEvidence?.positionBorrowed).toBe(false);
  });

  it.each(['mounting', 'wall', 'basinStyle'] as const)('rejects a known %s conflict', (field) => {
    const { candidate, baseline } = sample(true);
    if (field === 'mounting') candidate.mounting = 'floor';
    if (field === 'wall') candidate.wall = 'left';
    if (field === 'basinStyle') candidate.basinStyle = 'pedestal';
    const result = inspectObservedInstallation(candidate, [candidate], baseline);
    expect(result.installation).toBeUndefined();
    expect(result.diagnostic.code).toBe('installation-conflict');
  });

  it.each([
    'user-known',
    'user-unknown',
    'reflected',
    'review',
    'weak-class',
    'duplicate-observation',
    'shared-claim',
  ] as const)('does not promote %s evidence to independent installation', (problem) => {
    const { candidate, baseline } = sample();
    candidate.mounting = 'unknown';
    if (problem.startsWith('user')) baseline.candidates[0].installation!.source = 'user';
    if (problem === 'user-unknown') baseline.candidates[0].installation!.mode = 'unknown';
    if (problem === 'reflected') baseline.candidates[0].reflectionOf = 'mirror';
    if (problem === 'review') baseline.candidates[0].requiresReview = true;
    if (problem === 'weak-class') baseline.candidates[0].evidence.meanMargin = 0;
    if (problem === 'duplicate-observation')
      baseline.candidates.push({ ...baseline.candidates[0], id: 'duplicate' });
    const claims =
      problem === 'shared-claim' ? [candidate, { ...candidate, id: 'other-claim' }] : [candidate];
    expect(inspectObservedInstallation(candidate, claims, baseline).installation, problem).toBeUndefined();
  });

  it('shares the pedestal part threshold and requires a continuous stem even without position mapping', () => {
    const { candidate, baseline } = pedestalPartSample();
    baseline.planes = [];
    const result = inspectObservedInstallation(candidate, [candidate], baseline);
    expect(result.installation).toMatchObject({ mode: 'floor', basinVariant: 'pedestal' });
    expect(result.baselineEvidence).toMatchObject({
      matchMode: 'pedestal-bowl-part',
      candidateCoverage: 1,
      positionBorrowed: false,
    });
    baseline.candidates[0].evidence.pedestalSupport!.coverage = 0.69;
    expect(inspectObservedInstallation(candidate, [candidate], baseline).diagnostic.code).toBe(
      'observation-match-missing',
    );
  });
});
