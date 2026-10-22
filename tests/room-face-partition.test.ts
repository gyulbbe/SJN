import { describe, expect, it } from 'vitest';
import { BufferGeometry, Vector3 } from 'three';
import { createRoomSurfaces, roomFaceSizeMm } from '../src/lib/room-geometry';
import { partitionRoomFaces } from '../src/lib/room-face-partition';
import { applyRoomSurfaceBand } from '../src/lib/room-surface-bands';
import { applyRoomSurfaceRegion } from '../src/lib/room-surface-regions';
import { roomSurfaceAreas } from '../src/lib/room-surface-areas';
import { usageRoomAreas } from '../src/lib/material-usage';
import { roomAreaForSurfaces } from '../src/lib/quote';
import { viewerSurfaceGeometry, viewerSurfacePatches } from '../src/lib/room-viewer/surfaces';
import { buildWallFeaturePieces } from '../src/lib/room-viewer/wall-feature-geometry';
import { validateWallFeatures, type WallFeatureV1 } from '../src/lib/wall-features';
import type { RoomDefinition, RoomFace } from '../src/lib/room-types';
import { DEFAULT_COLOR, EMPTY_MASK, type Scene, type Surface, type SurfaceRegion } from '../src/lib/types';
import {
  legacyRoomAreaForSurfaces,
  legacyRoomSurfaceAreas,
  legacyUsageRoomAreas,
  legacyViewerSurfacePatches,
} from './helpers/legacy-face-bands';

