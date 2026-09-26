import type { FluxInputLayout } from './contract';
import type { FluxFixtureKind } from './scene-contract';

/**
 * Fixture protection for a FLUX result: where the model kept the picture in place, each placed
 * fixture is painted back from the original render, so its kind, shape and colour are the ones the
 * user chose. A fixture whose surroundings moved (the model reframed the shot) is left alone and
 * reported. Plain RGBA arrays only, so the same code runs in the page and in node checks.
 */
export type Pixels = { width: number; height: number; data: Uint8ClampedArray | Uint8Array };
/** Fixture ids per pixel: 0 is no fixture, n is `ids[n - 1]`. */
export type FixtureMask = { width: number; height: number; ids: string[]; data: Uint8Array };

/**
 * Opaque fixtures the model must not replace. Glass, curtains and mirrors are left to the model:
 * their look comes from what they show or let through, which a flat paste would freeze.
 */
export const PROTECTED_KINDS: ReadonlySet<FluxFixtureKind> = new Set([
  'toilet',
  'basin',
  'vanity',
  'bath',
  'shower',
  'faucet',
  'wallCabinet',
  'wallShelf',
]);
/** Search reach for the model's shift, as a share of the image width (the prompt's ±3%). */
export const MAX_SHIFT = 0.03;
/**
 * Thresholds from the 2026-09-25 results (fixture boxes as masks, see the stage-3 results): the
 * whole picture scored 0.34–0.61 where the model kept the framing and 0.11 where it reframed (C);
 * kept fixtures scored 0.33–0.58, a toilet replaced by another object 0.22, an erased basin 0.11.
 */
export const MIN_FRAMING = 0.22;
/** Lowest edge correlation of a fixture's own outline that counts as the same fixture in place. */
export const MIN_ALIGNMENT = 0.28;
/** Local refinement around the global shift, as a share of the image width. */
export const LOCAL_SHIFT = 0.01;
/** Blend width across the silhouette edge, in result pixels. */
export const FEATHER_PX = 2;

/** Result pixel centre → capture coordinate, through the padded model input (see fluxInputLayout). */
export function resultToCapture(layout: FluxInputLayout, result: { width: number; height: number }) {
  const sx = result.width / layout.width,
    sy = result.height / layout.height;
  return (u: number, v: number) => ({
    x: ((u + 0.5) / sx - layout.x) / layout.scale - 0.5,
    y: ((v + 0.5) / sy - layout.y) / layout.scale - 0.5,
  });
}

/** The original render as the model saw it, at result size: white padding, bilinear resampling. */
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

/** The capture's fixture mask at result size (nearest sample; padding has no fixture). */
export function projectMask(
  mask: FixtureMask,
  layout: FluxInputLayout,
  size: { width: number; height: number },
) {
  const map = resultToCapture(layout, { width: size.width, height: size.height });
  // The mask may be drawn at another size than the capture it belongs to.
  const captureWidth = layout.contentWidth / layout.scale,
    captureHeight = layout.contentHeight / layout.scale;
  const kx = mask.width / captureWidth,
    ky = mask.height / captureHeight;
  const out = new Uint8Array(size.width * size.height);
  for (let v = 0; v < size.height; v++)
    for (let u = 0; u < size.width; u++) {
      const { x, y } = map(u, v);
      const mx = Math.round((x + 0.5) * kx - 0.5),
        my = Math.round((y + 0.5) * ky - 0.5);
      if (mx >= 0 && my >= 0 && mx < mask.width && my < mask.height)
        out[v * size.width + u] = mask.data[my * mask.width + mx];
    }
  return { width: size.width, height: size.height, ids: mask.ids, data: out };
}

