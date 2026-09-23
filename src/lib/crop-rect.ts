import type { Point, Quad } from './types';

/**
 * Axis-aligned tile selection in normalized image coordinates (0–1). `aspect` values here are
 * normalized width/height; callers convert a pixel ratio with `pixelAspect * imageHeight / imageWidth`.
 */
export type CropRect = { x: number; y: number; width: number; height: number };
/** Corner handle 0–3 (top-left, top-right, bottom-right, bottom-left), drag inside, or draw anew. */
export type CropHandle = 0 | 1 | 2 | 3 | 'move' | 'draw';
export const MIN_CROP = 0.01;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const clamp01 = (value: number) => clamp(value, 0, 1);
const validAspect = (aspect?: number): aspect is number => !!aspect && Number.isFinite(aspect) && aspect > 0;

export const rectToQuad = ({ x, y, width, height }: CropRect): Quad => [
  { x, y },
  { x: x + width, y },
  { x: x + width, y: y + height },
  { x, y: y + height },
];

export function quadBounds(quad: Quad): CropRect {
  const xs = quad.map((point) => clamp01(point.x)),
    ys = quad.map((point) => clamp01(point.y));
  const x = Math.min(...xs),
    y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** Largest rectangle with `aspect` inside `rect`, centred on it. */
export function fitAspect(rect: CropRect, aspect?: number): CropRect {
  if (!validAspect(aspect)) return rect;
  const width = Math.min(rect.width, rect.height * aspect),
    height = width / aspect;
  return { x: rect.x + (rect.width - width) / 2, y: rect.y + (rect.height - height) / 2, width, height };
}

export const initialCropRect = (aspect?: number) =>
  fitAspect({ x: 0.05, y: 0.05, width: 0.9, height: 0.9 }, aspect);

/** Corners win within `tolerance` (normalized per axis); otherwise inside moves and outside draws. */
export function hitCropRect(rect: CropRect, point: Point, tolerance: Point): CropHandle {
  let handle: CropHandle | undefined,
    best = Infinity;
  rectToQuad(rect).forEach((corner, index) => {
    const dx = Math.abs(corner.x - point.x) / tolerance.x,
      dy = Math.abs(corner.y - point.y) / tolerance.y;
    if (dx > 1 || dy > 1 || Math.hypot(dx, dy) >= best) return;
    best = Math.hypot(dx, dy);
    handle = index as 0 | 1 | 2 | 3;
  });
  if (handle !== undefined) return handle;
  const inside =
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height;
  return inside ? 'move' : 'draw';
}

/**
 * Moving keeps the size inside the image. Corner and draw drags span from a fixed anchor to the
 * pointer; a locked aspect shrinks the span to fit that box, so the result never leaves the image.
 * A drag smaller than MIN_CROP keeps the previous selection (a plain click never erases it).
 */
export function dragCropRect(
  start: CropRect,
  handle: CropHandle,
  from: Point,
  to: Point,
  aspect?: number,
): CropRect {
  if (handle === 'move')
    return {
      ...start,
      x: clamp(start.x + to.x - from.x, 0, 1 - start.width),
      y: clamp(start.y + to.y - from.y, 0, 1 - start.height),
    };
  const anchor =
    handle === 'draw' ? { x: clamp01(from.x), y: clamp01(from.y) } : rectToQuad(start)[(handle + 2) % 4];
  const target = { x: clamp01(to.x), y: clamp01(to.y) };
  let width = Math.abs(target.x - anchor.x),
    height = Math.abs(target.y - anchor.y);
  if (validAspect(aspect)) {
    if (width > height * aspect) width = height * aspect;
    else height = width / aspect;
  }
  if (width < MIN_CROP || height < MIN_CROP) return start;
  return {
    x: target.x < anchor.x ? anchor.x - width : anchor.x,
    y: target.y < anchor.y ? anchor.y - height : anchor.y,
    width,
    height,
  };
}

/** Typed field edits: a locked aspect makes width and height follow each other; stays in the image. */
export function editCropRect(rect: CropRect, field: keyof CropRect, value: number, aspect?: number): CropRect {
  const next = { ...rect, [field]: clamp01(value) };
  if (field === 'width' || field === 'height') {
    next[field] = Math.max(MIN_CROP, next[field]);
    if (validAspect(aspect)) {
      if (field === 'width') next.height = next.width / aspect;
      else next.width = next.height * aspect;
    }
  }
  const scale = Math.min(1, 1 / next.width, 1 / next.height);
  next.width *= scale;
  next.height *= scale;
  next.x = Math.min(next.x, 1 - next.width);
  next.y = Math.min(next.y, 1 - next.height);
  return next;
}
