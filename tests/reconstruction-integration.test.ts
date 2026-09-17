import { describe, it, expect } from 'vitest';
import { DEFAULT_ROOM, createRoomSurfaces } from '../src/lib/room-geometry';
import {
  DEFAULT_COLOR,
  EMPTY_MASK,
  type Scene,
  type FixtureInstance,
  type LegacyProjectDocument,
} from '../src/lib/types';
import { normalizeRoomScene, resizedRoomScene } from '../src/lib/room-editing';
import { projectReconstructionFixture } from '../src/lib/reconstruction/projection';
import { reconstructionPositionFromPhoto } from '../src/lib/reconstruction/position';
import {
  fixtureReconstructionSchema,
  reconstructionReviewSchema,
  projectV3Schema,
} from '../src/lib/storage/validation';
import { sceneReferences } from '../src/lib/repositories/references';
import { useEditor } from '../src/lib/editor-store';
import { normalizeProjectDocument, getActiveDesign } from '../src/lib/comparison';
import type { RoomFace } from '../src/lib/room-types';

function model(face: RoomFace = 'back'): FixtureInstance {
  const f: FixtureInstance = {
    id: crypto.randomUUID(),
    name: '표준 설비',
    materialVersionId: crypto.randomUUID(),
    viewIndex: 0,
    position: { x: 0.5, y: 0.5 },
    width: 0.1,
    height: 0.1,
    rotation: 0,
    anchor: { x: 0.5, y: 1 },
    locked: false,
    shadow: { x: 0, y: 0, opacity: 0.1, blur: 0.008, scale: 1 },
    occlusion: EMPTY_MASK(),
    color: { ...DEFAULT_COLOR },
    reconstruction: {
      version: 2,
      kind: face === 'floor' ? 'glassPartition' : 'basin',
      basinVariant: 'wall',
      basinShape: 'rectangular',
      color: '#eeeeee',
      widthMm: 600,
      heightMm: 180,
      depthMm: 450,
      baseHeightMm: 650,
      yawDegrees: 90,
      opacity: 0.18,
      sourceMaterialVersionId: crypto.randomUUID(),
      provenance: { dimensions: 'default', mounting: 'inferred' },
    },
    roomPlacement: {
      face,
      u: 0.4,
      v: face === 'floor' ? 0.5 : 1 - 650 / DEFAULT_ROOM.heightMm,
      scale: 1,
      widthMm: 600,
      heightMm: 180,
      imageAspect: 1,
      contentBounds: { left: 0, top: 0, right: 1, bottom: 1 },
    },
  };
  projectReconstructionFixture(DEFAULT_ROOM, f, 1.5);
  return f;
}
function scene(f = model()): Scene {
  return {
    room: { ...DEFAULT_ROOM },
    originalAssetId: crypto.randomUUID(),
    previewAssetId: crypto.randomUUID(),
    imageWidth: 1200,
    imageHeight: 800,
    surfaces: createRoomSurfaces(DEFAULT_ROOM, 1.5),
    fixtures: [f],
    protection: EMPTY_MASK(),
    color: { ...DEFAULT_COLOR },
  };
}
function document(s = scene()) {
  const after = structuredClone(s);
  after.fixtures = [];
  const p: LegacyProjectDocument = {
    id: crypto.randomUUID(),
    ownerId: 'local',
    name: '재구성',
    schemaVersion: 2,
    editRevision: 0,
    storageRevision: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    scene: after,
    comparison: {
      before: s,
      room: { ...DEFAULT_ROOM },
      cameraVersion: 1,
      aspect: 1.5,
      referenceOriginalAssetId: crypto.randomUUID(),
      referencePreviewAssetId: crypto.randomUUID(),
      status: 'draft',
    },
    history: { past: [], future: [] },
    viewport: { zoom: 1, pan: { x: 0, y: 0 } },
  };
  return normalizeProjectDocument(p);
}
describe('standard reconstruction integration', () => {
  it.each(['back', 'left', 'right', 'floor'] as RoomFace[])(
    'inverts the actual %s anchor plane without offset drift',
    (face) => {
      const f = model(face),
        p = reconstructionPositionFromPhoto(DEFAULT_ROOM, f, f.position, 1.5);
      expect(p.u).toBeCloseTo(f.roomPlacement!.u, 7);
      expect(p.v).toBeCloseTo(f.roomPlacement!.v, 7);
    },
  );
  it('synchronizes wall dragging and one undo without affecting empty After', () => {
    const p = document();
    useEditor.getState().load(p);
    useEditor.getState().setEditing('before');
    const old = structuredClone(useEditor.getState().project!.shared.comparison!.before);
    useEditor.getState().preview((s) => {
      s.fixtures[0].position.y -= 0.035;
    });
    useEditor.getState().commit();
    const changed = useEditor.getState().project!;
    expect(changed.shared.comparison!.before.fixtures[0].reconstruction!.baseHeightMm).toBeGreaterThan(650);
    expect(changed.shared.beforeHistory.past).toHaveLength(1);
    expect(getActiveDesign(changed)!.scene.fixtures).toEqual([]);
    useEditor.getState().undo();
    expect(useEditor.getState().project!.shared.comparison!.before).toEqual(old);
    useEditor.getState().redo();
    expect(useEditor.getState().project!.shared.comparison!.before).toEqual(
      changed.shared.comparison!.before,
    );
  });
  it('keeps physical elevation on room resize and clamps only against the new ceiling', () => {
    const s = scene();
    const assets = {
      originalAssetId: s.originalAssetId,
      previewAssetId: s.previewAssetId,
      imageWidth: 1200,
      imageHeight: 800,
    };
    const next = resizedRoomScene(s, { ...DEFAULT_ROOM, heightMm: 2800 }, assets);
    expect(next.fixtures[0].reconstruction!.baseHeightMm).toBe(650);
    expect(next.fixtures[0].roomPlacement!.v).toBeCloseTo(1 - 650 / 2800);
    expect(s.fixtures[0].roomPlacement!.v).toBeCloseTo(1 - 650 / DEFAULT_ROOM.heightMm);
  });
  it('keeps explicit height edits and normalizes the associated wall coordinate', () => {
    const old = scene(),
      next = structuredClone(old);
    next.fixtures[0].reconstruction!.baseHeightMm = 800;
    normalizeRoomScene(old, next);
    expect(next.fixtures[0].roomPlacement!.v).toBeCloseTo(1 - 800 / DEFAULT_ROOM.heightMm);
  });
  it('roundtrips new metadata and retains the converted source version reference', () => {
    const s = scene();
    expect(fixtureReconstructionSchema.parse(s.fixtures[0].reconstruction)).toEqual(
      s.fixtures[0].reconstruction,
    );
    expect(sceneReferences(s).versions).toContain(s.fixtures[0].reconstruction!.sourceMaterialVersionId);
    const p = document(s);
    expect(projectV3Schema.parse(p).shared.comparison!.before.fixtures[0].reconstruction).toEqual(
      s.fixtures[0].reconstruction,
    );
  });
  it('validates uncertain candidates without discarding installation trace', () => {
    const review = {
      version: 2,
      warnings: [],
      analysis: 'partial',
      planes: [],
      candidates: [
        {
          id: 'cabinet-1',
          kind: 'vanity',
          detectedLabel: 'cabinet',
          source: 'deeplab',
          requiresReview: true,
          status: 'unplaced',
          bounds: { left: 0.1, top: 0.1, right: 0.4, bottom: 0.4 },
          foot: { x: 0.25, y: 0.4 },
          color: '#cccccc',
          pixels: 100,
          evidence: { semanticPixels: 100, meanMargin: 2, mirrorCompetition: 0.4 },
          installation: { mode: 'unknown', source: 'inferred', reason: '종류 확인' },
          trace: [{ stage: 'installation', outcome: 'held', reason: '설치 확인' }],
        },
      ],
    };
    expect(reconstructionReviewSchema.parse(review)).toEqual(review);
    expect(
      reconstructionReviewSchema.safeParse({
        ...review,
        candidates: [
          { ...review.candidates[0], evidence: { ...review.candidates[0].evidence, mirrorCompetition: 2 } },
        ],
      }).success,
    ).toBe(false);
  });
  it('rejects invalid standard dimensions, transparency and door count', () => {
    const m = model().reconstruction!;
    for (const patch of [
      { baseHeightMm: -1 },
      { opacity: 1.1 },
      { doorCount: 2.5 },
      { widthMm: NaN },
      { yawDegrees: Infinity },
    ])
      expect(fixtureReconstructionSchema.safeParse({ ...m, ...patch }).success).toBe(false);
  });
});
