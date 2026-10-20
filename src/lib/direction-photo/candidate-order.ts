/**
 * Which of a direction's candidates follows its guide more closely: the product's outline in each,
 * cut to its own box and laid over the other's (the overlap, IoU), as tests/direction-photo-real/
 * measure.mjs measures it. A toilet's side view turned a little toward the camera loses overlap with
 * its side-on guide: in the 2026-10-21 trial, wherever a pair of Cloudflare candidates differed in
 * how side-on they were, the one with the larger overlap was the better in 15 of 15
 * (docs/toilet-side-view-results-20261021.md). In the browser, no AI call, nothing stored.
 */

/** The side of the square a mask is laid on. */
export const OUTLINE_SIZE = 128;
/** Darker than this, on white, is the product (the faint shadow and the background are not). */
const SOLID_BELOW = 236;

/**
 * The product's outline as an OUTLINE_SIZE² mask (1 = product) of its own bounding box, from RGBA
 * pixels laid on white; undefined for a picture with no product in it.
 */
export function outlineMask(rgba: ArrayLike<number>, width: number, height: number): Uint8Array | undefined {
  const solid = new Uint8Array(width * height);
  let left = width,
    right = -1,
    top = height,
    bottom = -1;
  for (let i = 0; i < width * height; i++) {
    const alpha = rgba[i * 4 + 3] / 255;
    const grey = 0.2126 * rgba[i * 4] + 0.7152 * rgba[i * 4 + 1] + 0.0722 * rgba[i * 4 + 2];
    if (grey * alpha + 255 * (1 - alpha) >= SOLID_BELOW) continue;
    solid[i] = 1;
    const x = i % width,
      y = Math.floor(i / width);
    if (x < left) left = x;
    if (x > right) right = x;
    if (y < top) top = y;
    if (y > bottom) bottom = y;
  }
  if (right < 0) return undefined;
  const boxWidth = right - left + 1,
    boxHeight = bottom - top + 1;
  const mask = new Uint8Array(OUTLINE_SIZE * OUTLINE_SIZE);
  for (let j = 0; j < OUTLINE_SIZE; j++) {
    const y = top + Math.floor(((j + 0.5) * boxHeight) / OUTLINE_SIZE);
    for (let i = 0; i < OUTLINE_SIZE; i++) {
      const x = left + Math.floor(((i + 0.5) * boxWidth) / OUTLINE_SIZE);
      mask[j * OUTLINE_SIZE + i] = solid[y * width + x];
    }
  }
  return mask;
}

/** How much two masks overlap: the shared part over the joined part (1 for the same outline). */
export function maskOverlap(a: Uint8Array, b: Uint8Array): number {
  let both = 0,
    either = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] && b[i]) both++;
    if (a[i] || b[i]) either++;
  }
  return either ? both / either : 0;
}

/**
 * The candidates' order, the largest overlap first; ties and the unmeasured (a failed answer) keep
 * their places, the unmeasured last.
 */
export function overlapOrder(overlaps: readonly (number | undefined)[]): number[] {
  return overlaps
    .map((overlap, index) => ({ overlap, index }))
    .sort((a, b) =>
      a.overlap === undefined || b.overlap === undefined
        ? (a.overlap === undefined ? 1 : 0) - (b.overlap === undefined ? 1 : 0) || a.index - b.index
        : b.overlap - a.overlap || a.index - b.index,
    )
    .map(({ index }) => index);
}

async function maskOf(blob: Blob) {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return undefined;
    context.drawImage(bitmap, 0, 0);
    const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height);
    return outlineMask(data, width, height);
  } finally {
    bitmap.close();
  }
}

/** A candidate's overlap with its guide, or undefined when either cannot be read. */
export async function guideOverlap(guide: Blob, answer: Blob): Promise<number | undefined> {
  try {
    const [a, b] = await Promise.all([maskOf(guide), maskOf(answer)]);
    return a && b ? maskOverlap(a, b) : undefined;
  } catch {
    return undefined;
  }
}
