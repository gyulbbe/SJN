import type { FluxInputLayout } from './contract';

/**
 * Material colour in a FLUX result, without AI: each wall and floor of the result is compared with
 * the render it was made from, and where the model kept the framing its colour is moved back to
 * the render's. Hue and saturation move (Lab a*, b* mean shift); lightness moves only for light
 * tiles the model dimmed, and only part of the way. Shading and texture stay the model's, and no
 * render pixel is pasted. Fixtures, glass, the ceiling and anything outside the
 * room's faces keep the model's pixels exactly. Plain RGBA arrays, so the same code runs in the
 * page and in node checks.
 */
export type Pixels = { width: number; height: number; data: Uint8ClampedArray | Uint8Array };
export type FaceRegion = { key: string; kind: 'wall' | 'floor' };
/** What covers each pixel: 0 nothing checked, n `regions[n - 1]`, FIXTURE_REGION a fixture or glass. */
export type RegionMask = { width: number; height: number; regions: FaceRegion[]; data: Uint8Array };
export const FIXTURE_REGION = 255;

/** Search reach for the model's shift, as a share of the image width. */
export const MAX_SHIFT = 0.03;
/**
 * Lowest whole-picture edge correlation that counts as the same framing, from the ten saved
 * results: 0.46–0.61 where the model kept the room where it was, 0.34 where it widened the room
 * around it (faces no longer line up), 0.11 where it reframed.
 */
export const MIN_FRAMING = 0.4;
/** A face must cover this share of the result to be compared or corrected. */
export const MIN_REGION_SHARE = 0.01;
/** Pixels this close (result px) to another face, a fixture or the edge are not averaged. */
export const STATS_INSET = 3;
/** The correction fades in over this many result pixels next to fixtures and unchecked areas. */
export const FADE_PX = 2;
/** Larger shifts are the model painting another material; the correction stops here. */
export const MAX_SHIFT_AB = 30;
/**
 * Light tiles (render L* above this) that the model dimmed get part of their lightness back: a
 * white wall rendered darker and slightly warm reads as beige next to white fixtures (stage 3).
 * Never darkens: a brighter photographic result keeps its light.
 */
export const LIGHT_TILE_L = 70;
export const LIGHTNESS_SHARE = 0.5;
export const MAX_SHIFT_L = 10;
/**
 * Warning threshold on the colour change of a face (ΔE2000 with lightness held equal, so the
 * model's photographic light is not counted). The ten saved results stay below 5.
 */
export const COLOR_WARNING_DE = 6;
/**
 * A light near-grey tile (white walls) that gained a warm cast reads as beige long before the
 * ΔE threshold: stage-3 walls went from C* 2.4 to 3.9–4.7 with b* +1.5–2.1 and looked beige.
 * The 2026-09-25 stone walls, which lost warmth instead, are not flagged.
 */
export function isColorWarning(change: FaceChange): boolean {
  if (change.colorDeltaE > COLOR_WARNING_DE) return true;
  const [L, a, b] = change.reference,
    [, a1, b1] = change.result;
  const chroma = Math.hypot(a, b),
    gained = Math.hypot(a1, b1) - chroma;
  return L > LIGHT_TILE_L && chroma < 4 && b1 - b >= 1.2 && gained >= 1.2;
}

