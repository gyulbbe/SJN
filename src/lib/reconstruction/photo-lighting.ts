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
