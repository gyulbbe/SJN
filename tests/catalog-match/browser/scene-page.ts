/**
 * Round 6 scenes (catalog-match trial): a room of the photo's size with the chosen catalog tiles and
 * products, placed by the app's own functions and drawn by the app's 3D renderer from the room's
 * default view. A thin placement step stands in for placeLayout, which keeps products registered as
 * touching and skips the free-place search in an unchanged room (fixture-layouts.ts 197, 211): here
 * every product looks for a free place among the ones already placed (findFreeSlot, freeWallSlot), and
 * overlaps, moves and products that do not fit are counted. Bundled with page.ts into `window.CM`.
 */
import {
  placementToMaterialVersion,
  type PublicPlacement,
} from '../../../src/lib/catalog/placement-contract';
import { getPlacementViewIndex } from '../../../src/lib/material-images';
import { viewDirection } from '../../../src/lib/product-direction';
import { renderRoomBackground } from '../../../src/lib/room-background';
import { createPlacedFixture, createRoomPlacement, projectRoomFixture } from '../../../src/lib/room-fixtures';
import { createRoomSurfaces } from '../../../src/lib/room-geometry';
import { faceLengths, findFreeSlot, slotBox, type PlacedBox } from '../../../src/lib/room-slot';
import type { RoomFace } from '../../../src/lib/room-types';
import { behindWall, freeWallSlot, wallContactPlace } from '../../../src/lib/room-wall-contact';
import { RoomViewerRenderer } from '../../../src/lib/room-viewer/renderer';
import { defaultRoomView } from '../../../src/lib/room-viewer/view-state';
import type { AssetRecord, FixtureInstance, MaterialVersion, Scene } from '../../../src/lib/types';
import { fileUrl } from './page';

export * from './page';

type Wall = 'back' | 'left' | 'right';
export type SceneSpec = {
  id: string;
  room: { widthMm: number; depthMm: number; heightMm: number };
  tiles: Partial<Record<RoomFace, { placement: PublicPlacement; path: string }>>;
  products: { placement: PublicPlacement; paths: Record<string, string>; wall: Wall; u: number }[];
  out: string;
};
export type SceneResult = {
  placed: number;
  moved: number;
  crowded: number;
  tooBig: number;
  names: string[];
};

async function asset(
  id: string,
  path: string,
  kind: 'texture' | 'product' | 'original',
): Promise<AssetRecord> {
  const blob = await (await fetch(fileUrl(path))).blob();
  const bitmap = await createImageBitmap(blob);
  const record = {
    id,
    ownerId: 'catalog',
    name: id,
    mime: blob.type || 'image/png',
    size: blob.size,
    width: bitmap.width,
    height: bitmap.height,
    kind,
    blob,
    createdAt: '2026-11-02',
  } as AssetRecord;
  bitmap.close();
  return record;
}
/** The photo angle that puts a floor product's back on `wall` (behindWall: 정면 → back, 오른쪽 → left, 왼쪽 → right). */
const FACING: Record<Wall, string> = { back: '정면', left: '오른쪽', right: '왼쪽' };

