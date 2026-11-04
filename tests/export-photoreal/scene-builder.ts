/**
 * The trial's scenes, built in the page (bundled by esbuild) with the app's own placement functions:
 * public tiles and products from the 2026-11-02 catalogue snapshot (served by the driver at
 * /images/<file>), standard models placed as the reconstruction does, partial tiles, wall structure
 * and the SMC ceiling. Nothing here calls a model.
 */
import { createRoomSurfaces, DEFAULT_ROOM } from '../../src/lib/room-geometry';
import { applyRoomSurfaceRegion } from '../../src/lib/room-surface-regions';
import { projectReconstructionFixture } from '../../src/lib/reconstruction/projection';
import { createPlacedFixture, createRoomPlacement, projectRoomFixture } from '../../src/lib/room-fixtures';
import { renderRoomBackground } from '../../src/lib/room-background';
import type { RoomFace } from '../../src/lib/room-types';
import type { AssetRecord, FixtureInstance, MaterialVersion, Scene } from '../../src/lib/types';
import type { WallFeatureV1 } from '../../src/lib/wall-features';

/** A public catalogue record as the snapshot saved it (catalog-match/snapshot/catalog.json). */
export type PublicRecord = Omit<MaterialVersion, 'id' | 'scope' | 'createdAt'> & { versionId: string };
export type StandardSpec = {
  id: string;
  kind: string;
  face: RoomFace;
  u: number;
  v: number;
  widthMm: number;
  heightMm: number;
  depthMm: number;
  baseHeightMm?: number;
  color?: string;
  yawDegrees?: number;
  extra?: Record<string, unknown>;
};
export type ProductSpec = { id: string; materialId: string; face: RoomFace; u: number; v: number };
export type RegionSpec = {
  face: RoomFace;
  materialId: string;
  leftMm: number;
  topMm: number;
  widthMm: number;
  heightMm: number;
};
export type SceneSpec = {
  id: string;
  label: string;
  holdout?: boolean;
  room: { widthMm: number; depthMm: number; heightMm: number };
  wall: string;
  floor: string;
  wallGrout?: { color: string; widthMm: number };
  floorGrout?: { color: string; widthMm: number };
  regions?: RegionSpec[];
  features?: WallFeatureV1[];
  ceiling?: { kind: 'smc'; light: boolean };
  standard?: StandardSpec[];
  products?: ProductSpec[];
  /** The orbit's side: 0 front, 90 right. */
  azimuth: number;
};

const STANDARD_MATERIAL = 'standard';
const color = { exposure: 0, contrast: 1, saturation: 1, warmth: 0 };
const empty = () => ({ polygon: [], strokes: [] });

