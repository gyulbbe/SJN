import { describe, expect, it } from 'vitest';
import { DEFAULT_ROOM } from '../src/lib/room-geometry';
import {
  DEFAULT_COLOR,
  EMPTY_MASK,
  type FixtureInstance,
  type Scene,
  type LegacyProjectDocument,
} from '../src/lib/types';
import { reconstructionDefaults } from '../src/lib/reconstruction/types';
import {
  bathRimFixtureSupport,
  partitionTopFixtureSupport,
  resolveCandidateBathRim,
  resolveCandidatePartitionTop,
  candidatePartitionTopErrors,
  type CandidatePartitionTop,
} from '../src/lib/reconstruction/candidate-bath-rim';
import {
  resolvedBathRimScene,
  resolveBathRimFixture,
  syncBathRimAttachments,
} from '../src/lib/reconstruction/bath-rim';
import { normalizeRoomScene, resizedRoomScene } from '../src/lib/room-editing';
import {
  fixtureReconstructionSchema,
  projectSchema,
  reconstructionReviewSchema,
} from '../src/lib/storage/validation';
import { normalizeProjectDocument, projectScenes } from '../src/lib/comparison';
import { copyDesignDocument, duplicateProjectDocument } from '../src/lib/designs';
import { useEditor } from '../src/lib/editor-store';
import { resolveManualDraft } from '../src/lib/reconstruction/lab-manual-placement';
import {
  buildCandidatePipeline,
  type CandidateFixturePlan,
} from '../src/lib/reconstruction/candidate-pipeline';
import type { SceneUnderstanding } from '../src/lib/reconstruction/pipeline-contract';

const evidence = ['Synthetic contract relation only; not an actual AI observation.'];
const link = (parentCandidateId: string): CandidatePartitionTop => ({
  parentCandidateId,
  offsetMm: 50,
  provenance: { parent: 'inferred', offset: 'inferred' },
  evidence: [...evidence],
});
function plans() {
  return {
    parent: {
      ...reconstructionDefaults('lowPartition'),
      kind: 'lowPartition',
      version: 2,
      face: 'floor',
      u: 0.5,
      v: 0.5,
      widthMm: 1200,
      heightMm: 800,
      depthMm: 150,
      baseHeightMm: 0,
      yawDegrees: 0,
    } as CandidateFixturePlan,
    child: {
      ...reconstructionDefaults('glassPartition'),
      kind: 'glassPartition',
      version: 2,
      face: 'floor',
      u: 0.5,
      v: 0.5,
      widthMm: 600,
      heightMm: 1000,
      depthMm: 8,
      baseHeightMm: 800,
    } as CandidateFixturePlan,
  };
}
function fixture(plan: CandidateFixturePlan): FixtureInstance {
  const { face, u, v, ...meta } = plan;
  return {
    id: crypto.randomUUID(),
    materialVersionId: crypto.randomUUID(),
    name: plan.kind,
    viewIndex: 0,
    position: { x: 0.5, y: 0.5 },
    width: 0.2,
    height: 0.3,
    rotation: 0,
    anchor: { x: 0.5, y: 1 },
    locked: false,
    shadow: { x: 0, y: 0, opacity: 0, blur: 0, scale: 1 },
    occlusion: EMPTY_MASK(),
    color: { ...DEFAULT_COLOR },
    roomPlacement: {
      face,
      u,
      v,
      scale: 1,
      widthMm: plan.widthMm!,
      heightMm: plan.heightMm!,
      imageAspect: 1,
      contentBounds: { left: 0, top: 0, right: 1, bottom: 1 },
    },
    reconstruction: {
      ...meta,
      version: 2,
      widthMm: plan.widthMm!,
      heightMm: plan.heightMm!,
      depthMm: plan.depthMm!,
      color: plan.color!,
    },
  };
}
function sceneData() {
  const p = plans(),
    parent = fixture(p.parent),
    child = fixture(p.child);
  child.reconstruction!.support = partitionTopFixtureSupport(link('parent-observation-id'), parent.id, 800);
  const scene: Scene = {
    room: { ...DEFAULT_ROOM },
    originalAssetId: crypto.randomUUID(),
    previewAssetId: crypto.randomUUID(),
    imageWidth: 1200,
    imageHeight: 800,
    surfaces: [],
    fixtures: [parent, child],
    protection: EMPTY_MASK(),
    color: { ...DEFAULT_COLOR },
  };
  return { scene, parent, child };
}
function project(scene: Scene) {
  const date = new Date().toISOString();
  return normalizeProjectDocument({
    id: crypto.randomUUID(),
    ownerId: 'local',
    name: '지지 관계 단위 검증',
    schemaVersion: 2,
    scene,
    comparison: {
      before: structuredClone(scene),
      room: scene.room!,
      aspect: 1.5,
      cameraVersion: 1,
      status: 'draft',
      referenceOriginalAssetId: scene.originalAssetId,
      referencePreviewAssetId: scene.previewAssetId,
    },
    createdAt: date,
    updatedAt: date,
    editRevision: 0,
    storageRevision: 0,
    history: { past: [], future: [] },
    viewport: { zoom: 1, pan: { x: 0, y: 0 } },
  } satisfies LegacyProjectDocument);
}

