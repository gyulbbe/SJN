/**
 * Tile features without a model, for the catalog-match trial (docs/catalog-match-trials-20261102.md):
 * Lab colour (mean, histograms), texture numbers (contrast, grain direction, repeat spacing) and a weak
 * size score. Pure functions over RGBA pixels, used in node (sharp) and in the page alike.
 */

export type Rgba = { data: ArrayLike<number>; width: number; height: number };
export type Lab = [number, number, number];

const linear = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const LINEAR = Float64Array.from({ length: 256 }, (_, i) => linear(i));
const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);

/** sRGB 0–255 → CIE Lab (D65). */
export function rgbToLab(r: number, g: number, b: number): Lab {
  const R = LINEAR[r | 0],
    G = LINEAR[g | 0],
    B = LINEAR[b | 0];
  const x = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047,
    y = 0.2126729 * R + 0.7151522 * G + 0.072175 * B,
    z = (0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883;
  const fx = f(x),
    fy = f(y),
    fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIEDE2000 colour difference. */
export function deltaE2000(a: Lab, b: Lab): number {
  const [L1, a1, b1] = a,
    [L2, a2, b2] = b;
  const C1 = Math.hypot(a1, b1),
    C2 = Math.hypot(a2, b2),
    Cm = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cm ** 7 / (Cm ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1,
    a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1),
    C2p = Math.hypot(a2p, b2);
  const h = (x: number, y: number) => {
    if (x === 0 && y === 0) return 0;
    const angle = (Math.atan2(y, x) * 180) / Math.PI;
    return angle < 0 ? angle + 360 : angle;
  };
  const h1p = h(a1p, b1),
    h2p = h(a2p, b2);
  const dLp = L2 - L1,
    dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp * Math.PI) / 360);
  const Lmp = (L1 + L2) / 2,
    Cmp = (C1p + C2p) / 2;
  let hmp = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) > 180) hmp += h1p + h2p < 360 ? 360 : -360;
    hmp /= 2;
  }
  const rad = (d: number) => (d * Math.PI) / 180;
  const T =
    1 -
    0.17 * Math.cos(rad(hmp - 30)) +
    0.24 * Math.cos(rad(2 * hmp)) +
    0.32 * Math.cos(rad(3 * hmp + 6)) -
    0.2 * Math.cos(rad(4 * hmp - 63));
  const dTheta = 30 * Math.exp(-(((hmp - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cmp ** 7 / (Cmp ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lmp - 50) ** 2) / Math.sqrt(20 + (Lmp - 50) ** 2),
    Sc = 1 + 0.045 * Cmp,
    Sh = 1 + 0.015 * Cmp * T;
  const Rt = -Math.sin(rad(2 * dTheta)) * Rc;
  return Math.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh));
}

/** Histogram ranges: L 0–100, a and b −48…48 (tiles are rarely more saturated). */
export const HIST_BINS = 16;
const binOf = (value: number, lo: number, hi: number) =>
  Math.max(0, Math.min(HIST_BINS - 1, Math.floor(((value - lo) / (hi - lo)) * HIST_BINS)));

export type ColourFeatures = {
  mean: Lab;
  /** L, a, b histograms, each summing to 1. */
  hist: [number[], number[], number[]];
  /** Coarse joint histogram (4×4×4), summing to 1. */
  joint: number[];
  pixels: number;
};