// ---------- colour ----------
const DECODE = Float32Array.from({ length: 256 }, (_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});
const labF = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 / 116) * t + 16 / 116);
const labInverse = (t: number) => (t ** 3 > 216 / 24389 ? t ** 3 : (116 * t - 16) / (24389 / 27));
const encode = (v: number) => {
  const c = v <= 0 ? 0 : v >= 1 ? 1 : v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  return c * 255;
};
export type Lab = [number, number, number];
/** 8-bit sRGB → CIE Lab (D65). */
export function rgbToLab(r: number, g: number, b: number): Lab {
  const R = DECODE[r],
    G = DECODE[g],
    B = DECODE[b];
  const x = labF((0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047);
  const y = labF(0.2126729 * R + 0.7151522 * G + 0.072175 * B);
  const z = labF((0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
/** CIE Lab (D65) → 8-bit sRGB, clipped. */
export function labToRgb(L: number, a: number, b: number): [number, number, number] {
  const fy = (L + 16) / 116;
  const X = labInverse(fy + a / 500) * 0.95047,
    Y = labInverse(fy),
    Z = labInverse(fy - b / 200) * 1.08883;
  return [
    encode(3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z),
    encode(-0.969266 * X + 1.8760108 * Y + 0.041556 * Z),
    encode(0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z),
  ];
}
/** CIEDE2000 between two Lab colours. */
export function deltaE2000([L1, a1, b1]: Lab, [L2, a2, b2]: Lab): number {
  const rad = Math.PI / 180;
  const Cm = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cm ** 7 / (Cm ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1,
    a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1),
    C2p = Math.hypot(a2p, b2);
  const hue = (x: number, y: number) => {
    const angle = Math.atan2(y, x) / rad;
    return angle < 0 ? angle + 360 : angle;
  };
  const h1p = hue(a1p, b1),
    h2p = hue(a2p, b2);
  let dhp = h2p - h1p;
  if (C1p * C2p === 0) dhp = 0;
  else if (dhp > 180) dhp -= 360;
  else if (dhp < -180) dhp += 360;
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * rad);
  const Lm = (L1 + L2) / 2,
    Cmp = (C1p + C2p) / 2;
  let hm = h1p + h2p;
  if (C1p * C2p !== 0) hm = Math.abs(h1p - h2p) <= 180 ? hm / 2 : hm < 360 ? (hm + 360) / 2 : (hm - 360) / 2;
  const T =
    1 -
    0.17 * Math.cos((hm - 30) * rad) +
    0.24 * Math.cos(2 * hm * rad) +
    0.32 * Math.cos((3 * hm + 6) * rad) -
    0.2 * Math.cos((4 * hm - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hm - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cmp ** 7 / (Cmp ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lm - 50) ** 2) / Math.sqrt(20 + (Lm - 50) ** 2);
  const Sc = 1 + 0.045 * Cmp,
    Sh = 1 + 0.015 * Cmp * T;
  const Rt = -Math.sin(2 * dTheta * rad) * Rc;
  const dCp = C2p - C1p;
  return Math.sqrt(((L2 - L1) / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh));
}

// ---------- geometry: capture ↔ result ----------
/** Result pixel centre → capture coordinate, through the padded model input (see fluxInputLayout). */
export function resultToCapture(layout: FluxInputLayout, result: { width: number; height: number }) {
  const sx = result.width / layout.width,
    sy = result.height / layout.height;
  return (u: number, v: number) => ({
    x: ((u + 0.5) / sx - layout.x) / layout.scale - 0.5,
    y: ((v + 0.5) / sy - layout.y) / layout.scale - 0.5,
  });
}
/** The render as the model saw it, at result size: white padding, bilinear resampling. */
export function projectCapture(
  capture: Pixels,
  layout: FluxInputLayout,
  size: { width: number; height: number },
) {
  const map = resultToCapture(layout, size);
  const out = new Uint8ClampedArray(size.width * size.height * 4);
  for (let v = 0; v < size.height; v++)
    for (let u = 0; u < size.width; u++) {
      const { x, y } = map(u, v);
      const o = (v * size.width + u) * 4;
      if (x < -0.5 || y < -0.5 || x > capture.width - 0.5 || y > capture.height - 0.5) {
        out.fill(255, o, o + 4);
        continue;
      }
      const x0 = Math.max(0, Math.min(capture.width - 1, Math.floor(x))),
        y0 = Math.max(0, Math.min(capture.height - 1, Math.floor(y)));
      const x1 = Math.min(capture.width - 1, x0 + 1),
        y1 = Math.min(capture.height - 1, y0 + 1);
      const fx = Math.max(0, Math.min(1, x - x0)),
        fy = Math.max(0, Math.min(1, y - y0));
      for (let c = 0; c < 4; c++) {
        const at = (px: number, py: number) => capture.data[(py * capture.width + px) * 4 + c];
        out[o + c] =
          (at(x0, y0) * (1 - fx) + at(x1, y0) * fx) * (1 - fy) +
          (at(x0, y1) * (1 - fx) + at(x1, y1) * fx) * fy;
      }
    }
  return { width: size.width, height: size.height, data: out };
}
/** The capture's region mask at result size (nearest sample; padding is unchecked). */
export function projectMask(
  mask: RegionMask,
  layout: FluxInputLayout,
  size: { width: number; height: number },
) {
  const map = resultToCapture(layout, size);
  // The mask may be drawn at another size than the capture it belongs to.
  const kx = mask.width / (layout.contentWidth / layout.scale),
    ky = mask.height / (layout.contentHeight / layout.scale);
  const out = new Uint8Array(size.width * size.height);
  for (let v = 0; v < size.height; v++)
    for (let u = 0; u < size.width; u++) {
      const { x, y } = map(u, v);
      const mx = Math.round((x + 0.5) * kx - 0.5),
        my = Math.round((y + 0.5) * ky - 0.5);
      if (mx >= 0 && my >= 0 && mx < mask.width && my < mask.height)
        out[v * size.width + u] = mask.data[my * mask.width + mx];
    }
  return { width: size.width, height: size.height, regions: mask.regions, data: out };
}
/** The mask moved by the model's shift (result pixel (x, y) shows render pixel (x − dx, y − dy)). */
export function shiftMask(mask: RegionMask, dx: number, dy: number): RegionMask {
  const { width, height } = mask;
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const sy = y - dy;
    if (sy < 0 || sy >= height) continue;
    for (let x = 0; x < width; x++) {
      const sx = x - dx;
      if (sx >= 0 && sx < width) out[y * width + x] = mask.data[sy * width + sx];
    }
  }
  return { ...mask, data: out };
}

// ---------- framing ----------
/** Gradient magnitude of luminance at half resolution (fine detail from the model is noise here). */
type EdgeImage = { width: number; height: number; data: Float32Array };
function edges(image: Pixels): EdgeImage {
  const width = Math.floor(image.width / 2),
    height = Math.floor(image.height / 2);
  const lum = new Float32Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (const [dx, dy] of [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
      ]) {
        const i = ((2 * y + dy) * image.width + 2 * x + dx) * 4;
        sum += 0.2126 * image.data[i] + 0.7152 * image.data[i + 1] + 0.0722 * image.data[i + 2];
      }
      lum[y * width + x] = sum / 4;
    }
  // A light blur first, so stone veins, grain and JPEG blocks weigh less than outlines.
  const soft = new Float32Array(width * height);
  for (let y = 1; y < height - 1; y++)
    for (let x = 1; x < width - 1; x++) {
      let sum = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) sum += lum[(y + dy) * width + x + dx];
      soft[y * width + x] = sum / 9;
    }
  const grad = new Float32Array(width * height);
  for (let y = 2; y < height - 2; y++)
    for (let x = 2; x < width - 2; x++) {
      const i = y * width + x;
      grad[i] = Math.hypot(soft[i + 1] - soft[i - 1], soft[i + width] - soft[i - width]);
    }
  return { width, height, data: grad };
}
function halve(image: EdgeImage): EdgeImage {
  const width = Math.floor(image.width / 2),
    height = Math.floor(image.height / 2);
  const data = new Float32Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = 2 * y * image.width + 2 * x;
      data[y * width + x] =
        (image.data[i] + image.data[i + 1] + image.data[i + image.width] + image.data[i + image.width + 1]) /
        4;
    }
  return { width, height, data };
}
function correlate(a: EdgeImage, b: EdgeImage, margin: number, dx: number, dy: number) {
  let sa = 0,
    sb = 0,
    n = 0;
  for (let y = margin; y < a.height - margin; y++)
    for (let x = margin; x < a.width - margin; x++) {
      const bx = x + dx,
        by = y + dy;
      if (bx < 0 || by < 0 || bx >= b.width || by >= b.height) continue;
      sa += a.data[y * a.width + x];
      sb += b.data[by * b.width + bx];
      n++;
    }
  if (!n) return -1;
  const ma = sa / n,
    mb = sb / n;
  let cov = 0,
    va = 0,
    vb = 0;
  for (let y = margin; y < a.height - margin; y++)
    for (let x = margin; x < a.width - margin; x++) {
      const bx = x + dx,
        by = y + dy;
      if (bx < 0 || by < 0 || bx >= b.width || by >= b.height) continue;
      const da = a.data[y * a.width + x] - ma,
        db = b.data[by * b.width + bx] - mb;
      cov += da * db;
      va += da * da;
      vb += db * db;
    }
  return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : 0;
}
export type Framing = { dx: number; dy: number; score: number; aligned: boolean };
/**
 * Whether the model kept the framing: one shift for the whole picture (the room's edges), searched
 * within ±MAX_SHIFT at quarter resolution. A reframed or zoomed result scores low here.
 */
