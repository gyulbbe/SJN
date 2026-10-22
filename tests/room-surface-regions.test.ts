import { beforeEach, describe, expect, it } from 'vitest';
import { getActiveDesign } from '../src/lib/designs';
import { useEditor } from '../src/lib/editor-store';
import { getEditingScene } from '../src/lib/comparison';
import { DEFAULT_ROOM, createRoomSurfaces } from '../src/lib/room-geometry';
import { homography, tileAtPoint, transformPoint } from '../src/lib/render/math';
import { resizedRoomScene, roomResetWarnings } from '../src/lib/room-editing';
import {
  applyRoomSurfaceRegion,
  clipRegionToFace,
  createRegionSurface,
  groutJoints,
  regionName,
  snapRegion,
  surfaceTileOffset,
  validateSurfaceRegions,
} from '../src/lib/room-surface-regions';
import { applyTileSettingsToAllSurfaces } from '../src/lib/tile-settings';
import { projectV3Schema } from '../src/lib/storage/validation';
import {
  DEFAULT_COLOR,
  DEFAULT_TILE,
  EMPTY_MASK,
  type LegacyProjectDocument,
  type Scene,
  type Surface,
  type SurfaceRegion,
  type TileSettings,
} from '../src/lib/types';

function scene(): Scene {
  return {
    originalAssetId: crypto.randomUUID(),
    previewAssetId: crypto.randomUUID(),
    imageWidth: 1200,
    imageHeight: 800,
    room: { ...DEFAULT_ROOM },
    surfaces: createRoomSurfaces(DEFAULT_ROOM, 1.5).map((s) => ({
      ...s,
      materialVersionId: crypto.randomUUID(),
    })),
    fixtures: [],
    protection: EMPTY_MASK(),
    color: { ...DEFAULT_COLOR },
  };
}
const face = (value: Scene, roomFace: Surface['roomFace']) =>
  value.surfaces.find((s) => s.roomFace === roomFace && !s.region)!;
const region = (leftMm: number, topMm: number, widthMm: number, heightMm: number): SurfaceRegion => ({
  leftMm,
  topMm,
  widthMm,
  heightMm,
});

describe('a region surface', () => {
  it('keeps the face quad and size and masks exactly its rectangle', () => {
    const value = scene();
    const back = face(value, 'back');
    const made = applyRoomSurfaceRegion({ ...back, id: 'r' }, region(600, 1200, 900, 300));
    expect(made.quad).toEqual(back.quad);
    expect([made.widthMm, made.heightMm]).toEqual([back.widthMm, back.heightMm]);
    const toUv = homography(back.quad);
    const corners = made.mask.polygon.map((p) => transformPoint(toUv, p));
    const expected = [
      [0.25, 0.5],
      [0.625, 0.5],
      [0.625, 0.625],
      [0.25, 0.625],
    ];
    corners.forEach((p, i) => {
      expect(p.x).toBeCloseTo(expected[i][0], 9);
      expect(p.y).toBeCloseTo(expected[i][1], 9);
    });
    expect(made.mask.strokes).toEqual([]);
    expect(() => applyRoomSurfaceRegion(back, region(2000, 0, 500, 500))).toThrow('면 안에');
  });
  it('is made without a tile, named per face, on the canonical face', () => {
    const value = scene();
    const first = createRegionSurface(value, 'floor', region(0, 0, 900, 900));
    expect(first.materialVersionId).toBeUndefined();
    expect(first.kind).toBe('floor');
    expect(first.geometryMode).toBe('room');
    expect(first.name).toBe('바닥 · 부분 타일 1');
    value.surfaces.push(first);
    expect(regionName(value, 'floor')).toBe('바닥 · 부분 타일 2');
    expect(regionName(value, 'back')).toBe('정면 벽 · 부분 타일 1');
    value.surfaces.push({ ...first, id: 'third', name: '바닥 · 부분 타일 3' });
    expect(regionName(value, 'floor')).toBe('바닥 · 부분 타일 2');
  });
  it('starts its tiles at its own corner', () => {
    const tile: TileSettings = { ...DEFAULT_TILE, offsetX: 5, offsetY: -7 };
    expect(surfaceTileOffset({ tile })).toEqual({ x: 5, y: -7 });
    expect(surfaceTileOffset({ tile, region: region(300, 1200, 600, 600) })).toEqual({ x: 305, y: 1193 });
  });
});

