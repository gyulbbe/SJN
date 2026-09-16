import { describe, expect, it } from 'vitest';
import { DEFAULT_ROOM } from '../src/lib/room-geometry';
import {
  placementFromWallReference,
  wallReferenceFromPlacement,
} from '../src/lib/reconstruction/wall-relative-placement';
import { validateSourceFixture } from '../src/lib/reconstruction/source-camera';
import { reconstructionModelTransform } from '../src/lib/reconstruction/projection';

describe('wall-relative floor installation', () => {
  const room = { ...DEFAULT_ROOM, widthMm: 2200, depthMm: 3000, heightMm: 2500 };
  it.each(['back', 'left', 'right'] as const)(
    'preserves %s wall clearance using the real model transform',
    (wall) => {
      const reference = { wall, alongMm: 1100, clearanceMm: 80 };
      const placement = placementFromWallReference(room, reference, 680);
      const volume = { ...placement, version: 2 as const, widthMm: 420, heightMm: 800, depthMm: 680 };
      const check = validateSourceFixture(room, undefined, volume);
      expect(check.valid).toBe(true);
      expect(check.overflowMm).toEqual({ left: 0, right: 0, back: 0, front: 0, below: 0, above: 0 });
      const bounds = check.worldBoundsMm!;
      const clearance =
        wall === 'back'
          ? bounds.min[2]
          : wall === 'left'
            ? bounds.min[0] + room.widthMm / 2
            : room.widthMm / 2 - bounds.max[0];
      expect(clearance).toBeCloseTo(80, 8);
      const restored = wallReferenceFromPlacement(room, wall, placement, 680);
      expect(restored.alongMm).toBeCloseTo(reference.alongMm);
      expect(restored.clearanceMm).toBeCloseTo(reference.clearanceMm);
      expect(reconstructionModelTransform(room, volume).origin.y).toBe(0);
    },
  );
  it('depth changes preserve rear gap and shift the footprint centre', () => {
    const ref = { wall: 'back' as const, alongMm: 1100, clearanceMm: 100 };
    const a = placementFromWallReference(room, ref, 600);
    const b = placementFromWallReference(room, ref, 800);
    expect((b.v - a.v) * room.depthMm).toBeCloseTo(100);
    expect(a.u).toBe(b.u);
  });
  it('reports body overlap instead of fitting to pass validation', () => {
    const p = placementFromWallReference(room, { wall: 'back', alongMm: 10, clearanceMm: 0 }, 680);
    const check = validateSourceFixture(room, undefined, {
      ...p,
      version: 2,
      widthMm: 420,
      heightMm: 800,
      depthMm: 680,
    });
    expect(check.valid).toBe(false);
    expect(check.overflowMm?.left).toBe(200);
    expect(p.u).toBe(10 / room.widthMm);
  });
  it('does not conceal an out of room distance or negative initial clearance', () => {
    const p = placementFromWallReference(room, { wall: 'left', alongMm: 3400, clearanceMm: 0 }, 500);
    expect(p.v).toBeGreaterThan(1);
    expect(wallReferenceFromPlacement(room, 'back', { u: 0.5, v: 0 }, 600).clearanceMm).toBe(-300);
  });
  it.each([NaN, Infinity, -1])('rejects invalid user distance %s', (value) => {
    expect(() =>
      placementFromWallReference(room, { wall: 'back', alongMm: value, clearanceMm: 0 }, 600),
    ).toThrow();
    expect(() =>
      placementFromWallReference(room, { wall: 'back', alongMm: 1000, clearanceMm: value }, 600),
    ).toThrow();
  });
  it('rejects invalid room dimensions and unknown wall', () => {
    expect(() =>
      placementFromWallReference(
        { ...room, widthMm: 0 },
        { wall: 'left', alongMm: 1000, clearanceMm: 0 },
        600,
      ),
    ).toThrow();
    expect(() =>
      placementFromWallReference(room, { wall: 'unknown' as 'back', alongMm: 1000, clearanceMm: 0 }, 600),
    ).toThrow();
  });
});
