import { describe, expect, it } from 'vitest';
import { PerspectiveCamera } from 'three';
import { DEFAULT_ROOM, roomFacePoint } from '../src/lib/room-geometry';
import type { RoomFace } from '../src/lib/room-types';
import type { Quad } from '../src/lib/types';
import {
  buildCandidatePipeline,
  type ManualCandidatePlacement,
} from '../src/lib/reconstruction/candidate-pipeline';
import {
  projectSourcePoint,
  sourceRoomCornerPoint,
  type SourceCamera,
} from '../src/lib/reconstruction/source-camera';
import type {
  SceneCandidate,
  SceneUnderstanding,
  SourceRoomCorner,
} from '../src/lib/reconstruction/pipeline-contract';
import type { ReconstructionCandidate, ReconstructionReview } from '../src/lib/reconstruction/types';

const room = { ...DEFAULT_ROOM };
const camera = new PerspectiveCamera(62, 1.2, 0.1, 1e7);
camera.position.set(450, 1450, 4800);
camera.lookAt(0, 1100, 0);
camera.updateMatrixWorld(true);
const source: SourceCamera = {
  version: 1,
  positionMm: camera.position.toArray() as SourceCamera['positionMm'],
  quaternion: camera.quaternion.toArray() as SourceCamera['quaternion'],
  verticalFovDegrees: 62,
  image: { width: 1200, height: 1000 },
};
function item(kind: SceneCandidate['kind'] = 'basin', face: RoomFace = 'floor'): SceneCandidate {
  const point = projectSourcePoint(
    source,
    roomFacePoint(room, face, 0.5, face === 'floor' ? 0.5 : 0.65),
  ).point;
  return {
    id: 'candidate',
    kind,
    bounds: { left: point.x - 0.06, top: point.y - 0.1, right: point.x + 0.06, bottom: point.y },
    mounting: face === 'floor' ? 'floor' : 'wall',
    wall: face === 'floor' ? 'unknown' : face,
    basinStyle: kind === 'basin' ? (face === 'floor' ? 'pedestal' : 'wall') : 'unknown',
    shape: kind === 'basin' ? 'rectangular' : 'unknown',
    reflection: 'physical',
    evidence: ['synthetic model observation'],
    uncertainty: [],
    anchor: {
      point,
      kind: face === 'floor' ? 'floor-contact' : 'wall-attachment',
      evidence: ['contact'],
      uncertainty: [],
    },
  };
}
function understanding(candidates: SceneCandidate[]): SceneUnderstanding {
  const names: SourceRoomCorner[] = [
    'back-top-left',
    'back-top-right',
    'back-bottom-right',
    'back-bottom-left',
  ];
  return {
    schemaVersion: 1,
    candidates,
    relations: [],
    roomLayout: {
      orthogonal: true,
      evidence: ['observed room'],
      uncertainty: [],
      backWallQuad: names.map(
        (corner) => projectSourcePoint(source, sourceRoomCornerPoint(room, corner)).point,
      ) as Quad,
    },
  };
}
function baseline(
  candidate?: SceneCandidate,
  kind: ReconstructionCandidate['kind'] = 'basin',
): ReconstructionReview {
  return {
    version: 2,
    analysis: 'partial',
    planes: [],
    warnings: ['original warning'],
    candidates: candidate
      ? [
          {
            id: 'deeplab-original',
            kind,
            source: 'deeplab',
            bounds: { ...candidate.bounds },
            foot: { x: 0.5, y: 0.5 },
            color: '#ababab',
            pixels: 1000,
            evidence: { semanticPixels: 1000, meanMargin: 3.5 },
            status: 'unplaced',
          },
        ]
      : [],
  };
}
const manual: ManualCandidatePlacement = { face: 'floor', u: 0.5, v: 0.5, baseHeightMm: 0 };
function run(
  scene: SceneUnderstanding,
  review = baseline(),
  manualPlacements: Record<string, ManualCandidatePlacement> = {},
) {
  return buildCandidatePipeline(scene, review, room, source.image, manualPlacements);
}