/** Colour statistics of the opaque pixels where `mask` (one byte a pixel, optional) is non-zero. */
export function colourFeatures(image: Rgba, mask?: ArrayLike<number>): ColourFeatures {
  const hist: [number[], number[], number[]] = [
    new Array(HIST_BINS).fill(0),
    new Array(HIST_BINS).fill(0),
    new Array(HIST_BINS).fill(0),
  ];
  const joint = new Array(64).fill(0);
  let n = 0,
    L = 0,
    A = 0,
    B = 0;
  const { data, width, height } = image;
  for (let i = 0; i < width * height; i++) {
    if (mask && !mask[i]) continue;
    if (data[i * 4 + 3] < 128) continue;
    const [l, a, b] = rgbToLab(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
    L += l;
    A += a;
    B += b;
    n++;
    hist[0][binOf(l, 0, 100)]++;
    hist[1][binOf(a, -48, 48)]++;
    hist[2][binOf(b, -48, 48)]++;
    const j = (x: number, lo: number, hi: number) =>
      Math.max(0, Math.min(3, Math.floor(((x - lo) / (hi - lo)) * 4)));
    joint[j(l, 0, 100) * 16 + j(a, -24, 24) * 4 + j(b, -24, 24)]++;
  }
  const norm = (values: number[]) => values.map((v) => (n ? v / n : 0));
  return {
    mean: n ? [L / n, A / n, B / n] : [0, 0, 0],
    hist: [norm(hist[0]), norm(hist[1]), norm(hist[2])],
    joint: norm(joint),
    pixels: n,
  };
}

/** Bhattacharyya distance (0 same … 1 disjoint) of two normalised histograms. */
export function histogramDistance(p: number[], q: number[]): number {
  let bc = 0;
  for (let i = 0; i < p.length; i++) bc += Math.sqrt(p[i] * q[i]);
  return Math.sqrt(Math.max(0, 1 - bc));
}
export function colourDistance(p: ColourFeatures, q: ColourFeatures): number {
  return (
    (histogramDistance(p.hist[0], q.hist[0]) +
      histogramDistance(p.hist[1], q.hist[1]) +
      histogramDistance(p.hist[2], q.hist[2]) +
      histogramDistance(p.joint, q.joint)) /
    4
  );
}

export type TextureFeatures = {
  /** Luminance standard deviation, 0–1. */
  contrast: number;
  /** Gradient orientation histogram (8 bins over 180°), magnitude-weighted, summing to 1. */
  orientation: number[];
  /** Mean gradient magnitude, 0–1 per pixel step. */
  edges: number;
  /** Strongest repeat along x and y in pixels from autocorrelation of row/column means (0 = none). */
  period: [number, number];
};

/** Texture numbers of a (rectified) crop. */
export function textureFeatures(image: Rgba, mask?: ArrayLike<number>): TextureFeatures {
  const { data, width, height } = image;
  const Y = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++)
    Y[i] = (0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2]) / 255;
  let sum = 0,
    sum2 = 0,
    n = 0;
  for (let i = 0; i < Y.length; i++) {
    if (mask && !mask[i]) continue;
    sum += Y[i];
    sum2 += Y[i] * Y[i];
    n++;
  }
  const mean = n ? sum / n : 0;
  const contrast = n ? Math.sqrt(Math.max(0, sum2 / n - mean * mean)) : 0;
  const orientation = new Array(8).fill(0);
  let magnitude = 0,
    m = 0;
  for (let y = 1; y < height - 1; y++)
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      if (mask && !mask[i]) continue;
      const gx = Y[i + 1] - Y[i - 1],
        gy = Y[i + width] - Y[i - width];
      const g = Math.hypot(gx, gy);
      magnitude += g;
      m++;
      let angle = Math.atan2(gy, gx);
      if (angle < 0) angle += Math.PI;
      orientation[Math.min(7, Math.floor((angle / Math.PI) * 8))] += g;
    }
  const total = orientation.reduce((a, b) => a + b, 0);
  const period = (profile: Float32Array) => {
    const length = profile.length;
    let average = 0;
    for (const v of profile) average += v;
    average /= length || 1;
    let best = 0,
      bestLag = 0;
    let zero = 0;
    for (let i = 0; i < length; i++) zero += (profile[i] - average) ** 2;
    if (!zero) return 0;
    for (let lag = 4; lag < length / 2; lag++) {
      let c = 0;
      for (let i = 0; i + lag < length; i++) c += (profile[i] - average) * (profile[i + lag] - average);
      c /= zero;
      if (c > best) {
        best = c;
        bestLag = lag;
      }
    }
    return best > 0.3 ? bestLag : 0;
  };
  const columns = new Float32Array(width),
    rows = new Float32Array(height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      columns[x] += Y[y * width + x] / height;
      rows[y] += Y[y * width + x] / width;
    }
  return {
    contrast,
    orientation: orientation.map((v) => (total ? v / total : 0)),
    edges: m ? magnitude / m : 0,
    period: [period(columns), period(rows)],
  };
}

export function textureDistance(p: TextureFeatures, q: TextureFeatures): number {
  const orientation = histogramDistance(p.orientation, q.orientation);
  const contrast = Math.abs(p.contrast - q.contrast) / Math.max(0.02, p.contrast + q.contrast);
  const edges = Math.abs(p.edges - q.edges) / Math.max(0.005, p.edges + q.edges);
  return (orientation + contrast + edges) / 3;
}

/**
 * A weak size score: 0 when the catalog size (either way round) is near the estimate, up to 1 when
 * it is 3× off. Estimates from photos follow the room size the user typed, so this stays weak.
 */
export function sizeDistance(
  catalog: { widthMm: number; heightMm: number },
  estimate: { widthMm: number; heightMm: number } | undefined,
): number {
  if (!estimate || !(estimate.widthMm > 0) || !(estimate.heightMm > 0)) return 0;
  const off = (w: number, h: number) =>
    Math.abs(Math.log(w / estimate.widthMm)) + Math.abs(Math.log(h / estimate.heightMm));
  const best = Math.min(off(catalog.widthMm, catalog.heightMm), off(catalog.heightMm, catalog.widthMm));
  return Math.min(1, best / (2 * Math.log(3)));
}

// ---------- geometry: the plane quad, the clean rectangle ----------
export type Point = { x: number; y: number };
export type Quad = [Point, Point, Point, Point];

