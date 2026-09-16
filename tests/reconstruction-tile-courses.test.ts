import { describe, expect, it } from 'vitest';
import {
  analyzePlaneAppearanceDetails,
  completeObservedWallTiles,
  type WallTileEvidence,
} from '../src/lib/reconstruction/analysis';
import { DEFAULT_ROOM } from '../src/lib/room-geometry';
import type { ReconstructionPlane } from '../src/lib/reconstruction/types';

const plane: ReconstructionPlane = {
  id: 'wall',
  face: 'back',
  quad: [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ],
  depthStart: 0,
  depthEnd: 1,
  confirmed: false,
  tile: {
    color: '#777777',
    groutColor: '#cccccc',
    widthMm: 300,
    heightMm: 600,
    groutWidth: 0,
    estimated: true,
  },
};
function courses(pattern: 'brick' | 'grid' | 'stripes', bright = true, tileWidth = 120) {
  const width = 256,
    height = 256,
    rgba = new Uint8ClampedArray(width * height * 4),
    mask = new Uint8Array(width * height).fill(255);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const course = Math.floor((y + 10) / 24),
        offset = pattern === 'brick' && course % 2 ? tileWidth / 2 : 0;
      const vertical = pattern !== 'stripes' && (x + offset + 17) % tileWidth === 0;
      const horizontal = (y + 10) % 24 === 0;
      const shade = bright ? 140 : 185,
        grout = bright ? 225 : 85;
      const value = horizontal || vertical ? grout : shade;
      rgba.set([value, value, value, 255], (y * width + x) * 4);
    }
  return { rgba, mask, width, height };
}
function donorAndReceiver() {
  const donor = {
    ...structuredClone(plane),
    id: 'right',
    face: 'right' as const,
    tile: { ...plane.tile, widthMm: 600, heightMm: 150, groutWidth: 2, pattern: 'brick' as const },
  };
  const receiver = { ...structuredClone(plane), id: 'back' };
  const evidence = new Map<string, WallTileEvidence>([
    ['right', { horizontalSupport: 12, verticalSupport: 60, verticalSpan: 0.9, coursePattern: 'brick' }],
    ['back', { horizontalSupport: 3, verticalSupport: 45, verticalSpan: 0.65 }],
  ]);
  return { donor, receiver, evidence };
}
describe('narrow-wall course evidence', () => {
  it.each([true, false])(
    'recovers half-brick courses with only two visible vertical joints per row (bright=%s)',
    (bright) => {
      const result = analyzePlaneAppearanceDetails({
        plane,
        room: DEFAULT_ROOM,
        ...courses('brick', bright),
      });
      expect(result.tile.groutWidth, JSON.stringify(result)).toBe(2);
      expect(result.tile.pattern).toBe('brick');
      expect(result.tile.widthMm).toBeGreaterThan(1050);
      expect(result.tile.widthMm).toBeLessThan(1200);
      expect(result.tile.heightMm).toBeGreaterThan(200);
      expect(result.tile.heightMm).toBeLessThan(250);
      const channel = parseInt(result.tile.groutColor!.slice(1, 3), 16);
      expect(bright ? channel > 200 : channel < 110).toBe(true);
      expect(result.bands).toBeUndefined();
    },
  );
  it('keeps vertically aligned courses as a grid', () => {
    const result = analyzePlaneAppearanceDetails({ plane, room: DEFAULT_ROOM, ...courses('grid') });
    expect(result.tile.pattern, JSON.stringify(result)).toBe('grid');
    expect(result.tile.groutWidth, JSON.stringify(result)).toBe(2);
  });
  it.each(['brick', 'grid'] as const)('also identifies %s where many joints are visible', (pattern) => {
    const result = analyzePlaneAppearanceDetails({
      plane,
      room: DEFAULT_ROOM,
      ...courses(pattern, true, 48),
    });
    expect(result.tile.pattern).toBe(pattern);
    expect(result.tile.widthMm).toBeGreaterThan(420);
    expect(result.tile.widthMm).toBeLessThan(490);
  });
  it('does not invent vertical joints from horizontal stripes alone', () => {
    const result = analyzePlaneAppearanceDetails({ plane, room: DEFAULT_ROOM, ...courses('stripes') });
    expect(result.tile.groutWidth).toBe(0);
    expect(result.evidence?.coursePattern).toBeUndefined();
  });
  it('fills a weak dimension only with local repeated joints and a matching neighbouring finish, with an estimate notice', () => {
    const { donor, receiver, evidence } = donorAndReceiver();
    const warnings = completeObservedWallTiles([donor, receiver], evidence);
    expect(receiver.tile).toMatchObject({ widthMm: 600, heightMm: 150, pattern: 'brick', estimated: true });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('추정');
  });
  it.each(['no-joints', 'different-finish', 'different-grout', 'strong-grid', 'partial-band'] as const)(
    'does not propagate tiles into %s',
    (reason) => {
      const { donor, receiver, evidence } = donorAndReceiver();
      if (reason === 'no-joints')
        evidence.set('back', { horizontalSupport: 0, verticalSupport: 0, verticalSpan: 0 });
      if (reason === 'different-finish') receiver.tile.color = '#220022';
      if (reason === 'different-grout') receiver.tile.groutColor = '#222222';
      if (reason === 'strong-grid')
        evidence.set('back', {
          horizontalSupport: 25,
          verticalSupport: 45,
          verticalSpan: 0.65,
          coursePattern: 'grid',
        });
      if (reason === 'partial-band')
        receiver.bands = [
          { from: 0, to: 0.5, tile: { ...receiver.tile } },
          { from: 0.5, to: 1, tile: { ...donor.tile } },
        ];
      const before = structuredClone(receiver);
      expect(completeObservedWallTiles([donor, receiver], evidence)).toEqual([]);
      expect(receiver).toEqual(before);
    },
  );
});
