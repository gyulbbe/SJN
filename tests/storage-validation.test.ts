import { describe, expect, it } from 'vitest';
import {
  legacyProjectSchema as projectSchema,
  assetMetadataSchema,
  materialInputSchema,
} from '../src/lib/supabase/validation';
import { DEFAULT_COLOR, DEFAULT_TILE, EMPTY_MASK, type LegacyProjectDocument } from '../src/lib/types';

function document(): LegacyProjectDocument {
  return {
    id: crypto.randomUUID(),
    ownerId: 'local',
    name: '클라우드 형식 검사',
    schemaVersion: 1,
    editRevision: 1,
    storageRevision: 1,
    createdAt: '2026-09-05T01:00:00+00:00',
    updatedAt: '2026-09-05T01:00:00.000Z',
    viewport: { zoom: 1, pan: { x: 0, y: 0 } },
    history: { past: [], future: [] },
    scene: {
      originalAssetId: crypto.randomUUID(),
      previewAssetId: crypto.randomUUID(),
      imageWidth: 1920,
      imageHeight: 1080,
      color: { ...DEFAULT_COLOR },
      protection: EMPTY_MASK(),
      surfaces: [
        {
          id: crypto.randomUUID(),
          name: '벽',
          kind: 'wall',
          mask: EMPTY_MASK(),
          quad: [
            { x: 0, y: 0 },
            { x: 1, y: 0 },
            { x: 1, y: 1 },
            { x: 0, y: 1 },
          ],
          widthMm: 3000,
          heightMm: 2000,
          calibrated: false,
          tile: { ...DEFAULT_TILE },
          color: { ...DEFAULT_COLOR },
        },
      ],
      fixtures: [
        {
          id: crypto.randomUUID(),
          name: '세면대',
          materialVersionId: crypto.randomUUID(),
          viewIndex: 0,
          position: { x: 0.5, y: 0.8 },
          width: 0.2,
          height: 0.3,
          rotation: 0,
          anchor: { x: 0.5, y: 1 },
          locked: false,
          shadow: { x: 0, y: 0, opacity: 0.2, blur: 0.01, scale: 1 },
          occlusion: EMPTY_MASK(),
          color: { ...DEFAULT_COLOR },
        },
      ],
    },
  };
}

