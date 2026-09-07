import { describe, expect, it } from 'vitest';
import { refitWallsScene } from '../src/lib/refit-walls';
import { DEFAULT_COLOR, DEFAULT_TILE, EMPTY_MASK, type Scene, type Surface } from '../src/lib/types';

const wall = (id: string, x = 0, width = 1): Surface => ({
  id,
  name: id,
  kind: 'wall',
  quad: [
    { x, y: 0 },
    { x: x + width, y: 0 },
    { x: x + width, y: 1 },
    { x, y: 1 },
  ],
  mask: EMPTY_MASK(),
  calibrated: true,
  widthMm: 2300,
  heightMm: 2400,
  materialVersionId: 'cloud-v2',
  color: { ...DEFAULT_COLOR, warmth: 0.1 },
  tile: { ...DEFAULT_TILE, offsetX: 23, offsetY: -80, seed: 123 },
});
function scene(): Scene {
  return {
    originalAssetId: 'original',
    previewAssetId: 'preview',
    imageWidth: 1536,
    imageHeight: 1024,
    surfaces: [{ ...wall('floor'), kind: 'floor' }, wall('old-wall')],
    protection: {
      polygon: [
        { x: 0.1, y: 0.1 },
        { x: 0.2, y: 0.1 },
        { x: 0.2, y: 0.2 },
      ],
      strokes: [],
    },
    fixtures: [],
    color: { ...DEFAULT_COLOR },
  };
}

describe('벽 경계 재설정', () => {
  it('한 벽을 분리해도 자재 버전과 시공·색감을 유지하고 바닥/보호를 바꾸지 않는다', () => {
    const source = scene(),
      before = structuredClone(source);
    const next = refitWallsScene(source, [
      wall('left', 0, 0.25),
      wall('back', 0.25, 0.5),
      wall('right', 0.75, 0.25),
    ]);
    const walls = next.surfaces.filter((s) => s.kind === 'wall');
    expect(new Set(walls.map((s) => s.id)).size).toBe(3);
    expect(walls.map((s) => s.name)).toEqual(['left', 'back', 'right']);
    for (const w of walls) {
      expect(w.materialVersionId).toBe('cloud-v2');
      expect(w.tile).toEqual(before.surfaces[1].tile);
      expect(w.color).toEqual(before.surfaces[1].color);
      expect(w.calibrated).toBe(false);
    }
    expect(next.surfaces[0]).toEqual(before.surfaces[0]);
    expect(next.protection).toEqual(before.protection);
    expect(source).toEqual(before);
  });
  it('여러 벽의 서로 다른 자재는 가까운 면에 유지한다', () => {
    const source = scene();
    source.surfaces = [
      wall('left', 0, 0.3),
      { ...wall('right', 0.7, 0.3), materialVersionId: 'charcoal-v4' },
    ];
    const next = refitWallsScene(source, [wall('new-left', 0.02, 0.25), wall('new-right', 0.73, 0.25)]);
    expect(next.surfaces.map((s) => s.materialVersionId)).toEqual(['cloud-v2', 'charcoal-v4']);
    expect(next.surfaces.map((s) => s.id)).toEqual(['left', 'right']);
  });
  it('검출 실패는 원래 장면을 유지한다', () => {
    const source = scene(),
      before = structuredClone(source);
    expect(() => refitWallsScene(source, [])).toThrow('찾지 못했어요');
    expect(source).toEqual(before);
  });
});
