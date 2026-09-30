import { describe, expect, it } from 'vitest';
import { roomPlacementSchema } from '../src/lib/room-validation';
import { facesFront } from '../src/lib/room-viewer/fixtures';

const placement = () => ({
  face: 'left' as const,
  u: 0.5,
  v: 0.55,
  scale: 1,
  widthMm: 500,
  heightMm: 400,
  imageAspect: 1.2,
  contentBounds: { left: 0, top: 0, right: 1, bottom: 1 },
});

describe('RoomPlacement.facing', () => {
  it('takes no value (the old shape), "wall" and "front", and nothing else', () => {
    expect(roomPlacementSchema.safeParse(placement()).success).toBe(true);
    expect(roomPlacementSchema.parse({ ...placement(), facing: 'wall' }).facing).toBe('wall');
    expect(roomPlacementSchema.parse({ ...placement(), facing: 'front' }).facing).toBe('front');
    for (const bad of ['back', 'Front', '', 0, null, true, {}])
      expect(roomPlacementSchema.safeParse({ ...placement(), facing: bad }).success).toBe(false);
  });

  it('an old placement parses to exactly itself: no `facing` key appears', () => {
    const parsed = roomPlacementSchema.parse(placement());
    expect(parsed).toEqual(placement());
    expect('facing' in parsed).toBe(false);
  });

  it('only a left or right wall product can face the front', () => {
    expect(facesFront({ face: 'left', facing: 'front' })).toBe(true);
    expect(facesFront({ face: 'right', facing: 'front' })).toBe(true);
    expect(facesFront({ face: 'back', facing: 'front' })).toBe(false);
    expect(facesFront({ face: 'floor', facing: 'front' })).toBe(false);
    expect(facesFront({ face: 'left', facing: 'wall' })).toBe(false);
    expect(facesFront({ face: 'left' })).toBe(false);
  });
});
