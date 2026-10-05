import { describe, it, expect } from 'vitest';
import { photoViewAngle } from '../src/lib/room-viewer/fixtures';
import { choosePhotoForView, roomSideName, viewPhotoNote } from '../src/lib/room-viewer/view-photo';
import { PRODUCT_DIRECTIONS, type ProductDirection } from '../src/lib/product-direction';

const view = (direction: string) => ({ assetId: direction, direction, anchor: { x: 0.5, y: 1 } });
const SIDES = [0, 90, 180, -90] as const;
const ALL = ['정면', '오른쪽', '뒤', '왼쪽'] as const;
const photos = (names: readonly string[], selected: number, azimuth: number, available?: number[]) =>
  choosePhotoForView(names, selected, azimuth, available ? new Set(available) : undefined);

describe('photos by side: the four-direction views', () => {
  it('reads the direction a photo shows its product facing from its name, and nothing else', () => {
    expect(photoViewAngle(view('정면'))).toBe(0);
    expect(photoViewAngle(view('오른쪽'))).toBe(90);
    expect(photoViewAngle(view('왼쪽'))).toBe(-90);
    expect(photoViewAngle(view('뒤'))).toBe(180);
    // 위 and 아래 name no horizontal direction.
    expect(photoViewAngle(view('위'))).toBeUndefined();
    expect(photoViewAngle(view('아래'))).toBeUndefined();
    // Older names read through the closed list.
    expect(photoViewAngle(view('오른쪽 측면'))).toBe(90);
    expect(photoViewAngle(view('왼쪽 사선'))).toBe(-90);
    expect(photoViewAngle(view('뒤에서'))).toBe(180);
  });

  it('names the side a camera looks from', () => {
    expect(SIDES.map(roomSideName)).toEqual(['정면', '오른쪽', '뒤', '왼쪽']);
    expect(roomSideName(270)).toBe('왼쪽');
    expect(roomSideName(-180)).toBe('뒤');
    expect(roomSideName(40)).toBe('정면');
  });

  // The table of the specification: the photo chosen for each of the four sides, by the photo
  // selected (the way the product stands in the room). All four photos are registered, in the
  // order 정면 · 오른쪽 · 뒤 · 왼쪽, so a photo's index is its name's place in that list.
  const TABLE: Record<(typeof ALL)[number], Record<'0' | '90' | '180' | '-90', (typeof ALL)[number]>> = {
    정면: { '0': '정면', '90': '왼쪽', '180': '뒤', '-90': '오른쪽' },
    오른쪽: { '0': '오른쪽', '90': '정면', '180': '왼쪽', '-90': '뒤' },
    왼쪽: { '0': '왼쪽', '90': '뒤', '180': '오른쪽', '-90': '정면' },
    뒤: { '0': '뒤', '90': '오른쪽', '180': '정면', '-90': '왼쪽' },
  };
  for (const selected of ALL)
    for (const side of SIDES)
      it(`${selected} photo selected, seen from the ${roomSideName(side)}: the ${TABLE[selected][String(side) as '0']} photo`, () => {
        const photo = photos(ALL, ALL.indexOf(selected), side);
        expect(ALL[photo.index]).toBe(TABLE[selected][String(side) as '0']);
        expect(photo.used).toBe(TABLE[selected][String(side) as '0']);
        expect(photo.wanted).toBe(photo.used);
        expect(photo.exact).toBe(true);
        expect(viewPhotoNote('변기', side, photo)).toBe('');
      });

  it('a product facing right, seen from the right, faces the camera: its front photo', () => {
    // The specification's own example.
    expect(photos(['정면', '오른쪽'], 1, 90).index).toBe(0);
  });

  it('turns any angle to the nearest of the four sides first (45° goes clockwise)', () => {
    expect(photos(ALL, 0, 30).index).toBe(0);
    expect(photos(ALL, 0, 60).index).toBe(ALL.indexOf('왼쪽'));
    expect(photos(ALL, 0, 270).index).toBe(ALL.indexOf('오른쪽'));
    expect(photos(ALL, 0, -450).index).toBe(ALL.indexOf('오른쪽'));
  });

  it('shows the registered photo nearest to a missing direction, else the selected one, and says which', () => {
    // Front and right only; selected 정면.
    const names = ['정면', '오른쪽'];
    // The right side wants 왼쪽 (−90): 정면 is 90° away, 오른쪽 180°: the front.
    let photo = photos(names, 0, 90);
    expect([photo.index, photo.wanted, photo.used, photo.exact]).toEqual([0, '왼쪽', '정면', false]);
    expect(viewPhotoNote('변기', 90, photo)).toBe(
      '오른쪽 화면: 변기의 ‘왼쪽’ 사진이 없어 ‘정면’ 사진을 썼어요. 방향별 사진을 더 등록하면 더 자연스러워요.',
    );
    // The back wants 뒤 (180): 오른쪽 is 90° away, 정면 180°: the 오른쪽 photo.
    photo = photos(names, 0, 180);
    expect([photo.index, photo.wanted, photo.used, photo.exact]).toEqual([1, '뒤', '오른쪽', false]);
    expect(viewPhotoNote('변기', 180, photo)).toBe(
      '뒤 화면: 변기의 ‘뒤’ 사진이 없어 ‘오른쪽’ 사진을 썼어요. 방향별 사진을 더 등록하면 더 자연스러워요.',
    );
    // Equally near (정면 and 뒤 for a wanted 오른쪽 or 왼쪽): the selected photo wins.
    expect(photos(['정면', '뒤'], 0, -90).index).toBe(0);
    expect(photos(['뒤', '정면'], 0, -90).index).toBe(0);
    // Equally near and neither is the selected one: the first registered.
    expect(photos(['오른쪽', '정면', '뒤'], 0, 0).index).toBe(0);
    expect(photos(['왼쪽', '오른쪽', '정면'], 2, 180).index).toBe(0);
    // A photo only on one side is the whole product from every side.
    for (const side of SIDES) expect(photos(['오른쪽'], 0, side).index).toBe(0);
  });

  it('never mirrors: a missing left is not made from the right photo turned over', () => {
    // 왼쪽 wanted, only 정면 and 오른쪽: a stand-in is picked as is; there is no flipped result type.
    const photo = photos(['정면', '오른쪽'], 0, 90);
    expect(Object.keys(photo).sort()).toEqual(['exact', 'index', 'used', 'wanted']);
  });

  it('uses only the photos that can be shown (the others failed to load), the selected one always', () => {
    // 오른쪽 camera wants 왼쪽, which is registered but unavailable: the next nearest.
    expect(photos(ALL, 0, 90, [0, 1]).index).toBe(0);
    expect(photos(ALL, 0, 90, [0, 1]).exact).toBe(false);
    expect(photos(ALL, 0, 90, [0, 1, 3]).index).toBe(3);
    // Nothing else available: the selected photo.
    expect(photos(ALL, 2, 0, []).index).toBe(2);
  });

  it('never uses 위 or 아래 from the four sides', () => {
    const names: ProductDirection[] = ['정면', '위', '아래', '왼쪽'];
    for (const side of SIDES) {
      const photo = photos(names, 0, side);
      expect(['위', '아래']).not.toContain(names[photo.index]);
    }
    // Even when it is the only other photo, and even when the product is 위: those stay as selected.
    expect(photos(['정면', '위'], 0, 90).index).toBe(0);
    const above = photos(['위', '정면'], 0, 90);
    expect([above.index, above.exact]).toEqual([0, true]);
    expect(viewPhotoNote('변기', 90, above)).toBe('');
    // Every name of the closed list is read: an unknown one reads as 정면.
    expect(PRODUCT_DIRECTIONS).toHaveLength(6);
    expect(photos(['my 90 fancy', '오른쪽'], 0, 0).index).toBe(0);
  });
});
