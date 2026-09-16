import { describe, expect, it } from 'vitest';
import {
  judgeCandidateInstallation,
  mapReconstructionCandidate,
  reviewFromSegmentation,
} from '../src/lib/reconstruction/analysis';
import { estimateCandidateFixture } from '../src/lib/reconstruction';
import {
  reconstructionCandidateLabel,
  reconstructionDefaults,
  type ReconstructionCandidate,
  type ReconstructionPlane,
  type ReconstructionReview,
} from '../src/lib/reconstruction/types';
import { DEFAULT_ROOM } from '../src/lib/room-geometry';

function candidate(patch: Partial<ReconstructionCandidate> = {}): ReconstructionCandidate {
  return {
    id: 'basin',
    kind: 'basin',
    bounds: { left: 0.2, right: 0.5, top: 0.35, bottom: 0.48 },
    foot: { x: 0.35, y: 0.48 },
    color: '#efefea',
    pixels: 400,
    evidence: { semanticPixels: 400, meanMargin: 3 },
    status: 'unplaced',
    source: 'deeplab',
    ...patch,
  };
}
function plane(face: ReconstructionPlane['face'], top: number, bottom: number): ReconstructionPlane {
  return {
    id: face,
    face,
    geometrySource: 'room-boundaries',
    quad: [
      { x: 0, y: top },
      { x: 1, y: top },
      { x: 1, y: bottom },
      { x: 0, y: bottom },
    ],
    depthStart: 0,
    depthEnd: 1,
    confirmed: false,
    tile: { color: '#ffffff', widthMm: 300, heightMm: 300, groutWidth: 0, estimated: true },
  };
}
const review: ReconstructionReview = {
  version: 2,
  analysis: 'partial',
  candidates: [],
  warnings: [],
  planes: [plane('back', 0, 0.8), plane('floor', 0.8, 1)],
};

describe('v2 installation judgment', () => {
  it('places an elevated basin on the uniquely observed wall without a floor contact', () => {
    const c = candidate();
    c.installation = judgeCandidateInstallation(c, review);
    expect(c.installation).toMatchObject({
      mode: 'wall',
      wall: 'back',
      basinVariant: 'wall',
      source: 'inferred',
    });
    const placement = mapReconstructionCandidate(c, review)!;
    expect(placement.face).toBe('back');
    const estimated = estimateCandidateFixture(c, review, DEFAULT_ROOM, placement);
    expect(estimated.basinVariant).toBe('wall');
    expect(estimated.heightMm).toBe(320);
    expect(estimated.widthMm).toBe(600);
    expect(estimated.depthMm).toBe(450);
    expect(estimated.provenance?.dimensions).toBe('default');
    expect(estimated.baseHeightMm).toBeGreaterThan(500);
    expect(estimated.provenance?.position).toBe('inferred');
  });
  it('does not silently turn floor-adjacent basin pixels into a pedestal', () => {
    const c = candidate({ foot: { x: 0.35, y: 0.95 } });
    expect(judgeCandidateInstallation(c, review).mode).toBe('unknown');
    expect(mapReconstructionCandidate(c, review)).toBeUndefined();
    c.source = 'user';
    c.installation = { mode: 'floor', basinVariant: 'pedestal', source: 'user', reason: '기둥형 확인' };
    expect(mapReconstructionCandidate(c, review)?.face).toBe('floor');
  });
  it('keeps multiple-wall ambiguity unplaced until an installation wall is confirmed', () => {
    const ambiguous = { ...review, planes: [...review.planes, plane('left', 0, 0.8)] };
    const c = candidate();
    expect(mapReconstructionCandidate(c, ambiguous)).toBeUndefined();
    c.installation = {
      mode: 'wall',
      wall: 'left',
      basinVariant: 'wall',
      source: 'user',
      reason: '왼쪽 벽 확인',
    };
    expect(mapReconstructionCandidate(c, ambiguous)?.face).toBe('left');
  });
  it('keeps independent cabinets available with an honest label and no proposed subtype', () => {
    const c = candidate({ kind: 'vanity', detectedLabel: 'cabinet' });
    expect(reconstructionCandidateLabel(c)).toContain('종류 확인 필요');
    expect(judgeCandidateInstallation(c, review).mode).toBe('unknown');
    expect(mapReconstructionCandidate(c, review)).toBeUndefined();
  });
  it('retains weak detections and reflection suspects without automatically placing them', () => {
    expect(
      mapReconstructionCandidate(candidate({ evidence: { semanticPixels: 400, meanMargin: 0.5 } }), review),
    ).toBeUndefined();
    expect(
      mapReconstructionCandidate(candidate({ requiresReview: true, reflectionOf: 'mirror' }), review),
    ).toBeUndefined();
  });
  it('provides separate editable defaults for every new fixture and basin support type', () => {
    expect(reconstructionDefaults('basin')).toMatchObject({
      face: 'back',
      heightMm: 320,
      baseHeightMm: 650,
      basinVariant: 'wall',
    });
    expect(reconstructionDefaults('basin', 'pedestal')).toMatchObject({
      face: 'floor',
      baseHeightMm: 0,
      heightMm: 800,
    });
    expect(reconstructionDefaults('basin', 'vanity')).toMatchObject({
      face: 'floor',
      heightMm: 850,
      basinVariant: 'vanity',
    });
    expect(reconstructionDefaults('glassPartition')).toMatchObject({ opacity: 0.18, depthMm: 8 });
    expect(reconstructionDefaults('mirrorCabinet')).toMatchObject({ doorCount: 2, depthMm: 150 });
    expect(reconstructionDefaults('wallShelf')).toMatchObject({ shelfStyle: 'solid', baseHeightMm: 1700 });
  });
});

it('records weak semantic classification as the cause of a held candidate before placement', () => {
  const weak = candidate({ evidence: { semanticPixels: 400, meanMargin: 0.7 } });
  const result = reviewFromSegmentation(
    { width: 64, height: 64, wall: new Uint8Array(4096), floor: new Uint8Array(4096), objects: [weak] },
    new Uint8ClampedArray(4096 * 4).fill(180),
    DEFAULT_ROOM,
  );
  expect(result.candidates[0].requiresReview).toBe(true);
  expect(result.candidates[0].warning).toContain('분류 근거가 약해요');
  expect(result.candidates[0].trace).toContainEqual(
    expect.objectContaining({ stage: 'candidate', outcome: 'held' }),
  );
  expect(result.candidates[0].trace).toContainEqual(
    expect.objectContaining({ stage: 'placement', outcome: 'held' }),
  );
});
