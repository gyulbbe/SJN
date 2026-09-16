import { describe, expect, it, vi } from 'vitest';
import { FrontSide, Mesh, MeshBasicMaterial, Raycaster, Vector3 } from 'three';
import { createRoomSurfaces, DEFAULT_ROOM, roomFacePoint } from '../src/lib/room-geometry';
import type { RoomDefinition } from '../src/lib/room-types';
import type { WallFeatureV1 } from '../src/lib/wall-features';
import { viewerSurfaceGeometry, type ViewerSurfacePatch } from '../src/lib/room-viewer/surfaces';
import { buildWallFeaturePieces, type WallFeaturePiece } from '../src/lib/room-viewer/wall-feature-geometry';

const room: RoomDefinition = { ...DEFAULT_ROOM, widthMm: 2400, depthMm: 3000, heightMm: 2400 };
const feature = (face: WallFeatureV1['face'] = 'back'): Extract<WallFeatureV1, { kind: 'closed-niche' }> => ({
  version: 1,
  id: '10000000-0000-4000-8000-000000000001',
  source: 'user',
  kind: 'closed-niche',
  face,
  leftMm: 600,
  topMm: 600,
  widthMm: 600,
  heightMm: 1200,
  depthMm: 300,
});
const patches = (): ViewerSurfacePatch[] =>
  createRoomSurfaces(room).map((surface) => ({ face: surface.roomFace!, from: 0, to: 1, surface }));
const area = (piece: WallFeaturePiece) => {
  const g = piece.geometry,
    p = g.getAttribute('position'),
    index = g.getIndex()!;
  let sum = 0;
  for (let i = 0; i < index.count; i += 3) {
    const a = new Vector3().fromBufferAttribute(p, index.getX(i)),
      b = new Vector3().fromBufferAttribute(p, index.getX(i + 1)),
      c = new Vector3().fromBufferAttribute(p, index.getX(i + 2));
    sum += b.sub(a).cross(c.sub(a)).length() / 2;
  }
  return sum;
};
const total = (pieces: WallFeaturePiece[], role: string) =>
  pieces.filter((p) => p.role === role).reduce((sum, p) => sum + area(p), 0);
const normal = (face: WallFeatureV1['face']) =>
  face === 'back' ? new Vector3(0, 0, 1) : face === 'left' ? new Vector3(1, 0, 0) : new Vector3(-1, 0, 0);