/** Deterministic pseudo-random numbers (mulberry32) so a failure names a reproducible seed. */
function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const uuid = (prefix: string, n: number) =>
  `${prefix.padEnd(8, '0').slice(0, 8)}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const MATERIALS = ['m-a', 'm-b', 'm-c'];

function sceneFor(room: RoomDefinition, surfaces: Surface[], wallFeatures?: WallFeatureV1[]): Scene {
  return {
    room,
    ...(wallFeatures ? { wallFeatures } : {}),
    originalAssetId: 'original',
    previewAssetId: 'preview',
    imageWidth: 1200,
    imageHeight: 800,
    surfaces,
    fixtures: [],
    protection: EMPTY_MASK(),
    color: { ...DEFAULT_COLOR },
  };
}

/**
 * A room as saved before regions existed: each face whole or (a wall) split into bands that cover
 * it from top to bottom (as reconstruction and resizing make them), some without a tile, with or
 * without wall features. Never a whole face together with a partial band.
 */
function legacyScene(seed: number): Scene {
  const next = random(seed);
  const pick = <T>(values: readonly T[]) => values[Math.floor(next() * values.length)];
  const room: RoomDefinition = {
    kind: 'parametric',
    version: 1,
    widthMm: 1500 + Math.round(next() * 250) * 10,
    depthMm: 1500 + Math.round(next() * 250) * 10,
    heightMm: 2200 + Math.round(next() * 60) * 10,
  };
  let count = 0;
  const surfaces = createRoomSurfaces(room).flatMap((whole): Surface[] => {
    const tiled = (surface: Surface) => {
      const material = pick([...MATERIALS, undefined]);
      const copy = { ...structuredClone(surface), id: uuid('5afe', ++count) };
      if (material) copy.materialVersionId = material;
      else delete copy.materialVersionId;
      if (next() < 0.08)
        copy.mask = {
          ...copy.mask,
          holes: [
            [
              { x: 0, y: 0 },
              { x: 0.1, y: 0 },
              { x: 0, y: 0.1 },
            ],
          ],
        };
      return copy;
    };
    if (next() < 0.05) return [];
    if (whole.roomFace === 'floor' || next() < 0.5) return [tiled(whole)];
    const cuts = [0, ...[...new Set([1, 2, 3].map(() => Math.round(next() * 18 + 1) / 20))].sort(), 1];
    return cuts.slice(0, -1).map((from, i) => applyRoomSurfaceBand(tiled(whole), { from, to: cuts[i + 1] }));
  });
  let features: WallFeatureV1[] | undefined;
  if (next() < 0.6) {
    features = [];
    for (let i = 0; i < 3; i++) {
      const face = pick(['left', 'back', 'right'] as const);
      const span = face === 'back' ? room.widthMm : room.depthMm;
      const widthMm = 300 + Math.round(next() * 50) * 10;
      const leftMm = 50 + Math.round((next() * Math.max(0, span - widthMm - 100)) / 10) * 10;
      const topMm = 200 + Math.round(next() * 120) * 10;
      const candidate: WallFeatureV1 =
        next() < 0.5
          ? {
              version: 1,
              id: uuid('fea7', i + 1),
              kind: 'closed-niche',
              face,
              leftMm,
              topMm,
              widthMm,
              heightMm: Math.min(room.heightMm - topMm - 100, 300 + Math.round(next() * 60) * 10),
              depthMm: 100 + Math.round(next() * 20) * 10,
              source: 'user',
            }
          : {
              version: 1,
              id: uuid('fea7', i + 1),
              kind: 'floor-alcove',
              face,
              leftMm,
              topMm,
              widthMm,
              depthMm: 200 + Math.round(next() * 30) * 10,
              source: 'user',
            };
      if (!validateWallFeatures(room, [...features, candidate]).length) features.push(candidate);
    }
    if (!features.length) features = undefined;
  }
  return sceneFor(room, surfaces, features);
}

describe('one face partition, same results as before regions', () => {
  it('viewer patches, room areas, usage areas and quotation areas match the old code on 400 scenes', () => {
    const seen = { bands: 0, features: 0, alcoves: 0, masks: 0, missing: 0, quoted: 0 };
    for (let seed = 1; seed <= 400; seed++) {
      const scene = legacyScene(seed);
      const label = `seed ${seed}`;
      seen.bands += Number(scene.surfaces.some((s) => s.reconstructionBand));
      seen.features += Number(!!scene.wallFeatures);
      seen.alcoves += Number(!!scene.wallFeatures?.some((f) => f.kind === 'floor-alcove'));
      seen.masks += Number(scene.surfaces.some((s) => s.mask.holes?.length));
      seen.missing += Number(new Set(scene.surfaces.map((s) => s.roomFace)).size < 4);
      expect(viewerSurfacePatches(scene), label).toEqual(legacyViewerSurfacePatches(scene));
      expect(roomSurfaceAreas(scene), label).toEqual(legacyRoomSurfaceAreas(scene));
      const usage = usageRoomAreas(scene),
        legacyUsage = legacyUsageRoomAreas(scene);
      expect([...usage.keys()].sort(), label).toEqual([...legacyUsage.keys()].sort());
      for (const [id, value] of legacyUsage) {
        expect(usage.get(id)!.issue, label).toBe(value.issue);
        if (value.areaM2 === null) expect(usage.get(id)!.areaM2, label).toBeNull();
        // Same terms, summed in a different order: equal to the last bits of a double.
        else expect(usage.get(id)!.areaM2! / value.areaM2, label).toBeCloseTo(1, 12);
      }
      for (const material of MATERIALS) {
        const ids = scene.surfaces.filter((s) => s.materialVersionId === material).map((s) => s.id);
        const area = roomAreaForSurfaces(scene, ids, material);
        expect(area, label).toBe(legacyRoomAreaForSurfaces(scene, ids, material));
        seen.quoted += Number(area !== null);
      }
    }
    // The scenes cover what the old code handled.
    expect(seen.bands).toBeGreaterThan(200);
    expect(seen.features).toBeGreaterThan(150);
    expect(seen.alcoves).toBeGreaterThan(50);
    expect(seen.masks).toBeGreaterThan(50);
    expect(seen.missing).toBeGreaterThan(20);
    expect(seen.quoted).toBeGreaterThan(400);
  });
  it('differs from the old quotation only where a whole face and a partial band are both kept', () => {
    // No saved room has this: reconstruction and resizing make bands cover the whole wall.
    const room: RoomDefinition = {
      kind: 'parametric',
      version: 1,
      widthMm: 2400,
      depthMm: 2000,
      heightMm: 2400,
    };
    const surfaces: Surface[] = createRoomSurfaces(room).map((s, i) => ({
      ...s,
      id: uuid('face', i),
      materialVersionId: 'm-a',
    }));
    const back = surfaces.find((s) => s.roomFace === 'back')!;
    surfaces.push(
      applyRoomSurfaceBand(
        { ...structuredClone(back), id: uuid('band', 1), materialVersionId: 'm-b' },
        { from: 0.5, to: 1 },
      ),
    );
    const scene = sceneFor(room, surfaces);
    expect(legacyRoomAreaForSurfaces(scene, [back.id], 'm-a')).toBe(5.76);
    // The band's half now leaves the whole wall's area, as drawn.
    expect(roomAreaForSurfaces(scene, [back.id], 'm-a')).toBe(2.88);
  });
});

function triangleArea(geometry: BufferGeometry): number {
  const position = geometry.getAttribute('position');
  const index = geometry.getIndex()!;
  let area = 0;
  for (let offset = 0; offset < index.count; offset += 3) {
    const a = new Vector3().fromBufferAttribute(position, index.getX(offset));
    const b = new Vector3().fromBufferAttribute(position, index.getX(offset + 1));
    const c = new Vector3().fromBufferAttribute(position, index.getX(offset + 2));
    area += b.sub(a).cross(c.sub(a)).length() / 2;
  }
  return area / 1_000_000;
}
/** Areas measured on the drawn 3D geometry, per surface. */
function drawnAreas(scene: Scene): Map<string, number> {
  const { patches } = viewerSurfacePatches(scene);
  const totals = new Map<string, number>();
  const add = (id: string | undefined, area: number) => {
    if (id) totals.set(id, (totals.get(id) ?? 0) + area);
  };
  const pieces = scene.wallFeatures?.length
    ? buildWallFeaturePieces(scene.room!, patches, scene.wallFeatures)
    : undefined;
  try {
    for (const piece of pieces?.pieces ?? []) add(piece.sourceSurfaceId, triangleArea(piece.geometry));
    for (const patch of patches)
      if (!pieces?.affectedFaces.has(patch.face)) {
        const geometry = viewerSurfaceGeometry(scene.room!, patch);
        add(patch.surface?.id, triangleArea(geometry));
        geometry.dispose();
      }
  } finally {
    pieces?.dispose();
  }
  return totals;
}
/** Adds up to three tiled regions per face that do not overlap one another. */
function withRegions(scene: Scene, seed: number): Scene {
  const next = random(seed * 7919);
  let count = 0;
  for (const face of ['floor', 'left', 'back', 'right'] as RoomFace[]) {
    const base = scene.surfaces.find((s) => s.roomFace === face && !s.region);
    if (!base) continue;
    const size = roomFaceSizeMm(scene.room!, face);
    const placed: SurfaceRegion[] = [];
    for (let i = 0; i < 3; i++) {
      const widthMm = 100 + Math.round((next() * (size.width / 2)) / 10) * 10;
      const heightMm = 100 + Math.round((next() * (size.height / 2)) / 10) * 10;
      // Touching a face edge or another region is allowed; overlapping is not.
      const leftMm = next() < 0.2 ? 0 : Math.round((next() * (size.width - widthMm)) / 10) * 10;
      const topMm =
        next() < 0.2 ? size.height - heightMm : Math.round((next() * (size.height - heightMm)) / 10) * 10;
      const region = { leftMm, topMm, widthMm, heightMm };
      if (
        placed.some(
          (other) =>
            Math.min(other.leftMm + other.widthMm, leftMm + widthMm) > Math.max(other.leftMm, leftMm) &&
            Math.min(other.topMm + other.heightMm, topMm + heightMm) > Math.max(other.topMm, topMm),
        )
      )
        continue;
      placed.push(region);
      const whole = createRoomSurfaces(scene.room!).find((s) => s.roomFace === face)!;
      scene.surfaces.push(
        applyRoomSurfaceRegion(
          { ...whole, id: uuid('a1e9', ++count), name: 'region', materialVersionId: MATERIALS[i % 3] },
          region,
        ),
      );
    }
  }
  return scene;
}

describe('regions in the shared partition', () => {
  it('a region without a tile covers nothing: same cells and areas as without it', () => {
    const scene = legacyScene(3);
    const back = createRoomSurfaces(scene.room!).find((s) => s.roomFace === 'back')!;
    const bare = applyRoomSurfaceRegion(
      { ...back, id: uuid('bare', 1) },
      { leftMm: 200, topMm: 300, widthMm: 600, heightMm: 500 },
    );
    delete bare.materialVersionId;
    const withBare = { ...scene, surfaces: [...scene.surfaces, bare] };
    expect(viewerSurfacePatches(withBare)).toEqual(viewerSurfacePatches(scene));
    const areas = roomSurfaceAreas(withBare);
    for (const [id, area] of roomSurfaceAreas(scene)) expect(areas.get(id)).toEqual(area);
    expect(areas.get(bare.id)).toEqual({
      areaM2: null,
      issue: '타일을 고르면 이 부분 타일의 면적을 계산해요.',
    });
  });
  it('a tiled region owns its rectangle and leaves it out of the base, on a grid without T joints', () => {
    const room: RoomDefinition = {
      kind: 'parametric',
      version: 1,
      widthMm: 2400,
      depthMm: 2000,
      heightMm: 2400,
    };
    const surfaces = createRoomSurfaces(room).map((s, i) => ({
      ...s,
      id: uuid('face', i),
      materialVersionId: 'm-a',
    }));
    const back = surfaces.find((s) => s.roomFace === 'back')!;
    const region = applyRoomSurfaceRegion(
      { ...structuredClone(back), id: uuid('a1e9', 1), materialVersionId: 'm-b' },
      { leftMm: 600, topMm: 1200, widthMm: 1200, heightMm: 600 },
    );
    const scene = sceneFor(room, [...surfaces, region]);
    const cells = partitionRoomFaces(scene).faces.find((f) => f.face === 'back')!.cells;
    expect(cells.map((c) => [c.left, c.right, c.from, c.to, c.surface?.id === region.id])).toEqual([
      [0, 0.25, 0, 0.5, false],
      [0.25, 0.75, 0, 0.5, false],
      [0.75, 1, 0, 0.5, false],
      [0, 0.25, 0.5, 0.75, false],
      [0.25, 0.75, 0.5, 0.75, true],
      [0.75, 1, 0.5, 0.75, false],
      [0, 0.25, 0.75, 1, false],
      [0.25, 0.75, 0.75, 1, false],
      [0.75, 1, 0.75, 1, false],
    ]);
    const areas = roomSurfaceAreas(scene);
    expect(areas.get(region.id)!.areaM2).toBeCloseTo(0.72, 12);
    expect(areas.get(back.id)!.areaM2).toBeCloseTo(5.76 - 0.72, 12);
    expect(roomAreaForSurfaces(scene, [region.id], 'm-b')).toBe(0.72);
    expect(roomAreaForSurfaces(scene, [back.id], 'm-a')).toBe(5.04);
    expect(usageRoomAreas(scene).get(back.id)!.areaM2).toBeCloseTo(5.04, 12);
  });
  it('a region over a band boundary is cut into the band rows and still one surface', () => {
    const room: RoomDefinition = {
      kind: 'parametric',
      version: 1,
      widthMm: 2400,
      depthMm: 2000,
      heightMm: 2400,
    };
    const faces = createRoomSurfaces(room);
    const back = faces.find((s) => s.roomFace === 'back')!;
    const top = applyRoomSurfaceBand(
      { ...structuredClone(back), id: uuid('band', 1), materialVersionId: 'm-a' },
      { from: 0, to: 0.5 },
    );
    const bottom = applyRoomSurfaceBand(
      { ...structuredClone(back), id: uuid('band', 2), materialVersionId: 'm-c' },
      { from: 0.5, to: 1 },
    );
    const region = applyRoomSurfaceRegion(
      { ...structuredClone(back), id: uuid('a1e9', 1), materialVersionId: 'm-b' },
      { leftMm: 0, topMm: 900, widthMm: 2400, heightMm: 600 },
    );
    const scene = sceneFor(room, [...faces.filter((s) => s !== back), top, bottom, region]);
    const owned = partitionRoomFaces(scene)
      .faces.find((f) => f.face === 'back')!
      .cells.map((c) => [c.from, c.to, c.surface?.id, c.row]);
    expect(owned).toEqual([
      [0, 0.375, top.id, { from: 0, to: 0.5 }],
      [0.375, 0.5, region.id, { from: 0, to: 0.5 }],
      [0.5, 0.625, region.id, { from: 0.5, to: 1 }],
      [0.625, 1, bottom.id, { from: 0.5, to: 1 }],
    ]);
    const areas = roomSurfaceAreas(scene);
    expect(areas.get(region.id)!.areaM2).toBeCloseTo(1.44, 12);
    expect(areas.get(top.id)!.areaM2! + areas.get(bottom.id)!.areaM2!).toBeCloseTo(5.76 - 1.44, 12);
  });
  it('overlapping regions are never ordered: the overlap shows nothing and the face needs review', () => {
    const room: RoomDefinition = {
      kind: 'parametric',
      version: 1,
      widthMm: 2400,
      depthMm: 2000,
      heightMm: 2400,
    };
    const surfaces = createRoomSurfaces(room).map((s, i) => ({
      ...s,
      id: uuid('face', i),
      materialVersionId: 'm-a',
    }));
    const floor = surfaces.find((s) => s.roomFace === 'floor')!;
    const a = applyRoomSurfaceRegion(
      { ...structuredClone(floor), id: uuid('a1e9', 1), materialVersionId: 'm-b' },
      { leftMm: 0, topMm: 0, widthMm: 1000, heightMm: 1000 },
    );
    const b = applyRoomSurfaceRegion(
      { ...structuredClone(floor), id: uuid('a1e9', 2), materialVersionId: 'm-c' },
      { leftMm: 500, topMm: 500, widthMm: 1000, heightMm: 1000 },
    );
    const scene = sceneFor(room, [...surfaces, a, b]);
    const { faces, notices } = partitionRoomFaces(scene);
    const floorFace = faces.find((f) => f.face === 'floor')!;
    expect(floorFace.unclear).toBe(true);
    expect(floorFace.cells.filter((c) => c.surface === a || c.surface === b)).toEqual([]);
    expect(notices.map((n) => n.id)).toEqual([a.id, b.id]);
    expect(roomSurfaceAreas(scene).get(floor.id)!.areaM2).toBeNull();
  });
  it('an invalid region is reported and not drawn', () => {
    const room: RoomDefinition = {
      kind: 'parametric',
      version: 1,
      widthMm: 2400,
      depthMm: 2000,
      heightMm: 2400,
    };
    const surfaces = createRoomSurfaces(room).map((s, i) => ({
      ...s,
      id: uuid('face', i),
      materialVersionId: 'm-a',
    }));
    const left = surfaces.find((s) => s.roomFace === 'left')!;
    const outside = applyRoomSurfaceRegion(
      { ...structuredClone(left), id: uuid('a1e9', 1), materialVersionId: 'm-b' },
      { leftMm: 0, topMm: 0, widthMm: 500, heightMm: 500 },
    );
    outside.region = { leftMm: 1800, topMm: 0, widthMm: 500, heightMm: 500 };
    const { faces, notices } = partitionRoomFaces(sceneFor(room, [...surfaces, outside]));
    expect(faces.find((f) => f.face === 'left')!.cells.some((c) => c.surface === outside)).toBe(false);
    expect(notices.map((n) => n.message)).toEqual(['부분 타일의 범위가 잘못되어 자재를 표시하지 않아요.']);
  });
  it('drawn 3D areas and computed areas agree per surface with regions, bands and wall features', () => {
    let checked = 0;
    for (let seed = 1; seed <= 120; seed++) {
      const scene = withRegions(legacyScene(seed), seed);
      const drawn = drawnAreas(scene);
      for (const [id, value] of roomSurfaceAreas(scene)) {
        if (value.areaM2 === null) continue;
        expect(drawn.get(id) ?? 0, `seed ${seed} ${id}`).toBeCloseTo(value.areaM2, 4);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(400);
    // Regions met wall features: some region cells hold niche or alcove pieces.
    let regionPieces = 0;
    for (let seed = 1; seed <= 120; seed++) {
      const scene = withRegions(legacyScene(seed), seed);
      if (!scene.wallFeatures) continue;
      const pieces = buildWallFeaturePieces(
        scene.room!,
        viewerSurfacePatches(scene).patches,
        scene.wallFeatures,
      );
      regionPieces += pieces.pieces.filter(
        (p) => p.featureId && scene.surfaces.find((s) => s.id === p.sourceSurfaceId)?.region,
      ).length;
      pieces.dispose();
    }
    expect(regionPieces).toBeGreaterThan(20);
  });
});
