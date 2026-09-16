import { describe, it, expect } from 'vitest';
import { Box3, Vector3 } from 'three';
import { DEFAULT_ROOM } from '../src/lib/room-geometry';
import {
  EMPTY_MASK,
  DEFAULT_COLOR,
  type Scene,
  type FixtureInstance,
  type LegacyProjectDocument,
} from '../src/lib/types';
import { createTemplateModel, disposeTemplateModel } from '../src/lib/reconstruction/templates';
import { standardBathRimGeometry } from '../src/lib/reconstruction/bath-rim-geometry';
import {
  resolveBathRimFixture,
  resolvedBathRimScene,
  syncBathRimAttachments,
} from '../src/lib/reconstruction/bath-rim';
import { normalizeRoomScene, resizedRoomScene } from '../src/lib/room-editing';
import { fixtureReconstructionSchema, projectSchema } from '../src/lib/supabase/validation';
import { normalizeProjectDocument, projectScenes } from '../src/lib/comparison';
import { duplicateProjectDocument, copyDesignDocument } from '../src/lib/designs';
import { useEditor } from '../src/lib/editor-store';

function data() {
  const id = crypto.randomUUID(),
    glassId = crypto.randomUUID();
  const bath: FixtureInstance = {
    id,
    name: '실제 배치한 표준 욕조',
    materialVersionId: crypto.randomUUID(),
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
      face: 'floor',
      u: 0.5,
      v: 0.5,
      scale: 1,
      widthMm: 1600,
      heightMm: 600,
      imageAspect: 1,
      contentBounds: { left: 0, top: 0, right: 1, bottom: 1 },
    },
    reconstruction: {
      version: 2,
      kind: 'bath',
      widthMm: 1600,
      heightMm: 600,
      depthMm: 800,
      baseHeightMm: 0,
      yawDegrees: 0,
      color: '#eeeeee',
    },
  };
  const glass: FixtureInstance = {
    ...structuredClone(bath),
    id: glassId,
    name: '연결 유리',
    materialVersionId: crypto.randomUUID(),
    roomPlacement: { ...bath.roomPlacement!, widthMm: 600, heightMm: 1500 },
    reconstruction: {
      version: 2,
      kind: 'glassPartition',
      widthMm: 600,
      heightMm: 1500,
      depthMm: 8,
      baseHeightMm: 600,
      yawDegrees: 0,
      color: '#ccddee',
      support: {
        kind: 'bath-rim',
        heightMm: 600,
        provenance: { kind: 'user', height: 'parent' },
        bathRim: {
          parentFixtureId: id,
          side: 'front',
          offsetMm: 0,
          provenance: { parent: 'user', side: 'user', offset: 'user' },
        },
      },
    },
  };
  const scene: Scene = {
    room: { ...DEFAULT_ROOM },
    originalAssetId: crypto.randomUUID(),
    previewAssetId: crypto.randomUUID(),
    imageWidth: 1200,
    imageHeight: 800,
    surfaces: [],
    fixtures: [bath, glass],
    protection: EMPTY_MASK(),
    color: { ...DEFAULT_COLOR },
  };
  return { scene, bath, glass };
}
function project(scene: Scene) {
  const date = new Date().toISOString();
  return normalizeProjectDocument({
    id: crypto.randomUUID(),
    ownerId: 'local',
    name: '욕조 연결',
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
describe('explicit standard-bath rim attachment', () => {
  it.each([
    [1600, 600, 800],
    [700, 650, 1700],
    [100, 1900, 100],
  ])('matches the real normalized rim meshes (%i/%i/%i)', (w, h, d) => {
    const model = createTemplateModel({
        version: 2,
        kind: 'bath',
        widthMm: w,
        heightMm: h,
        depthMm: d,
        color: '#eeeeee',
      }),
      geometry = standardBathRimGeometry(w, h, d);
    try {
      for (const side of ['left', 'right', 'front', 'back'] as const) {
        const b = new Box3().setFromObject(model.getObjectByName('bath-rim-' + side)!);
        const c = b.getCenter(new Vector3());
        expect(b.max.y).toBeCloseTo(geometry.heightMm, 2);
        expect(c.x).toBeCloseTo(geometry[side].x, 2);
        expect(c.z).toBeCloseTo(geometry[side].z, 2);
        expect(geometry[side].lengthMm).toBeGreaterThan(0);
      }
    } finally {
      disposeTemplateModel(model);
    }
  });
  it('uses the actual rim height below the faucet, retains immutable assets and keeps glass touching the rim', () => {
    const { scene, bath, glass } = data(),
      original = structuredClone(scene);
    const result = resolveBathRimFixture(scene, glass);
    expect(result.status).toBe('attached');
    syncBathRimAttachments(scene);
    expect(glass.reconstruction!.baseHeightMm).toBeCloseTo(
      standardBathRimGeometry(1600, 600, 800).heightMm,
      4,
    );
    expect(glass.reconstruction!.baseHeightMm).toBeLessThan(600);
    expect(glass.reconstruction!.support!.provenance.height).toBe('parent');
    expect(bath).toEqual(original.fixtures[0]);
    expect(glass.materialVersionId).toBe(original.fixtures[1].materialVersionId);
    expect(fixtureReconstructionSchema.parse(glass.reconstruction)).toEqual(glass.reconstruction);
  });
  it.each(['left', 'right', 'front', 'back'] as const)(
    'follows translated, rotated, scaled and resized parent on %s',
    (side) => {
      const { scene, bath, glass } = data();
      glass.reconstruction!.support!.bathRim!.side = side;
      glass.reconstruction!.widthMm = 300;
      glass.reconstruction!.support!.bathRim!.offsetMm = 40;
      syncBathRimAttachments(scene);
      const old = structuredClone(scene);
      bath.roomPlacement!.u = 0.6;
      bath.roomPlacement!.v = 0.6;
      bath.reconstruction!.yawDegrees = 90;
      bath.reconstruction!.heightMm = 700;
      bath.reconstruction!.widthMm = 1400;
      bath.roomPlacement!.scale = 0.9;
      normalizeRoomScene(old, scene);
      const result = resolveBathRimFixture(scene, glass);
      expect(result.status).toBe('attached');
      if (result.status !== 'attached') return;
      expect(glass.roomPlacement!.u).toBeCloseTo(result.placement.u, 8);
      expect(glass.roomPlacement!.v).toBeCloseTo(result.placement.v, 8);
      expect(glass.reconstruction!.baseHeightMm).toBeCloseTo(
        standardBathRimGeometry(1400, 700, 800).heightMm * 0.9,
        4,
      );
      expect(glass.reconstruction!.widthMm).toBe(300);
    },
  );
  it('holds missing/deleted/replaced parents without deleting the reference, and restores on undo/redo', () => {
    const { scene, glass } = data();
    syncBathRimAttachments(scene);
    useEditor.getState().load(project(scene));
    useEditor.getState().setEditing('before');
    const current = () => useEditor.getState().project!.shared.comparison!.before;
    const saved = structuredClone(current().fixtures[1]);
    useEditor.getState().change((s) => {
      s.fixtures.splice(0, 1);
    });
    expect(resolveBathRimFixture(current(), current().fixtures[0]).status).toBe('held');
    expect(current().fixtures[0]).toEqual(saved);
    useEditor.getState().undo();
    expect(resolveBathRimFixture(current(), current().fixtures[1]).status).toBe('attached');
    useEditor.getState().redo();
    expect(resolveBathRimFixture(current(), current().fixtures[0]).status).toBe('held');
    expect(projectSchema.safeParse(useEditor.getState().project).success).toBe(true);
    expect(current().fixtures[0].reconstruction!.support!.bathRim!.parentFixtureId).toBe(
      glass.reconstruction!.support!.bathRim!.parentFixtureId,
    );
  });
  it('remaps parent IDs across complete project copies, history and design copies', () => {
    const { scene } = data();
    syncBathRimAttachments(scene);
    const p = project(scene);
    p.designs[0].history.past.push({ scene: structuredClone(scene) });
    p.shared.beforeHistory.past.push({
      baseline: structuredClone(scene),
      comparison: structuredClone(p.shared.comparison),
    });
    const copy = duplicateProjectDocument(p);
    for (const s of projectScenes(copy)) {
      const child = s.fixtures.find((f) => f.reconstruction?.support?.bathRim);
      if (child) {
        expect(s.fixtures.some((f) => f.id === child.reconstruction!.support!.bathRim!.parentFixtureId)).toBe(
          true,
        );
        expect(child.reconstruction!.support!.bathRim!.parentFixtureId).not.toBe(scene.fixtures[0].id);
      }
    }
    const dc = copyDesignDocument(p.designs[0]);
    expect(dc.scene.fixtures[1].reconstruction!.support!.bathRim!.parentFixtureId).toBe(
      dc.scene.fixtures[0].id,
    );
    expect(dc.scene.fixtures[0].materialVersionId).toBe(scene.fixtures[0].materialVersionId);
  });
  it('does not infer a parent or change the appearance of historical height-only supports', () => {
    const { scene, glass } = data();
    delete glass.reconstruction!.support!.bathRim;
    glass.reconstruction!.support!.provenance.height = 'default';
    const original = structuredClone(scene);
    expect(resolvedBathRimScene(scene)).toBe(scene);
    normalizeRoomScene(original, scene);
    expect(glass.reconstruction).toEqual(original.fixtures[1].reconstruction);
    expect(resolveBathRimFixture(scene, glass).status).toBe('independent');
  });
  it('holds oversize, unsupported thickness, out-of-room height, wrong parent kind and scale without clamping', () => {
    for (const mutation of [
      (s: Scene) => {
        s.fixtures[1].reconstruction!.widthMm = 1900;
      },
      (s: Scene) => {
        s.fixtures[1].reconstruction!.depthMm = 80;
      },
      (s: Scene) => {
        s.fixtures[1].reconstruction!.support!.bathRim!.offsetMm = 900;
      },
      (s: Scene) => {
        s.fixtures[1].reconstruction!.heightMm = 2400;
      },
      (s: Scene) => {
        s.fixtures[0].reconstruction!.kind = 'vanity';
      },
      (s: Scene) => {
        s.fixtures[1].roomPlacement!.scale = 2;
      },
    ]) {
      const { scene, glass } = data();
      mutation(scene);
      const original = structuredClone(glass);
      expect(resolveBathRimFixture(scene, glass).status).toBe('held');
      syncBathRimAttachments(scene);
      expect(glass).toEqual(original);
    }
  });
  it('resolves read-only stale placement and room resize without changing input or crossing history', () => {
    const { scene, glass } = data();
    const original = structuredClone(scene);
    const read = resolvedBathRimScene(scene);
    expect(scene).toEqual(original);
    expect(read).not.toBe(scene);
    expect(read.fixtures[1].reconstruction!.baseHeightMm).not.toBe(glass.reconstruction!.baseHeightMm);
    const small = resizedRoomScene(
      scene,
      { ...DEFAULT_ROOM, heightMm: 1800 },
      {
        originalAssetId: scene.originalAssetId,
        previewAssetId: scene.previewAssetId,
        imageWidth: 1200,
        imageHeight: 800,
      },
    );
    expect(resolveBathRimFixture(small, small.fixtures[1]).status).toBe('held');
    expect(small.fixtures[1].reconstruction!.heightMm).toBe(1500);
  });
  it('rejects fabricated parent provenance and invalid relation shapes in persisted data', () => {
    const { glass } = data();
    const meta = glass.reconstruction!;
    expect(fixtureReconstructionSchema.safeParse(meta).success).toBe(true);
    for (const value of [
      { ...meta, support: { ...meta.support, kind: 'shower-curb' } },
      { ...meta, support: { ...meta.support, bathRim: undefined } },
      { ...meta, support: { ...meta.support, bathRim: { ...meta.support!.bathRim, offsetMm: Infinity } } },
    ])
      expect(fixtureReconstructionSchema.safeParse(value).success).toBe(false);
  });
});
