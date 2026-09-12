import type { Quad, Point, AssetRecord } from '../types';
import type { AssetRepository } from '../repositories/contracts';
import type { ReconstructionCandidate, ReconstructionPlane } from './types';
import { homography, inverseHomography, transformPoint, validateQuad } from '../render/math';
import { rectifyImage } from '../render/crop';
import { makeAsset } from '../images';

/** Fit an observed frame to the source wall's directions, not to a screen-aligned crop. */
export function reconstructionAppearanceQuad(
  candidate: ReconstructionCandidate,
  plane: ReconstructionPlane,
): Quad | undefined {
  if (!['window', 'mirror'].includes(candidate.kind) || !validateQuad(plane.quad)) return;
  const b = candidate.bounds,
    inverse = homography(plane.quad),
    forward = inverseHomography(inverse);
  const target = [b.left, b.top, b.right, b.bottom];
  const corners = [
    { x: b.left, y: b.top },
    { x: b.right, y: b.top },
    { x: b.right, y: b.bottom },
    { x: b.left, y: b.bottom },
  ];
  const mapped = corners.map((p) => transformPoint(inverse, p));
  const xs = mapped.map((p) => p.x),
    ys = mapped.map((p) => p.y);
  let params = [
    (Math.min(...xs) + Math.max(...xs)) / 2,
    (Math.min(...ys) + Math.max(...ys)) / 2,
    (Math.max(...xs) - Math.min(...xs)) / 2,
    (Math.max(...ys) - Math.min(...ys)) / 2,
  ];
  const quad = (v: number[]): Quad =>
    [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ].map(([x, y]) => transformPoint(forward, { x: v[0] + x * v[2], y: v[1] + y * v[3] })) as Quad;
  function error(v: number[]) {
    if (v[2] <= 0 || v[3] <= 0) return Infinity;
    const points = quad(v);
    if (points.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return Infinity;
    const observed = [
      Math.min(...points.map((p) => p.x)),
      Math.min(...points.map((p) => p.y)),
      Math.max(...points.map((p) => p.x)),
      Math.max(...points.map((p) => p.y)),
    ];
    return observed.reduce((sum, n, i) => sum + (n - target[i]) ** 2, 0);
  }
  let step = Math.max(params[2], params[3]) * 0.25;
  for (let round = 0; round < 36; round++) {
    let improved = false;
    for (let axis = 0; axis < 4; axis++) {
      let best = error(params),
        choice = params;
      for (const direction of [-1, 1]) {
        const attempt = [...params];
        attempt[axis] += direction * step;
        const e = error(attempt);
        if (e < best) {
          best = e;
          choice = attempt;
        }
      }
      if (choice !== params) {
        params = choice;
        improved = true;
      }
    }
    if (!improved) step *= 0.5;
  }
  const fitted = quad(params);
  if (!validateQuad(fitted) || fitted.some((p) => p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1)) return;
  return fitted;
}
function abort(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('사진 디테일 준비를 취소했어요.', 'AbortError');
}
/** Keep the observed glazing/reflection and frame as a private, rectified material asset. */
export async function createReconstructionAppearance(options: {
  reference: AssetRecord;
  candidate: ReconstructionCandidate;
  plane: ReconstructionPlane;
  assets: AssetRepository;
  signal?: AbortSignal;
}): Promise<string | undefined> {
  abort(options.signal);
  if (options.reference.kind === 'product-mesh') throw new Error('재구성 기준 사진이 필요해요.');
  const quad = reconstructionAppearanceQuad(options.candidate, options.plane);
  if (!quad) return;
  const bitmap = await createImageBitmap(options.reference.blob);
  const distance = (a: Point, b: Point) =>
    Math.hypot((a.x - b.x) * bitmap.width, (a.y - b.y) * bitmap.height);
  const width = Math.max(16, Math.round((distance(quad[0], quad[1]) + distance(quad[3], quad[2])) / 2));
  const height = Math.max(16, Math.round((distance(quad[0], quad[3]) + distance(quad[1], quad[2])) / 2));
  bitmap.close();
  abort(options.signal);
  const blob = await rectifyImage(options.reference.blob, quad, width, height);
  abort(options.signal);
  const asset = await makeAsset(
    blob,
    options.candidate.kind === 'window' ? '기존 창 프레임과 유리.png' : '기존 거울 프레임과 반사.png',
    'product',
    options.reference.id,
  );
  abort(options.signal);
  await options.assets.put(asset);
  abort(options.signal);
  return asset.id;
}