/** The 3×3 homography taking the unit square (0,0)(1,0)(1,1)(0,1) to `quad`. */
export function squareToQuad(quad: Quad): number[] {
  const [p0, p1, p2, p3] = quad;
  const dx1 = p1.x - p2.x,
    dx2 = p3.x - p2.x,
    dx3 = p0.x - p1.x + p2.x - p3.x,
    dy1 = p1.y - p2.y,
    dy2 = p3.y - p2.y,
    dy3 = p0.y - p1.y + p2.y - p3.y;
  const det = dx1 * dy2 - dx2 * dy1;
  const g = (dx3 * dy2 - dx2 * dy3) / det,
    h = (dx1 * dy3 - dx3 * dy1) / det;
  return [
    p1.x - p0.x + g * p1.x,
    p3.x - p0.x + h * p3.x,
    p0.x,
    p1.y - p0.y + g * p1.y,
    p3.y - p0.y + h * p3.y,
    p0.y,
    g,
    h,
    1,
  ];
}
export function applyHomography(m: number[], p: Point): Point {
  const w = m[6] * p.x + m[7] * p.y + m[8];
  return { x: (m[0] * p.x + m[1] * p.y + m[2]) / w, y: (m[3] * p.x + m[4] * p.y + m[5]) / w };
}
export function invertHomography(m: number[]): number[] {
  const [a, b, c, d, e, f2, g, h, i] = m;
  const A = e * i - f2 * h,
    B = -(d * i - f2 * g),
    C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [
    A / det,
    -(b * i - c * h) / det,
    (b * f2 - c * e) / det,
    B / det,
    (a * i - c * g) / det,
    -(a * f2 - c * d) / det,
    C / det,
    -(a * h - b * g) / det,
    (a * e - b * d) / det,
  ];
}

export type Box = { left: number; top: number; right: number; bottom: number };
export type UvRect = { u0: number; v0: number; u1: number; v1: number };

/**
 * The largest rectangle (in the face's u-v square) that stays inside the photo frame and clear of
 * the given image boxes (products, mirrors, doors), on a `grid`×`grid` lattice. Area is measured in
 * face u-v (so in mm up to the face's size), not in pixels. `isBlocked` adds a per-point test on the
 * image (round 9: a pixel the segmentation does not call this face's wall or floor).
 */
export function cleanRectangle(
  quad: Quad,
  blockers: Box[],
  options: { grid?: number; frameMargin?: number; isBlocked?: (p: Point) => boolean } = {},
): UvRect | undefined {
  const grid = options.grid ?? 24,
    margin = options.frameMargin ?? 0.01;
  const m = squareToQuad(quad);
  const free: boolean[] = [];
  for (let j = 0; j < grid; j++)
    for (let i = 0; i < grid; i++) {
      let ok = true;
      // A cell is free when its centre and corners are in frame and out of every blocker.
      for (const [du, dv] of [
        [0.5, 0.5],
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ]) {
        const p = applyHomography(m, { x: (i + du) / grid, y: (j + dv) / grid });
        if (!(p.x >= margin && p.x <= 1 - margin && p.y >= margin && p.y <= 1 - margin)) ok = false;
        else if (blockers.some((b) => p.x > b.left && p.x < b.right && p.y > b.top && p.y < b.bottom))
          ok = false;
        else if (options.isBlocked?.(p)) ok = false;
        if (!ok) break;
      }
      free.push(ok);
    }
  // Largest all-free rectangle: heights histogram per row.
  const heights = new Array(grid).fill(0);
  let best: UvRect | undefined,
    bestArea = 0;
  for (let j = 0; j < grid; j++) {
    for (let i = 0; i < grid; i++) heights[i] = free[j * grid + i] ? heights[i] + 1 : 0;
    for (let i = 0; i < grid; i++) {
      let h = Infinity;
      for (let k = i; k < grid; k++) {
        h = Math.min(h, heights[k]);
        if (!h) break;
        const area = h * (k - i + 1);
        if (area > bestArea) {
          bestArea = area;
          best = { u0: i / grid, u1: (k + 1) / grid, v0: (j + 1 - h) / grid, v1: (j + 1) / grid };
        }
      }
    }
  }
  return best;
}

/** The image quad of a u-v rectangle on a face. */
export function subQuad(quad: Quad, rect: UvRect): Quad {
  const m = squareToQuad(quad);
  return [
    applyHomography(m, { x: rect.u0, y: rect.v0 }),
    applyHomography(m, { x: rect.u1, y: rect.v0 }),
    applyHomography(m, { x: rect.u1, y: rect.v1 }),
    applyHomography(m, { x: rect.u0, y: rect.v1 }),
  ];
}

/**
 * A tile drawn repeated over a fixed physical window (the "same size" comparison): how many tiles
 * fit, where the joints go. `windowMm` square; tiles start at the top-left corner, grid pattern.
 */
export function repeatLayout(
  tile: { widthMm: number; heightMm: number; groutMm: number },
  windowMm: number,
  px: number,
): { cells: { x: number; y: number; w: number; h: number }[]; grout: number } {
  const scale = px / windowMm;
  const stepX = (tile.widthMm + tile.groutMm) * scale,
    stepY = (tile.heightMm + tile.groutMm) * scale;
  const cells: { x: number; y: number; w: number; h: number }[] = [];
  for (let y = 0; y < px; y += stepY)
    for (let x = 0; x < px; x += stepX)
      cells.push({ x, y, w: tile.widthMm * scale, h: tile.heightMm * scale });
  return { cells, grout: tile.groutMm * scale };
}