export async function renderScene(spec: SceneSpec): Promise<SceneResult> {
  const room = { kind: 'parametric' as const, version: 1 as const, ...spec.room };
  const assets: Record<string, AssetRecord> = {};
  const materials: Record<string, MaterialVersion> = {};
  for (const tile of Object.values(spec.tiles)) {
    if (!tile || materials[tile.placement.versionId]) continue;
    assets[tile.placement.textureAssetIds[0]] = await asset(
      tile.placement.textureAssetIds[0],
      tile.path,
      'texture',
    );
    materials[tile.placement.versionId] = placementToMaterialVersion(tile.placement);
  }
  for (const product of spec.products) {
    materials[product.placement.versionId] = placementToMaterialVersion(product.placement);
    for (const [id, path] of Object.entries(product.paths)) assets[id] ??= await asset(id, path, 'product');
  }
  const imageWidth = 1600,
    imageHeight = 1200,
    aspect = imageWidth / imageHeight;
  const background = await renderRoomBackground(room, { width: imageWidth, height: imageHeight });
  assets.bg = {
    id: 'bg',
    ownerId: 'test',
    name: 'bg',
    mime: 'image/png',
    size: background.blob.size,
    width: imageWidth,
    height: imageHeight,
    kind: 'original',
    blob: background.blob,
    createdAt: '2026-11-02',
  } as AssetRecord;

  // ---------- products: the thin placement step ----------
  const result: SceneResult = { placed: 0, moved: 0, crowded: 0, tooBig: 0, names: [] };
  const fixtures: FixtureInstance[] = [];
  const placed: { face: RoomFace; box: PlacedBox }[] = [];
  const order = spec.products
    .map((product, i) => ({ product, i, material: materials[product.placement.versionId] }))
    .sort(
      (a, b) =>
        b.material.widthMm * b.material.heightMm - a.material.widthMm * a.material.heightMm || a.i - b.i,
    );
  for (const { product, material } of order) {
    const floor = material.installation !== 'wall';
    const face: RoomFace = floor ? 'floor' : product.wall;
    const viewIndex = floor
      ? Math.max(
          0,
          material.views.findIndex((v) => viewDirection(v.direction) === FACING[product.wall]),
        )
      : getPlacementViewIndex(material, face).index;
    const view = material.views[viewIndex];
    const roomPlacement = await createRoomPlacement(material, assets[view.assetId], face);
    const u = product.u;
    if (floor) {
      roomPlacement.u = product.wall === 'back' ? u : product.wall === 'left' ? 0.05 : 0.95;
      roomPlacement.v = product.wall === 'back' ? 0.05 : product.wall === 'left' ? 1 - u : u;
    } else {
      roomPlacement.u = u;
      // A basin's top about 850 mm from the floor (the anchor is its centre).
      roomPlacement.v = Math.max(0, Math.min(1, 1 - (850 - material.heightMm / 2) / spec.room.heightMm));
    }
    const fixture = createPlacedFixture({
      id: crypto.randomUUID(),
      material,
      viewIndex,
      view,
      roomPlacement,
    });
    const length = faceLengths(room, face);
    const box = slotBox(fixture.roomPlacement!, fixture.anchor, material.depthMm);
    if (box.widthMm > length.u || (face === 'floor' ? box.depthMm : box.heightMm) > length.v) {
      result.tooBig++;
      continue;
    }
    const wall = floor ? behindWall(fixture, materials) : undefined;
    const contact = wall && wallContactPlace(room, fixture, materials, wall);
    if (contact) Object.assign(fixture.roomPlacement!, contact, { againstWall: true as const });
    const obstacles = placed.filter((p) => p.face === face).map((p) => p.box);
    const slot =
      (contact ? freeWallSlot(room, fixture, materials, box, obstacles) : undefined) ??
      findFreeSlot(room, face, box, obstacles, {
        defaultSlot: { u: fixture.roomPlacement!.u, v: fixture.roomPlacement!.v },
        ...(face === 'floor' ? {} : { along: 'u' as const }),
      });
    fixture.roomPlacement!.u = slot.u;
    fixture.roomPlacement!.v = slot.v;
    if (slot.status === 'moved') result.moved++;
    if (slot.status === 'crowded') result.crowded++;
    try {
      projectRoomFixture(
        room,
        fixture,
        aspect,
        fixture.roomPlacement!.againstWall ? wall : undefined,
        viewDirection(view.direction) ?? '정면',
      );
    } catch {
      result.tooBig++;
      continue;
    }
    placed.push({ face, box: { ...box, u: slot.u, v: slot.v } });
    fixtures.push(fixture);
    result.placed++;
    result.names.push(material.name);
  }

  // ---------- the room ----------
  const color = { exposure: 0, contrast: 1, saturation: 1, warmth: 0 };
  const scene = {
    room: structuredClone(room),
    originalAssetId: 'bg',
    previewAssetId: 'bg',
    imageWidth,
    imageHeight,
    surfaces: createRoomSurfaces(room, aspect).map((surface) => {
      const tile = surface.roomFace ? spec.tiles[surface.roomFace] : undefined;
      return tile
        ? {
            ...surface,
            materialVersionId: tile.placement.versionId,
            tile: {
              ...surface.tile,
              groutWidth: tile.placement.defaultGroutWidth,
              groutColor: tile.placement.defaultGroutColor,
              pattern: tile.placement.defaultPattern,
              seed: 7,
            },
          }
        : surface;
    }),
    fixtures,
    protection: { polygon: [], strokes: [] },
    color,
  } as Scene;
  const viewer = new RoomViewerRenderer();
  try {
    await viewer.setSnapshot(
      { scene, beforeScene: structuredClone(scene), materials } as never,
      async (id: string) => assets[id],
      { background: '#ffffff' },
    );
    const blob = await viewer.export(defaultRoomView(), { format: 'jpeg', mode: 'after', longEdge: 1024 });
    await fetch(`${location.origin}/out?path=${encodeURIComponent(spec.out)}`, {
      method: 'POST',
      body: blob,
    });
  } finally {
    viewer.dispose();
  }
  return result;
}
