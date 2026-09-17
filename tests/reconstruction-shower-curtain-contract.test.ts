import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  fixtureReconstructionSchema,
  legacyProjectSchema,
  materialInputSchema,
  reconstructionReviewSchema,
} from '../src/lib/storage/validation';
import {
  reconstructionDefaults,
  reconstructionLabels,
  type CurtainHardware,
  type ReconstructionKind,
  type ReconstructionProvenance,
  type ReconstructionReview,
} from '../src/lib/reconstruction/types';
import {
  categoryLabels,
  DEFAULT_COLOR,
  EMPTY_MASK,
  type FixtureInstance,
  type LegacyProjectDocument,
  type MaterialInput,
} from '../src/lib/types';
import type { SceneCandidate } from '../src/lib/reconstruction/pipeline-contract';
import {
  parseSceneUnderstanding,
  SCENE_UNDERSTANDING_PROMPT,
  sceneUnderstandingJsonSchema,
} from '../src/lib/reconstruction/scene-understanding';
import { LAB_QWEN_PROMPT_REVISION } from '../src/lib/reconstruction/lab-engine';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const hardware: CurtainHardware[] = ['rod', 'track', 'none'];
function reconstruction() {
  return {
    version: 2 as const,
    kind: 'showerCurtain' as const,
    color: '#ddd8c8',
    widthMm: 881,
    heightMm: 1822,
    depthMm: 48,
    baseHeightMm: 210,
    yawDegrees: 37,
    placementPolicy: 'preserve' as const,
  };
}
function fixture(): FixtureInstance {
  return {
    id: crypto.randomUUID(),
    name: '저장 경계 검증용 커튼',
    materialVersionId: crypto.randomUUID(),
    reconstruction: {
      ...reconstruction(),
      curtainHardware: 'track',
      provenance: { curtainHardware: 'user', width: 'user', position: 'user' },
    },
    roomPlacement: {
      face: 'floor',
      u: 0.34,
      v: 0.57,
      scale: 1,
      widthMm: 881,
      heightMm: 1822,
      imageAspect: 881 / 1822,
      contentBounds: { left: 0, top: 0, right: 1, bottom: 1 },
    },
    viewIndex: 0,
    position: { x: 0.42, y: 0.66 },
    width: 0.4,
    height: 0.6,
    rotation: 0,
    anchor: { x: 0.5, y: 1 },
    locked: false,
    shadow: { x: 0, y: 0, opacity: 0.2, blur: 0.01, scale: 1 },
    occlusion: EMPTY_MASK(),
    color: { ...DEFAULT_COLOR },
  };
}
function document(): LegacyProjectDocument {
  return {
    id: crypto.randomUUID(),
    ownerId: 'local',
    name: '격리된 저장 형식 테스트',
    schemaVersion: 2,
    editRevision: 0,
    storageRevision: 0,
    createdAt: '2026-09-15T00:00:00.000Z',
    updatedAt: '2026-09-15T00:00:00.000Z',
    viewport: { zoom: 1, pan: { x: 0, y: 0 } },
    history: { past: [], future: [] },
    scene: {
      originalAssetId: crypto.randomUUID(),
      previewAssetId: crypto.randomUUID(),
      imageWidth: 800,
      imageHeight: 1200,
      room: { kind: 'parametric', version: 1, widthMm: 2400, heightMm: 2400, depthMm: 2400 },
      surfaces: [],
      fixtures: [fixture()],
      protection: EMPTY_MASK(),
      color: { ...DEFAULT_COLOR },
    },
  };
}
function material(): MaterialInput {
  return {
    name: '커튼 표준 모형',
    brand: '',
    code: '',
    category: 'showerCurtain',
    scope: 'personal',
    description: '앱 기본값이며 실측 아님',
    color: '#ddd8c8',
    finish: '',
    widthMm: 881,
    heightMm: 1822,
    depthMm: 48,
    usage: 'both',
    installation: 'suspended',
    reconstruction: { version: 2, kind: 'showerCurtain' },
    textureAssetIds: [],
    views: [{ assetId: crypto.randomUUID(), direction: '정면', anchor: { x: 0.5, y: 0 } }],
    defaultGroutWidth: 2,
    defaultGroutColor: '#ffffff',
    defaultPattern: 'grid',
  };
}
function review(): ReconstructionReview {
  return {
    version: 2,
    warnings: [],
    analysis: 'manual',
    planes: [],
    candidates: [
      {
        id: 'curtain_1',
        kind: 'showerCurtain',
        source: 'user',
        installation: { mode: 'suspended', source: 'user', reason: '사용자가 커튼 걸이를 확인함' },
        bounds: { left: 0.2, top: 0.1, right: 0.6, bottom: 0.9 },
        foot: { x: 0.4, y: 0.9 },
        color: '#ddd8c8',
        pixels: 0,
        evidence: { semanticPixels: 0, meanMargin: 0 },
        status: 'unplaced',
        requiresReview: true,
      },
    ],
  };
}