describe('region rules', () => {
  const issues = (value: Scene) => validateSurfaceRegions(value).map((issue) => issue.message);
  it('accepts regions inside a face that touch, rejects outside, small, overlapping and banded ones', () => {
    const value = scene();
    const back = face(value, 'back');
    const at = (r: SurfaceRegion, id: string) => ({ ...applyRoomSurfaceRegion({ ...back, id }, r) });
    value.surfaces.push(at(region(0, 0, 1200, 600), 'a'), at(region(1200, 0, 1200, 600), 'b'));
    expect(issues(value)).toEqual([]);
    value.surfaces.push({ ...at(region(0, 0, 100, 100), 'c'), region: region(2350, 0, 100, 100) });
    value.surfaces.push({ ...at(region(0, 0, 100, 100), 'd'), region: region(0, 1000, 49, 100) });
    value.surfaces.push(at(region(1100, 500, 300, 300), 'e'));
    value.surfaces.push({ ...at(region(0, 2000, 100, 100), 'f'), reconstructionBand: { from: 0, to: 0.5 } });
    value.surfaces.push({ ...at(region(0, 0, 100, 100), 'g'), region: region(Number.NaN, 0, 100, 100) });
    expect(issues(value)).toEqual([
      '부분 타일은 면 안에 있어야 해요.',
      '부분 타일은 가로·세로 50mm 이상이어야 해요.',
      '같은 면의 부분 타일끼리 겹칠 수 없어요.',
      '부분 타일은 높이 구간 면에 둘 수 없어요.',
      '부분 타일의 위치와 크기는 숫자여야 해요.',
    ]);
    expect(validateSurfaceRegions(value)[0].path).toEqual(['surfaces', 6, 'region']);
  });
  it('needs a room face of a room, of the same kind', () => {
    const value = scene();
    const made = applyRoomSurfaceRegion({ ...face(value, 'floor'), id: 'x' }, region(0, 0, 500, 500));
    expect(issues({ ...value, room: undefined, surfaces: [made] })).toEqual([
      '부분 타일은 방 치수가 있는 공간의 벽·바닥에만 둘 수 있어요.',
    ]);
    expect(issues({ ...value, surfaces: [{ ...made, kind: 'wall' }] })).toEqual([
      '부분 타일의 벽·바닥 종류가 면과 맞지 않아요.',
    ]);
  });
  it('a resized room cuts a region to the new face and drops one left too small', () => {
    expect(clipRegionToFace(region(2000, 2000, 1000, 1000), { width: 2400, height: 2200 })).toEqual(
      region(2000, 2000, 400, 200),
    );
    expect(clipRegionToFace(region(2380, 0, 500, 500), { width: 2400, height: 2400 })).toBeNull();
    expect(clipRegionToFace(region(3000, 0, 500, 500), { width: 2400, height: 2400 })).toBeNull();
  });
});