export function framing(reference: Pixels, result: Pixels): Framing {
  const a = halve(edges(reference)),
    b = halve(edges(result));
  const reach = Math.max(1, Math.round(MAX_SHIFT * b.width));
  let best = { dx: 0, dy: 0, score: -1 };
  for (let dy = -reach; dy <= reach; dy++)
    for (let dx = -reach; dx <= reach; dx++) {
      const score = correlate(a, b, reach, dx, dy);
      if (score > best.score) best = { dx, dy, score };
    }
  const inside = Math.abs(best.dx) < reach && Math.abs(best.dy) < reach;
  return {
    dx: best.dx * 4,
    dy: best.dy * 4,
    score: best.score,
    aligned: inside && best.score >= MIN_FRAMING,
  };
}

// ---------- faces ----------
/**
 * Chessboard distance of every pixel to the nearest pixel that `stop` accepts (0 on those pixels;
 * the image border counts as one too).
 */
function distanceTo(mask: RegionMask, stop: (label: number, x: number, y: number) => boolean) {
  const { width, height, data } = mask;
  const far = width + height;
  const d = new Uint16Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      d[i] = stop(data[i], x, y) ? 0 : x === 0 || y === 0 || x === width - 1 || y === height - 1 ? 1 : far;
    }
  for (let y = 1; y < height; y++)
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      d[i] = Math.min(d[i], d[i - 1] + 1, d[i - width] + 1, d[i - width - 1] + 1, d[i - width + 1] + 1);
    }
  for (let y = height - 2; y >= 0; y--)
    for (let x = width - 2; x >= 1; x--) {
      const i = y * width + x;
      d[i] = Math.min(d[i], d[i + 1] + 1, d[i + width] + 1, d[i + width + 1] + 1, d[i + width - 1] + 1);
    }
  return d;
}
/** Pixels next to a different label (4-neighbourhood). */
function edgeOf(mask: RegionMask) {
  const { width, height, data } = mask;
  return (label: number, x: number, y: number) =>
    (x > 0 && data[y * width + x - 1] !== label) ||
    (x < width - 1 && data[y * width + x + 1] !== label) ||
    (y > 0 && data[(y - 1) * width + x] !== label) ||
    (y < height - 1 && data[(y + 1) * width + x] !== label);
}
export type FaceColor = { region: number; pixels: number; lab: Lab };
/** Mean Lab of each face's interior (STATS_INSET away from any other label and the border). */
export function faceColors(image: Pixels, mask: RegionMask): FaceColor[] {
  const inset = distanceTo(mask, edgeOf(mask));
  const sums = mask.regions.map(() => ({ L: 0, a: 0, b: 0, n: 0 }));
  for (let i = 0; i < mask.data.length; i++) {
    const label = mask.data[i];
    if (!label || label === FIXTURE_REGION || label > sums.length || inset[i] < STATS_INSET) continue;
    const [L, a, b] = rgbToLab(image.data[i * 4], image.data[i * 4 + 1], image.data[i * 4 + 2]);
    const sum = sums[label - 1];
    sum.L += L;
    sum.a += a;
    sum.b += b;
    sum.n++;
  }
  const minimum = MIN_REGION_SHARE * mask.width * mask.height;
  return sums.flatMap((sum, i) =>
    sum.n >= minimum
      ? [{ region: i + 1, pixels: sum.n, lab: [sum.L / sum.n, sum.a / sum.n, sum.b / sum.n] as Lab }]
      : [],
  );
}

