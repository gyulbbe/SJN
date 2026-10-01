/**
 * How far a product's picture is turned on the screen, read from the straight edges of its
 * outline. Sanitary ware is made of horizontal and vertical lines (a tank's top, a basin's rim, a
 * bath's side), so when the outline's long straight edges all lean the same way by a few degrees,
 * the product is rolled on the screen by that much. The estimate is a pure function of the alpha
 * channel (no WebGL), so it can be tested on synthetic pictures and run on any capture.
 *
 * Edges are found as the 50% crossings of the alpha channel (sub-pixel), and a Hough transform
 * adds up the squared length of every straight run of crossings per direction. A curve gives each
 * direction only a few points and a short edge is below the minimum run, so neither makes a peak
 * (a gradient histogram does: round bases and pixel steps give false peaks, e.g. a spurious 0°).
 * Directions are folded modulo 90° (level and upright edges agree), so the answer is in
 * (−45°, 45°). A round or square outline, a weak or two-sided peak, or a half-turn ambiguity
 * returns nothing: a confident-looking wrong turn is worse than none.
 */
export interface SilhouetteTilt {
  /** Clockwise degrees the outline is turned on the screen; turn it back by the opposite. */
  degrees: number;
  /** Share (0–1) of the outline's edge points on the long straight lines in this direction. */
  confidence: number;
}
export interface SilhouetteTiltOptions {
  /** Largest side the picture is reduced to before reading it. */
  size?: number;
  /** Shortest straight edge that counts, as a share of the picture's longer side. */
  minRun?: number;
  /** Directions farther than this from level or upright are not answered (the ±45° ambiguity). */
  maxDegrees?: number;
  /** Least share of the outline's edge points on long straight edges in the peak's direction. */
  minLineShare?: number;
  /** Least share of all straight-edge energy within a few degrees of the peak. */
  minPeakShare?: number;
  /** The same, for an outline with at least `straightShare` of its edge on long straight lines. */
  straightPeakShare?: number;
  straightShare?: number;
  /** How many times larger the peak must be than the next one in another direction. */
  minDominance?: number;
}

/**
 * The framed picture the lines are read from: the square root of the product's area in pixels, the
 * picture size the minimum run is stated for, the largest side and zoom, and the margin.
 */
const SPAN = 250;
const FRAME_RUN = 320;
const MAX_FRAME = 640;
const MAX_ZOOM = 3;
const FRAME_PAD = 6;
const STEP = 0.5; // degrees per direction bin
const BINS = 180 / STEP; // directions over 180°
const QUARTER = BINS / 2; // 90° in bins

/** The strongest direction of the long straight edges, with the numbers the decision rests on. */
export interface SilhouetteTiltMeasure {
  degrees: number;
  /** Edge points on long straight lines in the peak's direction, as a share of all edge points. */
  lineShare: number;
  /** Share of all straight-edge energy within about ±4° of the peak. */
  peakShare: number;
  /** The peak's energy over the strongest energy in another direction (Infinity if none). */
  dominance: number;
}

