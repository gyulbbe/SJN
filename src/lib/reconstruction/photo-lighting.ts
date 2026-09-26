/**
 * The light of the reference photo, from its pixels only (no AI): an exposure and a white balance
 * (channel gains). Colours measured from the photo are divided by it to estimate the materials'
 * own colour; a render multiplied by it looks lit like the photo. Linear RGB throughout.
 *
 * Brightness and tint alone cannot tell a beige tile under white light from a white tile under
 * warm light. White sanitaryware (toilet, basin, bath bodies) breaks the tie: it is white, so its
 * colour in the photo is the light's. Without it, only clearly achromatic bright surface pixels
 * count, and with too little evidence the profile stays neutral.
 */
import type { PhotoLighting, ProjectDocument } from '../types';

export type Rgb = [number, number, number];
export type PhotoLightingMethod = 'neutral' | 'gray-world' | 'achromatic' | 'ceramic' | 'mixed';
export type PhotoLightingEstimate = {
  /** Brightness relative to a normally exposed photo, log2, clamped to ±MAX_EV. */
  exposureEv: number;
  /** Light colour relative to neutral white, luminance 1 (so exposure carries all brightness). */
  gains: Rgb;
  method: PhotoLightingMethod;
  /** Evidence counts behind the estimate. */
  evidence: { surfaces: number; achromatic: number; ceramics: number };
};
/** Photo samples in linear RGB: room surfaces (fixtures excluded) and white sanitaryware bodies. */
export type PhotoLightingSamples = {
  surfaces: Rgb[];
  ceramics: Rgb[];
  /** Representative colour of each analysed face (the colours that will be delit). */
  faces?: Rgb[];
};

export const MAX_EV = 1.5;
/** Glazed white sanitaryware, linear luminance, in a normally exposed photo (sRGB ≈ 231). */
export const CERAMIC_WHITE = 0.8;
/** At least this many achromatic surface samples before they set the white balance. */
export const MIN_ACHROMATIC = 200;
/**
 * White balance range as light colours on the blackbody line, in linear sRGB normalised to
 * green: about 7,500 K (bluish) to 2,700 K (warm incandescent).
 */
export const WHITE_RANGE = { r: [0.97, 2.5], b: [0.24, 1.18] } as const;

export const srgbToLinear = (value: number) => {
  const v = value / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
export const linearToSrgb = (value: number) => {
  const v = Math.max(0, Math.min(1, value));
  return Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055));
};
export const luminance = ([r, g, b]: Rgb) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
export function hexToLinear(hex: string): Rgb {
  return [1, 3, 5].map((i) => srgbToLinear(parseInt(hex.slice(i, i + 2), 16))) as Rgb;
}
export function linearToHex(rgb: Rgb): string {
  return '#' + rgb.map((v) => linearToSrgb(v).toString(16).padStart(2, '0')).join('');
}

const median = (values: number[]) => {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};
/** Chroma of a linear colour as the spread of its channels over their mean (0 for grey). */
export function chroma([r, g, b]: Rgb) {
  const mean = (r + g + b) / 3;
  return mean > 0 ? (Math.max(r, g, b) - Math.min(r, g, b)) / mean : 0;
}
/** Luminance-1 gains that turn `white` (the light seen on a white object) into itself. */
function lightColor(white: Rgb): Rgb {
  const g = Math.max(1e-6, white[1]);
  // Keep the cast within the blackbody range between about 7,500 K and 2,700 K.
  const r = Math.max(WHITE_RANGE.r[0], Math.min(WHITE_RANGE.r[1], white[0] / g));
  const b = Math.max(WHITE_RANGE.b[0], Math.min(WHITE_RANGE.b[1], white[2] / g));
  const scale = 1 / luminance([r, 1, b]);
  return [r * scale, scale, b * scale];
}
const neutral: Rgb = [1, 1, 1];

/** Per-channel medians of samples, as one colour. */
function channelMedian(samples: Rgb[]): Rgb {
  return [0, 1, 2].map((c) => median(samples.map((s) => s[c]))) as Rgb;
}
/** Bright, clearly achromatic surface samples: the upper quarter by luminance with low chroma. */
export function achromaticSamples(surfaces: Rgb[], maxChroma = 0.15) {
  if (!surfaces.length) return [];
  const bright = median(
    surfaces
      .map(luminance)
      .sort((a, b) => a - b)
      .slice(Math.floor(surfaces.length * 0.5)),
  );
  return surfaces.filter((s) => luminance(s) >= bright && chroma(s) <= maxChroma);
}