export type FaceChange = {
  region: number;
  kind: 'wall' | 'floor';
  reference: Lab;
  result: Lab;
  /** Full ΔE2000 (lightness included). */
  deltaE: number;
  /** ΔE2000 with the result's lightness set to the render's: the colour change alone. */
  colorDeltaE: number;
  /** How the colour moved, for the warning text. */
  shift: 'warmer' | 'cooler' | 'more-saturated' | 'less-saturated' | 'hue';
};
function describeShift(reference: Lab, result: Lab): FaceChange['shift'] {
  const da = result[1] - reference[1],
    db = result[2] - reference[2];
  const c0 = Math.hypot(reference[1], reference[2]),
    c1 = Math.hypot(result[1], result[2]);
  // A near-grey reference: any colour it gains reads as a warm (yellow/red) or cool (blue) cast.
  if (c0 < 6) return db + 0.3 * da >= 0 ? 'warmer' : 'cooler';
  if (Math.abs(c1 - c0) > Math.hypot(da, db) * 0.7) return c1 > c0 ? 'more-saturated' : 'less-saturated';
  return db > 0 ? 'warmer' : db < 0 ? 'cooler' : 'hue';
}
/** Per face: how far the result's mean colour is from the render's (mask already at the result's framing). */
export function compareFaces(
  reference: Pixels,
  result: Pixels,
  referenceMask: RegionMask,
  resultMask: RegionMask,
) {
  const before = new Map(faceColors(reference, referenceMask).map((f) => [f.region, f]));
  const changes: FaceChange[] = [];
  for (const after of faceColors(result, resultMask)) {
    const source = before.get(after.region);
    if (!source) continue;
    const held: Lab = [source.lab[0], after.lab[1], after.lab[2]];
    changes.push({
      region: after.region,
      kind: referenceMask.regions[after.region - 1].kind,
      reference: source.lab,
      result: after.lab,
      deltaE: deltaE2000(source.lab, after.lab),
      colorDeltaE: deltaE2000(source.lab, held),
      shift: describeShift(source.lab, after.lab),
    });
  }
  return changes;
}

