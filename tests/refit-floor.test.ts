import { describe, expect, it } from 'vitest';
import { refineFloorProtection, refitFloorScene } from '../src/lib/refit-floor';
import { maskContains } from '../src/lib/render/mask';
import { DEFAULT_COLOR, DEFAULT_TILE, EMPTY_MASK, type Scene, type Surface } from '../src/lib/types';

const square = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
] as Surface['quad'];
const floor = (id: string): Surface => ({
  id,
  name: id,
  kind: 'floor',
  mask: { polygon: square, strokes: [] },
  quad: square,
  widthMm: 2500,
  heightMm: 1800,
  calibrated: true,
  materialVersionId: 'immutable-tile-v3',
  tile: { ...DEFAULT_TILE, offsetX: 57, seed: 481 },
  color: { ...DEFAULT_COLOR, warmth: 0.12 },
});
const segmentation = { width: 8, height: 8, wall: new Uint8Array(64), floor: new Uint8Array(64).fill(255) };
const scene = (): Scene => ({
  originalAssetId: 'original',
  previewAssetId: 'preview',
  imageWidth: 800,
  imageHeight: 800,
  surfaces: [floor('floor-1'), { ...floor('wall-1'), kind: 'wall' }],
  fixtures: [],
  protection: EMPTY_MASK(),
  color: { ...DEFAULT_COLOR },
});

describe('명시적 바닥 경계 재설정', () => {
  it('자재 버전·실측값·시공·색감과 벽을 보존하고 원근은 추정으로 바꾼다', () => {
    const source = scene(),
      before = structuredClone(source),
      detected = floor('detected');
    detected.quad = square.map((p) => ({ x: p.x * 0.8, y: p.y })) as Surface['quad'];
    const next = refitFloorScene(source, [detected], segmentation, false);
    const after = next.surfaces.find((s) => s.kind === 'floor')!;
    expect(after).toEqual({ ...before.surfaces[0], quad: detected.quad, calibrated: false });
    expect(next.surfaces.find((s) => s.kind === 'wall')).toEqual(before.surfaces[1]);
    expect(next.protection).toEqual(before.protection);
    expect(source).toEqual(before);
  });

  it('보호 다듬기는 확인된 바닥 내부만 제거하고 물체와 한 픽셀 경계를 보존한다', () => {
    const detected = { ...segmentation, floor: segmentation.floor.slice() };
    detected.floor[3 * 8 + 3] = 0;
    const protection = { polygon: square, strokes: [] };
    const result = refineFloorProtection(protection, detected);
    const contains = (x: number, y: number) => maskContains(result, { x: (x + 0.5) / 8, y: (y + 0.5) / 8 });
    expect(contains(3, 3)).toBe(true); // body
    expect(contains(3, 4)).toBe(true); // one-pixel safety boundary
    expect(contains(0, 6)).toBe(true); // image boundary
    expect(contains(6, 6)).toBe(false); // confirmed floor interior
  });

  it('검출 실패는 원래 장면을 유지하며 보호 다듬기를 기본으로 하지 않는다', () => {
    const source = scene(),
      before = structuredClone(source);
    expect(() => refitFloorScene(source, [], segmentation, true)).toThrow('찾지 못했어요');
    expect(source).toEqual(before);
    source.protection = { polygon: square, strokes: [] };
    expect(refitFloorScene(source, [floor('new')], segmentation, false).protection).toEqual(
      source.protection,
    );
  });
});
