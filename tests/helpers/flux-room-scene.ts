/**
 * The FLUX comparison rooms, built in the page (bundled by esbuild; textures are drawn on canvases,
 * nothing is fetched). The default room like the 2026-09-27 user example: grey terrazzo walls, light
 * grey floor, a wall basin and a handheld shower on the left wall and a toilet at the back right
 * (standard models). "white" swaps the walls for white 300 × 600 tiles and the floor for grey
 * 600 × 600 (the stage-3 white room). `product` adds a wall cabinet drawn from product photos with
 * several angle photos, for the AI export's photo choice.
 *
 * The terrazzo room is the one tests/flux-input-in-room-browser.ts measured: same seeded texture,
 * same placements, so its in-room captures are pixel for pixel the 2026-09-27 inputs.
 */
import { renderRoomBackground } from '../../src/lib/room-background';
import { createRoomSurfaces, DEFAULT_ROOM } from '../../src/lib/room-geometry';
import { projectReconstructionFixture } from '../../src/lib/reconstruction/projection';
import { projectRoomFixture } from '../../src/lib/room-fixtures';
import type { AssetRecord, FixtureInstance, MaterialVersion, Scene } from '../../src/lib/types';
import type { RoomDimensions } from '../../src/lib/room-types';
import { FLUX_EYE_FOV, FLUX_EYE_HEIGHT_MM } from '../../src/lib/ai-export/view';
import {
  clampRoomEye,
  roomEyeView,
  type RoomEyePreset,
  type RoomViewState,
} from '../../src/lib/room-viewer/view-state';

export type FluxRoomOptions = { walls?: 'terrazzo' | 'white'; product?: boolean };