describe('Q3 snapping to the base grout', () => {
  const tileMm = { width: 300, height: 600 };
  const back = { width: 2400, height: 2400 };
  const grout = (tile: TileSettings, u: number, v: number) =>
    tileAtPoint({ x: u / back.width, y: v / back.height }, back, tileMm, tile).grout;
  /** Each boundary shows one base joint: the base side of every edge ends in grout, the inside in tile. */
  function expectOneJoint(tile: TileSettings, snapped: SurfaceRegion, axes: ('u' | 'v')[]) {
    const mid = { u: snapped.leftMm + snapped.widthMm / 2, v: snapped.topMm + snapped.heightMm / 2 };
    const right = snapped.leftMm + snapped.widthMm,
      bottom = snapped.topMm + snapped.heightMm;
    if (axes.includes('u')) {
      expect(grout(tile, snapped.leftMm - 0.4, mid.v) || grout(tile, snapped.leftMm - 0.4, mid.v + 7)).toBe(
        true,
      );
      expect(grout(tile, right + 0.4, mid.v) || grout(tile, right + 0.4, mid.v + 7)).toBe(true);
      expect(grout(tile, right - 0.4, mid.v + 100) && grout(tile, right - 0.4, mid.v + 107)).toBe(false);
    }
    if (axes.includes('v')) {
      expect(grout(tile, mid.u, snapped.topMm - 0.4) || grout(tile, mid.u + 7, snapped.topMm - 0.4)).toBe(
        true,
      );
      expect(grout(tile, mid.u, bottom + 0.4) || grout(tile, mid.u + 7, bottom + 0.4)).toBe(true);
      expect(grout(tile, mid.u + 100, bottom - 0.4) && grout(tile, mid.u + 107, bottom - 0.4)).toBe(false);
    }
  }
  const asked = region(517, 913, 803, 455);
  it('follows grid joints on both axes, also at 90° and 180°', () => {
    for (const rotation of [0, 90, 180, 270, -90]) {
      const tile: TileSettings = { ...DEFAULT_TILE, groutWidth: 3, offsetX: 40, offsetY: -25, rotation };
      const snapped = snapRegion(asked, back, { tile, tileMm });
      expectOneJoint(tile, snapped, ['u', 'v']);
      expect(Math.abs(snapped.leftMm - asked.leftMm)).toBeLessThan(310);
      expect(snapped.widthMm).toBeGreaterThanOrEqual(50);
    }
  });
  it('follows only straight rows in a brick layout; the shifted columns go to 10 mm', () => {
    const tile: TileSettings = { ...DEFAULT_TILE, groutWidth: 3, pattern: 'brick' };
    expect(groutJoints(tile, tileMm, 'u')).toBeUndefined();
    expect(groutJoints(tile, tileMm, 'v')).toEqual({ phase: -3, period: 603, grout: 3 });
    const snapped = snapRegion(asked, back, { tile, tileMm });
    expectOneJoint(tile, snapped, ['v']);
    expect(snapped.leftMm % 10).toBe(0);
    expect((snapped.leftMm + snapped.widthMm) % 10).toBe(0);
  });
  it('uses the 10 mm grid for a turned layout or no base tile, and keeps face edges', () => {
    const turned = snapRegion(asked, back, { tile: { ...DEFAULT_TILE, rotation: 30 }, tileMm });
    expect(turned).toEqual(region(520, 910, 800, 460));
    expect(snapRegion(asked, back)).toEqual(region(520, 910, 800, 460));
    expect(snapRegion(region(4, 3, 600, 2394), back)).toEqual(region(0, 0, 600, 2400));
    // A drag shorter than the minimum grows to it rather than collapsing.
    expect(snapRegion(region(100, 100, 52, 52), back)).toEqual(region(100, 100, 50, 50));
  });
});

function project(): LegacyProjectDocument {
  const after = scene(),
    before = scene();
  return {
    id: crypto.randomUUID(),
    ownerId: 'local',
    name: '부분 타일',
    schemaVersion: 2,
    editRevision: 0,
    storageRevision: 1,
    scene: after,
    comparison: {
      before,
      room: { ...DEFAULT_ROOM },
      aspect: 1.5,
      cameraVersion: 1,
      referenceOriginalAssetId: crypto.randomUUID(),
      referencePreviewAssetId: crypto.randomUUID(),
      status: 'draft',
    },
    history: { past: [], future: [] },
    viewport: { zoom: 1, pan: { x: 0, y: 0 } },
    createdAt: '2026-10-22T00:00:00.000Z',
    updatedAt: '2026-10-22T00:00:00.000Z',
  };
}

