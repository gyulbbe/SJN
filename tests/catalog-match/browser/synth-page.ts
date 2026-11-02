/**
 * Synthetic test rooms for the catalog-match trial: a room drawn by the app's own 3D renderer with
 * known catalog tiles on its walls and floor, seen from inside like a photo, then given the photo's
 * troubles (a light cast and exposure, darker corners, standard-model products in front, a small
 * size, JPEG). The face regions come from the renderer itself (`faceToFrame`), so the answer and its
 * place are exact. Bundled with page.ts into `window.CM`.
 */
import {
  placementToMaterialVersion,
  type PublicPlacement,
} from '../../../src/lib/catalog/placement-contract';
import { projectReconstructionFixture } from '../../../src/lib/reconstruction/projection';
import { renderRoomBackground } from '../../../src/lib/room-background';
import { createRoomSurfaces } from '../../../src/lib/room-geometry';
import type { RoomFace } from '../../../src/lib/room-types';
import { RoomViewerRenderer } from '../../../src/lib/room-viewer/renderer';
import { fluxOrbitView } from '../../../src/lib/ai-export/view';
import { clampRoomEye, roomEyeView, type RoomEyePreset } from '../../../src/lib/room-viewer/view-state';
import type { AssetRecord, FixtureInstance, MaterialVersion, Scene } from '../../../src/lib/types';
import { canvasBlob, canvasOf, fileUrl } from './page';

export * from './page';

export type SynthSpec = {
  id: string;
  room: { widthMm: number; depthMm: number; heightMm: number };
  tiles: Partial<Record<RoomFace, { placement: PublicPlacement; path: string }>>;
  fixtures: boolean;
  /** Inside like a photo (the walls; the floor is barely in frame), or from above outside (the floor). */
  preset: RoomEyePreset | 'orbit';
  orbit?: { azimuth: number; elevation: number };
  eyeHeightMm?: number;
  /** The lens shift (−0.3…0.3); the preset's −0.2 when absent. */
  shift?: number;
  light: { ev: number; gains: [number, number, number]; vignette: number };
  longEdge: number;
};
export type SynthFace = {
  face: RoomFace;
  materialId: string;
  /** The face's largest in-frame u-v rectangle with and without the products in front. */
  visible?: { uv: [number, number, number, number]; quad: { x: number; y: number }[] };
  clean?: { uv: [number, number, number, number]; quad: { x: number; y: number }[] };
};

const GRID = 12;
type Cell = { x: number; y: number } | null;

function largest(free: (i: number, j: number) => boolean) {
  const heights = new Array(GRID).fill(0);
  let best: [number, number, number, number] | undefined,
    bestArea = 0;
  for (let j = 0; j < GRID; j++) {
    for (let i = 0; i < GRID; i++) heights[i] = free(i, j) ? heights[i] + 1 : 0;
    for (let i = 0; i < GRID; i++) {
      let h = Infinity;
      for (let k = i; k < GRID; k++) {
        h = Math.min(h, heights[k]);
        if (!h) break;
        if (h * (k - i + 1) > bestArea) {
          bestArea = h * (k - i + 1);
          best = [i, j + 1 - h, k + 1, j + 1];
        }
      }
    }
  }
  return best;
}

