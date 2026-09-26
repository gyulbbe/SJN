/**
 * The authored bathroom used by the export-realism browser measurements: white wall tiles, grey
 * floor tiles, toilet, wall basin, mirror and bath in the default room. Runs in the page (bundled
 * by esbuild); textures are drawn on canvases, so nothing is fetched.
 */
import { createRoomSurfaces, DEFAULT_ROOM } from '../../src/lib/room-geometry';
import type { AssetRecord, FixtureInstance, MaterialVersion, Scene } from '../../src/lib/types';

const tileBlob = async (fill: string) => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = fill;
  ctx.fillRect(0, 0, 64, 64);
  return new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!)));
};

export async function buildRealismScene() {
  const room = structuredClone(DEFAULT_ROOM);
  const color = { exposure: 0, contrast: 1, saturation: 1, warmth: 0 };
  const empty = () => ({ polygon: [], strokes: [] });
  const assets: Record<string, AssetRecord> = {};
  const materials: Record<string, MaterialVersion> = {};
  const tiles = {
    wall: { fill: '#ecebe6', w: 300, h: 600, finish: '무광' },
    floor: { fill: '#8e8b85', w: 600, h: 600, finish: '무광' },
  } as const;
  for (const [id, tile] of Object.entries(tiles)) {
    const blob = await tileBlob(tile.fill);
    assets[id] = {
      id,
      ownerId: 'test',
      name: id,
      mime: 'image/png',
      size: blob.size,
      width: 64,
      height: 64,
      kind: 'texture',
      blob,
      createdAt: '2026-09-26',
    };
    materials[id] = {
      id,
      materialId: id,
      version: 1,
      name: id,
      brand: '',
      code: '',
      category: 'tile',
      scope: 'personal',
      description: '',
      color: tile.fill,
      finish: tile.finish,
      widthMm: tile.w,
      heightMm: tile.h,
      depthMm: 9,
      usage: 'both',
      installation: 'wall',
      textureAssetIds: [id],
      views: [],
      defaultGroutWidth: 2,
      defaultGroutColor: '#dddddd',
      defaultPattern: 'grid',
      createdAt: '2026-09-26',
    };
  }
  materials.standard = { ...materials.wall, id: 'standard', materialId: 'standard', category: 'toilet' };
  const fixture = (
    id: string,
    kind: string,
    face: 'floor' | 'back',
    u: number,
    v: number,
    w: number,
    h: number,
    d: number,
    base = 0,
  ): FixtureInstance => ({
    id,
    name: id,
    materialVersionId: 'standard',
    viewIndex: 0,
    position: { x: 0.5, y: 0.5 },
    width: 0.2,
    height: 0.4,
    rotation: 0,
    anchor: { x: 0.5, y: 1 },
    locked: false,
    shadow: { x: 0, y: 0, opacity: 0, blur: 0.01, scale: 1 },
    occlusion: empty(),
    color: { ...color },
    roomPlacement: {
      face,
      u,
      v,
      scale: 1,
      widthMm: w,
      heightMm: h,
      imageAspect: w / h,
      contentBounds: { left: 0, right: 1, top: 0, bottom: 1 },
    },
    reconstruction: {
      version: 2,
      kind,
      color: '#f2f1ec',
      widthMm: w,
      heightMm: h,
      depthMm: d,
      baseHeightMm: base,
      yawDegrees: 0,
    },
  });
  const basin = fixture('basin', 'basin', 'back', 0.28, 0.62, 600, 220, 430, 800);
  basin.reconstruction!.basinVariant = 'wall';
  const scene: Scene = {
    room: structuredClone(room),
    originalAssetId: 'none',
    previewAssetId: 'none',
    imageWidth: 3600,
    imageHeight: 2400,
    surfaces: createRoomSurfaces(room, 1.5).map((s) => ({
      ...s,
      materialVersionId: s.roomFace === 'floor' ? 'floor' : 'wall',
      tile: {
        ...s.tile,
        groutWidth: 2,
        groutColor: s.roomFace === 'floor' ? '#6f6c66' : '#d9d8d2',
        pattern: 'grid',
        seed: 11,
      },
    })),
    fixtures: [
      fixture('toilet', 'toilet', 'floor', 0.72, 0.28, 400, 750, 680),
      basin,
      fixture('mirror', 'mirror', 'back', 0.28, 0.25, 700, 550, 30, 1300),
      fixture('bath', 'bath', 'floor', 0.3, 0.3, 750, 520, 1500),
    ],
    protection: empty(),
    color: { ...color },
  };
  return {
    room,
    assets,
    materials,
    scene,
    snapshot: { scene, beforeScene: structuredClone(scene), materials },
  };
}

/** Canvas + RGBA pixels of an exported image blob. */
export async function toImage(blob: Blob) {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return { canvas, data: ctx.getImageData(0, 0, canvas.width, canvas.height).data };
}
