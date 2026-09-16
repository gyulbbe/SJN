import { describe, it, expect } from 'vitest';
import {
  buildCandidatePipeline,
  type ManualCandidatePlacement,
} from '../src/lib/reconstruction/candidate-pipeline';
import { DEFAULT_ROOM } from '../src/lib/room-geometry';
import type { SceneCandidate, SceneUnderstanding } from '../src/lib/reconstruction/pipeline-contract';
import type { ReconstructionReview } from '../src/lib/reconstruction/types';
import { resolveManualDraft } from '../src/lib/reconstruction/lab-manual-placement';
import {
  captureLabCorrection,
  restoreLabCorrectionDraft,
  type LabManualDraft,
} from '../src/lib/reconstruction/lab-correction';
import { standardBathRimGeometry } from '../src/lib/reconstruction/bath-rim-geometry';
const room = { ...DEFAULT_ROOM };
const baseline: ReconstructionReview = {
  version: 2,
  analysis: 'partial',
  planes: [],
  candidates: [],
  warnings: [],
};
function observation(kind: SceneCandidate['kind'], id: string, x: number): SceneCandidate {
  return {
    id,
    kind,
    bounds: { left: x, top: 0.2, right: x + 0.2, bottom: 0.5 },
    mounting: 'floor',
    wall: 'unknown',
    basinStyle: 'unknown',
    shape: 'unknown',
    reflection: 'physical',
    evidence: ['synthetic unit input, not actual model detection'],
    uncertainty: [],
    provenance: { kind: 'user' },
  };
}
function source(): SceneUnderstanding {
  return {
    schemaVersion: 1,
    candidates: [observation('glassPartition', 'glass', 0.1), observation('bath', 'bath', 0.5)],
    relations: [],
    roomLayout: { orthogonal: 'unknown', evidence: [], uncertainty: [] },
  };
}
const draft: LabManualDraft = {
  enabled: true,
  face: 'floor',
  u: '',
  v: '',
  baseHeightMm: '',
  yawDegrees: '',
  widthMm: '800',
  heightMm: '1800',
  depthMm: '8',
  support: {
    kind: 'bath-rim',
    heightMm: '',
    bathRim: { parentCandidateId: 'bath', side: 'front', offsetMm: '-200' },
  },
};
const manual = (): Record<string, ManualCandidatePlacement> => ({
  bath: { face: 'floor', u: 0.5, v: 0.3, baseHeightMm: 0, yawDegrees: 0 },
  glass: resolveManualDraft(draft, room, 8),
});
const build = (s = source(), m = manual()) =>
  buildCandidatePipeline(s, baseline, room, { width: 447, height: 447 }, m, s);
