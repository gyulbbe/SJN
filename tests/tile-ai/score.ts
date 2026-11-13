/**
 * The tile AI trial's automatic "joint score" (docs/tile-ai-trials-20261113.md, round 0), free of I/O:
 * how well the fine lines of a result lie where a reference picture of the same view has them, face by
 * face. The reference is the app's capture with the joints drawn wide enough to see, so a face the
 * model re-laid at another tile size, or left plain, scores low. A number for screening only; what
 * counts is the person's rating.
 */
import { FIXTURE_REGION, type Pixels, type RegionMask } from '../../src/lib/ai-export/color';

type Field = { width: number; height: number; data: Float32Array };
/** Gradient magnitude of luminance at half resolution, after a light blur (grain weighs less). */
export function edgeField(image: Pixels): Field {
  const width = Math.floor(image.width / 2),
    height = Math.floor(image.height / 2);
  const lum = new Float32Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let j = 0; j < 2; j++)
        for (let i = 0; i < 2; i++) {
          const o = ((2 * y + j) * image.width + 2 * x + i) * 4;
          sum += 0.2126 * image.data[o] + 0.7152 * image.data[o + 1] + 0.0722 * image.data[o + 2];
        }
      lum[y * width + x] = sum / 4;
    }
  const grad = new Float32Array(width * height);
  for (let y = 1; y < height - 1; y++)
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      grad[i] = Math.hypot(lum[i + 1] - lum[i - 1], lum[i + width] - lum[i - width]);
    }
  return { width, height, data: grad };
}
export type FaceScore = { key: string; kind: 'wall' | 'floor'; pixels: number; score: number };
/** How far a face's lines may sit from the reference's and still count (half-resolution pixels). */
const REACH = 3;
/** A face's rim left out, wider than REACH so a corner or a fixture's outline never counts. */
const RIM = 6;
/** A face smaller than this share of the picture is not scored. */
const MIN_SHARE = 0.01;
/**
 * The joint score of each face: the best correlation of the two pictures' edges inside the face, the
 * result moved by up to REACH pixels around the whole-picture shift (`dx`, `dy`, result pixels). The
 * face's rim (RIM) and fixtures are left out. `mask` is at the pictures' size.
 */
export function faceScores(reference: Pixels, result: Pixels, mask: RegionMask, dx = 0, dy = 0): FaceScore[] {
  const a = edgeField(reference),
    b = edgeField(result);
  const { width, height } = a;
  // Each half-resolution pixel's face, or 0 at a rim, a fixture or the backdrop.
  const label = new Uint8Array(width * height);
  const at = (x: number, y: number) =>
    mask.data[Math.min(mask.height - 1, 2 * y) * mask.width + Math.min(mask.width - 1, 2 * x)];
  for (let y = RIM; y < height - RIM; y++)
    for (let x = RIM; x < width - RIM; x++) {
      const own = at(x, y);
      if (!own || own === FIXTURE_REGION) continue;
      if (
        [RIM, RIM / 2].every(
          (d) => at(x - d, y) === own && at(x + d, y) === own && at(x, y - d) === own && at(x, y + d) === own,
        )
      )
        label[y * width + x] = own;
    }
  const sx = Math.round(dx / 2),
    sy = Math.round(dy / 2);
  return mask.regions.flatMap((region, index) => {
    const own = index + 1;
    const where: number[] = [];
    for (let i = 0; i < label.length; i++) if (label[i] === own) where.push(i);
    if (where.length < width * height * MIN_SHARE) return [];
    let best = -1;
    for (let oy = -REACH; oy <= REACH; oy++)
      for (let ox = -REACH; ox <= REACH; ox++) {
        let n = 0,
          sa = 0,
          sb = 0,
          saa = 0,
          sbb = 0,
          sab = 0;
        for (const i of where) {
          const x = (i % width) + sx + ox,
            y = Math.floor(i / width) + sy + oy;
          if (x < 0 || y < 0 || x >= width || y >= height) continue;
          const va = a.data[i],
            vb = b.data[y * width + x];
          n++;
          sa += va;
          sb += vb;
          saa += va * va;
          sbb += vb * vb;
          sab += va * vb;
        }
        if (n < where.length / 2) continue;
        const cov = sab - (sa * sb) / n,
          va = saa - (sa * sa) / n,
          vb = sbb - (sb * sb) / n;
        best = Math.max(best, va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : 0);
      }
    return [{ key: region.key, kind: region.kind, pixels: where.length, score: +best.toFixed(3) }];
  });
}
/** The faces' scores as one number for the walls and one for the floor, weighted by size. */
export function summary(scores: readonly FaceScore[]) {
  const mean = (kind: 'wall' | 'floor') => {
    const rows = scores.filter((row) => row.kind === kind);
    const pixels = rows.reduce((sum, row) => sum + row.pixels, 0);
    return pixels ? +(rows.reduce((sum, row) => sum + row.score * row.pixels, 0) / pixels).toFixed(3) : NaN;
  };
  return { wall: mean('wall'), floor: mean('floor') };
}