/**
 * Lighting of one photo by the chosen method. `mixed` (the default) uses the sanitaryware when
 * there is any, else the achromatic surfaces, else stays neutral; exposure comes from the
 * sanitaryware only (a grey tile room would otherwise read as a dark photo).
 */
export function estimatePhotoLighting(
  samples: PhotoLightingSamples,
  method: Exclude<PhotoLightingMethod, 'neutral'> = 'mixed',
): PhotoLightingEstimate {
  const achromatic = achromaticSamples(samples.surfaces);
  const evidence = {
    surfaces: samples.surfaces.length,
    achromatic: achromatic.length,
    ceramics: samples.ceramics.length,
  };
  const none: PhotoLightingEstimate = { exposureEv: 0, gains: neutral, method: 'neutral', evidence };
  const ceramicWhite = samples.ceramics.length ? channelMedian(samples.ceramics) : undefined;
  // White cannot look darker than a tile in the same light: a sanitaryware reading darker than
  // the brightest face is a misdetection or a shadowed part, and the face bounds the white.
  const brightestFace = Math.max(0, ...(samples.faces ?? []).map(luminance));
  const exposure = (white: Rgb | undefined) =>
    white
      ? Math.max(
          -MAX_EV,
          Math.min(MAX_EV, Math.log2(Math.max(luminance(white), brightestFace) / CERAMIC_WHITE)),
        )
      : 0;
  if (method === 'gray-world') {
    if (!samples.surfaces.length) return none;
    const mean = [0, 1, 2].map((c) => samples.surfaces.reduce((sum, s) => sum + s[c], 0)) as Rgb;
    return { exposureEv: exposure(ceramicWhite), gains: lightColor(mean), method, evidence };
  }
  if (method === 'achromatic') {
    if (achromatic.length < MIN_ACHROMATIC) return none;
    return {
      exposureEv: exposure(ceramicWhite),
      gains: lightColor(channelMedian(achromatic)),
      method,
      evidence,
    };
  }
  if (method === 'ceramic') {
    if (!ceramicWhite) return none;
    return { exposureEv: exposure(ceramicWhite), gains: lightColor(ceramicWhite), method, evidence };
  }
  if (ceramicWhite)
    return {
      exposureEv: exposure(ceramicWhite),
      gains: lightColor(ceramicWhite),
      method: 'ceramic',
      evidence,
    };
  if (achromatic.length >= MIN_ACHROMATIC)
    return { exposureEv: 0, gains: lightColor(channelMedian(achromatic)), method: 'achromatic', evidence };
  return none;
}

/** The linear multiplier a render gets at `strength` (0 neutral, 1 the photo's light). */
export function lightingMultiplier(
  estimate: Pick<PhotoLightingEstimate, 'exposureEv' | 'gains'>,
  strength = 1,
): Rgb {
  const k = Math.max(0, Math.min(1, strength));
  const scale = 2 ** estimate.exposureEv;
  return estimate.gains.map((g) => 1 + (g * scale - 1) * k) as Rgb;
}
/** A colour measured in the photo, with the photo's light taken out (clamped to a reflectance). */
export function delightColor(
  hex: string,
  estimate: Pick<PhotoLightingEstimate, 'exposureEv' | 'gains'>,
): string {
  const m = lightingMultiplier(estimate);
  return linearToHex(hexToLinear(hex).map((v, i) => Math.min(1, v / m[i])) as Rgb);
}
/** A material colour under the photo's light. */
export function relightColor(
  hex: string,
  estimate: Pick<PhotoLightingEstimate, 'exposureEv' | 'gains'>,
  strength = 1,
): string {
  const m = lightingMultiplier(estimate, strength);
  return linearToHex(hexToLinear(hex).map((v, i) => v * m[i]) as Rgb);
}

