import type { Mask, Point } from '../types';

export function pointInPolygon(point: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i],
      b = polygon[j];
    if (a.y > point.y !== b.y > point.y && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x)
      inside = !inside;
  }
  return inside;
}

function segmentDistance(p: Point, a: Point, b: Point, aspect: number): number {
  const dx = b.x - a.x,
    dy = (b.y - a.y) / aspect;
  const px = p.x - a.x,
    py = (p.y - a.y) / aspect;
  const t = Math.max(0, Math.min(1, (px * dx + py * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(px - t * dx, py - t * dy);
}

/** Strokes are sequential. Positive radius means a brush; radius zero means a closed polygon fill. */
export function maskContains(mask: Mask, point: Point, aspect = 1): boolean {
  let included =
    pointInPolygon(point, mask.polygon) ||
    (mask.polygons ?? []).some((polygon) => pointInPolygon(point, polygon));
  if ((mask.holes ?? []).some((polygon) => pointInPolygon(point, polygon))) included = false;
  for (const stroke of mask.strokes) {
    const points = stroke.points;
    if (stroke.radius === 0 && points.length >= 3) {
      if (pointInPolygon(point, points)) included = !stroke.erase;
      continue;
    }
    let touches = false;
    for (let i = 0; i < points.length; i++) {
      if (segmentDistance(point, points[Math.max(0, i - 1)], points[i], aspect) <= stroke.radius) {
        touches = true;
        break;
      }
    }
    if (touches) included = !stroke.erase;
  }
  return included;
}

export function surfaceContains(mask: Mask, protection: Mask, point: Point, aspect = 1) {
  return maskContains(mask, point, aspect) && !maskContains(protection, point, aspect);
}

export function paintMask(ctx: CanvasRenderingContext2D, mask: Mask, width: number, height: number): void {
  ctx.clearRect(0, 0, width, height);
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#ffffff';
  for (const polygon of [mask.polygon, ...(mask.polygons ?? [])])
    if (polygon.length >= 3) {
      ctx.beginPath();
      ctx.moveTo(polygon[0].x * width, polygon[0].y * height);
      polygon.slice(1).forEach((p) => ctx.lineTo(p.x * width, p.y * height));
      ctx.closePath();
      ctx.fill();
    }
  ctx.globalCompositeOperation = 'destination-out';
  for (const polygon of mask.holes ?? []) {
    if (polygon.length < 3) continue;
    ctx.beginPath();
    ctx.moveTo(polygon[0].x * width, polygon[0].y * height);
    polygon.slice(1).forEach((point) => ctx.lineTo(point.x * width, point.y * height));
    ctx.closePath();
    ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (let index = 0; index < mask.strokes.length; index++) {
    const stroke = mask.strokes[index];
    if (!stroke.points.length) continue;
    ctx.globalCompositeOperation = stroke.erase ? 'destination-out' : 'source-over';
    if (stroke.radius === 0 && stroke.points.length >= 3) {
      // Fill consecutive polygon patches in one path so adjacent rectangles cannot produce
      // antialiased seams when exported at a different resolution from the restoration canvas.
      ctx.beginPath();
      for (;;) {
        const polygon = mask.strokes[index].points;
        ctx.moveTo(polygon[0].x * width, polygon[0].y * height);
        polygon.slice(1).forEach((p) => ctx.lineTo(p.x * width, p.y * height));
        ctx.closePath();
        const next = mask.strokes[index + 1];
        if (!next || next.radius !== 0 || next.points.length < 3 || next.erase !== stroke.erase) break;
        index++;
      }
      ctx.fill();
      continue;
    }
    ctx.lineWidth = Math.max(0.01, stroke.radius * width * 2);
    const p = stroke.points[0];
    if (stroke.points.length === 1) {
      ctx.beginPath();
      ctx.arc(p.x * width, p.y * height, stroke.radius * width, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(p.x * width, p.y * height);
      stroke.points.slice(1).forEach((v) => ctx.lineTo(v.x * width, v.y * height));
      ctx.stroke();
    }
  }
  ctx.globalCompositeOperation = 'source-over';
}

export function maskCanvas(mask: Mask, width: number, height: number, protection?: Mask): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('마스크 캔버스를 준비하지 못했습니다.');
  paintMask(ctx, mask, width, height);
  if (protection && (protection.polygon.length || protection.polygons?.length || protection.strokes.length)) {
    const protectedCanvas = maskCanvas(protection, width, height);
    ctx.globalCompositeOperation = 'destination-out';
    ctx.drawImage(protectedCanvas, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
  }
  return canvas;
}