/**
 * Moves each face's mean a*, b* in `result` to the render's (capped at MAX_SHIFT_AB), faded in
 * over FADE_PX next to fixtures and unchecked areas, and lightly smoothed across face seams.
 * Fixture, glass and unchecked pixels are returned unchanged.
 */
export function correctFaces(result: Pixels, mask: RegionMask, changes: FaceChange[]): Pixels {
  const { width, height } = result;
  const shifts = new Map<number, [number, number, number]>();
  for (const change of changes) {
    let da = change.reference[1] - change.result[1],
      db = change.reference[2] - change.result[2];
    const size = Math.hypot(da, db);
    if (size > MAX_SHIFT_AB) {
      da *= MAX_SHIFT_AB / size;
      db *= MAX_SHIFT_AB / size;
    }
    const dimmed = change.reference[0] - change.result[0];
    const dL =
      change.reference[0] > LIGHT_TILE_L && dimmed > 0 ? Math.min(MAX_SHIFT_L, dimmed * LIGHTNESS_SHARE) : 0;
    shifts.set(change.region, [da, db, dL]);
  }
  const open = distanceTo(mask, (label) => !label || label === FIXTURE_REGION || !shifts.has(label));
  const fieldA = new Float32Array(width * height),
    fieldB = new Float32Array(width * height),
    fieldL = new Float32Array(width * height);
  for (let i = 0; i < mask.data.length; i++) {
    const shift = shifts.get(mask.data[i]);
    if (!shift) continue;
    const k = Math.min(1, Math.max(0, (open[i] - 1) / FADE_PX));
    fieldA[i] = shift[0] * k;
    fieldB[i] = shift[1] * k;
    fieldL[i] = shift[2] * k;
  }
  // A 5×5 box blur softens face seams; checked pixels only, so nothing leaks into fixtures.
  const blur = (field: Float32Array) => {
    const horizontal = new Float32Array(field.length),
      out = new Float32Array(field.length);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        let sum = 0,
          n = 0;
        for (let k = -2; k <= 2; k++) {
          const px = x + k;
          if (px < 0 || px >= width) continue;
          sum += field[y * width + px];
          n++;
        }
        horizontal[y * width + x] = sum / n;
      }
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        let sum = 0,
          n = 0;
        for (let k = -2; k <= 2; k++) {
          const py = y + k;
          if (py < 0 || py >= height) continue;
          sum += horizontal[py * width + x];
          n++;
        }
        out[y * width + x] = sum / n;
      }
    return out;
  };
  const smoothA = blur(fieldA),
    smoothB = blur(fieldB),
    smoothL = blur(fieldL);
  const out = new Uint8ClampedArray(result.data);
  for (let i = 0; i < mask.data.length; i++) {
    if (!shifts.has(mask.data[i])) continue;
    const da = smoothA[i],
      db = smoothB[i],
      dL = smoothL[i];
    if (Math.abs(da) < 0.05 && Math.abs(db) < 0.05 && dL < 0.05) continue;
    const o = i * 4;
    const [L, a, b] = rgbToLab(result.data[o], result.data[o + 1], result.data[o + 2]);
    const [r, g, bl] = labToRgb(L + dL, a + da, b + db);
    out[o] = r;
    out[o + 1] = g;
    out[o + 2] = bl;
  }
  return { width, height, data: out };
}