export function measureSilhouetteTilt(
  alpha: ArrayLike<number>,
  width: number,
  height: number,
  { size = 384, minRun = 0.07 }: SilhouetteTiltOptions = {},
): SilhouetteTiltMeasure | undefined {
  if (!(width > 0) || !(height > 0) || alpha.length < width * height) return undefined;
  // Reduce to at most `size` on the longer side by averaging whole pixels (0–1 coverage).
  const factor = Math.max(1, Math.floor(Math.max(width, height) / size));
  const sw = Math.floor(width / factor),
    sh = Math.floor(height / factor);
  if (sw < 8 || sh < 8) return undefined;
  const source = new Float32Array(sw * sh);
  const area = factor * factor * 255;
  let inside = 0,
    x0 = sw,
    x1 = -1,
    y0 = sh,
    y1 = -1;
  for (let y = 0; y < sh; y++)
    for (let x = 0; x < sw; x++) {
      let sum = 0;
      for (let j = 0; j < factor; j++)
        for (let i = 0; i < factor; i++) sum += alpha[(y * factor + j) * width + x * factor + i];
      const value = sum / area;
      source[y * sw + x] = value;
      if (value >= 0.5) {
        inside++;
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
    }
  const coverage = inside / (sw * sh);
  if (coverage < 0.01 || coverage > 0.9) return undefined;
  // Frame the product itself: cropped to its bounding box and scaled so the square root of its area
  // is SPAN pixels, whatever the picture around it and however the product is turned. The straight
  // runs, the line tolerance and the curves' tangent chords are then the same size relative to the
  // product (a tighter frame made a round base's tangent chords longer than the minimum run and
  // weakened a real peak; a scale from the bounding box moved as the product turned, the area's
  // does not). Beyond the picture the nearest pixel is used, so a cut edge makes no line.
  const bw = x1 - x0 + 1,
    bh = y1 - y0 + 1;
  const scale = Math.min(SPAN / Math.sqrt(inside), MAX_FRAME / Math.max(bw, bh), MAX_ZOOM);
  const w = Math.max(8, Math.ceil(bw * scale) + FRAME_PAD * 2),
    h = Math.max(8, Math.ceil(bh * scale) + FRAME_PAD * 2);
  // The shortest run that counts, in the framed picture's pixels (a product of SPAN has FRAME_RUN).
  const runScale = (Math.sqrt(inside) * scale) / SPAN;
  const a = new Float32Array(w * h);
  const at = (x: number, y: number) =>
    source[Math.min(sh - 1, Math.max(0, y)) * sw + Math.min(sw - 1, Math.max(0, x))];
  for (let v = 0; v < h; v++)
    for (let u = 0; u < w; u++) {
      const fx = x0 + (u + 0.5 - FRAME_PAD) / scale - 0.5,
        fy = y0 + (v + 0.5 - FRAME_PAD) / scale - 0.5;
      const ix = Math.floor(fx),
        iy = Math.floor(fy),
        tx = fx - ix,
        ty = fy - iy;
      a[v * w + u] =
        (at(ix, iy) * (1 - tx) + at(ix + 1, iy) * tx) * (1 - ty) +
        (at(ix, iy + 1) * (1 - tx) + at(ix + 1, iy + 1) * tx) * ty;
    }
  // The 50% crossings between neighbouring pixels, placed by linear interpolation. An edge at an
  // angle crosses more neighbour pairs per unit length (|sin| + |cos| times a level one's), so each
  // crossing counts for the inverse of that: a line is worth its length in any direction.
  const xs: number[] = [],
    ys: number[] = [],
    ws: number[] = [];
  const cell = (x: number, y: number) =>
    a[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = a[y * w + x];
      if (x + 1 < w) {
        const q = a[y * w + x + 1];
        if (p >= 0.5 !== q >= 0.5) {
          const gx = q - p,
            gy = (cell(x, y + 1) + cell(x + 1, y + 1) - cell(x, y - 1) - cell(x + 1, y - 1)) / 4;
          xs.push(x + 0.5 + (p - 0.5) / (p - q));
          ys.push(y + 0.5);
          ws.push(Math.hypot(gx, gy) / (Math.abs(gx) + Math.abs(gy)));
        }
      }
      if (y + 1 < h) {
        const q = a[(y + 1) * w + x];
        if (p >= 0.5 !== q >= 0.5) {
          const gy = q - p,
            gx = (cell(x + 1, y) + cell(x + 1, y + 1) - cell(x - 1, y) - cell(x - 1, y + 1)) / 4;
          xs.push(x + 0.5);
          ys.push(y + 0.5 + (p - 0.5) / (p - q));
          ws.push(Math.hypot(gx, gy) / (Math.abs(gx) + Math.abs(gy)));
        }
      }
    }
  const count = xs.length;
  if (count < 40) return undefined;
  const length = ws.reduce((sum, weight) => sum + weight, 0);
  const cx = w / 2,
    cy = h / 2;
  const reach = Math.ceil(Math.hypot(w, h) / 2) + 2;
  const rows = reach * 2 + 1;
  const minPoints = Math.max(8, minRun * FRAME_RUN * runScale);
  const cos = new Float64Array(BINS),
    sin = new Float64Array(BINS);
  for (let k = 0; k < BINS; k++) {
    cos[k] = Math.cos((k * STEP * Math.PI) / 180);
    sin[k] = Math.sin((k * STEP * Math.PI) / 180);
  }
  // Energy per direction: the squared point count of every line (within ±1 px) longer than minRun.
  const energy = new Float64Array(BINS);
  const onLines = new Float64Array(BINS);
  const votes = new Float32Array(rows);
  for (let k = 0; k < BINS; k++) {
    votes.fill(0);
    for (let i = 0; i < count; i++) {
      const rho = (xs[i] - cx) * cos[k] + (ys[i] - cy) * sin[k];
      votes[Math.round(rho) + reach] += ws[i];
    }
    let e = 0,
      lines = 0;
    for (let r = 1; r < rows - 1; r++) {
      const run = votes[r - 1] + votes[r] + votes[r + 1];
      if (run > minPoints) {
        e += (run - minPoints) * (run - minPoints);
        lines += run - minPoints;
      }
    }
    energy[k] = e;
    onLines[k] = lines;
  }
  // Fold to directions modulo 90° and smooth over about ±1°.
  const folded = new Float64Array(QUARTER),
    foldedLines = new Float64Array(QUARTER);
  for (let k = 0; k < QUARTER; k++) {
    folded[k] = energy[k] + energy[k + QUARTER];
    foldedLines[k] = onLines[k] + onLines[k + QUARTER];
  }
  const smooth = new Float64Array(QUARTER);
  const weights = [0.06, 0.24, 0.4, 0.24, 0.06];
  for (let k = 0; k < QUARTER; k++)
    for (let d = -2; d <= 2; d++) smooth[k] += weights[d + 2] * folded[(k + d + QUARTER) % QUARTER];
  let peak = 0;
  for (let k = 1; k < QUARTER; k++) if (smooth[k] > smooth[peak]) peak = k;
  const total = smooth.reduce((s, v) => s + v, 0);
  if (!(smooth[peak] > 0) || !(total > 0)) return undefined;
  // The peak's centre (circular mean within ±3°), then its answer in (−45°, 45°].
  let sumWeight = 0,
    sumOffset = 0;
  for (let d = -6; d <= 6; d++) {
    const weight = smooth[(peak + d + QUARTER) % QUARTER];
    sumWeight += weight;
    sumOffset += weight * d;
  }
  const centre = peak + sumOffset / sumWeight;
  let near = 0;
  for (let d = -8; d <= 8; d++) near += smooth[(peak + d + QUARTER) % QUARTER];
  let second = 0;
  for (let k = 0; k < QUARTER; k++) {
    const distance = Math.min(Math.abs(k - peak), QUARTER - Math.abs(k - peak));
    if (distance >= 16) second = Math.max(second, smooth[k]);
  }
  // The edge points on long lines in the peak's direction (level and upright together). A line is
  // counted by the three neighbouring distance bins it falls in, hence the third.
  let lines = 0;
  for (let d = -2; d <= 2; d++) lines = Math.max(lines, foldedLines[(peak + d + QUARTER) % QUARTER]);
  const lineShare = Math.min(1, lines / (3 * length));
  const folded90 = (((centre * STEP) % 90) + 90) % 90;
  return {
    degrees: folded90 > 45 ? folded90 - 90 : folded90,
    lineShare,
    peakShare: near / total,
    dominance: second > 0 ? smooth[peak] / second : Infinity,
  };
}

/** The outline's screen roll when the measure is clear enough to act on, else nothing. */
export function estimateSilhouetteTilt(
  alpha: ArrayLike<number>,
  width: number,
  height: number,
  options: SilhouetteTiltOptions = {},
): SilhouetteTilt | undefined {
  const {
    maxDegrees = 44,
    minLineShare = 0.1,
    minPeakShare = 0.45,
    straightPeakShare = 0.35,
    straightShare = 0.5,
    minDominance = 1.6,
  } = options;
  const m = measureSilhouetteTilt(alpha, width, height, options);
  if (!m) return undefined;
  if (Math.abs(m.degrees) > maxDegrees) return undefined;
  // An outline that is mostly straight lines (a thin rod and its base) spreads them over a few
  // directions, so a smaller share of the energy in the peak is enough.
  const needed = m.lineShare >= straightShare ? straightPeakShare : minPeakShare;
  if (m.lineShare < minLineShare || m.peakShare < needed || m.dominance < minDominance) return undefined;
  return { degrees: m.degrees, confidence: m.lineShare };
}