/** Gradient magnitude of luminance at half resolution (fine detail from the model is noise here). */
export type EdgeImage = { width: number; height: number; data: Float32Array };
export function edges(image: Pixels): EdgeImage {
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

export type Box = { left: number; top: number; right: number; bottom: number };
/** Pixel bounds of one fixture id in a mask, or undefined when it has no pixels. */
export function maskBounds(mask: { width: number; height: number; data: Uint8Array }, index: number) {
  let left = mask.width,
    top = mask.height,
    right = -1,
    bottom = -1;
  for (let y = 0; y < mask.height; y++)
    for (let x = 0; x < mask.width; x++)
      if (mask.data[y * mask.width + x] === index) {
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
  return right < 0 ? undefined : { left, top, right: right + 1, bottom: bottom + 1 };
}

export type Alignment = { dx: number; dy: number; score: number; aligned: boolean };
type Window = { x0: number; y0: number; x1: number; y1: number; skip?: Uint8Array };

/** Edge correlation of window `w` of `a` against `b` moved by (dx, dy); null when too little overlaps. */
function correlate(a: EdgeImage, b: EdgeImage, w: Window, dx: number, dy: number) {
  let sa = 0,
    sb = 0,
    n = 0,
    total = 0;
  for (let y = w.y0; y < w.y1; y++)
    for (let x = w.x0; x < w.x1; x++) {
      if (w.skip?.[y * a.width + x]) continue;
      total++;
      const bx = x + dx,
        by = y + dy;
      if (bx < 0 || by < 0 || bx >= b.width || by >= b.height) continue;
      sa += a.data[y * a.width + x];
      sb += b.data[by * b.width + bx];
      n++;
    }
  if (!n || n < total * 0.9) return null;
  const ma = sa / n,
    mb = sb / n;
  let cov = 0,
    va = 0,
    vb = 0;
  for (let y = w.y0; y < w.y1; y++)
    for (let x = w.x0; x < w.x1; x++) {
      if (w.skip?.[y * a.width + x]) continue;
      const bx = x + dx,
        by = y + dy;
      if (bx < 0 || by < 0 || bx >= b.width || by >= b.height) continue;
      const da = a.data[y * a.width + x] - ma,
        db = b.data[by * b.width + bx] - mb;
      cov += da * db;
      va += da * da;
      vb += db * db;
    }
  return { score: va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : 0, energy: va / n };
}

/** Best shift around `center` within ±reach; `inside` is false when the best one lies on the rim. */
function search(a: EdgeImage, b: EdgeImage, w: Window, center: { dx: number; dy: number }, reach: number) {
  let best = { dx: center.dx, dy: center.dy, score: -1, energy: 0 };
  for (let dy = center.dy - reach; dy <= center.dy + reach; dy++)
    for (let dx = center.dx - reach; dx <= center.dx + reach; dx++) {
      const found = correlate(a, b, w, dx, dy);
      if (found && found.score > best.score) best = { dx, dy, ...found };
    }
  const inside = Math.abs(best.dx - center.dx) < reach && Math.abs(best.dy - center.dy) < reach;
  return { ...best, inside };
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

/**
 * Whether the model kept the framing: one shift for the whole picture (the room's edges), searched
 * within ±MAX_SHIFT at quarter resolution. A reframed or zoomed result scores low here.
 */
export function globalAlignment(reference: EdgeImage, result: EdgeImage): Alignment {
  const a = halve(reference),
    b = halve(result);
  const reach = Math.max(1, Math.round(MAX_SHIFT * b.width));
  const margin = reach;
  const found = search(
    a,
    b,
    { x0: margin, y0: margin, x1: a.width - margin, y1: a.height - margin },
    { dx: 0, dy: 0 },
    reach,
  );
  return {
    dx: found.dx * 4,
    dy: found.dy * 4,
    score: found.score,
    aligned: found.inside && found.score >= MIN_FRAMING,
  };
}

/**
 * Whether one fixture stayed what and where it was: the edge correlation of its own silhouette
 * (grown by a few pixels for its outline) between the render and the result, searched near the
 * global shift. A fixture the model redrew as something else, or moved, scores low and is left to
 * the model (and to the Gemma check). Nothing is protected when the framing itself changed.
 */
export function fixtureAlignment(
  reference: EdgeImage,
  result: EdgeImage,
  mask: { width: number; height: number; data: Uint8Array },
  index: number,
  box: Box,
  global: Alignment,
): Alignment {
  const grow = 3;
  const w: Window = {
    x0: Math.max(0, Math.floor(box.left / 2) - grow),
    y0: Math.max(0, Math.floor(box.top / 2) - grow),
    x1: Math.min(reference.width, Math.ceil(box.right / 2) + grow),
    y1: Math.min(reference.height, Math.ceil(box.bottom / 2) + grow),
    skip: new Uint8Array(reference.width * reference.height).fill(1),
  };
  for (let y = Math.floor(box.top / 2); y < Math.ceil(box.bottom / 2); y++)
    for (let x = Math.floor(box.left / 2); x < Math.ceil(box.right / 2); x++) {
      const mx = Math.min(mask.width - 1, 2 * x),
        my = Math.min(mask.height - 1, 2 * y);
      if (mask.data[my * mask.width + mx] !== index) continue;
      for (let dy = -grow; dy <= grow; dy++)
        for (let dx = -grow; dx <= grow; dx++) {
          const px = x + dx,
            py = y + dy;
          if (px >= 0 && py >= 0 && px < reference.width && py < reference.height)
            w.skip![py * reference.width + px] = 0;
        }
    }
  const reach = Math.max(1, Math.round(LOCAL_SHIFT * reference.width));
  const found = search(
    reference,
    result,
    w,
    { dx: Math.round(global.dx / 2), dy: Math.round(global.dy / 2) },
    reach,
  );
  return {
    dx: found.dx * 2,
    dy: found.dy * 2,
    score: found.score,
    aligned: global.aligned && found.inside && found.score >= MIN_ALIGNMENT,
  };
}

/** A soft 0–1 alpha from a hard mask: two box blurs of radius FEATHER_PX, centred on the edge. */
function feather(hard: Float32Array, width: number, height: number) {
  let current = hard;
  for (let pass = 0; pass < 2; pass++)
    for (const horizontal of [true, false]) {
      const next = new Float32Array(width * height);
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          let sum = 0,
            n = 0;
          for (let k = -FEATHER_PX; k <= FEATHER_PX; k++) {
            const px = horizontal ? x + k : x,
              py = horizontal ? y : y + k;
            if (px < 0 || py < 0 || px >= width || py >= height) continue;
            sum += current[py * width + px];
            n++;
          }
          next[y * width + x] = sum / n;
        }
      current = next;
    }
  return current;
}

export type FixtureProtection = {
  id: string;
  kind?: FluxFixtureKind;
  status: 'protected' | 'moved' | 'hidden' | 'skipped';
  alignment?: Alignment;
};

/**
 * Paints aligned fixtures of `reference` (the original render at result size) over `result`,
 * each moved by the model's own shift, with a feathered edge. Kinds outside PROTECTED_KINDS are
 * skipped; fixtures that moved are left to the model and reported.
 */
export function protectFixtures(input: {
  reference: Pixels;
  result: Pixels;
  mask: FixtureMask;
  kinds?: Record<string, FluxFixtureKind | undefined>;
}): { image: Pixels; fixtures: FixtureProtection[]; framing: Alignment } {
  const { reference, result, mask, kinds = {} } = input;
  const { width, height } = result;
  if (
    reference.width !== width ||
    reference.height !== height ||
    mask.width !== width ||
    mask.height !== height
  )
    throw new Error('보호할 이미지와 마스크의 크기가 달라요.');
  const out = new Uint8ClampedArray(result.data);
  const fixtures: FixtureProtection[] = [];
  const referenceEdges = edges(reference),
    resultEdges = edges(result);
  const framing = globalAlignment(referenceEdges, resultEdges);
  mask.ids.forEach((id, i) => {
    const index = i + 1;
    const kind = kinds[id];
    if (kind && !PROTECTED_KINDS.has(kind)) return fixtures.push({ id, kind, status: 'skipped' });
    const box = maskBounds(mask, index);
    if (!box) return fixtures.push({ id, kind, status: 'hidden' });
    const alignment = fixtureAlignment(referenceEdges, resultEdges, mask, index, box, framing);
    if (!alignment.aligned) return fixtures.push({ id, kind, status: 'moved', alignment });
    const hard = new Float32Array(width * height);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const sx = x - alignment.dx,
          sy = y - alignment.dy;
        if (sx >= 0 && sy >= 0 && sx < width && sy < height && mask.data[sy * width + sx] === index)
          hard[y * width + x] = 1;
      }
    const alpha = feather(hard, width, height);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const k = alpha[y * width + x];
        if (k <= 0) continue;
        const sx = Math.max(0, Math.min(width - 1, x - alignment.dx)),
          sy = Math.max(0, Math.min(height - 1, y - alignment.dy));
        const o = (y * width + x) * 4,
          s = (sy * width + sx) * 4;
        for (let c = 0; c < 3; c++) out[o + c] = out[o + c] * (1 - k) + reference.data[s + c] * k;
      }
    fixtures.push({ id, kind, status: 'protected', alignment });
  });
  return { image: { width, height, data: out }, fixtures, framing };
}