describe('opt-in scene candidate pipeline: plans, holds, and provenance', () => {
  it('builds an editable square pedestal from model style while keeping dimensions default', () => {
    const candidate = item(),
      result = run(understanding([candidate]), baseline(candidate));
    expect(result.plans.candidate).toMatchObject({
      kind: 'basin',
      basinVariant: 'pedestal',
      basinShape: 'rectangular',
      widthMm: 600,
      depthMm: 480,
      heightMm: 800,
    });
    expect(result.plans.candidate!.provenance).toMatchObject({
      kind: 'model',
      position: 'inferred',
      dimensions: 'default',
      shape: 'model',
    });
    expect(result.pipeline.placements[0].status).toBe('estimated');
    expect(result.pipeline.modelChecks[0]).toMatchObject({
      source: 'source-camera',
      result: { valid: true },
    });
    expect(result.pipeline.modelChecks[0].result.bboxErrorPx).toBeGreaterThan(0);
  });
  it('does not introduce an automatic fallback location when the source camera is held', () => {
    const scene = understanding([item()]);
    scene.roomLayout.backWallQuad = null;
    const result = run(scene);
    expect(result.pipeline.camera.status).toBe('held');
    expect(result.plans.candidate).toBeNull();
    expect(result.pipeline.placements[0].status).toBe('held');
    expect(result.review.candidates[0].requiresReview).toBe(true);
  });
  it('keeps unknown style and unknown kind held consistently across report and model plan', () => {
    const basin = { ...item(), basinStyle: 'unknown' as const };
    const unknown = { ...item('unknown'), id: 'unclassified' };
    const result = run(understanding([basin, unknown]));
    expect(result.plans).toEqual({ candidate: null, unclassified: null });
    expect(result.pipeline.placements.map((entry) => entry.status)).toEqual(['held', 'held']);
    expect(result.review.candidates[0]).toMatchObject({ requiresReview: true, status: 'unplaced' });
    expect(result.pipeline.understanding.candidates).toHaveLength(2);
  });
  it('holds a semantic kind conflict until the user confirms the kind, not only its location', () => {
    const candidate = item('toilet'),
      review = baseline(candidate, 'basin');
    const first = run(understanding([candidate]), review, { candidate: manual });
    expect(first.pipeline.evidenceChecks[0].agreement).toBe('conflicts');
    expect(first.plans.candidate).toBeNull();
    const confirmed = { ...candidate, provenance: { kind: 'user' as const } };
    const second = run(understanding([confirmed]), review, { candidate: manual });
    expect(second.plans.candidate).not.toBeNull();
    expect(second.plans.candidate!.provenance).toMatchObject({ kind: 'user', position: 'user' });
    expect(second.pipeline.evidenceChecks[0].agreement).toBe('conflicts');
  });
  it('does not remove a new supported kind merely because DeepLab cannot classify it', () => {
    const result = run(understanding([item('glassPartition')]));
    expect(result.plans.candidate).toMatchObject({
      kind: 'glassPartition',
      opacity: 0.18,
      hasFrame: true,
      yawDegrees: 90,
    });
    expect(result.pipeline.evidenceChecks[0].agreement).toBe('unobserved');
  });
  it('retains glass and the bath behind it even when DeepLab sees the bath pixels at that location', () => {
    const bath = { ...item('bath'), id: 'bath' },
      glass = { ...item('glassPartition'), id: 'glass' };
    const scene = understanding([glass, bath]);
    scene.relations = [
      { frontId: 'glass', behindId: 'bath', relation: 'visibleThrough', evidence: ['transparent overlap'] },
    ];
    const result = run(scene, baseline(bath, 'bath'));
    expect(result.plans.glass).not.toBeNull();
    expect(result.plans.bath).not.toBeNull();
    expect(result.pipeline.evidenceChecks[0].agreement).toBe('unobserved');
    expect(result.pipeline.evidenceChecks[0].reasons.join(' ')).toContain('유리 뒤');
  });
  it.each(['reflected', 'uncertain'] as const)(
    'keeps a %s candidate in the report without building a duplicated product',
    (reflection) => {
      const candidate = { ...item('toilet'), reflection };
      const result = run(understanding([candidate]));
      expect(result.plans.candidate).toBeNull();
      expect(result.pipeline.understanding.candidates).toHaveLength(1);
      expect(() => run(understanding([candidate]), baseline(), { candidate: manual })).toThrow();
    },
  );
  it('holds reflectionOf copies and does not let manual position alone convert a reflection into a physical item', () => {
    const copied = { ...item('toilet'), id: 'copy', reflection: 'reflected' as const };
    const actual = { ...item('toilet'), id: 'actual' };
    const scene = understanding([copied, actual]);
    scene.relations = [
      { frontId: 'copy', behindId: 'actual', relation: 'reflectionOf', evidence: ['reflected copy'] },
    ];
    const result = run(scene);
    expect(result.plans.copy).toBeNull();
    expect(result.plans.actual).not.toBeNull();
  });
  it('holds same-kind duplicate boxes while preserving both original observations', () => {
    const first = item('toilet'),
      second = { ...item('toilet'), id: 'duplicate' };
    const result = run(understanding([first, second]));
    expect(result.plans.candidate).not.toBeNull();
    expect(result.plans.duplicate).toBeNull();
    expect(result.pipeline.understanding.candidates).toHaveLength(2);
    expect(result.pipeline.placements[1].reasons.join(' ')).toContain('중복');
  });
  it('preserves neutral mirror cabinet options rather than using a source photo crop', () => {
    const result = run(understanding([item('mirrorCabinet', 'back')]));
    expect(result.plans.candidate).toMatchObject({
      kind: 'mirrorCabinet',
      doorCount: 2,
      depthMm: 150,
      version: 2,
    });
    expect(result.plans.candidate).not.toHaveProperty('imageAssetId');
  });
  it('does not claim an unsupported round mirror shape was applied by the standard renderer', () => {
    const round = { ...item('mirror', 'back'), shape: 'round' as const };
    const result = run(understanding([round]));
    expect(result.plans.candidate!.provenance!.shape).toBe('default');
    expect(result.plans.candidate!.basinShape).toBeUndefined();
    expect(result.review.candidates[0].warning).toContain('자동 반영하지');
    expect(result.pipeline.understanding.candidates[0].shape).toBe('round');
  });
  it('does not put a pedestal on a wall or a wall-hung model on the floor', () => {
    const pedestal = item('basin'),
      wallHung = item('basin', 'back');
    expect(
      run(understanding([pedestal]), baseline(), {
        candidate: { face: 'back', u: 0.5, v: 0.5, baseHeightMm: 800 },
      }).plans.candidate,
    ).toBeNull();
    expect(run(understanding([wallHung]), baseline(), { candidate: manual }).plans.candidate).toBeNull();
  });
  it('allows explicit user placement after a held camera, with room-only checks and no invented reprojection', () => {
    const scene = understanding([item()]);
    scene.roomLayout.backWallQuad = null;
    const result = run(scene, baseline(), { candidate: { ...manual, widthMm: 650 } });
    expect(result.pipeline.camera.status).toBe('held');
    expect(result.plans.candidate).toMatchObject({ widthMm: 650 });
    expect(result.pipeline.placements[0].provenance).toEqual({ position: 'user', dimensions: 'user' });
    expect(result.pipeline.placements[0].reprojectionErrorPx).toBeUndefined();
    expect(result.pipeline.modelChecks[0]).toMatchObject({ source: 'room-only', result: { valid: true } });
    expect(result.pipeline.modelChecks[0].result.bboxErrorPx).toBeUndefined();
  });
  it('uses explicit wall installation height as the canonical vertical coordinate', () => {
    const result = run(understanding([item('mirror', 'back')]), baseline(), {
      candidate: { face: 'back', u: 0.5, v: 0.1, baseHeightMm: 1000 },
    });
    expect(result.plans.candidate!.v).toBeCloseTo(1 - 1000 / room.heightMm);
    expect(result.plans.candidate!.baseHeightMm).toBe(1000);
    expect(result.review.candidates[0].installation).toMatchObject({
      mode: 'wall',
      wall: 'back',
      source: 'user',
    });
  });
  it.each([NaN, Infinity, 0, -5, 20001])('rejects invalid manual dimensions %s', (widthMm) => {
    expect(() => run(understanding([item()]), baseline(), { candidate: { ...manual, widthMm } })).toThrow();
  });
  it('holds oversize, floating and room-exiting models instead of silently shrinking/moving them', () => {
    for (const change of [{ widthMm: 5000 }, { baseHeightMm: 100 }, { u: 0.99 }]) {
      const result = run(understanding([item()]), baseline(), { candidate: { ...manual, ...change } });
      expect(result.plans.candidate).toBeNull();
      expect(result.pipeline.placements[0].status).toBe('held');
      expect(result.review.candidates[0].requiresReview).toBe(true);
      expect(result.pipeline.modelChecks[0].result.valid).toBe(false);
    }
  });
  it('skips photo-box error for new user fixtures while keeping it for corrected original candidates', () => {
    const original = understanding([item()]);
    const corrected = structuredClone(original);
    corrected.candidates[0].provenance = { kind: 'user', position: 'user', shape: 'user' };
    const added: SceneCandidate = {
      ...item('toilet'),
      id: 'user-added',
      bounds: { left: 0, top: 0, right: 1, bottom: 1 },
      anchor: undefined,
      provenance: { kind: 'user', position: 'user' },
    };
    corrected.candidates.push(added);
    const result = buildCandidatePipeline(
      corrected,
      baseline(),
      room,
      source.image,
      { candidate: manual, 'user-added': manual },
      original,
    );
    expect(result.plans.candidate).not.toBeNull();
    expect(result.plans['user-added']).not.toBeNull();
    const originalCheck = result.pipeline.modelChecks.find((check) => check.candidateId === 'candidate')!;
    const newCheck = result.pipeline.modelChecks.find((check) => check.candidateId === 'user-added')!;
    expect(originalCheck.result.bboxErrorPx).toBeGreaterThan(0);
    expect(newCheck.result.bboxErrorPx).toBeUndefined();
    expect(newCheck.result.projectedBounds).toBeDefined();
    expect(newCheck.result.valid).toBe(true);
    expect(result.pipeline.automaticUnderstanding.candidates.map((candidate) => candidate.id)).toEqual([
      'candidate',
    ]);
    expect(original.candidates).toHaveLength(1);
  });
  it('retains immutable automatic/baseline inputs and does not share nested report objects', () => {
    const candidate = item(),
      scene = understanding([candidate]),
      review = baseline(candidate);
    const original = structuredClone({ scene, review });
    const result = run(scene, review);
    result.pipeline.understanding.candidates[0].evidence.push('user draft');
    result.pipeline.baselineReview.candidates[0].evidence.meanMargin = 0;
    result.review.candidates[0].bounds.left = 0;
    expect(scene).toEqual(original.scene);
    expect(review).toEqual(original.review);
    expect(result.pipeline.automaticUnderstanding).toEqual(original.scene);
  });
});

