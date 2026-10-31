import { describe, expect, it } from 'vitest';
import { getActiveDesign, normalizeProjectDocument } from '../src/lib/comparison';
import { useEditor } from '../src/lib/editor-store';
import { DEFAULT_ROOM, createRoomSurfaces } from '../src/lib/room-geometry';
import { snapRegion } from '../src/lib/room-surface-regions';
import {
  featureFields,
  featureFromClick,
  featureFromDrag,
  featureIssue,
  featureUv,
  isWallFace,
  movedFeature,
  putWallFeature,
  removeWallFeature,
  WALL_FACE_NOTE,
  WALL_FEATURE_EDGE_MM,
  WALL_FEATURE_SIZE_NOTE,
  wallFeatureDrawIssue,
  wallFeatureTitle,
  wallFeatureToolIssue,
  withFields,
  type WallFeatureDraw,
} from '../src/lib/wall-feature-editing';
import { validateWallFeatures, type WallFeatureV1 } from '../src/lib/wall-features';
import { DEFAULT_COLOR, EMPTY_MASK, type MaterialVersion, type Scene } from '../src/lib/types';

const tile = (id: string, size: number): MaterialVersion => ({
  id,
  materialId: id,
  version: 1,
  name: id,
  brand: '',
  code: '',
  category: 'tile',
  scope: 'personal',
  description: '',
  color: '#ffffff',
  finish: '',
  widthMm: size,
  heightMm: size,
  depthMm: 8,
  usage: 'both',
  installation: 'wall',
  textureAssetIds: ['t'],
  views: [],
  defaultGroutWidth: 2,
  defaultGroutColor: '#ffffff',
  defaultPattern: 'grid',
  createdAt: '2026-10-29',
});
const materials = { base: tile('base', 300) };
/** 2400 mm cube; every face tiled with 300 mm tiles and 2 mm grout (joints at k·302). */
function scene(tiled = true): Scene {
  return {
    room: { ...DEFAULT_ROOM },
    originalAssetId: 'o',
    previewAssetId: 'p',
    imageWidth: 1200,
    imageHeight: 800,
    surfaces: createRoomSurfaces(DEFAULT_ROOM, 1.5).map((s) => ({
      ...s,
      ...(tiled ? { materialVersionId: 'base' } : {}),
      tile: { ...s.tile, groutWidth: 2 },
    })),
    fixtures: [],
    protection: EMPTY_MASK(),
    color: { ...DEFAULT_COLOR },
  };
}
const niche = (snap = false): WallFeatureDraw => ({ depthMm: 200, snap, materials });
const drawn = (made: ReturnType<typeof featureFromDrag>) => {
  if (!made.feature) throw new Error(made.issue);
  return made.feature;
};
const box = (feature: WallFeatureV1) => ({
  left: feature.leftMm,
  top: feature.topMm,
  width: feature.widthMm,
  height: feature.kind === 'closed-niche' ? feature.heightMm : undefined,
});

