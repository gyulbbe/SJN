import { describe, expect, it } from 'vitest';
import {
  dragCropRect,
  editCropRect,
  fitAspect,
  hitCropRect,
  initialCropRect,
  quadBounds,
  rectToQuad,
  type CropRect,
} from '../src/lib/crop-rect';

const rect: CropRect = { x: 0.2, y: 0.3, width: 0.4, height: 0.2 };
const close = (value: CropRect, expected: CropRect) => {
  for (const key of ['x', 'y', 'width', 'height'] as const) expect(value[key]).toBeCloseTo(expected[key], 6);
};

describe('tile crop rectangle', () => {
  it('converts to the ordered quad used by rectifyImage and back', () => {
    expect(rectToQuad(rect)).toEqual([
      { x: 0.2, y: 0.3 },
      { x: 0.6000000000000001, y: 0.3 },
      { x: 0.6000000000000001, y: 0.5 },
      { x: 0.2, y: 0.5 },
    ]);
    close(quadBounds(rectToQuad(rect)), rect);
    close(
      quadBounds([
        { x: 0.1, y: 0.2 },
        { x: 0.9, y: 0.1 },
        { x: 1.2, y: 0.8 },
        { x: 0.2, y: 0.7 },
      ]),
      { x: 0.1, y: 0.1, width: 0.9, height: 0.7 },
    );
  });

  it('fits a locked aspect centred inside the rectangle', () => {
    close(fitAspect({ x: 0, y: 0, width: 1, height: 1 }, 2), { x: 0, y: 0.25, width: 1, height: 0.5 });
    close(fitAspect({ x: 0, y: 0, width: 1, height: 1 }, 0.5), { x: 0.25, y: 0, width: 0.5, height: 1 });
    expect(fitAspect(rect)).toBe(rect);
    close(initialCropRect(), { x: 0.05, y: 0.05, width: 0.9, height: 0.9 });
  });

  it('hits corners before the inside and treats the outside as drawing', () => {
    const tolerance = { x: 0.03, y: 0.03 };
    expect(hitCropRect(rect, { x: 0.21, y: 0.31 }, tolerance)).toBe(0);
    expect(hitCropRect(rect, { x: 0.59, y: 0.49 }, tolerance)).toBe(2);
    expect(hitCropRect(rect, { x: 0.4, y: 0.4 }, tolerance)).toBe('move');
    expect(hitCropRect(rect, { x: 0.9, y: 0.9 }, tolerance)).toBe('draw');
  });

  it('moves inside the image and resizes around the opposite corner', () => {
    close(dragCropRect(rect, 'move', { x: 0.4, y: 0.4 }, { x: 0.9, y: -0.5 }), {
      x: 0.6,
      y: 0,
      width: 0.4,
      height: 0.2,
    });
    // Dragging the bottom-right corner keeps the top-left fixed, even past the image edge.
    close(dragCropRect(rect, 2, { x: 0.6, y: 0.5 }, { x: 1.4, y: 0.9 }), {
      x: 0.2,
      y: 0.3,
      width: 0.8,
      height: 0.6,
    });
    // Dragging the top-left corner past the fixed bottom-right corner flips the rectangle.
    close(dragCropRect(rect, 0, { x: 0.2, y: 0.3 }, { x: 0.8, y: 0.7 }), {
      x: 0.6,
      y: 0.5,
      width: 0.2,
      height: 0.2,
    });
  });

  it('draws a new rectangle in any direction and keeps a locked aspect', () => {
    close(dragCropRect(rect, 'draw', { x: 0.9, y: 0.8 }, { x: 0.1, y: 0.2 }), {
      x: 0.1,
      y: 0.2,
      width: 0.8,
      height: 0.6,
    });
    const locked = dragCropRect(rect, 'draw', { x: 0.1, y: 0.1 }, { x: 0.7, y: 0.9 }, 2);
    close(locked, { x: 0.1, y: 0.1, width: 0.6, height: 0.3 });
    expect(locked.width / locked.height).toBeCloseTo(2, 6);
  });

  it('keeps the previous selection for a click or a too small drag', () => {
    expect(dragCropRect(rect, 'draw', { x: 0.9, y: 0.9 }, { x: 0.9, y: 0.9 })).toBe(rect);
    expect(dragCropRect(rect, 1, { x: 0.6, y: 0.3 }, { x: 0.201, y: 0.3 })).toBe(rect);
  });

  it('edits typed fields, links width and height when locked, and stays in the image', () => {
    close(editCropRect(rect, 'width', 0.5, 2), { x: 0.2, y: 0.3, width: 0.5, height: 0.25 });
    close(editCropRect(rect, 'height', 0.4, 2), { x: 0.2, y: 0.3, width: 0.8, height: 0.4 });
    close(editCropRect(rect, 'x', 0.9), { x: 0.6, y: 0.3, width: 0.4, height: 0.2 });
    // A locked edit that would need more than the whole image shrinks both sides together.
    close(editCropRect(rect, 'height', 1, 2), { x: 0, y: 0.3, width: 1, height: 0.5 });
  });
});