describe('editing regions in a design', () => {
  beforeEach(() => useEditor.getState().load(project()));
  const after = () => getActiveDesign(useEditor.getState().project!)!.scene;
  it('adds, moves and removes a region in one history step each; faces still cannot be removed', () => {
    const st = useEditor.getState();
    st.change((s) => {
      s.surfaces.push(createRegionSurface(s, 'back', region(600, 1200, 900, 600)));
    });
    const made = after().surfaces.find((s) => s.region)!;
    expect(made.geometryMode).toBe('room');
    expect(projectV3Schema.safeParse(useEditor.getState().project).success).toBe(true);
    useEditor.getState().change((s) => {
      const target = s.surfaces.find((x) => x.id === made.id)!;
      Object.assign(target, applyRoomSurfaceRegion(target, region(900, 1200, 900, 600)));
    });
    expect(after().surfaces.find((s) => s.id === made.id)!.geometryMode).toBe('room');
    useEditor.getState().removeSurface(face(after(), 'back').id);
    expect(after().surfaces).toHaveLength(5);
    useEditor.getState().removeSurface(made.id);
    expect(after().surfaces.map((s) => s.id)).not.toContain(made.id);
    useEditor.getState().undo();
    expect(after().surfaces.find((s) => s.id === made.id)!.region).toEqual(region(900, 1200, 900, 600));
    useEditor.getState().redo();
    expect(after().surfaces).toHaveLength(4);
    useEditor.getState().change((s) => {
      s.surfaces = s.surfaces.filter((x) => x.roomFace !== 'floor');
    });
    expect(after().surfaces.filter((s) => s.roomFace === 'floor')).toHaveLength(1);
  });
  it('rejects a saved region on the Before side, an unknown region field and an overlap', () => {
    useEditor.getState().change((s) => {
      s.surfaces.push(createRegionSurface(s, 'floor', region(0, 0, 900, 900)));
    });
    const valid = structuredClone(useEditor.getState().project!);
    expect(projectV3Schema.safeParse(valid).success).toBe(true);
    const onBefore = structuredClone(valid);
    onBefore.shared.comparison!.before.surfaces.push(
      createRegionSurface(onBefore.shared.comparison!.before, 'floor', region(0, 0, 900, 900)),
    );
    expect(projectV3Schema.safeParse(onBefore).error?.issues.map((i) => i.message)).toContain(
      '부분 타일은 After 시안에만 둘 수 있어요.',
    );
    const extra = structuredClone(valid);
    Object.assign(getActiveDesign(extra)!.scene.surfaces.find((s) => s.region)!.region!, { rotation: 5 });
    expect(projectV3Schema.safeParse(extra).success).toBe(false);
    const overlap = structuredClone(valid);
    const scene = getActiveDesign(overlap)!.scene;
    scene.surfaces.push(createRegionSurface(scene, 'floor', region(800, 800, 300, 300)));
    expect(projectV3Schema.safeParse(overlap).error?.issues.map((i) => i.message)).toContain(
      '같은 면의 부분 타일끼리 겹칠 수 없어요.',
    );
    // Documents without regions keep reading as before.
    const plain = structuredClone(valid);
    getActiveDesign(plain)!.scene.surfaces = getActiveDesign(plain)!.scene.surfaces.filter((s) => !s.region);
    expect(projectV3Schema.safeParse(plain).success).toBe(true);
  });
  it('a room resize keeps millimetres, cuts and removes regions and says how many', () => {
    const value = getEditingScene(useEditor.getState().project!, 'after');
    const kept = createRegionSurface(value, 'back', region(1800, 0, 600, 600));
    value.surfaces.push(kept);
    const gone = createRegionSurface(value, 'right', region(2300, 2300, 100, 100));
    value.surfaces.push(gone);
    const whole = createRegionSurface(value, 'floor', region(100, 100, 500, 500));
    whole.materialVersionId = 'tile';
    value.surfaces.push(whole);
    const smaller = { ...DEFAULT_ROOM, widthMm: 2100, depthMm: 2000 };
    expect(roomResetWarnings(value)).toEqual([]);
    expect(roomResetWarnings(value, smaller)).toEqual([
      '부분 타일 1개를 새 면에 맞춰 잘라요.',
      '면 밖으로 나간 부분 타일 1개를 지워요.',
    ]);
    const resized = resizedRoomScene(value, smaller, {
      originalAssetId: crypto.randomUUID(),
      previewAssetId: crypto.randomUUID(),
      imageWidth: 1200,
      imageHeight: 800,
    });
    expect(resized.surfaces.find((s) => s.id === kept.id)!.region).toEqual(region(1800, 0, 300, 600));
    expect(resized.surfaces.find((s) => s.id === gone.id)).toBeUndefined();
    const floor = resized.surfaces.find((s) => s.id === whole.id)!;
    expect(floor.region).toEqual(region(100, 100, 500, 500));
    expect(floor.materialVersionId).toBe('tile');
    expect(floor.quad).toEqual(face(resized, 'floor').quad);
    expect(validateSurfaceRegions(resized)).toEqual([]);
    expect(resized.surfaces.filter((s) => !s.region)).toHaveLength(4);
  });
  it('installation settings for all faces leave regions as they are', () => {
    const value = scene();
    const made = createRegionSurface(value, 'back', region(0, 0, 600, 600));
    made.tile = { ...made.tile, groutWidth: 9, pattern: 'brick' };
    value.surfaces.push(made);
    value.surfaces[0].tile = { ...value.surfaces[0].tile, groutWidth: 1, rotation: 45 };
    expect(applyTileSettingsToAllSurfaces(value, value.surfaces[0].id)).toBe(4);
    expect(made.tile.groutWidth).toBe(9);
    expect(value.surfaces[2].tile.rotation).toBe(45);
    // From a region, the faces take its settings and other regions keep theirs.
    const other = createRegionSurface(value, 'floor', region(0, 0, 600, 600));
    value.surfaces.push(other);
    expect(applyTileSettingsToAllSurfaces(value, made.id)).toBe(5);
    expect(value.surfaces[0].tile.groutWidth).toBe(9);
    expect(other.tile.groutWidth).not.toBe(9);
  });
});
