import { describe, expect, it } from 'vitest';
import { DEFAULT_ROOM, createRoomSurfaces } from '../src/lib/room-geometry';
import { applyRoomSurfaceBand } from '../src/lib/room-surface-bands';
import { normalizeRoomScene, resizedRoomScene, roomResetWarnings } from '../src/lib/room-editing';
import { roomAreaForSurfaces } from '../src/lib/quote';
import { homography, transformPoint } from '../src/lib/render/math';
import { reconstructionBandSchema, fixtureReconstructionSchema } from '../src/lib/supabase/validation';
import { DEFAULT_COLOR, EMPTY_MASK, type Scene } from '../src/lib/types';

function scene(): Scene {
  const surfaces = createRoomSurfaces(DEFAULT_ROOM);
  const back = surfaces.find((s) => s.roomFace === 'back')!;
  const upper = applyRoomSurfaceBand(
    { ...back, id: 'upper', materialVersionId: 'paint' },
    { from: 0, to: 0.45 },
  );
  const lower = applyRoomSurfaceBand(
    { ...back, id: 'lower', materialVersionId: 'tile' },
    { from: 0.45, to: 1 },
  );
  return {
    room: { ...DEFAULT_ROOM },
    originalAssetId: 'original',
    previewAssetId: 'preview',
    imageWidth: 1500,
    imageHeight: 1000,
    surfaces: [...surfaces.filter((s) => s.roomFace !== 'back'), upper, lower],
    fixtures: [],
    protection: EMPTY_MASK(),
    color: { ...DEFAULT_COLOR },
  };
}
describe('reconstructed wall height bands', () => {
  it('keeps a common mm grid while clipping each material exactly at a shared boundary', () => {
    const value = scene(),
      upper = value.surfaces.find((s) => s.id === 'upper')!,
      lower = value.surfaces.find((s) => s.id === 'lower')!;
    expect(upper.quad).toEqual(lower.quad);
    expect(upper.heightMm).toBe(2400);
    expect(lower.mask.polygon[0]).toEqual(upper.mask.polygon[3]);
    expect(lower.mask.polygon[1]).toEqual(upper.mask.polygon[2]);
    const uv = lower.mask.polygon.map((p) => transformPoint(homography(lower.quad), p));
    expect(uv[0].y).toBeCloseTo(0.45, 10);
    expect(uv[2].y).toBeCloseTo(1, 10);
  });
  it('preserves both materials and their height proportions on room resize without duplicate-face warnings', () => {
    const old = scene();
    expect(roomResetWarnings(old)).toEqual([]);
    const resized = resizedRoomScene(
      old,
      { ...DEFAULT_ROOM, widthMm: 3600, heightMm: 3000 },
      { originalAssetId: 'new', previewAssetId: 'new-preview', imageWidth: 1500, imageHeight: 1000 },
    );
    const walls = resized.surfaces.filter((s) => s.roomFace === 'back');
    expect(walls.map((s) => s.id)).toEqual(['upper', 'lower']);
    expect(walls.map((s) => s.materialVersionId)).toEqual(['paint', 'tile']);
    expect(walls.map((s) => s.reconstructionBand)).toEqual([
      { from: 0, to: 0.45 },
      { from: 0.45, to: 1 },
    ]);
    expect(walls.map((s) => s.heightMm)).toEqual([3000, 3000]);
    expect(roomAreaForSurfaces(resized, ['lower'])).toBe(5.94);
    expect(roomAreaForSurfaces(resized, ['upper', 'lower'])).toBe(10.8);
  });
  it('retains manual edits until explicit room restore and rejects overlapping quote intervals', () => {
    const old = scene(),
      next = structuredClone(old),
      lower = next.surfaces.find((s) => s.id === 'lower')!;
    lower.mask.polygon[0].y += 0.01;
    normalizeRoomScene(old, next);
    expect(lower.geometryMode).toBe('manual');
    const dup = structuredClone(old.surfaces.find((s) => s.id === 'lower')!);
    dup.id = 'duplicate';
    old.surfaces.push(dup);
    expect(roomAreaForSurfaces(old, ['lower', 'duplicate'])).toBeNull();
  });
  it('validates persisted band intervals and the cabinet orientation without accepting unknown directions', () => {
    expect(reconstructionBandSchema.safeParse({ from: 0.5, to: 0.5 }).success).toBe(false);
    expect(reconstructionBandSchema.safeParse({ from: -0.1, to: 1 }).success).toBe(false);
    const template = {
      version: 1,
      kind: 'vanity',
      color: '#9ab7b9',
      widthMm: 1200,
      heightMm: 850,
      depthMm: 550,
      orientation: 'left',
    };
    expect(fixtureReconstructionSchema.parse(template)).toEqual(template);
    expect(fixtureReconstructionSchema.safeParse({ ...template, orientation: 'up' }).success).toBe(false);
  });
});
