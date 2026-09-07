import { getActiveDesign } from '../src/lib/designs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Vector3 } from 'three';
import { createRoomSurfaces, DEFAULT_ROOM, projectRoomPoint, roomFacePoint } from '../src/lib/room-geometry';
import {
  createRoomPlacement,
  productContentBounds,
  projectRoomFixture,
  roomPositionFromPhoto,
} from '../src/lib/room-fixtures';
import { normalizeRoomScene, resizedRoomScene, roomResetWarnings } from '../src/lib/room-editing';
import { projectReferences } from '../src/lib/repositories/references';
import { useEditor } from '../src/lib/editor-store';
import {
  DEFAULT_COLOR,
  EMPTY_MASK,
  type AssetRecord,
  type FixtureInstance,
  type MaterialVersion,
  type LegacyProjectDocument as ProjectDocument,
  type Scene,
} from '../src/lib/types';
import type { RoomFace } from '../src/lib/room-types';

const aspect = 1.5;
const fullBounds = { left: 0, top: 0, right: 1, bottom: 1 };
function fixture(): FixtureInstance {
  return {
    id: crypto.randomUUID(),
    name: '세면대',
    materialVersionId: crypto.randomUUID(),
    viewIndex: 0,
    position: { x: 0.5, y: 0.5 },
    width: 0.2,
    height: 0.3,
    rotation: 0,
    anchor: { x: 0.5, y: 1 },
    locked: false,
    shadow: { x: 0, y: 0.01, opacity: 0.2, blur: 0.03, scale: 1 },
    occlusion: EMPTY_MASK(),
    color: { ...DEFAULT_COLOR },
    roomPlacement: {
      face: 'floor',
      u: 0.5,
      v: 0.55,
      scale: 1,
      widthMm: 600,
      heightMm: 800,
      imageAspect: 0.75,
      contentBounds: { ...fullBounds },
    },
  };
}
function scene(): Scene {
  const product = fixture();
  projectRoomFixture(DEFAULT_ROOM, product, aspect);
  return {
    room: { ...DEFAULT_ROOM },
    originalAssetId: crypto.randomUUID(),
    previewAssetId: crypto.randomUUID(),
    imageWidth: 1536,
    imageHeight: 1024,
    surfaces: createRoomSurfaces(DEFAULT_ROOM),
    protection: EMPTY_MASK(),
    fixtures: [product],
    color: { ...DEFAULT_COLOR },
  };
}
function documentFor(value: Scene): ProjectDocument {
  const time = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    ownerId: 'local',
    name: '실제 크기 공간',
    schemaVersion: 1,
    editRevision: 0,
    storageRevision: 0,
    scene: value,
    history: { past: [], future: [] },
    viewport: { zoom: 1, pan: { x: 0, y: 0 } },
    createdAt: time,
    updatedAt: time,
  };
}
function assets() {
  return {
    originalAssetId: crypto.randomUUID(),
    previewAssetId: crypto.randomUUID(),
    imageWidth: 4096,
    imageHeight: 2731,
  };
}
function pixelAsset(width = 4, height = 4): AssetRecord {
  return {
    id: crypto.randomUUID(),
    ownerId: 'local',
    name: '도기.png',
    mime: 'image/png',
    size: 3,
    width,
    height,
    kind: 'product',
    createdAt: new Date().toISOString(),
    blob: new Blob(['png']),
  };
}
function mockRaster(alphas: number[], width = 4, height = 4) {
  const data = new Uint8ClampedArray(width * height * 4);
  alphas.forEach((alpha, i) => {
    data[i * 4 + 3] = alpha;
  });
  const close = vi.fn();
  const decode = vi.fn().mockResolvedValue({ width, height, close });
  vi.stubGlobal('createImageBitmap', decode);
  vi.stubGlobal('document', {
    createElement: () => ({
      width,
      height,
      getContext: () => ({
        drawImage: vi.fn(),
        getImageData: () => ({ data }),
      }),
    }),
  });
  return { decode, close };
}
afterEach(() => vi.unstubAllGlobals());

