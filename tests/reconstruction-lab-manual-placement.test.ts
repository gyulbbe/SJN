import { describe, it, expect } from 'vitest';
import { DEFAULT_ROOM } from '../src/lib/room-geometry';
import { resolveManualDraft } from '../src/lib/reconstruction/lab-manual-placement';
import type { LabManualDraft } from '../src/lib/reconstruction/lab-correction';
import { buildCandidatePipeline } from '../src/lib/reconstruction/candidate-pipeline';
import type { SceneUnderstanding } from '../src/lib/reconstruction/pipeline-contract';

const draft: LabManualDraft = {
  enabled: true,
  face: 'floor',
  u: '.5',
  v: '.5',
  baseHeightMm: '0',
  widthMm: '',
  heightMm: '',
  depthMm: '',
  yawDegrees: '0',
  wallPosition: { wall: 'back', alongMm: '1200', clearanceMm: '70' },
};
const original: SceneUnderstanding = {
  schemaVersion: 1,
  candidates: [
    {
      id: 'toilet',
      kind: 'toilet',
      bounds: { left: 0.3, right: 0.5, top: 0.3, bottom: 0.7 },
      mounting: 'floor',
      wall: 'back',
      basinStyle: 'unknown',
      shape: 'unknown',
      reflection: 'physical',
      evidence: ['test input'],
      uncertainty: [],
      provenance: { kind: 'user', wall: 'user', mounting: 'user' },
    },
  ],
  relations: [],
  roomLayout: { orthogonal: 'unknown', evidence: [], uncertainty: [], corners: [], lines: [] },
};
const baseline = {
  version: 2 as const,
  analysis: 'partial' as const,
  planes: [],
  candidates: [],
  warnings: [],
};

describe('wall distances through correction input and scene', () => {
  it('uses default depth without falsely recording a measured dimension', () => {
    const p = resolveManualDraft(draft, DEFAULT_ROOM, 680);
    expect(p.v * DEFAULT_ROOM.depthMm).toBeCloseTo(410);
    expect(p.depthMm).toBeUndefined();
    expect(p.wallReference).toEqual({ wall: 'back', alongMm: 1200, clearanceMm: 70 });
  });
  it('places an explicitly confirmed fixture with no source camera and keeps its origin unchanged', () => {
    const p = resolveManualDraft(draft, DEFAULT_ROOM, 680);
    const source = JSON.stringify(original);
    const result = buildCandidatePipeline(
      original,
      baseline,
      DEFAULT_ROOM,
      { width: 447, height: 447 },
      { toilet: p },
    );
    expect(result.plans.toilet).toBeTruthy();
    expect(result.plans.toilet?.provenance).toMatchObject({
      position: 'user',
      wall: 'user',
      dimensions: 'default',
      depth: 'default',
    });
    expect(result.pipeline.placements[0].reasons.join(' ')).toContain('70mm');
    expect(result.pipeline.camera.status).toBe('held');
    expect(JSON.stringify(original)).toBe(source);
  });
  it('rejects a stale reference after coordinates or wall provenance are changed', () => {
    const p = resolveManualDraft(draft, DEFAULT_ROOM, 680);
    expect(() =>
      buildCandidatePipeline(
        original,
        baseline,
        DEFAULT_ROOM,
        { width: 447, height: 447 },
        { toilet: { ...p, u: 0.6 } },
      ),
    ).toThrow('일치');
    const unconfirmed = structuredClone(original);
    unconfirmed.candidates[0].provenance!.wall = 'model';
    expect(() =>
      buildCandidatePipeline(unconfirmed, baseline, DEFAULT_ROOM, { width: 447, height: 447 }, { toilet: p }),
    ).toThrow('일치');
  });
  it.each(['', ' ', 'NaN', '-10'])(
    'keeps incomplete/invalid distance %s from becoming zero or success',
    (value) => {
      expect(() =>
        resolveManualDraft(
          { ...draft, wallPosition: { ...draft.wallPosition!, clearanceMm: value } },
          DEFAULT_ROOM,
          680,
        ),
      ).toThrow();
    },
  );
  it('requires an explicitly selected wall', () => {
    expect(() =>
      resolveManualDraft({ ...draft, wallPosition: { ...draft.wallPosition!, wall: '' } }, DEFAULT_ROOM, 680),
    ).toThrow();
  });
  it('retains the free-position contract for an old draft', () => {
    const p = resolveManualDraft({ ...draft, wallPosition: undefined, depthMm: '600' }, DEFAULT_ROOM, 680);
    expect(p).toEqual({ face: 'floor', u: 0.5, v: 0.5, baseHeightMm: 0, yawDegrees: 0, depthMm: 600 });
  });
});