describe('wall-feature tool', () => {
  it('is offered on a writable room shown as itself and pauses during another edit; 24 only stops drawing', () => {
    const value = scene();
    const ok = { scene: value, writable: true, mode: 'after' as const, drafting: false };
    expect(wallFeatureToolIssue(ok)).toBeNull();
    expect(wallFeatureToolIssue({ ...ok, scene: { ...value, room: undefined } })).toBe(
      '벽 구조는 방 치수가 있는 공간에서만 만들 수 있어요.',
    );
    expect(wallFeatureToolIssue({ ...ok, writable: false })).toBe('읽기 전용이라 벽 구조를 만들 수 없어요.');
    expect(wallFeatureToolIssue({ ...ok, mode: 'split' })).toBe('비교 보기에서는 벽 구조를 그릴 수 없어요.');
    expect(wallFeatureToolIssue({ ...ok, drafting: true })).toBe('진행 중인 편집을 마친 뒤 써 주세요.');
    const full = Array.from({ length: 24 }, () =>
      featureFromClick(DEFAULT_ROOM, 'back', { u: 0.5, v: 0.5 }, niche()),
    );
    // With no other way to delete one, the tool stays on at 24 for picking, moving and deleting.
    expect(wallFeatureToolIssue({ ...ok, scene: { ...value, wallFeatures: full } })).toBeNull();
    expect(wallFeatureDrawIssue({ wallFeatures: full })).toBe(
      '벽 구조는 장면당 24개까지 만들 수 있어요. 놓인 구조를 눌러 고치거나 지워 주세요.',
    );
    expect(wallFeatureDrawIssue({ wallFeatures: full.slice(1) })).toBeNull();
    expect(isWallFace('floor')).toBe(false);
    expect(['left', 'back', 'right'].every((face) => isWallFace(face as 'left'))).toBe(true);
    expect(WALL_FACE_NOTE).toBe('왼쪽·정면·오른쪽 벽을 끌어 주세요.');
    expect(wallFeatureTitle({ face: 'back' })).toBe('정면 벽 · 벽 홈');
  });

  it('turns a drag into a niche in wall millimetres, cut 10 mm inside the wall and the ceiling', () => {
    const value = scene();
    const plain = drawn(featureFromDrag(value, 'back', { u: 0.3, v: 0.5 }, { u: 0.1, v: 0.2 }, niche()));
    expect(plain).toMatchObject({
      version: 1,
      source: 'user',
      face: 'back',
      kind: 'closed-niche',
      depthMm: 200,
    });
    expect(box(plain)).toEqual({ left: 240, top: 480, width: 480, height: 720 });
    // Past the corners and the ceiling: cut to the margin, never 0 or the wall's end.
    const outside = drawn(featureFromDrag(value, 'left', { u: -0.2, v: -0.1 }, { u: 1.3, v: 0.9 }, niche()));
    expect(box(outside)).toEqual({ left: 10, top: 10, width: 2380, height: 2150 });
    expect(validateWallFeatures(DEFAULT_ROOM, [outside])).toEqual([]);
    expect(featureFromDrag(value, 'back', { u: 0.1, v: 0.1 }, { u: 0.115, v: 0.4 }, niche())).toEqual({
      issue: WALL_FEATURE_SIZE_NOTE,
    });
    expect(WALL_FEATURE_SIZE_NOTE).toBe('가로·세로 50mm보다 크게 끌어 주세요.');
  });

  it('reaches the floor when the drag gets within 10 mm of it or past it, and not otherwise', () => {
    const value = scene();
    expect(
      drawn(featureFromDrag(value, 'right', { u: 0.1, v: 0.5 }, { u: 0.3, v: 0.99 }, niche())).kind,
    ).toBe('closed-niche');
    for (const to of [
      { u: 0.3, v: 0.997 },
      { u: 0.3, v: 1.4 },
    ]) {
      const made = drawn(featureFromDrag(value, 'right', { u: 0.1, v: 0.5 }, to, niche()));
      expect(made).toMatchObject({
        kind: 'floor-alcove',
        face: 'right',
        leftMm: 240,
        topMm: 1200,
        widthMm: 480,
      });
      expect(made).not.toHaveProperty('heightMm');
      expect(featureUv(made, DEFAULT_ROOM).bottom).toBe(1);
      expect(validateWallFeatures(DEFAULT_ROOM, [made])).toEqual([]);
    }
  });

  it('snaps to the base grout lines but never to the wall ends, and to 10 mm without a tile', () => {
    const tiled = drawn(
      featureFromDrag(scene(), 'back', { u: 0.1, v: 0.2 }, { u: 0.3, v: 0.5 }, niche(true)),
    );
    // Starts at a joint's end (k·302), ends at a joint's start (k·302 − 2).
    expect(box(tiled)).toEqual({ left: 302, top: 604, width: 300, height: 602 });
    const corner = drawn(featureFromDrag(scene(), 'back', { u: 0, v: 0 }, { u: 0.1, v: 0.1 }, niche(true)));
    expect(corner.leftMm).toBe(WALL_FEATURE_EDGE_MM);
    expect(corner.topMm).toBe(WALL_FEATURE_EDGE_MM);
    expect(validateWallFeatures(DEFAULT_ROOM, [corner])).toEqual([]);
    // The partial tile keeps its face-edge candidates.
    const base = { tile: scene().surfaces[0].tile, tileMm: { width: 300, height: 300 } };
    expect(
      snapRegion({ leftMm: 10, topMm: 10, widthMm: 230, heightMm: 230 }, { width: 2400, height: 2400 }, base),
    ).toMatchObject({
      leftMm: 0,
      topMm: 0,
    });
    const bare = drawn(
      featureFromDrag(scene(false), 'back', { u: 0.1013, v: 0.2021 }, { u: 0.3022, v: 0.5011 }, niche(true)),
    );
    expect(box(bare)).toEqual({ left: 240, top: 490, width: 490, height: 710 });
    const snappedAlcove = drawn(
      featureFromDrag(scene(), 'back', { u: 0.1, v: 0.2 }, { u: 0.3, v: 1.1 }, niche(true)),
    );
    expect(snappedAlcove).toMatchObject({ leftMm: 302, topMm: 604, widthMm: 300 });
    expect(featureUv(snappedAlcove, DEFAULT_ROOM).bottom).toBe(1);
  });

  it('places the default size centred on a click, pushed inside the wall', () => {
    expect(box(featureFromClick(DEFAULT_ROOM, 'back', { u: 0.5, v: 0.5 }, niche()))).toEqual({
      left: 900,
      top: 950,
      width: 600,
      height: 500,
    });
    expect(box(featureFromClick(DEFAULT_ROOM, 'left', { u: 0.01, v: 0.99 }, niche()))).toEqual({
      left: 10,
      top: 1890,
      width: 600,
      height: 500,
    });
    const room = { ...DEFAULT_ROOM, widthMm: 1200 };
    expect(featureFromClick(room, 'back', { u: 0.5, v: 0.5 }, niche()).widthMm).toBe(400);
    // A click is never one reaching the floor, even at the wall's foot.
    const low = featureFromClick(DEFAULT_ROOM, 'back', { u: 0.5, v: 1 }, niche());
    expect(low).toMatchObject({ kind: 'closed-niche', topMm: 1890, heightMm: 500 });
    for (const made of [low, featureFromClick(DEFAULT_ROOM, 'right', { u: 0, v: 0 }, niche())])
      expect(validateWallFeatures(DEFAULT_ROOM, [made])).toEqual([]);
  });

  it('moves inside the margins, one reaching the floor only sideways', () => {
    const feature = featureFromClick(DEFAULT_ROOM, 'back', { u: 0.5, v: 0.5 }, niche());
    expect(box(movedFeature(feature, DEFAULT_ROOM, 1, -1))).toMatchObject({ left: 1790, top: 10 });
    expect(box(movedFeature(feature, DEFAULT_ROOM, -0.1, 0.1))).toMatchObject({ left: 660, top: 1190 });
    const open = drawn(featureFromDrag(scene(), 'back', { u: 0.375, v: 0.4 }, { u: 0.625, v: 1.1 }, niche()));
    expect(movedFeature(open, DEFAULT_ROOM, 0.1, 0.3)).toMatchObject({ leftMm: 1140, topMm: open.topMm });
  });

  it('names the reason a feature cannot go in: overlapping or touching another on the wall', () => {
    const first = featureFromClick(DEFAULT_ROOM, 'back', { u: 0.5, v: 0.5 }, niche());
    const second = featureFromClick(DEFAULT_ROOM, 'back', { u: 0.55, v: 0.5 }, niche());
    expect(featureIssue(DEFAULT_ROOM, [first], second)).toContain('겹치거나 맞닿는');
    const touching = { ...second, leftMm: first.leftMm + first.widthMm };
    expect(featureIssue(DEFAULT_ROOM, [first], touching)).toContain('겹치거나 맞닿는');
    expect(featureIssue(DEFAULT_ROOM, [first], { ...touching, leftMm: touching.leftMm + 1 })).toBeNull();
    // The feature being edited is compared without its own old place.
    expect(featureIssue(DEFAULT_ROOM, [first], { ...first, leftMm: first.leftMm + 50 })).toBeNull();
    expect(featureIssue(DEFAULT_ROOM, [], { ...first, depthMm: 1001 })).toContain('1000mm');
  });

  it('shows heights from the floor and keeps the stored distance from the ceiling', () => {
    const feature = drawn(featureFromDrag(scene(), 'back', { u: 0.1, v: 0.2 }, { u: 0.3, v: 0.5 }, niche()));
    const fields = featureFields(feature, DEFAULT_ROOM);
    expect(fields).toEqual({ leftMm: 240, bottomMm: 1200, widthMm: 480, heightMm: 720, depthMm: 200 });
    expect(withFields(feature, fields, DEFAULT_ROOM)).toEqual(feature);
    expect(withFields(feature, { ...fields, bottomMm: 1000 }, DEFAULT_ROOM)).toMatchObject({
      topMm: 680,
      heightMm: 720,
    });
    expect(withFields(feature, { ...fields, heightMm: 500 }, DEFAULT_ROOM)).toMatchObject({
      topMm: 700,
      heightMm: 500,
    });
    const open = drawn(featureFromDrag(scene(), 'back', { u: 0.1, v: 0.5 }, { u: 0.3, v: 1.2 }, niche()));
    expect(featureFields(open, DEFAULT_ROOM)).toMatchObject({ bottomMm: 0, heightMm: 1200 });
    const taller = withFields(open, { ...featureFields(open, DEFAULT_ROOM), heightMm: 1500 }, DEFAULT_ROOM);
    expect(taller).toMatchObject({ kind: 'floor-alcove', topMm: 900 });
    expect(taller).not.toHaveProperty('heightMm');
    // One kind on screen: 바닥에서 alone decides how it is stored, both ways.
    const down = withFields(feature, { ...fields, bottomMm: 0 }, DEFAULT_ROOM);
    expect(down).toMatchObject({ kind: 'floor-alcove', topMm: 1680 });
    expect(down).not.toHaveProperty('heightMm');
    expect(validateWallFeatures(DEFAULT_ROOM, [down])).toEqual([]);
    const up = withFields(down, { ...featureFields(down, DEFAULT_ROOM), bottomMm: 300 }, DEFAULT_ROOM);
    expect(up).toMatchObject({ kind: 'closed-niche', topMm: 1380, heightMm: 720 });
    expect(validateWallFeatures(DEFAULT_ROOM, [up])).toEqual([]);
    expect(
      validateWallFeatures(DEFAULT_ROOM, [withFields(feature, { ...fields, bottomMm: -5 }, DEFAULT_ROOM)])
        .length,
    ).toBeGreaterThan(0);
  });

  it('adds, replaces and removes a feature of a draft scene', () => {
    const value = scene();
    const first = featureFromClick(DEFAULT_ROOM, 'back', { u: 0.3, v: 0.5 }, niche());
    putWallFeature(value, first);
    putWallFeature(value, { ...first, depthMm: 300 });
    expect(value.wallFeatures).toEqual([{ ...first, depthMm: 300 }]);
    removeWallFeature(value, first.id);
    expect(value).not.toHaveProperty('wallFeatures');
  });

  it('keeps a wall feature selected across edits and lets go of it when undo takes it away', () => {
    const base = scene();
    const project = normalizeProjectDocument({
      id: crypto.randomUUID(),
      ownerId: 'local',
      name: '벽 구조 선택',
      schemaVersion: 2,
      editRevision: 0,
      storageRevision: 0,
      createdAt: '2026-10-29T00:00:00.000Z',
      updatedAt: '2026-10-29T00:00:00.000Z',
      viewport: { zoom: 1, pan: { x: 0, y: 0 } },
      scene: { ...base, surfaces: createRoomSurfaces(DEFAULT_ROOM, 1.5) },
      history: { past: [], future: [] },
    });
    const editor = useEditor.getState();
    editor.load(project);
    const feature = featureFromClick(DEFAULT_ROOM, 'back', { u: 0.5, v: 0.5 }, niche());
    editor.change((draft) => putWallFeature(draft, feature));
    useEditor.getState().select(feature.id);
    useEditor.getState().change((draft) => {
      draft.color.saturation = 0.5;
    });
    expect(useEditor.getState().selection).toBe(feature.id);
    expect(getActiveDesign(useEditor.getState().project!)!.scene.wallFeatures).toHaveLength(1);
    useEditor.getState().undo();
    expect(useEditor.getState().selection).toBe(feature.id);
    useEditor.getState().undo();
    expect(getActiveDesign(useEditor.getState().project!)!.scene).not.toHaveProperty('wallFeatures');
    expect(useEditor.getState().selection).toBeNull();
    // The drawing choices survive edits and reset with another project.
    useEditor.getState().setWallFeatureDrawing({ depthMm: 350 });
    useEditor.getState().redo();
    expect(useEditor.getState().wallFeatureDrawing).toEqual({
      snap: true,
      depthMm: 350,
    });
    useEditor.getState().load(project);
    expect(useEditor.getState().wallFeatureDrawing).toEqual({
      snap: true,
      depthMm: 200,
    });
  });
});