export async function buildSpecScene(spec: SceneSpec, records: Record<string, PublicRecord>) {
  const room = { ...structuredClone(DEFAULT_ROOM), ...spec.room };
  const assets: Record<string, AssetRecord> = {};
  const fetchAsset = async (id: string, file: string, kind: 'texture' | 'product') => {
    if (assets[id]) return assets[id];
    const blob = await (await fetch(`/images/${file}`)).blob();
    const bitmap = await createImageBitmap(blob);
    assets[id] = {
      id,
      ownerId: 'public',
      name: id,
      mime: blob.type || 'image/png',
      size: blob.size,
      width: bitmap.width,
      height: bitmap.height,
      kind,
      blob,
      createdAt: '2026-11-02',
    };
    bitmap.close();
    return assets[id];
  };
  const files = (window as unknown as { IMAGE_FILES: Record<string, string> }).IMAGE_FILES;
  const materials: Record<string, MaterialVersion> = {};
  const material = async (materialId: string) => {
    if (materials[materialId]) return materials[materialId];
    const record = records[materialId];
    if (!record) throw new Error(`no public record ${materialId}`);
    for (const asset of record.textureAssetIds) await fetchAsset(asset, files[asset], 'texture');
    for (const view of record.views) await fetchAsset(view.assetId, files[view.assetId], 'product');
    const rest: Partial<PublicRecord> = { ...record };
    delete rest.versionId;
    materials[materialId] = {
      ...rest,
      id: materialId,
      scope: 'personal',
      createdAt: '2026-11-02',
    } as MaterialVersion;
    return materials[materialId];
  };
  await material(spec.wall);
  await material(spec.floor);
  for (const region of spec.regions ?? []) await material(region.materialId);
  materials[STANDARD_MATERIAL] = {
    ...materials[spec.floor],
    id: STANDARD_MATERIAL,
    materialId: STANDARD_MATERIAL,
    name: STANDARD_MATERIAL,
    category: 'toilet',
    textureAssetIds: [],
    views: [],
  };
  const imageWidth = 4096,
    imageHeight = 2731,
    aspect = imageWidth / imageHeight;
  const background = await renderRoomBackground(room, { width: imageWidth, height: imageHeight });
  const bgBitmap = await createImageBitmap(background.blob);
  assets.bg = {
    id: 'bg',
    ownerId: 'test',
    name: 'bg',
    mime: 'image/png',
    size: background.blob.size,
    width: bgBitmap.width,
    height: bgBitmap.height,
    kind: 'original',
    blob: background.blob,
    createdAt: '2026-11-04',
  };
  bgBitmap.close();

  const fixtures: FixtureInstance[] = [];
  for (const s of spec.standard ?? []) {
    const fixture: FixtureInstance = {
      id: s.id,
      name: s.id,
      materialVersionId: STANDARD_MATERIAL,
      viewIndex: 0,
      position: { x: 0.5, y: 0.5 },
      width: 0.1,
      height: 0.1,
      rotation: 0,
      anchor: { x: 0.5, y: 1 },
      locked: false,
      shadow: { x: 0, y: 0, opacity: 0, blur: 0.01, scale: 1 },
      occlusion: empty(),
      color: { ...color },
      roomPlacement: {
        face: s.face,
        u: s.u,
        v: s.v,
        scale: 1,
        widthMm: s.widthMm,
        heightMm: s.heightMm,
        imageAspect: s.widthMm / s.heightMm,
        contentBounds: { left: 0, right: 1, top: 0, bottom: 1 },
      },
      reconstruction: {
        version: 2,
        kind: s.kind,
        color: s.color ?? '#f2f1ec',
        widthMm: s.widthMm,
        heightMm: s.heightMm,
        depthMm: s.depthMm,
        baseHeightMm: s.baseHeightMm ?? 0,
        yawDegrees: s.yawDegrees ?? 0,
        ...(s.extra ?? {}),
      } as FixtureInstance['reconstruction'],
    };
    projectReconstructionFixture(room, fixture, aspect);
    fixtures.push(fixture);
  }
  for (const p of spec.products ?? []) {
    const m = await material(p.materialId);
    const viewIndex = Math.max(
      0,
      m.views.findIndex((v) => v.direction === '정면'),
    );
    const view = m.views[viewIndex];
    const roomPlacement = await createRoomPlacement(m, assets[view.assetId], p.face);
    roomPlacement.u = p.u;
    roomPlacement.v = p.v;
    const fixture = createPlacedFixture({ id: p.id, material: m, viewIndex, view, roomPlacement });
    projectRoomFixture(room, fixture, aspect, undefined, view.direction as never);
    fixtures.push(fixture);
  }

  const faceSurface = (s: ReturnType<typeof createRoomSurfaces>[number]) => {
    const floor = s.roomFace === 'floor';
    const grout = floor ? spec.floorGrout : spec.wallGrout;
    const m = materials[floor ? spec.floor : spec.wall];
    return {
      ...s,
      materialVersionId: m.id,
      tile: {
        ...s.tile,
        groutWidth: grout?.widthMm ?? m.defaultGroutWidth ?? 2,
        groutColor: grout?.color ?? m.defaultGroutColor ?? '#d5d1c9',
        pattern: m.defaultPattern ?? 'grid',
        seed: 7,
      },
    };
  };
  const makeScene = (): Scene => {
    const surfaces: Scene['surfaces'] = createRoomSurfaces(room, aspect).map(faceSurface);
    spec.regions?.forEach((region, index) => {
      const base = surfaces.find((s) => s.roomFace === region.face)!;
      const m = materials[region.materialId];
      surfaces.push(
        applyRoomSurfaceRegion(
          {
            ...base,
            id: `30000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
            name: `${region.face} · 부분 타일 ${index + 1}`,
            materialVersionId: m.id,
            tile: { ...base.tile, groutColor: m.defaultGroutColor ?? base.tile.groutColor },
          },
          { leftMm: region.leftMm, topMm: region.topMm, widthMm: region.widthMm, heightMm: region.heightMm },
        ),
      );
    });
    return {
      room: structuredClone(room),
      ...(spec.features?.length ? { wallFeatures: structuredClone(spec.features) } : {}),
      ...(spec.ceiling ? { ceiling: { ...spec.ceiling } } : {}),
      originalAssetId: 'bg',
      previewAssetId: 'bg',
      imageWidth,
      imageHeight,
      surfaces,
      fixtures: structuredClone(fixtures),
      protection: empty(),
      color: { ...color },
    };
  };
  // The Before is the same room without the After's options, as a comparison would have it.
  const before = makeScene();
  delete before.ceiling;
  const snapshot = { scene: makeScene(), beforeScene: before, materials };
  return { room, assets, materials, snapshot, imageWidth, imageHeight, aspect };
}
