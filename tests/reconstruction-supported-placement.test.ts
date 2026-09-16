import { describe, expect, it } from 'vitest';
import {
  judgeCandidateInstallation,
  mapReconstructionCandidate,
} from '../src/lib/reconstruction/installation';
import type {
  ReconstructionCandidate,
  ReconstructionPlane,
  ReconstructionReview,
} from '../src/lib/reconstruction/types';
import { estimateCandidateFixture } from '../src/lib/reconstruction';
import { DEFAULT_ROOM } from '../src/lib/room-geometry';
import { reconstructionReviewSchema } from '../src/lib/supabase/validation';

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
    tile: { color: '#aaaaaa', widthMm: 300, heightMm: 600, groutWidth: 2, estimated: true },
  };
}
const review: ReconstructionReview = {
  version: 2,
  analysis: 'partial',
  warnings: [],
  candidates: [],
  planes: [plane('back', 0, 0.8), plane('floor', 0.8, 1)],
};
function basin(): ReconstructionCandidate {
  return {
    id: 'visible-basin',
    kind: 'basin',
    source: 'deeplab',
    status: 'unplaced',
    bounds: { left: 0.2, top: 0.3, right: 0.5, bottom: 0.86 },
    foot: { x: 0.35, y: 0.86 },
    color: '#eeeeee',
    pixels: 4000,
    evidence: {
      semanticPixels: 4000,
      meanMargin: 3.5,
      pedestalSupport: { stemWidthRatio: 0.35, stemHeightRatio: 0.6, coverage: 0.95 },
    },
  };
}
describe('observed fixture support and installation', () => {
  it('places an observed continuous pedestal on the floor without turning it into a wall basin', () => {
    const c = basin();
    expect(judgeCandidateInstallation(c, review)).toMatchObject({
      mode: 'floor',
      basinVariant: 'pedestal',
      source: 'inferred',
    });
    expect(mapReconstructionCandidate(c, review)).toMatchObject({ face: 'floor', u: 0.35 });
    expect(c.evidence.meanMargin).toBe(3.5);
  });
  it('does not infer a pedestal from a bowl touching the floor without a support observation', () => {
    const c = basin();
    delete c.evidence.pedestalSupport;
    expect(judgeCandidateInstallation(c, review).mode).toBe('unknown');
    expect(mapReconstructionCandidate(c, review)).toBeUndefined();
  });
  it.each([
    { stemWidthRatio: 0.85, stemHeightRatio: 0.6, coverage: 0.95 },
    { stemWidthRatio: 0.35, stemHeightRatio: 0.15, coverage: 0.95 },
    { stemWidthRatio: 0.35, stemHeightRatio: 0.6, coverage: 0.3 },
  ])('holds wide, short or interrupted apparent supports instead of inventing a pedestal: %j', (support) => {
    const c = basin();
    c.evidence.pedestalSupport = support;
    expect(judgeCandidateInstallation(c, review).mode).toBe('unknown');
  });
  it('does not put a suspended tall basin shape on the floor solely because of a narrow shape', () => {
    const c = basin();
    c.foot.y = 0.55;
    expect(judgeCandidateInstallation(c, review).basinVariant).not.toBe('pedestal');
    expect(mapReconstructionCandidate(c, review)).toBeUndefined();
  });
  it('keeps a reflection or explicit review hold even when there is pedestal evidence', () => {
    const c = basin();
    c.requiresReview = true;
    c.reflectionOf = 'mirror';
    expect(mapReconstructionCandidate(c, review)).toBeUndefined();
  });
  it('preserves the observed support through server validation and rejects invalid support values', () => {
    const document = { ...review, candidates: [basin()] };
    const saved = reconstructionReviewSchema.parse(document);
    expect(saved.candidates[0].evidence.pedestalSupport).toEqual(
      document.candidates[0].evidence.pedestalSupport,
    );
    document.candidates[0].evidence.pedestalSupport!.coverage = 2;
    expect(reconstructionReviewSchema.safeParse(document).success).toBe(false);
  });
});

it('keeps a wall basin observation but does not turn an appearance region into a measured installation wall', () => {
  const source = { ...plane('back', 0.02, 0.98), geometrySource: 'appearance-region' as const };
  const r = { ...review, planes: [source, plane('floor', 0.8, 1)] };
  const c = basin();
  delete c.evidence.pedestalSupport;
  c.bounds.bottom = c.foot.y = 0.48;
  const installation = judgeCandidateInstallation(c, r);
  expect(installation.mode).toBe('wall');
  expect(installation.wall).toBeUndefined();
  expect(installation.reason).toContain('높이');
  expect(mapReconstructionCandidate(c, r)).toBeUndefined();
  expect(c.status).toBe('unplaced');
  c.installation = {
    mode: 'wall',
    wall: 'back',
    basinVariant: 'wall',
    source: 'user',
    reason: '설치 벽 확인',
  };
  const placement = mapReconstructionCandidate(c, r)!;
  const estimate = estimateCandidateFixture(c, r, DEFAULT_ROOM, placement);
  expect(estimate.baseHeightMm).toBe(650);
  expect(estimate.provenance).toMatchObject({ position: 'default', wall: 'user', dimensions: 'default' });
  const cropped = {
    ...r,
    planes: [
      {
        ...source,
        quad: source.quad.map((p) => ({ ...p, y: 0.1 + p.y * 0.8 })) as ReconstructionPlane['quad'],
      },
      plane('floor', 0.8, 1),
    ],
  };
  expect(
    estimateCandidateFixture(c, cropped, DEFAULT_ROOM, mapReconstructionCandidate(c, cropped)!).baseHeightMm,
  ).toBe(650);
});

it('does not reuse a historical inferred wall name from an uncalibrated appearance region', () => {
  const c = basin();
  c.bounds.bottom = c.foot.y = 0.48;
  c.installation = {
    mode: 'wall',
    wall: 'back',
    basinVariant: 'wall',
    source: 'inferred',
    reason: 'old observation',
  };
  const source = { ...plane('back', 0, 0.8), geometrySource: undefined, id: 'observed-back' };
  const r = { ...review, planes: [source] };
  expect(judgeCandidateInstallation(c, r).wall).toBeUndefined();
  expect(mapReconstructionCandidate(c, r)).toBeUndefined();
});
