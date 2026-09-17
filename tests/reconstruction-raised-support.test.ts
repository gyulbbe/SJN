import { describe, expect, it } from 'vitest';
import { DEFAULT_ROOM } from '../src/lib/room-geometry';
import { validateSourceFixture } from '../src/lib/reconstruction/source-camera';
import { reconstructionModelTransform } from '../src/lib/reconstruction/projection';
import { fixtureReconstructionSchema } from '../src/lib/storage/validation';
import { resolveManualDraft } from '../src/lib/reconstruction/lab-manual-placement';
import { buildCandidatePipeline } from '../src/lib/reconstruction/candidate-pipeline';
import type { RaisedGlassSupport } from '../src/lib/reconstruction/types';
import type { SceneUnderstanding } from '../src/lib/reconstruction/pipeline-contract';

const support: RaisedGlassSupport = {
  kind: 'bath-rim',
  heightMm: 600,
  provenance: { kind: 'user', height: 'user' },
};
const plan = {
  kind: 'glassPartition',
  version: 2 as const,
  face: 'floor' as const,
  u: 0.5,
  v: 0.5,
  widthMm: 800,
  heightMm: 1800,
  depthMm: 8,
  baseHeightMm: 600,
  yawDegrees: 90,
  color: '#abcdef',
  support,
};
const review = {
  version: 2 as const,
  analysis: 'partial' as const,
  planes: [],
  candidates: [],
  warnings: [],
};
const observation: SceneUnderstanding = {
  schemaVersion: 1,
  candidates: [
    {
      id: 'glass',
      kind: 'glassPartition',
      bounds: { left: 0.4, right: 0.6, top: 0.1, bottom: 0.8 },
      mounting: 'floor',
      wall: 'back',
      basinStyle: 'unknown',
      shape: 'unknown',
      reflection: 'physical',
      evidence: ['Synthetic test candidate, not an inference result'],
      uncertainty: [],
      provenance: { kind: 'user', mounting: 'user', wall: 'user' },
    },
  ],
  relations: [],
  roomLayout: { orthogonal: 'unknown', evidence: [], uncertainty: [], corners: [], lines: [] },
};

describe('explicit independent raised glass support', () => {
  it.each([
    ['bath-rim', 600],
    ['shower-curb', 100],
  ] as const)('uses %s at %imm without shrinking or grounding', (kind, heightMm) => {
    const p = { ...plan, baseHeightMm: heightMm, support: { ...support, kind, heightMm } };
    const check = validateSourceFixture(DEFAULT_ROOM, undefined, p);
    expect(check.valid).toBe(true);
    expect(check.worldBoundsMm?.min[1]).toBe(heightMm);
    expect(check.worldBoundsMm?.max[1]).toBe(heightMm + p.heightMm);
    expect(reconstructionModelTransform(DEFAULT_ROOM, p).origin.y).toBe(heightMm);
    expect(fixtureReconstructionSchema.parse(p).support).toEqual(p.support);
  });
  it('keeps old floor placement and legacy saved metadata without a new field', () => {
    const old = { ...plan, version: 1 as const, baseHeightMm: 0, support: undefined };
    expect(validateSourceFixture(DEFAULT_ROOM, undefined, old).valid).toBe(true);
    expect(fixtureReconstructionSchema.parse(old).support).toBeUndefined();
  });
  it.each(['toilet', 'basin', 'vanity', 'bath', undefined])('never authorizes %s to float', (kind) => {
    expect(validateSourceFixture(DEFAULT_ROOM, undefined, { ...plan, kind }).valid).toBe(false);
  });
  it.each([
    ['missing support', { support: undefined }],
    ['legacy model', { version: 1 as const }],
    ['wall coordinates', { face: 'back' as const }],
    ['mismatched height', { baseHeightMm: 200 }],
    ['above ceiling', { heightMm: 1900 }],
    ['outside room', { u: 0 }],
  ])('rejects %s', (_name, patch) => {
    expect(validateSourceFixture(DEFAULT_ROOM, undefined, { ...plan, ...patch }).valid).toBe(false);
  });
  it.each([0, -1, NaN, Infinity, 20001])(
    'rejects invalid support height %s at validation and storage',
    (heightMm) => {
      const p = { ...plan, support: { ...support, heightMm } };
      expect(validateSourceFixture(DEFAULT_ROOM, undefined, p).valid).toBe(false);
      expect(fixtureReconstructionSchema.safeParse(p).success).toBe(false);
    },
  );
  it('requires a user-confirmed kind, preserves default-height source and rejects a fake model source', () => {
    const p = {
      ...plan,
      support: { ...support, provenance: { kind: 'user' as const, height: 'default' as const } },
    };
    expect(fixtureReconstructionSchema.parse(p).support).toEqual(p.support);
    const invalid = { ...plan, support: { ...support, provenance: { kind: 'model', height: 'model' } } };
    expect(fixtureReconstructionSchema.safeParse(invalid).success).toBe(false);
  });
  it('resolves support and wall distances together and retains user/default attribution', () => {
    const p = resolveManualDraft(
      {
        enabled: true,
        face: 'floor',
        u: '.5',
        v: '.5',
        baseHeightMm: '0',
        widthMm: '',
        heightMm: '',
        depthMm: '',
        yawDegrees: '0',
        support: { kind: 'bath-rim', heightMm: '600' },
        wallPosition: { wall: 'back', alongMm: '1200', clearanceMm: '500' },
      },
      DEFAULT_ROOM,
      8,
    );
    const original = JSON.stringify(observation);
    const result = buildCandidatePipeline(
      observation,
      review,
      DEFAULT_ROOM,
      { width: 447, height: 447 },
      { glass: p },
    );
    expect(result.plans.glass?.baseHeightMm).toBe(600);
    expect(result.plans.glass?.support).toEqual(support);
    expect(result.plans.glass?.provenance?.height).toBe('default');
    expect(result.pipeline.placements[0].reasons.join(' ')).toContain('독립 지지면');
    expect(result.pipeline.camera.status).toBe('held');
    expect(JSON.stringify(observation)).toBe(original);
    p.support!.heightMm = 300;
    expect(result.plans.glass?.support?.heightMm).toBe(600);
  });
});