export async function buildFluxRoomScene(options: FluxRoomOptions = {}) {
  const walls = options.walls ?? 'terrazzo';
  const room = structuredClone(DEFAULT_ROOM);
  const color = { exposure: 0, contrast: 1, saturation: 1, warmth: 0 };
  const empty = () => ({ polygon: [], strokes: [] });
  const assets: Record<string, AssetRecord> = {};
  const blobOf = (canvas: HTMLCanvasElement) =>
    new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), 'image/png'));
  const addAsset = async (
    id: string,
    canvas: HTMLCanvasElement,
    kind: 'texture' | 'original' | 'product',
  ) => {
    const blob = await blobOf(canvas);
    assets[id] = {
      id,
      ownerId: 'test',
      name: id,
      mime: 'image/png',
      size: blob.size,
      width: canvas.width,
      height: canvas.height,
      kind,
      blob,
      createdAt: '2026-09-27',
    };
  };
  // Seeded speckles: grey terrazzo like the user example's walls (render mean near #8a8981).
  let seed = 20260927;
  const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const terrazzo = document.createElement('canvas');
  terrazzo.width = terrazzo.height = 256;
  const t = terrazzo.getContext('2d')!;
  t.fillStyle = '#76756d';
  t.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 900; i++) {
    t.fillStyle = random() < 0.7 ? '#dcd9cf' : '#b9b6ab';
    t.beginPath();
    t.ellipse(random() * 256, random() * 256, 1 + random() * 3, 0.8 + random() * 2, random() * 3, 0, 7);
    t.fill();
  }
  await addAsset('terrazzo', terrazzo, 'texture');
  const floor = document.createElement('canvas');
  floor.width = floor.height = 64;
  const f = floor.getContext('2d')!;
  f.fillStyle = '#bdbdb9';
  f.fillRect(0, 0, 64, 64);
  for (let i = 0; i < 300; i++) {
    f.fillStyle = random() < 0.5 ? '#c4c4c0' : '#b6b6b2';
    f.fillRect(random() * 64, random() * 64, 2, 2);
  }
  await addAsset('floor', floor, 'texture');
  const flat = async (id: string, fill: string) => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    const context = canvas.getContext('2d')!;
    context.fillStyle = fill;
    context.fillRect(0, 0, 64, 64);
    await addAsset(id, canvas, 'texture');
  };
  await flat('white', '#ecebe6');
  await flat('grey-floor', '#8e8b85');
  const imageWidth = 4096,
    imageHeight = 2731,
    aspect = imageWidth / imageHeight;
  const background = await renderRoomBackground(room, { width: imageWidth, height: imageHeight });
  const bgBitmap = await createImageBitmap(background.blob);
  const bg = document.createElement('canvas');
  bg.width = bgBitmap.width;
  bg.height = bgBitmap.height;
  bg.getContext('2d')!.drawImage(bgBitmap, 0, 0);
  await addAsset('bg', bg, 'original');
  const tile = (id: string, patch: Partial<MaterialVersion>): MaterialVersion => ({
    id,
    materialId: id,
    version: 1,
    name: id,
    brand: '',
    code: '',
    category: 'tile',
    scope: 'personal',
    description: '',
    color: '',
    finish: '무광',
    widthMm: 600,
    heightMm: 600,
    depthMm: 10,
    usage: 'both',
    installation: 'wall',
    textureAssetIds: [id],
    views: [],
    defaultGroutWidth: 2,
    defaultGroutColor: '#9a9890',
    defaultPattern: 'grid',
    createdAt: '2026-09-27',
    ...patch,
  });
  const materials: Record<string, MaterialVersion> = {
    terrazzo: tile('terrazzo', {}),
    floor: tile('floor', { installation: 'floor' }),
    white: tile('white', { widthMm: 300, heightMm: 600, color: '#ecebe6' }),
    'grey-floor': tile('grey-floor', { installation: 'floor', color: '#8e8b85' }),
    standard: tile('standard', { category: 'toilet', textureAssetIds: [] }),
  };
  const fixture = (
    id: string,
    face: 'floor' | 'left',
    u: number,
    v: number,
    reconstruction: NonNullable<FixtureInstance['reconstruction']>,
  ): FixtureInstance => ({
    id,
    name: id,
    materialVersionId: 'standard',
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
      face,
      u,
      v,
      scale: 1,
      widthMm: reconstruction.widthMm,
      heightMm: reconstruction.heightMm,
      imageAspect: reconstruction.widthMm / reconstruction.heightMm,
      contentBounds: { left: 0, right: 1, top: 0, bottom: 1 },
    },
    reconstruction,
  });
  const fixtures = [
    fixture('toilet', 'floor', 0.78, 0.28, {
      version: 2,
      kind: 'toilet',
      color: '#f2f1ec',
      widthMm: 400,
      heightMm: 750,
      depthMm: 680,
      baseHeightMm: 0,
      yawDegrees: 0,
    }),
    fixture('basin', 'left', 0.35, 0.62, {
      version: 2,
      kind: 'basin',
      color: '#f2f1ec',
      widthMm: 520,
      heightMm: 380,
      depthMm: 420,
      baseHeightMm: 780,
      yawDegrees: 0,
      basinVariant: 'wall',
    }),
    fixture('shower', 'left', 0.8, 0.3, {
      version: 2,
      kind: 'shower',
      color: '#c8ccd0',
      widthMm: 200,
      heightMm: 1100,
      depthMm: 120,
      baseHeightMm: 900,
      yawDegrees: 0,
      showerVariant: 'handheld-rail',
    }),
  ];
  for (const item of fixtures) projectReconstructionFixture(room, item, aspect);
  if (options.product) {
    // A cabinet photographed from the front, the right diagonal (same outline, a darker side
    // panel) and the right side (a narrow outline that would change the footprint).
    const photo = async (id: string, draw: (c: CanvasRenderingContext2D) => void, width = 200) => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = 300;
      draw(canvas.getContext('2d')!);
      await addAsset(id, canvas, 'product');
    };
    await photo('cabinet-front', (c) => {
      c.fillStyle = '#b38a5a';
      c.fillRect(0, 0, 200, 300);
    });
    await photo('cabinet-diagonal', (c) => {
      c.fillStyle = '#b38a5a';
      c.fillRect(0, 0, 150, 300);
      c.fillStyle = '#6f4f2c';
      c.fillRect(150, 0, 50, 300);
    });
    await photo(
      'cabinet-side',
      (c) => {
        c.fillStyle = '#6f4f2c';
        c.fillRect(0, 0, 90, 300);
      },
      90,
    );
    materials.cabinet = tile('cabinet', {
      category: 'wallCabinet',
      installation: 'wall',
      widthMm: 400,
      heightMm: 600,
      depthMm: 200,
      textureAssetIds: [],
      views: [
        { assetId: 'cabinet-front', direction: '정면', anchor: { x: 0.5, y: 1 } },
        { assetId: 'cabinet-diagonal', direction: '오른쪽 사선', anchor: { x: 0.5, y: 1 } },
        { assetId: 'cabinet-side', direction: '오른쪽 측면', anchor: { x: 0.5, y: 1 } },
      ],
    });
    const cabinet: FixtureInstance = {
      ...fixture('cabinet', 'floor', 0, 0, {
        version: 2,
        kind: 'wallCabinet',
        color: '#b38a5a',
        widthMm: 400,
        heightMm: 600,
        depthMm: 200,
        baseHeightMm: 0,
        yawDegrees: 0,
      }),
      materialVersionId: 'cabinet',
      reconstruction: undefined,
      roomPlacement: {
        face: 'back',
        u: 0.45,
        v: 0.35,
        scale: 1,
        widthMm: 400,
        heightMm: 600,
        imageAspect: 200 / 300,
        contentBounds: { left: 0, right: 1, top: 0, bottom: 1 },
      },
    };
    projectRoomFixture(room, cabinet, aspect);
    fixtures.push(cabinet);
  }
  const makeScene = (): Scene => ({
    room: structuredClone(room),
    originalAssetId: 'bg',
    previewAssetId: 'bg',
    imageWidth,
    imageHeight,
    surfaces: createRoomSurfaces(room, aspect).map((s) => ({
      ...s,
      materialVersionId:
        walls === 'white'
          ? s.roomFace === 'floor'
            ? 'grey-floor'
            : 'white'
          : s.roomFace === 'floor'
            ? 'floor'
            : 'terrazzo',
      tile: {
        ...s.tile,
        groutWidth: walls === 'white' ? 2 : 1.5,
        groutColor:
          walls === 'white'
            ? s.roomFace === 'floor'
              ? '#6f6c66'
              : '#d9d8d2'
            : s.roomFace === 'floor'
              ? '#a9a9a4'
              : '#9a9890',
        pattern: 'grid',
        seed: 7,
      },
    })),
    fixtures: structuredClone(fixtures),
    protection: empty(),
    color: { ...color },
  });
  const snapshot = { scene: makeScene(), beforeScene: makeScene(), materials };
  return { room, assets, materials, snapshot, imageWidth, imageHeight, aspect };
}

/**
 * The AI input's old fixed viewpoints (until 2026-09-28): a room-eye preset's place and heading at
 * 1200 mm with a 90° lens and no shift. Kept here so the 2026-09-27/28 comparison inputs can be
 * rebuilt pixel for pixel; the app now turns one front-centre eye freely (src/lib/ai-export/view.ts).
 */
export function presetFluxView(room: RoomDimensions, preset: RoomEyePreset): RoomViewState {
  const view = roomEyeView(room, preset);
  const eye = view.eye!;
  return {
    ...view,
    eye: clampRoomEye(room, {
      position: [eye.position[0], FLUX_EYE_HEIGHT_MM, eye.position[2]],
      yaw: eye.yaw,
      shift: 0,
      fov: FLUX_EYE_FOV,
    }),
  };
}