describe('organized fixture plans and component provenance', () => {
  it('keeps an invalid item in review without preventing a valid sibling from being placed', () => {
    const bad = {
      ...item('toilet'),
      id: 'bad',
      validation: {
        status: 'needs-review' as const,
        issues: [{ code: 'anchor', message: 'wrong support contact' }],
      },
    };
    const result = run(understanding([item(), bad]));
    expect(result.plans.candidate).not.toBeNull();
    expect(result.plans.bad).toBeNull();
    expect(result.pipeline.resolution.entries[1].disposition).toBe('invalid');
  });
  it('does not bypass duplicate resolution with a position-only correction', () => {
    const result = run(understanding([item('toilet'), { ...item('toilet'), id: 'duplicate' }]), baseline(), {
      duplicate: manual,
    });
    expect(result.plans.duplicate).toBeNull();
    expect(result.review.candidates[1]).toMatchObject({ status: 'ignored', requiresReview: false });
  });
  it('keeps glass over opaque semantic pixels independently of a missing visibleThrough relation', () => {
    const glass = item('glassPartition');
    const result = run(understanding([glass]), baseline(glass, 'bath'));
    expect(result.pipeline.evidenceChecks[0].agreement).toBe('unobserved');
    expect(result.plans.candidate).not.toBeNull();
  });
  it('builds one cabinet with two observed bowl components and retains all raw observations', () => {
    const parent = { ...item('vanity'), id: 'cabinet' };
    const child = (id: string, shift: number): SceneCandidate => ({
      ...item('basin'),
      id,
      mounting: 'countertop',
      basinStyle: 'vanity',
      shape: 'round',
      anchor: undefined,
      bounds: {
        left: parent.bounds.left + shift,
        top: parent.bounds.top,
        right: parent.bounds.left + shift + 0.04,
        bottom: parent.bounds.top + 0.03,
      },
    });
    const left = child('left', 0.01),
      right = child('right', 0.07);
    const input = understanding([parent, left, right]);
    input.relations = [left, right].map((c) => ({
      frontId: c.id,
      behindId: parent.id,
      relation: 'partOf',
      evidence: ['observed separate bowls on the cabinet'],
    }));
    const original = structuredClone(input);
    const result = run(input);
    expect(result.plans.cabinet).toMatchObject({
      kind: 'vanity',
      bowlCount: 2,
      basinShape: 'round',
      provenance: { bowlCount: 'inferred', shape: 'inferred' },
    });
    expect(result.plans.left).toBeNull();
    expect(result.plans.right).toBeNull();
    expect(result.pipeline.resolution).toMatchObject({ rawCount: 3, organizedCount: 1, componentCount: 2 });
    expect(result.pipeline.automaticUnderstanding).toEqual(original);
    expect(input).toEqual(original);
  });
  it('uses the supporting wall to orient a floor-standing fixture without replacing the common camera', () => {
    const candidate = { ...item('toilet'), wall: 'left' as const };
    const result = run(understanding([candidate]));
    expect(result.plans.candidate!.yawDegrees).toBe(90);
    expect(result.pipeline.camera.status).toBe('estimated');
  });
  it('does not use quarantined room geometry just because a fit is numerically possible', () => {
    const input = understanding([item()]);
    input.validation = {
      rawCandidateCount: 1,
      quarantinedRelations: [],
      roomLayoutIssues: [{ code: 'room', message: 'unsupported observed corners' }],
    };
    const result = run(input);
    expect(result.pipeline.camera.status).toBe('held');
    expect(result.pipeline.camera.camera).toBeUndefined();
    expect(result.plans.candidate).toBeNull();
  });
});