describe('room-scaled 2D fixtures', () => {
  it('fits visible alpha bounds into physical dimensions while retaining full image aspect and anchor', () => {
    for (const bounds of [fullBounds, { left: 0.2, top: 0.15, right: 0.8, bottom: 0.9 }])
      for (const imageAspect of [0.5, 1, 2])
        for (const face of ['floor', 'left', 'back', 'right'] as RoomFace[]) {
          const product = fixture(),
            placement = product.roomPlacement!;
          Object.assign(placement, { face, contentBounds: bounds, imageAspect, u: 0.4, v: 0.65 });
          const anchor = structuredClone(product.anchor);
          projectRoomFixture(DEFAULT_ROOM, product, aspect);
          const world = roomFacePoint(DEFAULT_ROOM, face, placement.u, placement.v);
          const origin = projectRoomPoint(DEFAULT_ROOM, world);
          const right = projectRoomPoint(
            DEFAULT_ROOM,
            world.clone().add(new Vector3(placement.widthMm, 0, 0)),
          );
          const top = projectRoomPoint(
            DEFAULT_ROOM,
            world.clone().add(new Vector3(0, placement.heightMm, 0)),
          );
          const widthRatio = (product.width * (bounds.right - bounds.left)) / Math.abs(right.x - origin.x);
          const heightRatio = (product.height * (bounds.bottom - bounds.top)) / Math.abs(top.y - origin.y);
          expect(widthRatio).toBeLessThanOrEqual(1 + 1e-12);
          expect(heightRatio).toBeLessThanOrEqual(1 + 1e-12);
          expect(Math.max(widthRatio, heightRatio)).toBeCloseTo(1, 12);
          expect((product.width * aspect) / product.height).toBeCloseTo(imageAspect, 12);
          expect(product.position).toEqual(origin);
          expect(product.anchor).toEqual(anchor);
        }
  });

  it('projects every installation face back to relative coordinates and clamps edge dragging', () => {
    for (const face of ['floor', 'left', 'back', 'right'] as RoomFace[]) {
      for (const [u, v] of [
        [0, 0],
        [1, 1],
        [0.23, 0.76],
      ]) {
        const photo = projectRoomPoint(DEFAULT_ROOM, roomFacePoint(DEFAULT_ROOM, face, u, v));
        const result = roomPositionFromPhoto(DEFAULT_ROOM, face, photo, aspect);
        expect(result.u).toBeCloseTo(u, 10);
        expect(result.v).toBeCloseTo(v, 10);
      }
      const outside = projectRoomPoint(DEFAULT_ROOM, roomFacePoint(DEFAULT_ROOM, face, -0.2, 0.7));
      expect(roomPositionFromPhoto(DEFAULT_ROOM, face, outside, aspect).u).toBe(0);
    }
  });

  it('makes the same product larger near the front and scales both axes from the saved user multiplier', () => {
    const back = fixture(),
      front = fixture();
    back.roomPlacement!.v = 0;
    front.roomPlacement!.v = 1;
    projectRoomFixture(DEFAULT_ROOM, back, aspect);
    projectRoomFixture(DEFAULT_ROOM, front, aspect);
    expect(front.width).toBeGreaterThan(back.width);
    expect(front.height).toBeGreaterThan(back.height);
    const previous = structuredClone(front);
    front.roomPlacement!.scale = 1.75;
    projectRoomFixture(DEFAULT_ROOM, front, aspect);
    expect(front.width).toBeCloseTo(previous.width * 1.75, 12);
    expect(front.height).toBeCloseTo(previous.height * 1.75, 12);
    expect(front.position).toEqual(previous.position);
  });

  it('reprojects a drag and preserves explicit face/relative-position changes without treating color as movement', () => {
    const before = scene(),
      moved = structuredClone(before);
    moved.fixtures[0].position = projectRoomPoint(
      DEFAULT_ROOM,
      roomFacePoint(DEFAULT_ROOM, 'floor', 0.7, 0.88),
    );
    normalizeRoomScene(before, moved);
    expect(moved.fixtures[0].roomPlacement!.u).toBeCloseTo(0.7, 12);
    expect(moved.fixtures[0].roomPlacement!.v).toBeCloseTo(0.88, 12);
    expect(moved.fixtures[0].width).toBeGreaterThan(before.fixtures[0].width);
    const explicit = structuredClone(before);
    Object.assign(explicit.fixtures[0].roomPlacement!, { face: 'back', u: 0.1, v: 0.3, scale: 1.2 });
    explicit.fixtures[0].color.warmth = 0.5;
    normalizeRoomScene(before, explicit);
    expect(explicit.fixtures[0].roomPlacement).toMatchObject({ face: 'back', u: 0.1, v: 0.3, scale: 1.2 });
    expect(explicit.fixtures[0].position).toEqual(
      projectRoomPoint(DEFAULT_ROOM, roomFacePoint(DEFAULT_ROOM, 'back', 0.1, 0.3)),
    );
    expect(explicit.fixtures[0].color.warmth).toBe(0.5);
  });

  it('rejects implausibly large products before changing their displayed position or size', () => {
    const product = fixture();
    Object.assign(product.roomPlacement!, { widthMm: 100000, heightMm: 100000, scale: 5 });
    const before = structuredClone(product);
    expect(() => projectRoomFixture(DEFAULT_ROOM, product, aspect)).toThrow('너무 커요');
    expect(product).toEqual(before);
  });

  it('reads transparent padding once, preserves opaque images and closes decoded images', async () => {
    const asset = pixelAsset();
    const { decode, close } = mockRaster([0, 0, 0, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 0, 0, 0]);
    const first = await productContentBounds(asset);
    expect(first).toEqual({ left: 0.25, top: 0.25, right: 0.75, bottom: 0.75 });
    expect(await productContentBounds(asset)).toBe(first);
    expect(decode).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    mockRaster(Array(16).fill(255));
    expect(await productContentBounds(pixelAsset())).toEqual(fullBounds);
  });

  it('rejects transparent products, permits a retry and snapshots material dimensions for a placement', async () => {
    const asset = pixelAsset(4, 4),
      raster = mockRaster(Array(16).fill(0));
    await expect(productContentBounds(asset)).rejects.toThrow('모두 투명');
    expect(raster.close).toHaveBeenCalledOnce();
    mockRaster(Array(16).fill(255));
    const material = { widthMm: 630, heightMm: 810 } as MaterialVersion;
    const placement = await createRoomPlacement(material, asset, 'back');
    expect(placement).toMatchObject({
      face: 'back',
      u: 0.5,
      v: 0.55,
      scale: 1,
      widthMm: 630,
      heightMm: 810,
      imageAspect: 1,
      contentBounds: fullBounds,
    });
    material.widthMm = 900;
    expect(placement.widthMm).toBe(630);
    const cachedBounds = await productContentBounds(asset);
    expect(placement.contentBounds).not.toBe(cachedBounds);
    placement.contentBounds.left = 0.1;
    expect(cachedBounds.left).toBe(0);
  });
});