export async function renderSynth(
  spec: SynthSpec,
): Promise<{ faces: SynthFace[]; width: number; height: number; boxes: [number, number, number, number][] }> {
  const { room } = spec;
  const definition = { kind: 'parametric' as const, version: 1 as const, ...room };
  const assets: Record<string, AssetRecord> = {};
  const materials: Record<string, MaterialVersion> = {};
  for (const tile of Object.values(spec.tiles)) {
    if (!tile || materials[tile.placement.versionId]) continue;
    const blob = await (await fetch(fileUrl(tile.path))).blob();
    const bitmap = await createImageBitmap(blob);
    const assetId = tile.placement.textureAssetIds[0];
    assets[assetId] = {
      id: assetId,
      ownerId: 'catalog',
      name: assetId,
      mime: blob.type || 'image/jpeg',
      size: blob.size,
      width: bitmap.width,
      height: bitmap.height,
      kind: 'texture',
      blob,
      createdAt: '2026-11-02',
    } as AssetRecord;
    bitmap.close();
    materials[tile.placement.versionId] = placementToMaterialVersion(tile.placement);
  }
  const imageWidth = 1600,
    imageHeight = 1200,
    aspect = imageWidth / imageHeight;
  const background = await renderRoomBackground(definition, { width: imageWidth, height: imageHeight });
  const bg = await createImageBitmap(background.blob);
  assets.bg = {
    id: 'bg',
    ownerId: 'test',
    name: 'bg',
    mime: 'image/png',
    size: background.blob.size,
    width: bg.width,
    height: bg.height,
    kind: 'original',
    blob: background.blob,
    createdAt: '2026-11-02',
  } as AssetRecord;
  bg.close();
  materials.standard = {
    ...placementToMaterialVersion(Object.values(spec.tiles)[0]!.placement),
    id: 'standard',
    materialId: 'standard',
    category: 'toilet',
    textureAssetIds: [],
    views: [],
  };
  const color = { exposure: 0, contrast: 1, saturation: 1, warmth: 0 };
  const empty = () => ({ polygon: [], strokes: [] });
  const fixture = (
    id: string,
    face: RoomFace,
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
  const fixtures: FixtureInstance[] = spec.fixtures
    ? [
        fixture('toilet', 'floor', 0.68, 0.22, {
          version: 2,
          kind: 'toilet',
          color: '#f2f1ec',
          widthMm: 400,
          heightMm: 750,
          depthMm: 680,
          baseHeightMm: 0,
          yawDegrees: 0,
        }),
        fixture('basin', 'left', 0.45, 0.62, {
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
      ]
    : [];
  for (const item of fixtures) projectReconstructionFixture(definition, item, aspect);
  const scene: Scene = {
    room: structuredClone(definition),
    originalAssetId: 'bg',
    previewAssetId: 'bg',
    imageWidth,
    imageHeight,
    surfaces: createRoomSurfaces(definition, aspect).map((surface) => {
      const tile = surface.roomFace ? spec.tiles[surface.roomFace] : undefined;
      if (!tile) return surface;
      return {
        ...surface,
        materialVersionId: tile.placement.versionId,
        tile: {
          ...surface.tile,
          groutWidth: tile.placement.defaultGroutWidth,
          groutColor: tile.placement.defaultGroutColor,
          pattern: tile.placement.defaultPattern,
          seed: 7,
        },
      };
    }),
    fixtures,
    protection: empty(),
    color: { ...color },
  } as Scene;
  const snapshot = { scene, beforeScene: structuredClone(scene), materials };
  const viewer = new RoomViewerRenderer();
  try {
    await viewer.setSnapshot(snapshot as never, async (id: string) => assets[id], { background: '#dcdad5' });
    let view =
      spec.preset === 'orbit'
        ? fluxOrbitView(spec.orbit ?? { azimuth: 0, elevation: 30 })
        : roomEyeView(definition, spec.preset);
    if (spec.preset !== 'orbit' && (spec.eyeHeightMm || spec.shift !== undefined))
      view = {
        ...view,
        eye: clampRoomEye(definition, {
          ...view.eye!,
          position: [view.eye!.position[0], spec.eyeHeightMm ?? view.eye!.position[1], view.eye!.position[2]],
          shift: spec.shift ?? view.eye!.shift,
        }),
      };
    const W = 1024,
      H = 768;
    const frame = viewer.render(W, H, view, 'after');
    const copy = canvasOf(W, H);
    copy.getContext('2d')!.drawImage(frame, 0, 0, W, H);
    const boxes = Object.values(viewer.fixtureBounds(W, H, view));
    const inBox = (p: { x: number; y: number }) =>
      boxes.some(([l, t, r, b]) => p.x > l && p.x < r && p.y > t && p.y < b);
    const faces: SynthFace[] = [];
    for (const face of ['back', 'left', 'right', 'floor'] as RoomFace[]) {
      const tile = spec.tiles[face];
      if (!tile) continue;
      const grid: Cell[][] = [];
      for (let i = 0; i <= GRID; i++) {
        grid.push([]);
        for (let j = 0; j <= GRID; j++) {
          const p = viewer.faceToFrame(face, i / GRID, j / GRID);
          grid[i].push(p && p.x >= 0.005 && p.x <= 0.995 && p.y >= 0.005 && p.y <= 0.995 ? p : null);
        }
      }
      const corners = (i: number, j: number) => [
        grid[i][j],
        grid[i + 1][j],
        grid[i + 1][j + 1],
        grid[i][j + 1],
      ];
      const centre = (i: number, j: number) => viewer.faceToFrame(face, (i + 0.5) / GRID, (j + 0.5) / GRID);
      const pick = (rect?: [number, number, number, number]) =>
        rect && {
          uv: rect.map((value) => value / GRID) as [number, number, number, number],
          quad: [
            grid[rect[0]][rect[1]]!,
            grid[rect[2]][rect[1]]!,
            grid[rect[2]][rect[3]]!,
            grid[rect[0]][rect[3]]!,
          ],
        };
      const visible = largest((i, j) => corners(i, j).every(Boolean));
      const clean = largest((i, j) => {
        const c = centre(i, j);
        return corners(i, j).every((p) => p && !inBox(p)) && !!c && !inBox(c);
      });
      faces.push({ face, materialId: tile.placement.materialId, visible: pick(visible), clean: pick(clean) });
    }
    // The photo's troubles, in linear light: exposure and a colour cast, darker corners.
    const context = copy.getContext('2d', { willReadFrequently: true })!;
    const image = context.getImageData(0, 0, W, H);
    const lut = Float32Array.from({ length: 256 }, (_, i) => {
      const v = i / 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    const scale = 2 ** spec.light.ev;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const r2 = ((x / W - 0.5) ** 2 + (y / H - 0.5) ** 2) / 0.5;
        const fall = 1 - spec.light.vignette * r2;
        const i = (y * W + x) * 4;
        for (let c = 0; c < 3; c++) {
          const v = Math.min(1, lut[image.data[i + c]] * spec.light.gains[c] * scale * fall);
          image.data[i + c] = 255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
        }
      }
    context.putImageData(image, 0, 0);
    const factor = Math.min(1, spec.longEdge / W);
    const out = canvasOf(W * factor, H * factor);
    const outContext = out.getContext('2d')!;
    outContext.imageSmoothingQuality = 'high';
    outContext.drawImage(copy, 0, 0, out.width, out.height);
    const blob = await canvasBlob(out, 'image/jpeg', 0.85);
    await fetch(`${location.origin}/out?path=${encodeURIComponent(`synth/images/${spec.id}.jpg`)}`, {
      method: 'POST',
      body: blob,
    });
    return { faces, width: out.width, height: out.height, boxes };
  } finally {
    viewer.dispose();
  }
}