it('retains a rejected proposal for correction without applying it or changing original observations', () => {
  const scene = understanding([item('toilet')]);
  scene.roomLayout.backWallQuad = null;
  const original = structuredClone(scene);
  const result = run(scene, baseline(), { candidate: { ...manual, v: 0 } });
  const check = result.pipeline.modelChecks[0];
  expect(result.plans.candidate).toBeNull();
  expect(result.pipeline.placements[0].placement).toBeUndefined();
  expect(check.proposedPlacement).toMatchObject({ face: 'floor', v: 0 });
  expect(check.result.overflowMm!.back).toBeGreaterThan(0);
  expect(scene).toEqual(original);
  expect(result.pipeline.automaticUnderstanding).toEqual(original);
  const proposed = structuredClone(check.proposedPlacement!);
  const fixed = run(scene, baseline(), { candidate: { ...manual, v: 0.5 } });
  expect(fixed.plans.candidate).not.toBeNull();
  expect(check.proposedPlacement).toEqual(proposed);
});

it('records individual dimension sources when only the width is confirmed', () => {
  const scene = understanding([item()]);
  scene.roomLayout.backWallQuad = null;
  const result = run(scene, baseline(), { candidate: { ...manual, widthMm: 650 } });
  expect(result.plans.candidate!.provenance).toMatchObject({
    width: 'user',
    height: 'default',
    depth: 'default',
  });
  expect(result.review.candidates[0].trace!.find((step) => step.stage === 'installation')!.reason).toContain(
    '비운 규격은 기본값',
  );
});

it.each(['qwen', 'gemma'] as const)('retains %s candidate provenance through the review storage schema', async (providerSource) => {
  const candidate = item(), scene = understanding([candidate]);
  const result = buildCandidatePipeline(scene, baseline(candidate), room, source.image, {}, scene, {}, undefined, undefined, {}, {}, undefined, providerSource);
  expect(result.review.candidates.find(c => c.id === candidate.id)?.source).toBe(providerSource);
  const { reconstructionReviewSchema } = await import('../src/lib/supabase/validation');
  const restored = reconstructionReviewSchema.parse(JSON.parse(JSON.stringify(result.review)));
  expect(restored.candidates.find(c => c.id === candidate.id)?.source).toBe(providerSource);
  expect(scene.candidates[0].provenance).toBeUndefined();
});

it('keeps a user-confirmed candidate attributed to the user when the analysis provider is Gemma', () => {
  const candidate = item(); candidate.provenance = { kind: 'user' };
  const scene = understanding([candidate]);
  const result = buildCandidatePipeline(scene, baseline(candidate), room, source.image, {}, scene, {}, undefined, undefined, {}, {}, undefined, 'gemma');
  expect(result.review.candidates.find(c => c.id === candidate.id)?.source).toBe('user');
});