describe('cloud input boundaries (without a live Supabase connection)', () => {
  it('retains exact detection contour holes through scenes and undo history', () => {
    const base = document();
    const hole = [
      { x: 0.3, y: 0.4 },
      { x: 0.5, y: 0.4 },
      { x: 0.5, y: 0.8 },
      { x: 0.3, y: 0.8 },
    ];
    const scene = {
      ...base.scene,
      surfaces: base.scene.surfaces.map((surface) => ({
        ...surface,
        mask: { polygon: surface.quad, holes: [hole], strokes: [] },
      })),
    };
    const result = projectSchema.parse({ ...base, scene, history: { past: [scene], future: [] } });
    expect(result.scene.surfaces[0].mask.holes).toEqual([hole]);
    expect(result.history.past[0].surfaces[0].mask.holes).toEqual([hole]);
  });
  it('accepts detailed detection contours but bounds total contour and hole vertices', () => {
    const base = document();
    const contour = Array.from({ length: 8192 }, (_, i) => ({
      x: (i % 512) / 512,
      y: Math.floor(i / 512) / 512,
    }));
    const withMask = (count: number) => ({
      ...base,
      scene: {
        ...base.scene,
        protection: {
          polygon: [],
          polygons: Array.from({ length: count }, () => contour),
          holes: [],
          strokes: [],
        },
      },
    });
    expect(projectSchema.safeParse(withMask(4)).success).toBe(true);
    expect(projectSchema.safeParse(withMask(5)).success).toBe(false);
    const invalidHole = {
      ...base,
      scene: {
        ...base.scene,
        protection: {
          ...base.scene.protection,
          holes: [
            [
              { x: -0.1, y: 0 },
              { x: 0.2, y: 0.1 },
              { x: 0.3, y: 0.2 },
            ],
          ],
        },
      },
    };
    expect(projectSchema.safeParse(invalidHole).success).toBe(false);
  });
  it('preserves multiple protection polygons and accepts PostgreSQL timezone timestamps', () => {
    const value = document();
    value.scene.protection.polygons = [
      [
        { x: 0.1, y: 0.2 },
        { x: 0.2, y: 0.2 },
        { x: 0.2, y: 0.4 },
      ],
      [
        { x: 0.7, y: 0.2 },
        { x: 0.8, y: 0.2 },
        { x: 0.8, y: 0.4 },
      ],
    ];
    value.history.past = [structuredClone(value.scene)];
    const result = projectSchema.parse(value);
    expect(result.scene.protection.polygons).toEqual(value.scene.protection.polygons);
    expect(result.history.past[0].protection.polygons).toHaveLength(2);
  });
  it.each(['crossed', 'collapsed', 'concave'] as const)('rejects %s perspective quads', (mode) => {
    const value = document();
    const q = value.scene.surfaces[0].quad;
    if (mode === 'crossed') [q[1], q[2]] = [q[2], q[1]];
    if (mode === 'collapsed') q[1] = { ...q[0] };
    if (mode === 'concave') q[2] = { x: 0.1, y: 0.1 };
    expect(projectSchema.safeParse(value).success).toBe(false);
  });
  it.each([-1, 0.5, 100, Number.MAX_SAFE_INTEGER, Infinity, NaN])(
    'rejects invalid view index %s',
    (viewIndex) => {
      const value = document();
      value.scene.fixtures[0].viewIndex = viewIndex;
      expect(projectSchema.safeParse(value).success).toBe(false);
    },
  );
  it('rejects unsafe geometry, image sizes, zoom, and oversized undo history', () => {
    const oversized = document();
    oversized.scene.imageWidth = oversized.scene.imageHeight = 10000;
    expect(projectSchema.safeParse(oversized).success).toBe(false);
    const unbounded = document();
    unbounded.scene.fixtures[0].position.x = 1e20;
    expect(projectSchema.safeParse(unbounded).success).toBe(false);
    const zoom = document();
    zoom.viewport.zoom = 0;
    expect(projectSchema.safeParse(zoom).success).toBe(false);
    const history = document();
    history.history.past = Array.from({ length: 51 }, () => structuredClone(history.scene));
    expect(projectSchema.safeParse(history).success).toBe(false);
    const stroke = document();
    stroke.scene.protection.strokes.push({ points: [{ x: 0.5, y: 0.5 }], radius: Infinity, erase: false });
    expect(projectSchema.safeParse(stroke).success).toBe(false);
  });
  it('strips client-supplied ownership and dimensions from upload metadata', () => {
    const result = assetMetadataSchema.parse({
      id: crypto.randomUUID(),
      name: 'a.png',
      kind: 'original',
      ownerId: 'another-user',
      width: 1,
      height: 1,
      size: 1,
    });
    expect(result).not.toHaveProperty('ownerId');
    expect(result).not.toHaveProperty('size');
    expect(result).not.toHaveProperty('width');
  });
  it('rejects material anchors outside the product image', () => {
    const id = crypto.randomUUID();
    const input = {
      name: '세면대',
      brand: '',
      code: '',
      category: 'basin',
      scope: 'personal',
      description: '',
      color: '',
      finish: '',
      widthMm: 500,
      heightMm: 700,
      depthMm: 300,
      usage: 'both',
      installation: 'wall',
      coverAssetId: id,
      imageAssetIds: [id],
      textureAssetIds: [],
      views: [{ assetId: id, direction: '정면', anchor: { x: 0.5, y: 5 } }],
      defaultGroutWidth: 0,
      defaultGroutColor: '#000000',
      defaultPattern: 'grid',
    };
    expect(materialInputSchema.safeParse(input).success).toBe(false);
  });
});
