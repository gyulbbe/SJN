import type { Point, Quad, TileSettings } from '../types';

export type Homography = [number, number, number, number, number, number, number, number, number];
const UNIT: Quad = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
];

/** Input corners must follow the perimeter (top-left, top-right, bottom-right, bottom-left). */
export function validateQuad(quad: Quad): boolean {
  if (quad.length !== 4 || quad.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return false;
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = quad[i],
      b = quad[(i + 1) % 4],
      c = quad[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-7) return false;
    if (sign && Math.sign(cross) !== sign) return false;
    sign = Math.sign(cross);
  }
  return true;
}

/** Solve eight projective constraints using pivoted elimination. */
export function homography(from: Quad, to: Quad = UNIT): Homography {
  if (!validateQuad(from) || !validateQuad(to))
    throw new Error('원근의 네 점은 겹치지 않는 볼록 사각형이어야 합니다.');
  const rows: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = from[i],
      { x: u, y: v } = to[i];
    rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    rows.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  for (let col = 0; col < 8; col++) {
    let pivot = col;
    for (let r = col + 1; r < 8; r++) if (Math.abs(rows[r][col]) > Math.abs(rows[pivot][col])) pivot = r;
    if (Math.abs(rows[pivot][col]) < 1e-11)
      throw new Error('원근을 계산할 수 없습니다. 네 점의 간격을 늘려 주세요.');
    [rows[pivot], rows[col]] = [rows[col], rows[pivot]];
    const div = rows[col][col];
    for (let k = col; k <= 8; k++) rows[col][k] /= div;
    for (let r = 0; r < 8; r++)
      if (r !== col) {
        const mult = rows[r][col];
        for (let k = col; k <= 8; k++) rows[r][k] -= mult * rows[col][k];
      }
  }
  return [...rows.map((r) => r[8]), 1] as Homography;
}

export function transformPoint(h: Homography, p: Point): Point {
  const z = h[6] * p.x + h[7] * p.y + h[8];
  if (Math.abs(z) < 1e-10) throw new Error('원근 소실선 위의 점입니다.');
  return { x: (h[0] * p.x + h[1] * p.y + h[2]) / z, y: (h[3] * p.x + h[4] * p.y + h[5]) / z };
}

export function inverseHomography(h: Homography): Homography {
  const [a, b, c, d, e, f, g, k, i] = h;
  const out = [
    e * i - f * k,
    c * k - b * i,
    b * f - c * e,
    f * g - d * i,
    a * i - c * g,
    c * d - a * f,
    d * k - e * g,
    b * g - a * k,
    a * e - b * d,
  ];
  const det = a * out[0] + b * out[3] + c * out[6];
  if (Math.abs(det) < 1e-12) throw new Error('역원근 행렬을 계산할 수 없습니다.');
  return out.map((n) => n / det) as Homography;
}

function mod(n: number, d: number) {
  return ((n % d) + d) % d;
}
/** The same integer-cell hash as the shader: stable over export/reopen and negative tile coordinates. */
export function variantForCell(x: number, y: number, seed: number, count: number): number {
  const h = mod(mod(x, 251) * 17 + mod(y, 251) * 131 + mod(seed, 251) * 23, 251);
  return Math.floor((mod(h * 73 + 19, 251) / 251) * Math.max(1, count));
}

export function tileAtPoint(
  uv: Point,
  plane: { width: number; height: number },
  tile: { width: number; height: number },
  settings: TileSettings,
) {
  const rad = (settings.rotation * Math.PI) / 180,
    c = Math.cos(rad),
    s = Math.sin(rad);
  const x = uv.x * plane.width - settings.offsetX,
    y = uv.y * plane.height - settings.offsetY;
  const rx = c * x + s * y,
    ry = -s * x + c * y;
  const px = Math.max(0.001, tile.width + Math.max(0, settings.groutWidth)),
    py = Math.max(0.001, tile.height + Math.max(0, settings.groutWidth));
  const row = Math.floor(ry / py),
    shifted = rx - (settings.pattern === 'brick' ? mod(row, 2) * px * 0.5 : 0);
  const column = Math.floor(shifted / px),
    localX = mod(shifted, px),
    localY = mod(ry, py);
  return {
    column,
    row,
    u: localX / Math.max(0.001, tile.width),
    v: localY / Math.max(0.001, tile.height),
    grout: localX >= tile.width || localY >= tile.height,
  };
}

export function fitOutput(width: number, height: number, maxEdge = 4096): { width: number; height: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)
    throw new Error('이미지 크기가 올바르지 않습니다.');
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}
