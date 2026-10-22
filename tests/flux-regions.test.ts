import { describe, expect, it } from 'vitest';
import { fluxInputLayout } from '../src/lib/ai-export/contract';
import { buildFluxGrounding, type Box } from '../src/lib/ai-export/scene';
import { buildFluxPrompt } from '../src/lib/ai-export/prompt';
import { fluxSceneSchema, type FluxScene } from '../src/lib/ai-export/scene-contract';
import { fluxResultNotices, readFluxCheck } from '../src/lib/ai-export/notices';
import { DEFAULT_ROOM, createRoomSurfaces } from '../src/lib/room-geometry';
import { createRegionSurface } from '../src/lib/room-surface-regions';
import { DEFAULT_COLOR, EMPTY_MASK, type MaterialVersion, type Scene } from '../src/lib/types';

const tile = (id: string, color: string, finish = ''): MaterialVersion => ({
  id,
  materialId: id,
  version: 1,
  name: id,
  brand: '',
  code: '',
  category: 'tile',
  scope: 'personal',
  description: '',
  color,
  finish,
  widthMm: 300,
  heightMm: 600,
  depthMm: 8,
  usage: 'both',
  installation: 'wall',
  // No readable texture here: the material colour is what the text names.
  textureAssetIds: ['missing-' + id],
  views: [],
  defaultGroutWidth: 2,
  defaultGroutColor: '#ffffff',
  defaultPattern: 'grid',
  createdAt: '2026-10-22',
});
const materials: Record<string, MaterialVersion> = {
  base: tile('base', '#c9c2b4'),
  accent: tile('accent', '#1d3557', 'glossy'),
};
function scene(): Scene {
  return {
    room: { ...DEFAULT_ROOM },
    originalAssetId: 'o',
    previewAssetId: 'p',
    imageWidth: 1200,
    imageHeight: 800,
    surfaces: createRoomSurfaces(DEFAULT_ROOM, 1.5).map((s) => ({
      ...s,
      materialVersionId: 'base',
      tile: { ...s.tile, groutWidth: 2, groutColor: '#ffffff' },
    })),
    fixtures: [],
    protection: EMPTY_MASK(),
    color: { ...DEFAULT_COLOR },
  };
}
const ground = (value: Scene, surfaceBoxes: Record<string, Box>) =>
  buildFluxGrounding({
    snapshot: { scene: value, materials },
    reader: async () => undefined,
    capture: {} as ImageBitmap,
    layout: fluxInputLayout(1200, 800),
    surfaceBoxes,
  });

describe('regions in the AI conversion', () => {
  it('sends each tiled region on its own after the faces, with where it is in image 0', async () => {
    const value = scene();
    const accent = createRegionSurface(value, 'back', {
      leftMm: 600,
      topMm: 900,
      widthMm: 900,
      heightMm: 600,
    });
    accent.materialVersionId = 'accent';
    // A region with its face's own tile adds nothing; one not seen in the frame cannot be placed.
    const same = createRegionSurface(value, 'floor', { leftMm: 0, topMm: 0, widthMm: 900, heightMm: 900 });
    same.materialVersionId = 'base';
    same.tile = { ...value.surfaces[0].tile };
    const hidden = createRegionSurface(value, 'left', { leftMm: 0, topMm: 0, widthMm: 900, heightMm: 900 });
    hidden.materialVersionId = 'accent';
    value.surfaces.push(accent, same, hidden);
    const { scene: sent } = await ground(value, {
      [accent.id]: [0.4, 0.3, 0.6, 0.55],
      [same.id]: [0.2, 0.8, 0.4, 0.9],
    });
    expect(fluxSceneSchema.safeParse(sent).success).toBe(true);
    expect(sent.surfaces.map((s) => [s.faces, s.color, s.box])).toEqual([
      [['floor', 'left', 'back', 'right'], '#c9c2b4', undefined],
      [['back'], '#1d3557', expect.any(Array)],
    ]);
    const layout = fluxInputLayout(1200, 800);
    const box = sent.surfaces[1].box!;
    expect(box[0]).toBeCloseTo((layout.x + 0.4 * layout.contentWidth) / layout.width, 9);
    expect(box[3]).toBeCloseTo((layout.y + 0.55 * layout.contentHeight) / layout.height, 9);
  });
  it('keeps the faces first and the largest regions while there is room for eight surfaces', async () => {
    const value = scene();
    const boxes: Record<string, Box> = {};
    for (let i = 0; i < 9; i++) {
      const region = createRegionSurface(value, 'back', {
        leftMm: (i % 4) * 600,
        topMm: Math.floor(i / 4) * 600,
        widthMm: 600,
        heightMm: 600,
      });
      const id = 'r' + i;
      materials[id] = tile(id, `#${(0x102030 + i * 0x0a0a0a).toString(16)}`);
      region.materialVersionId = id;
      value.surfaces.push(region);
      boxes[region.id] = [0.1 * (i % 4), 0.1, 0.1 * (i % 4) + 0.02 + i * 0.005, 0.2];
    }
    const { scene: sent } = await ground(value, boxes);
    expect(sent.surfaces).toHaveLength(8);
    expect(sent.surfaces[0].box).toBeUndefined();
    const widths = sent.surfaces.slice(1).map((s) => s.box![2] - s.box![0]);
    expect(widths).toEqual([...widths].sort((a, b) => b - a));
    expect(sent.surfaces.slice(1).map((s) => s.color)).not.toContain('#102030');
  });
  it('says a region as a rectangle of its face, the rest of the face keeping its tiles', () => {
    const scene: FluxScene = {
      version: 1,
      fixtures: [],
      surfaces: [
        {
          faces: ['back'],
          color: '#1d3557',
          tileMm: [300, 600],
          pattern: 'grid',
          groutColor: '#ffffff',
          groutMm: 2,
          finish: 'glossy',
          box: [0.404, 0.3, 0.6, 0.551],
        },
      ],
    };
    const text = buildFluxPrompt(scene);
    expect(text).toContain(
      'On the back wall, the rectangular area at x 40–60%, y 30–55% of image 0 has dark blue (#1d3557) glossy tiles, 300 × 600 mm, grid layout, white (#ffffff) grout 2 mm; the rest of the back wall keeps its own tiles.',
    );
    expect(buildFluxPrompt(scene)).toBe(text);
    expect(
      fluxSceneSchema.safeParse({ ...scene, surfaces: [{ ...scene.surfaces[0], faces: ['back', 'left'] }] })
        .success,
    ).toBe(false);
    expect(
      fluxSceneSchema.safeParse({ ...scene, surfaces: [{ ...scene.surfaces[0], box: ['x', 0, 1, 1] }] })
        .success,
    ).toBe(false);
  });
  it('does not warn about another tile layout on a wall that has a region', () => {
    const reading = readFluxCheck(
      {
        fixtures: [],
        extras: [],
        walls: [
          { face: 'back', uniformTiles: 'no' },
          { face: 'left', uniformTiles: 'no' },
        ],
      },
      [],
    );
    const shown = (regionWalls?: string[]) =>
      fluxResultNotices({
        products: [],
        check: { status: 'done', reading },
        corrected: true,
        showTiles: true,
        regionWalls,
      }).warnings.flatMap((w) => w.lines);
    expect(shown()).toEqual(['뒷벽·왼쪽 벽 타일 배열이 원본과 달라 보여요.']);
    expect(shown(['back'])).toEqual(['왼쪽 벽 타일 배열이 원본과 달라 보여요.']);
  });
});