describe('observation-grounded estimated glass parent support', () => {
  it('requires evidence and retains inferred provenance for bath rim and partition links', () => {
    const { parent, child } = plans();
    const partitionLink = link('partition');
    expect(candidatePartitionTopErrors({ ...partitionLink, evidence: [] })).not.toEqual([]);
    const result = resolveCandidatePartitionTop(DEFAULT_ROOM, partitionLink, parent, child);
    expect(result.status).toBe('attached');
    if (result.status !== 'attached') return;
    expect(result.placement.support?.provenance).toEqual({ kind: 'inferred', height: 'parent' });
    expect(result.placement.support?.evidence).toEqual(evidence);
    expect(result.placement.baseHeightMm).toBe(800);
    const bathLink = {
      parentCandidateId: 'bath',
      side: 'front' as const,
      offsetMm: 0,
      provenance: { parent: 'inferred' as const, side: 'inferred' as const, offset: 'inferred' as const },
      evidence,
    };
    const bath = {
      ...parent,
      ...reconstructionDefaults('bath'),
      kind: 'bath' as const,
      face: 'floor' as const,
    };
    const bathResult = resolveCandidateBathRim(DEFAULT_ROOM, bathLink, bath, child);
    expect(bathResult.status).toBe('attached');
    if (bathResult.status === 'attached')
      expect(bathResult.placement.support?.provenance.kind).toBe('inferred');
    expect(bathRimFixtureSupport(bathLink, crypto.randomUUID(), 500).evidence).toEqual(evidence);
  });

  it('schema preserves source/evidence but rejects forged user confirmation or orphan height', () => {
    const { child } = sceneData(),
      meta = child.reconstruction!;
    expect(fixtureReconstructionSchema.parse(meta)).toEqual(meta);
    for (const support of [
      { ...meta.support!, evidence: undefined },
      { ...meta.support!, evidence: [] },
      { ...meta.support!, partitionTop: undefined },
      { ...meta.support!, provenance: { kind: 'user', height: 'parent' } },
      { ...meta.support!, kind: 'bath-rim' },
      { ...meta.support!, heightMm: 700 },
    ])
      expect(fixtureReconstructionSchema.safeParse({ ...meta, support }).success).toBe(false);
    const input = {
      version: 2,
      analysis: 'partial',
      warnings: [],
      candidates: [],
      planes: [],
      analysisSummary: {
        profile: 'local-quality-v1',
        revision: 'test',
        estimated: true,
        placementPolicy: 'visible-relation-estimate',
        layoutRevision: 'test-relation-v1',
      },
    };
    expect(reconstructionReviewSchema.parse(input).analysisSummary).toEqual(input.analysisSummary);
  });

  it('resolves partition translation/rotation/scale from parent while keeping glass size and source', () => {
    const { scene, parent, child } = sceneData();
    syncBathRimAttachments(scene);
    const original = structuredClone(scene);
    parent.roomPlacement!.u = 0.6;
    parent.roomPlacement!.v = 0.55;
    parent.roomPlacement!.scale = 0.8;
    parent.reconstruction!.yawDegrees = 90;
    parent.reconstruction!.heightMm = 900;
    normalizeRoomScene(original, scene);
    expect(child.reconstruction!.baseHeightMm).toBeCloseTo(720, 5);
    expect(child.reconstruction!.yawDegrees).toBe(90);
    expect(child.roomPlacement!.u).toBeCloseTo(0.6, 6);
    expect(child.roomPlacement!.v).toBeCloseTo(0.55 - 50 / DEFAULT_ROOM.depthMm, 6);
    expect(child.reconstruction!.widthMm).toBe(600);
    expect(child.reconstruction!.support?.provenance.kind).toBe('inferred');
  });

  it('holds unsafe geometry, invalid parents, mixed supports and child scale without moving/shrinking', () => {
    const mutations: ((scene: Scene) => void)[] = [
      (s) => {
        s.fixtures[1].reconstruction!.widthMm = 1500;
      },
      (s) => {
        s.fixtures[1].reconstruction!.depthMm = 200;
      },
      (s) => {
        s.fixtures[1].reconstruction!.heightMm = 2000;
      },
      (s) => {
        s.fixtures[1].roomPlacement!.scale = 0.5;
      },
      (s) => {
        s.fixtures[0].reconstruction!.kind = 'bath';
      },
      (s) => {
        s.fixtures[0].reconstruction!.baseHeightMm = 50;
      },
      (s) => {
        s.fixtures[1].reconstruction!.support!.partitionTop!.offsetMm = 700;
      },
      (s) => {
        s.fixtures[1].reconstruction!.support!.bathRim = {
          parentFixtureId: s.fixtures[0].id,
          side: 'front',
          offsetMm: 0,
          provenance: { parent: 'user', side: 'user', offset: 'user' },
        };
      },
    ];
    for (const mutate of mutations) {
      const { scene, child } = sceneData();
      mutate(scene);
      const original = structuredClone(child);
      expect(resolveBathRimFixture(scene, child).status).toBe('held');
      syncBathRimAttachments(scene);
      expect(child).toEqual(original);
    }
  });

  it('keeps missing-parent data and restores it with Before undo/redo', () => {
    const { scene } = sceneData();
    syncBathRimAttachments(scene);
    useEditor.getState().load(project(scene));
    useEditor.getState().setEditing('before');
    const current = () => useEditor.getState().project!.shared.comparison!.before;
    const child = structuredClone(current().fixtures[1]);
    useEditor.getState().change((s) => {
      s.fixtures.splice(0, 1);
    });
    expect(resolveBathRimFixture(current(), current().fixtures[0]).status).toBe('held');
    expect(current().fixtures[0].reconstruction?.support).toEqual(child.reconstruction!.support);
    useEditor.getState().undo();
    expect(resolveBathRimFixture(current(), current().fixtures[1]).status).toBe('attached');
    useEditor.getState().redo();
    expect(resolveBathRimFixture(current(), current().fixtures[0]).status).toBe('held');
    expect(projectSchema.safeParse(useEditor.getState().project).success).toBe(true);
  });

  it('remaps fixture IDs through project/design/history copies and shares immutable material versions', () => {
    const { scene } = sceneData();
    syncBathRimAttachments(scene);
    const original = project(scene);
    original.designs[0].history.past.push({ scene: structuredClone(scene) });
    original.shared.beforeHistory.past.push({
      baseline: structuredClone(scene),
      comparison: structuredClone(original.shared.comparison),
    });
    const copy = duplicateProjectDocument(original);
    for (const copiedScene of projectScenes(copy)) {
      const child = copiedScene.fixtures.find((f) => f.reconstruction?.support?.partitionTop);
      if (!child) continue;
      const parentId = child.reconstruction!.support!.partitionTop!.parentFixtureId;
      expect(copiedScene.fixtures.some((f) => f.id === parentId)).toBe(true);
      expect(parentId).not.toBe(scene.fixtures[0].id);
      expect(child.reconstruction!.support!.provenance.kind).toBe('inferred');
    }
    const design = copyDesignDocument(original.designs[0]);
    expect(design.scene.fixtures[1].reconstruction!.support!.partitionTop!.parentFixtureId).toBe(
      design.scene.fixtures[0].id,
    );
    expect(design.scene.fixtures[0].materialVersionId).toBe(scene.fixtures[0].materialVersionId);
    expect(original.designs[0].scene.fixtures[0].id).toBe(scene.fixtures[0].id);
  });

  it('read/export resolves a copy, and smaller room holds the child instead of flattening support', () => {
    const { scene, child } = sceneData(),
      original = structuredClone(scene);
    const display = resolvedBathRimScene(scene);
    expect(display).not.toBe(scene);
    expect(scene).toEqual(original);
    const resized = resizedRoomScene(
      scene,
      { ...DEFAULT_ROOM, heightMm: 1500 },
      {
        originalAssetId: scene.originalAssetId,
        previewAssetId: scene.previewAssetId,
        imageWidth: 1200,
        imageHeight: 800,
      },
    );
    expect(resolveBathRimFixture(resized, resized.fixtures[1]).status).toBe('held');
    expect(resized.fixtures[1].reconstruction!.heightMm).toBe(child.reconstruction!.heightMm);
    expect(resized.fixtures[1].reconstruction!.support!.partitionTop).toEqual(
      child.reconstruction!.support!.partitionTop,
    );
  });

  it('Lab draft replay preserves inferred link fields and uses parent order even when glass is first', () => {
    const draft = {
      enabled: true,
      face: 'floor' as const,
      u: '',
      v: '',
      baseHeightMm: '',
      yawDegrees: '',
      widthMm: '600',
      heightMm: '900',
      depthMm: '8',
      support: {
        kind: 'partition-top' as const,
        heightMm: '800',
        evidence,
        partitionTop: { ...link('parent'), offsetMm: '50' },
      },
    };
    const manual = resolveManualDraft(draft, DEFAULT_ROOM, 8);
    expect(manual.partitionTop?.provenance).toEqual(link('parent').provenance);
    expect(manual.partitionTop?.evidence).toEqual(evidence);
    const observation: SceneUnderstanding = {
      schemaVersion: 1,
      roomLayout: { orthogonal: 'unknown', evidence: [], uncertainty: [] },
      relations: [],
      candidates: [
        {
          id: 'glass',
          kind: 'glassPartition',
          bounds: { left: 0.4, top: 0.2, right: 0.55, bottom: 0.7 },
          mounting: 'floor',
          wall: 'unknown',
          basinStyle: 'unknown',
          shape: 'unknown',
          reflection: 'physical',
          evidence,
          uncertainty: [],
          provenance: { kind: 'user' },
        },
        {
          id: 'parent',
          kind: 'lowPartition',
          bounds: { left: 0.3, top: 0.6, right: 0.65, bottom: 0.9 },
          mounting: 'floor',
          wall: 'unknown',
          basinStyle: 'unknown',
          shape: 'unknown',
          reflection: 'physical',
          evidence,
          uncertainty: [],
          provenance: { kind: 'user' },
        },
      ],
    };
    const result = buildCandidatePipeline(
      observation,
      { version: 2, analysis: 'partial', warnings: [], planes: [], candidates: [] },
      DEFAULT_ROOM,
      { width: 600, height: 800 },
      {
        glass: manual,
        parent: {
          face: 'floor',
          u: 0.5,
          v: 0.5,
          baseHeightMm: 0,
          widthMm: 1200,
          heightMm: 800,
          depthMm: 150,
        },
      },
      observation,
    );
    expect(result.plans.glass?.partitionTopCandidate?.parentCandidateId).toBe('parent');
    expect(result.plans.glass?.baseHeightMm).toBe(800);
    expect(result.plans.glass?.partitionTopCandidate?.provenance.parent).toBe('inferred');
    expect(result.plans.glass?.support?.partitionTop).toBeUndefined();
  });
});