type Quad = [
  { x: number; y: number },
  { x: number; y: number },
  { x: number; y: number },
  { x: number; y: number },
];
type Bounds = { left: number; top: number; right: number; bottom: number };
/** The parts of an analysis this needs: faces with their photo colour, fixture candidates. */
export type PhotoLightingReview = {
  planes: { quad: Quad; tile: { color: string }; bands?: { tile: { color: string } }[] }[];
  candidates: { kind: string; status: string; color: string; bounds: Bounds }[];
};
function insideQuad(quad: Quad, x: number, y: number) {
  let hit = false;
  for (let i = 0, j = 3; i < 4; j = i++) {
    const a = quad[i],
      b = quad[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}
/** Candidates smaller than this share of the photo are detections of fittings or reflections. */
const MIN_CERAMIC_AREA = 0.01;
/**
 * Samples of one analysed photo (RGBA, any size; coordinates are normalised): the face pixels
 * without fixture boxes, the largest white-sanitaryware candidate's observed colour (a toilet,
 * else a basin or bath that is not strongly coloured) and each face's photo colour.
 */
export function samplePhotoLighting(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  review: PhotoLightingReview,
): PhotoLightingSamples {
  const candidates = review.candidates.filter((c) => c.status !== 'ignored');
  const inBox = (b: Bounds, x: number, y: number) =>
    x >= b.left && x <= b.right && y >= b.top && y <= b.bottom;
  const surfaces: Rgb[] = [];
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width,
        v = (y + 0.5) / height;
      if (!review.planes.some((p) => insideQuad(p.quad, u, v))) continue;
      if (candidates.some((c) => inBox(c.bounds, u, v))) continue;
      const i = (y * width + x) * 4;
      if (!rgba[i + 3]) continue;
      surfaces.push([srgbToLinear(rgba[i]), srgbToLinear(rgba[i + 1]), srgbToLinear(rgba[i + 2])]);
    }
  const area = (b: Bounds) => (b.right - b.left) * (b.bottom - b.top);
  const valid = (c: (typeof candidates)[number]) =>
    /^#[0-9a-f]{6}$/i.test(c.color) && area(c.bounds) >= MIN_CERAMIC_AREA;
  const largest = (list: typeof candidates) =>
    [...list].sort((a, b) => area(b.bounds) - area(a.bounds)).slice(0, 1);
  const toilets = candidates.filter((c) => c.kind === 'toilet' && valid(c));
  const others = candidates.filter(
    (c) => (c.kind === 'basin' || c.kind === 'bath') && valid(c) && chroma(hexToLinear(c.color)) <= 0.35,
  );
  const ceramics = (toilets.length ? largest(toilets) : largest(others)).map((c) => hexToLinear(c.color));
  const faces = review.planes
    .flatMap((p) => (p.bands?.length ? p.bands.map((b) => b.tile.color) : [p.tile.color]))
    .filter((hex) => /^#[0-9a-f]{6}$/i.test(hex))
    .map(hexToLinear);
  return { surfaces, ceramics, faces };
}

/** The stored profile for an estimate, or undefined when the photo gave no evidence. */
export function createPhotoLighting(estimate: PhotoLightingEstimate): PhotoLighting | undefined {
  if (estimate.method !== 'ceramic' && estimate.method !== 'achromatic') return;
  return {
    version: 1,
    exposureEv: estimate.exposureEv,
    gains: [...estimate.gains],
    method: estimate.method,
    enabled: true,
    strength: 1,
  };
}
/** What a render multiplies by for a stored profile; undefined leaves every pixel unchanged. */
export function photoLightingMultiplier(profile: PhotoLighting | undefined): Rgb | undefined {
  if (!profile?.enabled || profile.strength <= 0) return;
  return lightingMultiplier(profile, profile.strength);
}
/** A colour observed in the photo, delit when the project has a profile (else unchanged). */
export function delightObserved(hex: string, profile: PhotoLighting | undefined): string {
  return profile && /^#[0-9a-f]{6}$/i.test(hex) ? delightColor(hex, profile) : hex;
}
/** The render multiplier of a project's comparison photo light, if it has one switched on. */
export function projectPhotoLight(project: Pick<ProjectDocument, 'shared'>): Rgb | undefined {
  return photoLightingMultiplier(project.shared.comparison?.photoLighting);
}

/**
 * Estimates the light of an analysed photo in the browser (the photo never leaves it): at most
 * 640 px wide, the faces and fixture candidates of its review, the mixed method. Undefined when
 * the photo gives no evidence.
 */
export async function estimateReviewLighting(
  photo: Blob,
  review: PhotoLightingReview,
): Promise<PhotoLighting | undefined> {
  if (!review.planes.length) return;
  const bitmap = await createImageBitmap(photo);
  try {
    const width = Math.min(640, bitmap.width),
      height = Math.max(1, Math.round((width * bitmap.height) / bitmap.width));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return;
    context.drawImage(bitmap, 0, 0, width, height);
    const rgba = context.getImageData(0, 0, width, height).data;
    canvas.width = canvas.height = 1;
    return createPhotoLighting(estimatePhotoLighting(samplePhotoLighting(rgba, width, height, review)));
  } finally {
    bitmap.close();
  }
}
