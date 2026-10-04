import { describe, expect, it } from 'vitest';
import { getPlacementViewIndex, getPreferredProductViewIndex } from '../src/lib/material-images';
import { directionSuitsFace, readProductDirection } from '../src/lib/product-direction';
import type { RoomFace } from '../src/lib/room-types';

const views = (...names: string[]) => ({
  views: names.map((direction, i) => ({ assetId: `a${i}`, direction, anchor: { x: 0.5, y: 1 } })),
});

describe('the photo a product is placed with', () => {
  it('is the one that suits the wall: 오른쪽 on the left wall, 왼쪽 on the right wall, 정면 on the back wall', () => {
    const m = views('정면', '오른쪽', '왼쪽');
    expect(getPlacementViewIndex(m, 'left')).toEqual({ index: 1 });
    expect(getPlacementViewIndex(m, 'right')).toEqual({ index: 2 });
    expect(getPlacementViewIndex(m, 'back')).toEqual({ index: 0 });
  });

  it('does not depend on the order of the photos', () => {
    const m = views('왼쪽', '뒤', '오른쪽', '정면');
    expect(getPlacementViewIndex(m, 'left').index).toBe(2);
    expect(getPlacementViewIndex(m, 'right').index).toBe(0);
    expect(getPlacementViewIndex(m, 'back').index).toBe(3);
  });

  it('keeps the usual one (정면 first) on the floor, which takes any name', () => {
    const m = views('왼쪽', '정면', '오른쪽');
    expect(getPlacementViewIndex(m, 'floor')).toEqual({ index: 1 });
    expect(getPlacementViewIndex(m, 'floor').index).toBe(getPreferredProductViewIndex(m));
    expect(getPlacementViewIndex(views('오른쪽', '왼쪽'), 'floor')).toEqual({ index: 0 });
  });

  it('falls back to the usual photo and says which name was wanted when the suiting one is missing', () => {
    expect(getPlacementViewIndex(views('정면', '왼쪽'), 'left')).toEqual({ index: 0, missing: '오른쪽' });
    expect(getPlacementViewIndex(views('정면', '오른쪽'), 'right')).toEqual({ index: 0, missing: '왼쪽' });
    expect(getPlacementViewIndex(views('왼쪽', '오른쪽'), 'back')).toEqual({ index: 0, missing: '정면' });
    expect(getPlacementViewIndex(views('왼쪽'), 'left')).toEqual({ index: 0, missing: '오른쪽' });
  });

  it('reads older names as the names they stand for', () => {
    expect(getPlacementViewIndex(views('front', '오른쪽 측면'), 'left')).toEqual({ index: 1 });
    expect(getPlacementViewIndex(views('후면', 'left'), 'right')).toEqual({ index: 1 });
    // A name nobody can read is 정면: it suits the back wall, and nothing else.
    expect(getPlacementViewIndex(views('사선', '오른쪽'), 'back')).toEqual({ index: 0 });
  });

  it('never picks a photo that does not suit when one does (a suiting pick has nothing missing)', () => {
    const faces: RoomFace[] = ['left', 'right', 'back'];
    const m = views('정면', '오른쪽', '왼쪽', '뒤', '위', '아래');
    for (const face of faces) {
      const picked = getPlacementViewIndex(m, face);
      expect(picked.missing).toBeUndefined();
      expect(directionSuitsFace(face, readProductDirection(m.views[picked.index].direction).name)).toBe(true);
    }
  });

  it('leaves the catalog preview policy alone: 정면 first, whatever the wall', () => {
    expect(getPreferredProductViewIndex(views('오른쪽', '정면'))).toBe(1);
    expect(getPreferredProductViewIndex(views('오른쪽', '왼쪽'))).toBe(0);
  });
});
