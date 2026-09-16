import { describe, expect, it, vi } from 'vitest';
import { Box3, Mesh, PerspectiveCamera, Vector3 } from 'three';
import { createRoomSurfaces, DEFAULT_ROOM } from '../src/lib/room-geometry';
import { buildViewerSurfaces, ViewerTileCache, viewerSurfaceGeometry } from '../src/lib/room-viewer/surfaces';
import {
  createRoomViewCamera,
  normalizeRoomView,
  roomViewBounds,
  rotateRoomView,
} from '../src/lib/room-viewer/view-state';
import { DEFAULT_COLOR, EMPTY_MASK, type Scene } from '../src/lib/types';
import type { WallFeatureV1 } from '../src/lib/wall-features';

function scene(): Scene {
  return {
    room: structuredClone(DEFAULT_ROOM),
    originalAssetId: 'original',
    previewAssetId: 'preview',
    imageWidth: 1200,
    imageHeight: 800,
    surfaces: createRoomSurfaces(DEFAULT_ROOM),
    fixtures: [],
    protection: EMPTY_MASK(),
    color: { ...DEFAULT_COLOR },
  };
}
const feature = (): WallFeatureV1 => ({
  version: 1,
  id: 'aaacbe10-0846-4a1b-88f3-383fb47f0b32',
  kind: 'closed-niche',
  face: 'back',
  leftMm: 500,
  topMm: 400,
  widthMm: 700,
  heightMm: 500,
  depthMm: 900,
  source: 'user',
});
const cache = () => new ViewerTileCache(async () => undefined, 2048);

describe('wall feature renderer integration', () => {
  it('preserves old four meshes byte-for-byte when features are absent or empty', async () => {
    for (const input of [scene(), { ...scene(), wallFeatures: [] }]) {
      const result = await buildViewerSurfaces(input, {}, cache());
      expect(result.group.children).toHaveLength(4);
      expect(result.structureBounds.isEmpty()).toBe(true);
      for (const child of result.group.children) {
        expect(child).toBeInstanceOf(Mesh);
        const mesh = child as Mesh,
          face = input.surfaces.find((s) => s.id === mesh.userData.surfaceId)!.roomFace!;
        const old = viewerSurfaceGeometry(input.room!, { face, from: 0, to: 1 });
        expect(Array.from(mesh.geometry.getAttribute('position').array)).toEqual(
          Array.from(old.getAttribute('position').array),
        );
        expect(Array.from(mesh.geometry.getAttribute('uv').array)).toEqual(
          Array.from(old.getAttribute('uv').array),
        );
        expect(Array.from(mesh.geometry.index!.array)).toEqual(Array.from(old.index!.array));
        old.dispose();
      }
      result.dispose();
    }
  });
  it('shares parent material between fragments and disposes each resource once', async () => {
    const input = scene();
    input.wallFeatures = [feature()];
    const original = structuredClone(input);
    const result = await buildViewerSurfaces(input, {}, cache());
    const meshes = result.group.children as Mesh[];
    const back = input.surfaces.find((s) => s.roomFace === 'back')!.id;
    const fragments = meshes.filter((mesh) => mesh.userData.surfaceId === back);
    expect(fragments.length).toBeGreaterThan(5);
    expect(new Set(fragments.map((mesh) => mesh.material)).size).toBe(1);
    const geometrySpies = meshes.map((mesh) => vi.spyOn(mesh.geometry, 'dispose'));
    const materials = [
      ...new Set(meshes.flatMap((mesh) => (Array.isArray(mesh.material) ? mesh.material : [mesh.material]))),
    ];
    const materialSpies = materials.map((material) => vi.spyOn(material, 'dispose'));
    result.dispose();
    result.dispose();
    expect(geometrySpies.every((spy) => spy.mock.calls.length === 1)).toBe(true);
    expect(materialSpies.every((spy) => spy.mock.calls.length === 1)).toBe(true);
    expect(input).toEqual(original);
  });
  it('shows interiors from inside the void even when the parent wall is cut away', async () => {
    const input = scene();
    input.wallFeatures = [feature()];
    const result = await buildViewerSurfaces(input, {}, cache());
    const camera = new PerspectiveCamera();
    camera.position.set(-350, 1750, -400);
    camera.updateMatrixWorld(true);
    result.updateView(camera);
    const pieces = result.group.children as Mesh[];
    expect(pieces.filter((m) => m.name.endsWith(':base-wall')).every((m) => !m.visible)).toBe(true);
    expect(pieces.filter((m) => m.name.endsWith(':rear')).every((m) => m.visible)).toBe(true);
    camera.position.set(1800, 1750, -400);
    camera.updateMatrixWorld(true);
    result.updateView(camera);
    expect(pieces.filter((m) => m.name.endsWith(':rear')).every((m) => !m.visible)).toBe(true);
    result.dispose();
  });
  it('rejects invalid geometry instead of silently drawing a flat wall', async () => {
    const input = scene();
    input.wallFeatures = [{ ...feature(), depthMm: 1001 }];
    await expect(buildViewerSurfaces(input, {}, cache())).rejects.toThrow();
  });
});

describe('common room fit with validated wall depths', () => {
  const room = { ...DEFAULT_ROOM, widthMm: 600, depthMm: 600, heightMm: 1200 };
  const structure = new Box3(new Vector3(-150, 100, -1000), new Vector3(150, 1000, 0));
  it('allows supported wall depth beyond the fixture margin without trusting far fixtures', () => {
    const distant = new Box3(new Vector3(-50000, 0, 0), new Vector3(50000, 1000, 0));
    const result = roomViewBounds(room, distant, structure);
    expect(result.min.z).toBe(-1000);
    expect(result.max.x).toBe(300);
    expect(result.min.x).toBe(-300);
    expect(roomViewBounds(room, structure).min.z).toBe(0);
    expect(
      roomViewBounds(room, undefined, new Box3(new Vector3(0, 0, -1001), new Vector3(100, 100, 0))).min.z,
    ).toBe(0);
  });
  it('fits all structure corners through four rotations and tall/narrow output', () => {
    let view = normalizeRoomView(undefined);
    for (let turn = 0; turn < 4; turn++) {
      for (const aspect of [0.5, 1.5]) {
        const camera = createRoomViewCamera(room, aspect, view, undefined, structure);
        for (const x of [structure.min.x, structure.max.x])
          for (const y of [structure.min.y, structure.max.y])
            for (const z of [structure.min.z, structure.max.z]) {
              const projected = new Vector3(x, y, z).project(camera);
              expect(Math.abs(projected.x)).toBeLessThan(1);
              expect(Math.abs(projected.y)).toBeLessThan(1);
              expect(projected.z).toBeGreaterThan(-1);
              expect(projected.z).toBeLessThan(1);
            }
      }
      view = rotateRoomView(view, 'right');
    }
  });
});