export type ColorReview = {
  framing: Framing;
  /** Face changes of the model's result (empty when the framing changed). */
  changes: FaceChange[];
  /** Faces whose colour changed noticeably in the model's result (isColorWarning). */
  warnings: FaceChange[];
  /** The result with the faces' colours moved back; absent when not applied (framing changed). */
  corrected?: Pixels;
  /** Face changes left after the correction. */
  residual?: FaceChange[];
};
/**
 * Checks and corrects one FLUX result against the render it was made from. `capture` is the render
 * (any size), `mask` its regions (any size, same framing), `layout` the model input's padding.
 */
export function reviewResultColors(input: {
  capture: Pixels;
  mask: RegionMask;
  layout: FluxInputLayout;
  result: Pixels;
}): ColorReview {
  const size = { width: input.result.width, height: input.result.height };
  const reference = projectCapture(input.capture, input.layout, size);
  const referenceMask = projectMask(input.mask, input.layout, size);
  const frame = framing(reference, input.result);
  if (!frame.aligned) return { framing: frame, changes: [], warnings: [] };
  const resultMask = shiftMask(referenceMask, frame.dx, frame.dy);
  const changes = compareFaces(reference, input.result, referenceMask, resultMask);
  const warnings = changes.filter(isColorWarning);
  const corrected = correctFaces(input.result, resultMask, changes);
  const residual = compareFaces(reference, corrected, referenceMask, resultMask);
  return { framing: frame, changes, warnings, corrected, residual };
}