describe('Lab user-confirmed bath candidate attachment', () => {
  it('keeps candidate IDs separate until fixture creation, resolves a parent appearing after the glass and preserves raw inputs', () => {
    const s = source(),
      input = manual(),
      raw = JSON.stringify({ s, input });
    const result = build(s, input);
    expect(result.plans.bath?.kind).toBe('bath');
    expect(result.plans.glass?.bathRimCandidate?.parentCandidateId).toBe('bath');
    expect(result.plans.glass?.support).toBeUndefined();
    expect(result.plans.glass?.baseHeightMm).toBeCloseTo(standardBathRimGeometry(1500, 600, 750).heightMm, 4);
    expect(result.pipeline.userBathRimLinks).toMatchObject([
      { candidateId: 'glass', parentCandidateId: 'bath', status: 'attached' },
    ]);
    expect(JSON.stringify({ s, input })).toBe(raw);
    expect(result.pipeline.automaticUnderstanding).toEqual(s);
    expect(result.plans.glass?.provenance?.position).toBe('user');
  });
  it.each(['missing', 'held', 'changed-kind', 'reflection'] as const)(
    'holds only the linked glass when parent is %s and retains correction',
    (mode) => {
      const s = source(),
        m = manual();
      if (mode === 'missing') {
        s.candidates = s.candidates.filter((c) => c.id !== 'bath');
        delete m.bath;
      }
      if (mode === 'held') delete m.bath;
      if (mode === 'changed-kind') s.candidates[1].kind = 'toilet';
      if (mode === 'reflection') {
        s.candidates[1].reflection = 'reflected';
        delete m.bath;
      }
      const original = JSON.stringify(m.glass),
        result = build(s, m);
      expect(result.plans.glass).toBeNull();
      expect(result.review.candidates.find((c) => c.id === 'glass')?.requiresReview).toBe(true);
      expect(result.pipeline.userBathRimLinks?.[0].status).toBe('held');
      expect(JSON.stringify(m.glass)).toBe(original);
    },
  );
  it.each(['width', 'height', 'offset', 'thickness'] as const)(
    'does not clamp oversized %s into a success',
    (mode) => {
      const m = manual();
      if (mode === 'width') m.glass.widthMm = 3000;
      if (mode === 'height') m.glass.heightMm = 2400;
      if (mode === 'offset') m.glass.bathRim!.offsetMm = 3000;
      if (mode === 'thickness') m.glass.depthMm = 100;
      const result = build(source(), m);
      expect(result.plans.glass).toBeNull();
      expect(result.plans.bath).not.toBeNull();
      expect(result.pipeline.userBathRimLinks?.[0].status).toBe('held');
    },
  );
  it.each(['wall-face', 'wall-reference', 'independent-support'] as const)(
    'rejects contradictory direct relation input: %s',
    (mode) => {
      const m = manual();
      if (mode === 'wall-face') m.glass.face = 'left';
      if (mode === 'wall-reference') m.glass.wallReference = { wall: 'left', alongMm: 1000, clearanceMm: 0 };
      if (mode === 'independent-support')
        m.glass.support = { kind: 'bath-rim', heightMm: 600, provenance: { kind: 'user', height: 'user' } };
      const raw = JSON.stringify(m);
      expect(() => build(source(), m)).toThrow('별도 벽 기준이나 독립 지지 높이');
      expect(JSON.stringify(m)).toBe(raw);
    },
  );
  it('recalculates from parent move, yaw and height instead of stale manual glass coordinates', () => {
    const m = manual();
    m.bath.u = 0.6;
    m.bath.v = 0.45;
    m.bath.yawDegrees = 90;
    m.bath.heightMm = 620;
    const result = build(source(), m);
    expect(result.plans.glass?.yawDegrees).toBe(90);
    expect(result.plans.glass?.heightMm).toBe(1800);
    expect(result.plans.glass?.baseHeightMm).toBeCloseTo(standardBathRimGeometry(1500, 620, 750).heightMm, 4);
  });
  it('preserves independent historical height and validates explicit relation input', () => {
    const old = {
      ...draft,
      u: '.5',
      v: '.5',
      baseHeightMm: '600',
      yawDegrees: '0',
      support: { kind: 'bath-rim' as const, heightMm: '600', heightSource: 'default' as const },
    };
    expect(resolveManualDraft(old, room, 8).support?.provenance.height).toBe('default');
    expect(resolveManualDraft(old, room, 8).bathRim).toBeUndefined();
    expect(() =>
      resolveManualDraft(
        { ...draft, support: { ...draft.support!, bathRim: { ...draft.support!.bathRim!, offsetMm: '' } } },
        room,
        8,
      ),
    ).toThrow();
  });
  it('captures and restores the exact parent/side/offset without changing old result metadata', () => {
    const snapshot = captureLabCorrection({
      capturedAt: '2026-09-13T00:00:00Z',
      sourceRunId: 'run',
      inputKey: 'key',
      sourceModelRunId: 'model',
      sourceEngineMetadata: {
        id: 'candidate',
        revision: 'test',
        modelId: 'test',
        modelRevision: 'test',
        settings: {},
      },
      draft: { manual: { glass: structuredClone(draft) }, corrections: {}, additions: [] },
      input: { understanding: source(), manualPlacements: manual() },
      changedFieldCount: 1,
    });
    const edit = restoreLabCorrectionDraft(snapshot, 'run', 'key');
    edit.manual.glass.support!.bathRim!.offsetMm = '100';
    expect(snapshot.draft.manual.glass.support!.bathRim!.offsetMm).toBe('-200');
    expect(snapshot.input.manualPlacements.glass.bathRim?.parentCandidateId).toBe('bath');
  });
});