describe('shower curtain foundation (synthetic storage contracts, no recognition claim)', () => {
  it('provides an editable v2 whole-envelope default without a second support-height field', () => {
    const defaults = reconstructionDefaults('showerCurtain');
    expect(defaults).toEqual({
      version: 2,
      widthMm: 900,
      heightMm: 1900,
      depthMm: 50,
      color: '#e8e7e1',
      face: 'floor',
      baseHeightMm: 0,
      yawDegrees: 0,
      curtainHardware: 'rod',
    });
    expect(reconstructionLabels.showerCurtain).toBe('샤워 커튼');
    expect(categoryLabels.showerCurtain).toBe('샤워 커튼');
    expect(defaults).not.toHaveProperty('topSupportHeightMm');
    expect(defaults).not.toHaveProperty('support');
    defaults.widthMm = 1;
    expect(reconstructionDefaults('showerCurtain').widthMm).toBe(900);
  });
  it.each(hardware)(
    'roundtrips %s with exact custom dimensions and every valid provenance source',
    (curtainHardware) => {
      for (const source of ['model', 'inferred', 'default', 'user'] as ReconstructionProvenance[]) {
        const value = {
          ...reconstruction(),
          curtainHardware,
          provenance: { curtainHardware: source, dimensions: 'user' as const, position: 'user' as const },
        };
        const before = structuredClone(value);
        expect(fixtureReconstructionSchema.parse(JSON.parse(JSON.stringify(value)))).toEqual(value);
        expect(value).toEqual(before);
      }
    },
  );
  it('keeps an omitted hardware choice absent instead of injecting rod during load', () => {
    const value = reconstruction();
    expect(fixtureReconstructionSchema.parse(value)).toEqual(value);
    expect(fixtureReconstructionSchema.parse(value)).not.toHaveProperty('curtainHardware');
  });
  it.each([
    { curtainHardware: 'pipe' },
    { curtainHardware: null },
    { version: 1 },
    { depthMm: 0 },
    { depthMm: -1 },
    { widthMm: 0 },
    { heightMm: Infinity },
    { baseHeightMm: -1 },
    { yawDegrees: NaN },
    { curtainHardware: 'rod', provenance: { curtainHardware: 'observed' } },
    { provenance: { curtainHardware: 'user' } },
  ])('rejects malformed or incompatible new values %j without silently repairing them', (patch) => {
    expect(fixtureReconstructionSchema.safeParse({ ...reconstruction(), ...patch }).success).toBe(false);
  });
  it('requires both hardware and its provenance to be cleared on a kind change', () => {
    const value = {
      ...reconstruction(),
      kind: 'glassPartition',
      curtainHardware: 'rod',
      provenance: { curtainHardware: 'user', width: 'user' },
    };
    expect(fixtureReconstructionSchema.safeParse(value).success).toBe(false);
    expect(fixtureReconstructionSchema.safeParse({ ...value, curtainHardware: undefined }).success).toBe(
      false,
    );
    const cleared = { ...value, curtainHardware: undefined, provenance: { width: 'user' } };
    expect(fixtureReconstructionSchema.parse(cleared).provenance).toEqual({ width: 'user' });
    expect(value.provenance.curtainHardware).toBe('user');
  });
  it('preserves legacy fixture kinds, versions and materials when the new fields are absent', () => {
    for (const kind of Object.keys(reconstructionLabels).filter(
      (k) => k !== 'showerCurtain',
    ) as ReconstructionKind[]) {
      for (const version of [1, 2]) {
        const value = { kind, version, color: '#bbaa99', widthMm: 700, heightMm: 800, depthMm: 40 };
        expect(fixtureReconstructionSchema.parse(value)).toEqual(value);
      }
    }
    for (const installation of ['floor', 'wall', 'embedded'] as const) {
      const legacy = { ...material(), category: 'basin' as const, installation, reconstruction: undefined };
      expect(materialInputSchema.parse(legacy)).toEqual(legacy);
    }
  });
  it('persists current and undo/redo scenes without changing source assets or creating quote values', () => {
    const value = document();
    value.history.past.push(structuredClone(value.scene));
    value.history.future.push(structuredClone(value.scene));
    const copy = structuredClone(value);
    const result = legacyProjectSchema.parse(JSON.parse(JSON.stringify(value)));
    expect(result).toEqual(copy);
    expect(value).toEqual(copy);
    expect(result.scene.fixtures[0].reconstruction).not.toHaveProperty('topSupportHeightMm');
    expect(result).not.toHaveProperty('quote');
    const storedMaterial = material();
    expect(materialInputSchema.parse(storedMaterial)).toEqual(storedMaterial);
    expect(materialInputSchema.parse(storedMaterial)).not.toHaveProperty('pricing');
  });
  it.each(['left', 'back', 'right', undefined] as const)(
    'rejects %s as the curtain coordinate frame while retaining valid data',
    (face) => {
      const value = document();
      if (face) value.scene.fixtures[0].roomPlacement!.face = face;
      else delete value.scene.fixtures[0].roomPlacement;
      expect(legacyProjectSchema.safeParse(value).success).toBe(false);
      expect(value.scene.fixtures[0].reconstruction!.baseHeightMm).toBe(210);
    },
  );
  it('preserves hanging support separately from the candidate image bottom and proposed kind', () => {
    const value = review();
    expect(reconstructionReviewSchema.parse(value)).toEqual(value);
    const corrected = review();
    corrected.candidates[0].kind = 'glassPartition';
    corrected.candidates[0].proposedKind = 'showerCurtain';
    expect(reconstructionReviewSchema.parse(corrected)).toEqual(corrected);
    expect(reconstructionReviewSchema.parse(value).candidates[0].foot).toEqual({ x: 0.4, y: 0.9 });
    for (const mode of ['wall', 'floor'] as const) {
      const bad = review();
      bad.candidates[0].installation!.mode = mode;
      expect(reconstructionReviewSchema.safeParse(bad).success).toBe(false);
    }
    for (const mode of [undefined, 'unknown'] as const) {
      const unresolved = review();
      if (mode) unresolved.candidates[0].installation!.mode = mode;
      else delete unresolved.candidates[0].installation;
      expect(reconstructionReviewSchema.parse(unresolved)).toEqual(unresolved);
    }
    const other = review();
    other.candidates[0].kind = 'wallShelf';
    expect(reconstructionReviewSchema.safeParse(other).success).toBe(false);
  });
  it('requires suspended material semantics without reinterpreting the coordinate frame as floor support', () => {
    for (const installation of ['floor', 'wall', 'embedded'] as const)
      expect(materialInputSchema.safeParse({ ...material(), installation }).success).toBe(false);
    expect(materialInputSchema.safeParse({ ...material(), category: 'shower' }).success).toBe(false);
    expect(
      materialInputSchema.safeParse({ ...material(), reconstruction: { kind: 'showerCurtain', version: 1 } })
        .success,
    ).toBe(false);
  });
  it.each([{ depthMm: 0 }, { reconstruction: { version: 2, kind: 'glassPartition' } }])(
    'rejects a curtain material with inconsistent envelope or reconstruction identity %j',
    (patch) => {
      expect(materialInputSchema.safeParse({ ...material(), ...patch }).success).toBe(false);
    },
  );
  it('preserves the frozen inventory prompt, grammar and revision despite the broader internal types', () => {
    expect(LAB_QWEN_PROMPT_REVISION).toBe(8);
    expect(sha256(SCENE_UNDERSTANDING_PROMPT)).toBe(
      '952b65bd58c7de20a3ca2d80e52a8ed3bb5fe1cf5fd354797dfcb5e25850afea',
    );
    expect(sha256(JSON.stringify(sceneUnderstandingJsonSchema))).toBe(
      '45a2c392844fc50b5a750651343b2b6c3ff80932ec66cb18b1f56de4e92e5dd9',
    );
    const internal: SceneCandidate = {
      id: 'curtain_1',
      kind: 'showerCurtain',
      mounting: 'suspended',
      wall: 'unknown',
      bounds: { left: 0.1, top: 0.1, right: 0.6, bottom: 0.8 },
      basinStyle: 'unknown',
      shape: 'unknown',
      reflection: 'physical',
      evidence: [],
      uncertainty: [],
    };
    const response = {
      schemaVersion: 1,
      candidates: [{ ...internal, anchor: null }],
      relations: [],
      roomLayout: {
        backWallQuad: null,
        orthogonal: 'unknown',
        evidence: [],
        uncertainty: [],
        lines: [],
        corners: [],
      },
    };
    expect(() => parseSceneUnderstanding(JSON.stringify(response))).toThrow();
  });
});