describe('room resize and manual geometry', () => {
  it('detaches changed masks, quads and dimensions but keeps tile controls and colors connected', () => {
    const before = scene();
    for (const change of [
      (surface: Scene['surfaces'][number]) => {
        surface.widthMm += 100;
      },
      (surface: Scene['surfaces'][number]) => {
        surface.heightMm += 100;
      },
      (surface: Scene['surfaces'][number]) => {
        surface.quad[0].x += 0.001;
      },
      (surface: Scene['surfaces'][number]) => {
        surface.mask.strokes.push({ points: [{ x: 0.5, y: 0.8 }], radius: 0.02, erase: true });
      },
    ]) {
      const next = structuredClone(before);
      change(next.surfaces[0]);
      normalizeRoomScene(before, next);
      expect(next.surfaces[0].geometryMode).toBe('manual');
      expect(next.surfaces.slice(1).every((surface) => surface.geometryMode === 'room')).toBe(true);
    }
    const colored = structuredClone(before);
    colored.surfaces[0].color.warmth = 0.3;
    colored.surfaces[0].tile.offsetX = 150;
    normalizeRoomScene(before, colored);
    expect(colored.surfaces[0].geometryMode).toBe('room');
  });

  it('accepts a canonical reset and leaves uploaded photo projects unchanged', () => {
    const before = scene();
    before.surfaces[0].geometryMode = 'manual';
    before.surfaces[0].widthMm += 200;
    const reset = structuredClone(before);
    reset.surfaces[0] = { ...createRoomSurfaces(DEFAULT_ROOM)[0], id: before.surfaces[0].id };
    normalizeRoomScene(before, reset);
    expect(reset.surfaces[0].geometryMode).toBe('room');
    const photo = scene();
    delete photo.room;
    const original = structuredClone(photo);
    normalizeRoomScene(photo, photo);
    expect(photo).toEqual(original);
  });

  it('reports removed custom work, retains material controls and rebuilds placements without mutating the old scene', () => {
    const before = scene();
    before.surfaces[0].geometryMode = 'manual';
    before.surfaces[0].quad[0].x += 0.001;
    before.surfaces[0].tile.offsetY = 120;
    before.surfaces[0].tile.rotation = 45;
    before.surfaces[0].color.exposure = 0.4;
    before.surfaces[0].materialVersionId = crypto.randomUUID();
    const extra = structuredClone(before.surfaces[1]);
    delete extra.roomFace;
    delete extra.geometryMode;
    extra.id = crypto.randomUUID();
    before.surfaces.push(extra);
    before.protection.strokes.push({ points: [{ x: 0.4, y: 0.7 }], radius: 0.02, erase: false });
    before.fixtures[0].occlusion.polygon = [
      { x: 0.4, y: 0.7 },
      { x: 0.6, y: 0.7 },
      { x: 0.6, y: 0.8 },
    ];
    before.fixtures[0].roomPlacement!.scale = 1.3;
    before.fixtures[0].roomPlacement!.u = 0.62;
    before.fixtures[0].locked = true;
    before.fixtures[0].rotation = 32;
    before.backgroundAssetId = crypto.randomUUID();
    const original = structuredClone(before),
      nextRoom = { ...DEFAULT_ROOM, widthMm: 4800, depthMm: 3600, heightMm: 3000 };
    expect(roomResetWarnings(before)).toHaveLength(5);
    expect(roomResetWarnings(before).join(' ')).toContain('수동 보정한 기본 면 1개');
    expect(roomResetWarnings(before).join(' ')).toContain('직접 추가한 면 1개');
    const nextAssets = assets(),
      after = resizedRoomScene(before, nextRoom, nextAssets);
    expect(before).toEqual(original);
    expect(after.room).toEqual(nextRoom);
    expect(after.originalAssetId).toBe(nextAssets.originalAssetId);
    expect(after.previewAssetId).toBe(nextAssets.previewAssetId);
    expect(after.backgroundAssetId).toBeUndefined();
    expect(after.protection).toEqual(EMPTY_MASK());
    expect(after.surfaces).toHaveLength(4);
    expect(after.surfaces[0]).toMatchObject({
      id: before.surfaces[0].id,
      name: before.surfaces[0].name,
      materialVersionId: before.surfaces[0].materialVersionId,
      tile: before.surfaces[0].tile,
      color: before.surfaces[0].color,
      widthMm: 4800,
      heightMm: 3600,
      geometryMode: 'room',
    });
    expect(after.fixtures[0].roomPlacement).toEqual(before.fixtures[0].roomPlacement);
    expect(after.fixtures[0].occlusion).toEqual(EMPTY_MASK());
    expect(after.fixtures[0].locked).toBe(true);
    expect(after.fixtures[0].rotation).toBe(32);
    expect(after.fixtures[0].position).toEqual(
      projectRoomPoint(
        nextRoom,
        roomFacePoint(nextRoom, 'floor', 0.62, before.fixtures[0].roomPlacement!.v),
        nextAssets.imageWidth / nextAssets.imageHeight,
      ),
    );
    expect(after.fixtures[0].width).not.toBe(before.fixtures[0].width);
    expect(roomResetWarnings(after)).toEqual([]);
  });

  it('resizes in one undo command and keeps old and new background references reachable through redo', () => {
    const before = scene();
    before.backgroundAssetId = crypto.randomUUID();
    const oldScene = structuredClone(before),
      nextAssets = assets();
    useEditor.getState().load(documentFor(before));
    useEditor.getState().resizeAll({ ...DEFAULT_ROOM, widthMm: 3600 }, nextAssets);
    const changed = useEditor.getState().project!;
    expect(getActiveDesign(changed)!.history.past).toHaveLength(0);
    expect(changed.roomHistory.past!.designs[0].scene).toEqual(oldScene);
    expect(projectReferences(changed).assets).toEqual(
      expect.arrayContaining([
        before.originalAssetId,
        before.previewAssetId,
        before.backgroundAssetId!,
        nextAssets.originalAssetId,
        nextAssets.previewAssetId,
      ]),
    );
    useEditor.getState().restoreRoomChange();
    expect(getActiveDesign(useEditor.getState().project!)!.scene).toEqual(oldScene);
    expect(projectReferences(useEditor.getState().project!).assets).toContain(nextAssets.originalAssetId);
    useEditor.getState().redoRoomChange();
    expect(getActiveDesign(useEditor.getState().project!)!.scene).toEqual(getActiveDesign(changed)!.scene);
    expect(projectReferences(useEditor.getState().project!).assets).toContain(before.originalAssetId);
  });
});