describe('physical wall feature geometry (CPU only)', () => {
  it('returns no pieces for an old scene and leaves legacy geometry and parents untouched', () => {
    const parents = patches(),
      before = structuredClone(parents),
      legacy = parents.map((p) => viewerSurfaceGeometry(room, p));
    const result = buildWallFeaturePieces(room, parents, []);
    expect(result.pieces).toHaveLength(0);
    expect(result.affectedFaces.size).toBe(0);
    expect(result.structureBounds.isEmpty()).toBe(true);
    expect(parents).toEqual(before);
    result.dispose();
    result.dispose();
    for (let i = 0; i < parents.length; i++) {
      const after = viewerSurfaceGeometry(room, parents[i]);
      expect(after.getAttribute('position').array).toEqual(legacy[i].getAttribute('position').array);
      expect(after.getAttribute('uv').array).toEqual(legacy[i].getAttribute('uv').array);
      expect(after.index!.array).toEqual(legacy[i].index!.array);
      after.dispose();
      legacy[i].dispose();
    }
  });

  for (const face of ['left', 'back', 'right'] as const) {
    it(`${face}: cuts the actual opening and conserves front/rear/reveal area`, () => {
      const f = feature(face),
        parents = patches(),
        before = structuredClone(f),
        result = buildWallFeaturePieces(room, parents, [f]);
      expect(total(result.pieces, 'base-wall')).toBeCloseTo(
        (face === 'back' ? room.widthMm : room.depthMm) * room.heightMm - 600 * 1200,
        2,
      );
      expect(total(result.pieces, 'rear')).toBeCloseTo(600 * 1200, 2);
      expect(total(result.pieces, 'reveal-left')).toBeCloseTo(300 * 1200, 2);
      expect(total(result.pieces, 'reveal-right')).toBeCloseTo(300 * 1200, 2);
      expect(total(result.pieces, 'reveal-top')).toBeCloseTo(600 * 300, 2);
      expect(total(result.pieces, 'reveal-bottom')).toBeCloseTo(600 * 300, 2);
      for (const p of result.pieces) {
        expect(p.parentPatch).toBe(parents.find((q) => q.face === face));
        const ns = p.geometry.getAttribute('normal');
        for (let i = 0; i < ns.count; i++)
          expect(new Vector3().fromBufferAttribute(ns, i).dot(new Vector3(...p.expectedNormal))).toBeCloseTo(
            1,
            6,
          );
        expect(area(p)).toBeGreaterThan(0);
      }
      expect(f).toEqual(before);
      result.dispose();
    });

    it(`${face}: a front-side ray enters the hole, reaches the rear and misses the front wall`, () => {
      const f = feature(face),
        result = buildWallFeaturePieces(room, patches(), [f]),
        n = normal(face),
        length = face === 'back' ? room.widthMm : room.depthMm;
      const material = new MeshBasicMaterial({ side: FrontSide }),
        meshes = result.pieces.map((p) => {
          const m = new Mesh(p.geometry, material);
          m.userData.role = p.role;
          m.updateMatrixWorld();
          return m;
        });
      const centre = roomFacePoint(room, face, 900 / length, 0.5),
        ray = new Raycaster(centre.clone().addScaledVector(n, 1000), n.clone().negate());
      const hits = ray.intersectObjects(meshes, false);
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0].object.userData.role).toBe('rear');
      expect(hits[0].distance).toBeCloseTo(1300, 4);
      expect(hits.some((h) => h.object.userData.role === 'base-wall')).toBe(false);
      const outside = roomFacePoint(room, face, 200 / length, 0.5);
      ray.set(outside.addScaledVector(n, 1000), n.clone().negate());
      expect(ray.intersectObjects(meshes, false)[0].object.userData.role).toBe('base-wall');
      material.dispose();
      result.dispose();
    });

    it(`${face}: floor alcove extends floor outwards with global, unclamped millimetre UV`, () => {
      const { heightMm: _height, ...base } = feature(face) as Extract<
        WallFeatureV1,
        { kind: 'closed-niche' }
      >;
      void _height;
      const f: WallFeatureV1 = { ...base, kind: 'floor-alcove' },
        parents = patches(),
        result = buildWallFeaturePieces(room, parents, [f]);
      expect(total(result.pieces, 'base-wall')).toBeCloseTo(
        (face === 'back' ? 2400 : 3000) * 2400 - 600 * 1800,
        2,
      );
      expect(result.pieces.some((p) => p.role === 'reveal-bottom')).toBe(false);
      const floor = result.pieces.find((p) => p.role === 'floor-extension')!;
      expect(area(floor)).toBeCloseTo(180000, 2);
      expect(floor.parentPatch).toBe(parents.find((p) => p.face === 'floor'));
      expect(floor.tileFace).toBe('floor');
      expect(floor.ownerFace).toBe(face);
      const p = floor.geometry.getAttribute('position'),
        uv = floor.geometry.getAttribute('uv');
      for (let i = 0; i < p.count; i++) {
        expect(p.getY(i)).toBe(0);
        expect(uv.getX(i) * room.widthMm).toBeCloseTo(p.getX(i) + room.widthMm / 2, 3);
        expect(uv.getY(i) * room.depthMm).toBeCloseTo(p.getZ(i), 3);
      }
      if (face === 'back')
        expect(Math.min(...Array.from({ length: 4 }, (_, i) => uv.getY(i)))).toBeLessThan(0);
      if (face === 'left')
        expect(Math.min(...Array.from({ length: 4 }, (_, i) => uv.getX(i)))).toBeLessThan(0);
      if (face === 'right')
        expect(Math.max(...Array.from({ length: 4 }, (_, i) => uv.getX(i)))).toBeGreaterThan(1);
      // Only a boundary is shared with the main floor; the extension interior is outside the room.
      const mid = floor.worldBounds.getCenter(new Vector3());
      expect(face === 'back' ? mid.z < 0 : face === 'left' ? mid.x < -1200 : mid.x > 1200).toBe(true);
      result.dispose();
    });
  }

  it('inherits rear/side material bands and picks the inside band at exact top/bottom seams', () => {
    const parents = patches(),
      original = parents.find((p) => p.face === 'back')!;
    const bands = [
      { ...original, from: 0, to: 0.25 },
      { ...original, from: 0.25, to: 0.5, surface: { ...original.surface!, id: 'upper-inner' } },
      { ...original, from: 0.5, to: 0.75, surface: { ...original.surface!, id: 'lower-inner' } },
      { ...original, from: 0.75, to: 1 },
    ];
    const result = buildWallFeaturePieces(
      room,
      [...parents.filter((p) => p.face !== 'back'), ...bands],
      [feature()],
    );
    for (const role of ['rear', 'reveal-left', 'reveal-right'])
      expect(result.pieces.filter((p) => p.role === role).map((p) => p.sourceSurfaceId)).toEqual([
        'upper-inner',
        'lower-inner',
      ]);
    expect(result.pieces.find((p) => p.role === 'reveal-top')!.parentPatch).toBe(bands[1]);
    expect(result.pieces.find((p) => p.role === 'reveal-bottom')!.parentPatch).toBe(bands[2]);
    for (const p of result.pieces.filter((p) => p.role === 'rear')) {
      const uv = p.geometry.getAttribute('uv');
      expect(uv.getX(0)).toBe(0.25);
      expect(uv.getX(1)).toBe(0.5);
      expect(uv.getY(0)).toBe(p.parentPatch.from);
      expect(uv.getY(2)).toBe(p.parentPatch.to);
    }
    const left = result.pieces.find((p) => p.role === 'reveal-left')!,
      lu = left.geometry.getAttribute('uv');
    expect((lu.getX(1) - lu.getX(0)) * room.widthMm).toBeCloseTo(300, 5);
    const top = result.pieces.find((p) => p.role === 'reveal-top')!,
      tu = top.geometry.getAttribute('uv');
    expect((tu.getY(2) - tu.getY(1)) * room.heightMm).toBeCloseTo(300, 5);
    result.dispose();
  });

  it('preserves neutral parent patches instead of choosing an arbitrary conflicting material', () => {
    const parents = patches().map((p) => (p.face === 'back' ? { ...p, surface: undefined } : p)),
      result = buildWallFeaturePieces(room, parents, [feature()]);
    expect(
      result.pieces.every(
        (p) => p.sourceSurfaceId === undefined && p.parentPatch === parents.find((q) => q.face === 'back'),
      ),
    ).toBe(true);
    result.dispose();
  });

  it('subdivides multiple openings and bands without positive-area overlap or lost front area', () => {
    const f1 = { ...feature(), widthMm: 400, heightMm: 600 },
      f2 = {
        ...feature(),
        id: '10000000-0000-4000-8000-000000000002',
        leftMm: 1400,
        topMm: 1400,
        widthMm: 500,
        heightMm: 600,
      };
    const parents = patches(),
      back = parents.find((p) => p.face === 'back')!,
      bands = [
        { ...back, from: 0, to: 0.5 },
        { ...back, from: 0.5, to: 1 },
      ];
    const result = buildWallFeaturePieces(
      room,
      [...parents.filter((p) => p.face !== 'back'), ...bands],
      [f1, f2],
    );
    const front = result.pieces.filter((p) => p.role === 'base-wall');
    expect(total(front, 'base-wall')).toBeCloseTo(2400 * 2400 - 400 * 600 - 500 * 600, 2);
    for (let i = 0; i < front.length; i++)
      for (let j = i + 1; j < front.length; j++) {
        const a = front[i].worldBounds,
          b = front[j].worldBounds;
        const overlapX = Math.min(a.max.x, b.max.x) - Math.max(a.min.x, b.min.x),
          overlapY = Math.min(a.max.y, b.max.y) - Math.max(a.min.y, b.min.y);
        expect(overlapX > 1e-5 && overlapY > 1e-5).toBe(false);
      }
    expect(new Set(result.pieces.filter((p) => p.featureId).map((p) => p.featureId))).toEqual(
      new Set([f1.id, f2.id]),
    );
    result.dispose();
  });

  it('owns and disposes every unique geometry exactly once without mutating parent surfaces', () => {
    const parents = patches(),
      before = structuredClone(parents),
      result = buildWallFeaturePieces(room, parents, [feature()]);
    expect(new Set(result.pieces.map((p) => p.geometry)).size).toBe(result.pieces.length);
    const spies = result.pieces.map((p) => vi.spyOn(p.geometry, 'dispose'));
    result.dispose();
    result.dispose();
    for (const spy of spies) expect(spy).toHaveBeenCalledTimes(1);
    expect(parents).toEqual(before);
    expect(result.structureBounds.min.z).toBe(-300);
    expect(result.structureBounds.max.z).toBe(0);
  });

  it('rejects invalid or overlapping features and invalid parent partitions before building pieces', () => {
    expect(() => buildWallFeaturePieces(room, patches(), [{ ...feature(), depthMm: -1 }])).toThrow();
    expect(() =>
      buildWallFeaturePieces(room, patches(), [
        feature(),
        { ...feature(), id: '10000000-0000-4000-8000-000000000002' },
      ]),
    ).toThrow();
    expect(() =>
      buildWallFeaturePieces(
        room,
        patches().map((p) => (p.face === 'back' ? { ...p, to: 0.8 } : p)),
        [feature()],
      ),
    ).toThrow();
    expect(() =>
      buildWallFeaturePieces(
        room,
        patches().map((p) => (p.face === 'back' ? { ...p, from: NaN } : p)),
        [feature()],
      ),
    ).toThrow();
  });
  it('fails explicitly when a positive physical feature collapses in Float32 coordinates', () => {
    expect(() => buildWallFeaturePieces(room, patches(), [{ ...feature(), widthMm: 1e-9 }])).toThrow(
      /정밀도/,
    );
  });
  it('all cavity normals face the void: interior rays hit each reveal and exit through the mouth', () => {
    for (const face of ['left', 'back', 'right'] as const) {
      const result = buildWallFeaturePieces(room, patches(), [feature(face)]);
      const material = new MeshBasicMaterial({ side: FrontSide });
      const meshes = result.pieces.map((p) => {
        const mesh = new Mesh(p.geometry, material);
        mesh.userData.role = p.role;
        mesh.updateMatrixWorld();
        return mesh;
      });
      const n = normal(face),
        length = face === 'back' ? room.widthMm : room.depthMm;
      const centre = roomFacePoint(room, face, 900 / length, 0.5).addScaledVector(n, -150);
      const u =
        face === 'back'
          ? new Vector3(1, 0, 0)
          : face === 'left'
            ? new Vector3(0, 0, -1)
            : new Vector3(0, 0, 1);
      for (const [direction, role, distance] of [
        [n.clone().negate(), 'rear', 150],
        [u.clone().negate(), 'reveal-left', 300],
        [u, 'reveal-right', 300],
        [new Vector3(0, 1, 0), 'reveal-top', 600],
        [new Vector3(0, -1, 0), 'reveal-bottom', 600],
      ] as const) {
        const hits = new Raycaster(centre, direction).intersectObjects(meshes, false);
        expect(hits[0].object.userData.role).toBe(role);
        expect(hits[0].distance).toBeCloseTo(distance, 4);
      }
      expect(new Raycaster(centre, n).intersectObjects(meshes, false)).toHaveLength(0);
      material.dispose();
      result.dispose();
    }
  });
});
