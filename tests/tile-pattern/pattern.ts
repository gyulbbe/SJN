/**
 * The pattern score of the tile-pattern trial (docs/tile-pattern-trials-20261115.md): per wall and
 * floor, how much of the render's fine pattern INSIDE the tiles (printed lines, marble veins, waves)
 * the model kept. The joint score (joints.ts `faceScores`) compares the joints only, so a face whose
 * grid stayed but whose tiles went plain passes it; here the joints are left out and the rest of the
 * fine detail is compared.
 *
 * Fine detail is luminance over its own blur inside the face (the restore's `LIGHT_BLUR`, so it is the
 * same detail a restore would put back). Joint pixels are where the widened-joints capture differs
 * from the render. The model may sit a few pixels off: the best correlation over small shifts around
 * the whole-picture shift counts. A face whose render has almost no fine detail (a plain tile) is not
 * judged.
 */
import { FIXTURE_REGION, type Pixels, type RegionMask } from '../../src/lib/ai-export/color';
import { blurInside, LIGHT_BLUR } from '../../src/lib/ai-export/joints';

/** Pixels each way the model's tiles may sit off the whole-picture shift. */
export const PATTERN_REACH = 4;
/** The face's rim left out (pixels): corners, edges and fixture outlines are not pattern. */
export const PATTERN_RIM = 10;
/** A render pixel this much (grey levels) different in the widened-joints capture is a joint. */
export const JOINT_DIFF = 6;
/** Joint pixels grow by this much before they are left out. */
export const JOINT_GROW = 2;
/** Under this spread of fine detail (grey levels, render) a face has no pattern to keep. */
export const MIN_DETAIL = 1.2;
/** A face smaller than this share of the picture is not judged. */
export const MIN_SHARE = 0.01;
/** Every this-many pixels each way are compared (speed). */
export const STEP = 2;

export type PatternScore = {
  key: string;
  kind: 'wall' | 'floor';
  pixels: number;
  /** Spread of the render's fine detail inside the tiles (grey levels). */
  detail: number;
  /** Best correlation of the two pictures' fine detail inside the tiles (−1…1). */
  score: number;
  /** The model's fine-detail spread over the render's, at the best shift (1 = as strong). */
  ratio: number;
  /**
   * How much fine detail the model kept, wherever it sits: the median size of its fine detail over the
   * render's, inside the tiles. Glare edges and moved joints are rare and do not move a median; a
   * marble the model drew with other veins keeps it near 1, a tile it left plain takes it towards 0.
   */
  amount: number;
  /** The same at the 75th percentile. */
  amount75: number;
};
const quantile = (values: number[], q: number) => {
  const sorted = [...values].sort((x, y) => x - y);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0;
};

const lum = (image: Pixels) => {
  const out = new Float32Array(image.width * image.height);
  for (let i = 0; i < out.length; i++)
    out[i] = 0.2126 * image.data[i * 4] + 0.7152 * image.data[i * 4 + 1] + 0.0722 * image.data[i * 4 + 2];
  return out;
};
/** Luminance over its blur inside `weight` (0/1), as a difference in grey levels. */
function fine(value: Float32Array, weight: Float32Array, width: number, height: number, radius: number) {
  const { mean } = blurInside(value, weight, width, height, radius);
  const out = new Float32Array(value.length);
  for (let i = 0; i < out.length; i++) out[i] = weight[i] ? value[i] - mean[i] : 0;
  return out;
}

/**
 * `reference` and `joints` are the render and its widened-joints copy at the result's size, `mask`
 * their regions (not shifted), `dx`/`dy` the model's whole-picture shift (result pixels).
 */
export function patternScores(
  reference: Pixels,
  joints: Pixels,
  result: Pixels,
  mask: RegionMask,
  dx = 0,
  dy = 0,
): PatternScore[] {
  const { width, height } = result;
  const count = width * height;
  const a = lum(reference),
    j = lum(joints),
    b = lum(result);
  const radius = Math.max(2, Math.round(width * LIGHT_BLUR));
  // Joint pixels, grown.
  const joint = new Uint8Array(count);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (Math.abs(j[y * width + x] - a[y * width + x]) > JOINT_DIFF)
        for (let oy = -JOINT_GROW; oy <= JOINT_GROW; oy++)
          for (let ox = -JOINT_GROW; ox <= JOINT_GROW; ox++) {
            const xx = x + ox,
              yy = y + oy;
            if (xx >= 0 && yy >= 0 && xx < width && yy < height) joint[yy * width + xx] = 1;
          }
  const at = (x: number, y: number) =>
    x < 0 || y < 0 || x >= width || y >= height ? 0 : mask.data[y * mask.width + x];
  const sx = Math.round(dx),
    sy = Math.round(dy);
  return mask.regions.flatMap((region, index) => {
    const own = index + 1;
    if (own === FIXTURE_REGION) return [];
    // The face in the render, and where it sits in the result.
    const face = new Float32Array(count),
      moved = new Float32Array(count);
    let size = 0;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++)
        if (at(x, y) === own) {
          face[y * width + x] = 1;
          size++;
          const xx = x + sx,
            yy = y + sy;
          if (xx >= 0 && yy >= 0 && xx < width && yy < height) moved[yy * width + xx] = 1;
        }
    if (size < count * MIN_SHARE) return [];
    const fa = fine(a, face, width, height, radius),
      fb = fine(b, moved, width, height, radius);
    // Compared pixels: deep inside the face, not on a joint, every STEP pixels.
    const where: number[] = [];
    for (let y = PATTERN_RIM; y < height - PATTERN_RIM; y += STEP)
      for (let x = PATTERN_RIM; x < width - PATTERN_RIM; x += STEP) {
        const i = y * width + x;
        if (at(x, y) !== own || joint[i]) continue;
        if (
          [PATTERN_RIM, PATTERN_RIM / 2].every(
            (d) =>
              at(x - d, y) === own && at(x + d, y) === own && at(x, y - d) === own && at(x, y + d) === own,
          )
        )
          where.push(i);
      }
    if (where.length < 50) return [];
    let s = 0,
      ss = 0;
    for (const i of where) {
      s += fa[i];
      ss += fa[i] * fa[i];
    }
    const detail = Math.sqrt(Math.max(0, ss / where.length - (s / where.length) ** 2));
    if (detail < MIN_DETAIL) return [];
    let best = -1,
      ratio = 0;
    for (let oy = -PATTERN_REACH; oy <= PATTERN_REACH; oy++)
      for (let ox = -PATTERN_REACH; ox <= PATTERN_REACH; ox++) {
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
          const va = fa[i],
            vb = fb[y * width + x];
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
        const r = va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : 0;
        if (r > best) {
          best = r;
          ratio = va > 0 ? Math.sqrt(vb / va) : 0;
        }
      }
    const own_ = where.map((i) => Math.abs(fa[i]));
    const theirs = where.flatMap((i) => {
      const x = (i % width) + sx,
        y = Math.floor(i / width) + sy;
      return x < 0 || y < 0 || x >= width || y >= height ? [] : [Math.abs(fb[y * width + x])];
    });
    const amount = (q: number) => quantile(theirs, q) / Math.max(1e-3, quantile(own_, q));
    return [
      {
        key: region.key,
        kind: region.kind,
        pixels: where.length,
        detail: +detail.toFixed(2),
        score: +best.toFixed(3),
        ratio: +ratio.toFixed(2),
        amount: +amount(0.5).toFixed(2),
        amount75: +amount(0.75).toFixed(2),
      },
    ];
  });
}
