import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { createRoomSurfaces, DEFAULT_ROOM, roomFacePoint } from '../src/lib/room-geometry';
import { DEFAULT_COLOR, EMPTY_MASK, type Scene } from '../src/lib/types';
import {
  viewerFaceIsVisible,
  viewerSurfaceGeometry,
  viewerSurfacePatches,
} from '../src/lib/room-viewer/surfaces';
import { roomViewerSceneKey } from '../src/lib/room-viewer/renderer';

const scene = (): Scene => ({
  room: structuredClone(DEFAULT_ROOM),
  originalAssetId: 'original',
  previewAssetId: 'preview',
  imageWidth: 1200,
  imageHeight: 800,
  surfaces: createRoomSurfaces(DEFAULT_ROOM),
  fixtures: [],
  protection: EMPTY_MASK(),
  color: { ...DEFAULT_COLOR },
});

describe('world surface contract', () => {
  it('uses four authored room faces and does not add a ceiling or mutate source', () => {
    const input = scene(),
      before = structuredClone(input),
      result = viewerSurfacePatches(input);
    expect(result.patches.map((p) => p.face)).toEqual(['floor', 'left', 'back', 'right']);
    expect(input).toEqual(before);
  });
  it('partitions bands before the remaining full wall so depths never fight', () => {
    const input = scene(),
      back = input.surfaces.find((s) => s.roomFace === 'back')!;
    input.surfaces.push({ ...structuredClone(back), id: 'lower', reconstructionBand: { from: 0.6, to: 1 } });
    expect(
      viewerSurfacePatches(input)
        .patches.filter((p) => p.face === 'back')
        .map((p) => [p.from, p.to, p.surface?.id]),
    ).toEqual([
      [0, 0.6, back.id],
      [0.6, 1, 'lower'],
    ]);
  });
  it('keeps a band in full-face millimetre UV coordinates', () => {
    const patch = { face: 'left' as const, from: 0.6, to: 1 };
    const geometry = viewerSurfaceGeometry(DEFAULT_ROOM, patch),
      position = geometry.getAttribute('position'),
      uv = geometry.getAttribute('uv');
    expect(uv.getY(0)).toBeCloseTo(0.6);
    expect(uv.getY(3)).toBe(1);
    for (let i = 0; i < 4; i++) {
      const point = roomFacePoint(DEFAULT_ROOM, 'left', uv.getX(i), uv.getY(i));
      expect(position.getX(i)).toBeCloseTo(point.x, 3);
      expect(position.getY(i)).toBeCloseTo(point.y, 3);
      expect(position.getZ(i)).toBeCloseTo(point.z, 3);
    }
    geometry.dispose();
  });
  it('all four face normals point toward the room and u follows authored wall direction', () => {
    const inward = { floor: [0, 1, 0], back: [0, 0, 1], left: [1, 0, 0], right: [-1, 0, 0] };
    for (const face of ['floor', 'left', 'back', 'right'] as const) {
      const g = viewerSurfaceGeometry(DEFAULT_ROOM, { face, from: 0, to: 1 }),
        n = g.getAttribute('normal');
      expect([n.getX(0), n.getY(0), n.getZ(0)].map((v) => v || 0)).toEqual(inward[face]);
      g.dispose();
    }
  });
  it('rejects unclear overlapping bands and leaves their region visibly neutral', () => {
    const input = scene(),
      back = input.surfaces.find((s) => s.roomFace === 'back')!;
    input.surfaces.push(
      { ...structuredClone(back), id: 'a', reconstructionBand: { from: 0.4, to: 0.8 } },
      { ...structuredClone(back), id: 'b', reconstructionBand: { from: 0.6, to: 1 } },
    );
    const result = viewerSurfacePatches(input);
    expect(result.notices.map((n) => n.id)).toEqual(['a', 'b']);
    expect(result.patches.find((p) => p.face === 'back' && p.from === 0.6)?.surface).toBeUndefined();
  });
  it('does not invent a world texture from photo-mask/manual geometry', () => {
    const input = scene();
    input.surfaces[0].geometryMode = 'manual';
    const result = viewerSurfacePatches(input);
    expect(result.patches[0].surface).toBeUndefined();
    expect(result.notices[0].message).toContain('사진 좌표');
  });
  it('does not accept floor bands, NaN or backward intervals', () => {
    const input = scene();
    input.surfaces[0].reconstructionBand = { from: 0, to: 0.5 };
    input.surfaces[1].reconstructionBand = { from: NaN, to: 1 };
    input.surfaces[2].reconstructionBand = { from: 0.7, to: 0.2 };
    expect(viewerSurfacePatches(input).notices).toHaveLength(3);
  });
  it('uses actual camera position for near-wall and underside cutaway', () => {
    expect(viewerFaceIsVisible(DEFAULT_ROOM, 'back', new Vector3(0, 1200, -5000))).toBe(false);
    expect(viewerFaceIsVisible(DEFAULT_ROOM, 'left', new Vector3(-5000, 1200, 1200))).toBe(false);
    expect(viewerFaceIsVisible(DEFAULT_ROOM, 'right', new Vector3(5000, 1200, 1200))).toBe(false);
    expect(viewerFaceIsVisible(DEFAULT_ROOM, 'floor', new Vector3(0, -5000, 1200))).toBe(false);
    expect(viewerFaceIsVisible(DEFAULT_ROOM, 'floor', new Vector3(0, 5000, 1200))).toBe(true);
  });
  it('camera and price changes do not enter preparation identity', () => {
    const input = scene(),
      original = roomViewerSceneKey(input, {});
    expect(roomViewerSceneKey(structuredClone(input), {})).toBe(original);
    input.color.exposure = 0.5;
    expect(roomViewerSceneKey(input, {})).not.toBe(original);
  });
});
