import { describe, it, expect } from 'vitest';
import {
  chooseDirectionalPhoto,
  chooseExportPhoto,
  photoFootprint,
  photoViewAngle,
  sameFootprint,
} from '../src/lib/room-viewer/fixtures';
import type { ProductDirection } from '../src/lib/product-direction';

const view = (direction: string) => ({ assetId: direction, direction, anchor: { x: 0.5, y: 1 } });

describe('AI export photo angles', () => {
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

  it('keeps the footprint: width, height within 5%, the anchor within 2% of the content', () => {
    const placement = { widthMm: 400, heightMm: 600, scale: 1 };
    const bounds = { left: 0, right: 1, top: 0, bottom: 1 };
    const front = photoFootprint(placement, bounds, 200 / 300, { x: 0.5, y: 1 });
    expect(front).toEqual({ width: 400, height: 600, anchorX: 0.5, anchorY: 1 });
    // The same outline from a diagonal: kept.
    expect(sameFootprint(front, photoFootprint(placement, bounds, 200 / 300, { x: 0.5, y: 1 }))).toBe(true);
    // A narrow side photo: another width.
    expect(sameFootprint(front, photoFootprint(placement, bounds, 90 / 300, { x: 0.5, y: 1 }))).toBe(false);
    // Same size, the base point moved.
    expect(sameFootprint(front, photoFootprint(placement, bounds, 200 / 300, { x: 0.46, y: 1 }))).toBe(false);
    // A photo with a margin around the product draws the same content: kept.
    const margin = { left: 0.1, right: 0.9, top: 0.05, bottom: 0.95 };
    expect(
      sameFootprint(front, photoFootprint(placement, margin, (200 / 300) * (0.9 / 0.8), { x: 0.5, y: 0.95 })),
    ).toBe(true);
  });

  it('a camera sees a fixed product turned by where the camera stands: the photo showing that', () => {
    const names: ProductDirection[] = ['정면', '왼쪽', '오른쪽', '위', '뒤'];
    const all = new Set([0, 1, 2, 3, 4]);
    // In front of a product that faces the front: the front photo.
    expect(chooseExportPhoto(names, 0, 0, 0, all)).toBe(0);
    expect(chooseExportPhoto(names, 0, 10, 0, all)).toBe(0);
    // A camera on the room's right (+90) looks at the product's left side: its facing is seen
    // turned to the left, the 왼쪽 photo. From the left, the 오른쪽 photo.
    expect(chooseExportPhoto(names, 0, 90, 0, all)).toBe(1);
    expect(chooseExportPhoto(names, 0, -90, 0, all)).toBe(2);
    // From behind, the 뒤 photo; without one the nearest is a side (equally near: the first).
    expect(chooseExportPhoto(names, 0, 180, 0, all)).toBe(4);
    expect(chooseExportPhoto(names, 0, 180, 0, new Set([0, 1, 2]))).toBe(1);
    // A product that faces right, seen from the right (it faces the camera): the front photo.
    expect(chooseExportPhoto(names, 2, 90, 0, all)).toBe(0);
    // Not usable (another footprint): the next nearest usable, or the chosen one.
    expect(chooseExportPhoto(names, 0, 90, 0, new Set([0, 2]))).toBe(0);
    expect(chooseExportPhoto(names, 0, 90, 0, new Set([0]))).toBe(0);
    // A chosen photo without a horizontal name stays.
    expect(chooseExportPhoto(names, 3, 90, 0, all)).toBe(3);
  });

  it('steeply above, the 위 photo is a candidate (when usable); below, 아래; else the chosen one', () => {
    const names: ProductDirection[] = ['정면', '위', '아래'];
    const all = new Set([0, 1, 2]);
    expect(chooseExportPhoto(names, 0, 0, 50, all)).toBe(1);
    expect(chooseExportPhoto(names, 0, 0, -50, all)).toBe(2);
    expect(chooseExportPhoto(names, 0, 0, 35, all)).toBe(0);
    expect(chooseExportPhoto(names, 0, 0, 36, all)).toBe(1);
    // Not usable, or none of that name: the chosen photo stays.
    expect(chooseExportPhoto(names, 0, 0, 50, new Set([0, 2]))).toBe(0);
    expect(chooseExportPhoto(['정면', '왼쪽'], 0, 0, 50, new Set([0, 1]))).toBe(0);
    // The chosen photo is itself 위: it stays from above.
    expect(chooseExportPhoto(names, 1, 0, 50, new Set([1]))).toBe(1);
  });

  it('the viewer switches only between flat photos, within 25°, and never from steeply above', () => {
    const views = [view('정면'), view('왼쪽'), view('오른쪽'), view('위')];
    expect(chooseDirectionalPhoto(views, 0, 0, 0)).toBe(0);
    expect(chooseDirectionalPhoto(views, 0, 90, 0)).toBe(1);
    expect(chooseDirectionalPhoto(views, 0, -90, 0)).toBe(2);
    // Between the front and the side, past 25° from both: stays.
    expect(chooseDirectionalPhoto(views, 0, 45, 0)).toBe(0);
    expect(chooseDirectionalPhoto(views, 0, 70, 0)).toBe(1);
    expect(chooseDirectionalPhoto(views, 0, 0, 50)).toBe(0);
    expect(chooseDirectionalPhoto(views, 3, 90, 0)).toBe(3);
  });
});
