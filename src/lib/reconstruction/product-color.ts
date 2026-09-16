import { reconstructionDefaults, type ReconstructionKind } from './types';

export type ProductColorOverride = { mode: 'custom'; color: string } | { mode: 'neutral' };
/** sRGB observations are not calibrated reflectance. Keep the observation and chosen material separate. */
export type ProductColorEvidence = {
  version: 1;
  method: 'semantic-interior' | 'legacy-observation' | 'neutral-optics' | 'default' | 'user';
  source: 'inferred' | 'default' | 'user';
  observedColor?: string;
  color: string;
  requiresReview: boolean;
  reasons: string[];
  sampleCount?: number;
  interiorCount?: number;
};
export const PRODUCT_NEUTRAL_OPTICS: readonly ReconstructionKind[] = [
  'mirror',
  'mirrorCabinet',
  'glassPartition',
  'window',
];
const validColor = (color: string) => /^#[0-9a-f]{6}$/i.test(color);
const rgb = (color: string) => [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
const hex = (channels: number[]) =>
  '#' + channels.map((n) => Math.round(n).toString(16).padStart(2, '0')).join('');
const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
const light = (channels: number[]) => channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
/** A dark amber photograph cannot distinguish white ceramic under warm light from beige ceramic. */
function ambiguousWarmCeramic(kind: ReconstructionKind, color: string) {
  if (!['basin', 'toilet', 'bath'].includes(kind)) return false;
  const [r, g, b] = rgb(color);
  return light([r, g, b]) < 205 && r - g >= 9 && g - b >= 7 && r - b >= 23;
}
function observedDecision(kind: ReconstructionKind, observation: ProductColorEvidence): ProductColorEvidence {
  const observedColor = observation.observedColor ?? observation.color;
  if (ambiguousWarmCeramic(kind, observedColor))
    return {
      ...observation,
      color: reconstructionDefaults(kind).color,
      source: 'default',
      observedColor,
      requiresReview: true,
      reasons: [
        ...new Set([
          ...observation.reasons,
          '어둡고 따뜻한 도기 관측색은 조명색과 제품 고유색을 구분하기 어려워요. 관측색을 보존하고 중립 기본색으로 표시했어요. 실제 베이지·갈색 제품이면 색을 직접 확인해 주세요.',
        ]),
      ],
    };
  return observation;
}
export function resolveProductColor(
  kind: ReconstructionKind,
  observation?: { color: string; colorEvidence?: ProductColorEvidence },
  override?: ProductColorOverride,
): ProductColorEvidence {
  const defaultColor = reconstructionDefaults(kind).color;
  const observedColor = observation?.colorEvidence?.observedColor ?? observation?.color;
  if (override && override.mode !== 'custom' && override.mode !== 'neutral')
    throw new Error('제품 색상 보정 방식을 확인해 주세요.');
  if (override?.mode === 'custom' && (!validColor(override.color) || PRODUCT_NEUTRAL_OPTICS.includes(kind)))
    throw new Error('제품 색은 #RRGGBB 형식이어야 하며 거울·유리·창은 중립 표면을 유지해요.');
  if (override)
    return {
      version: 1,
      method: 'user',
      source: 'user',
      color: override.mode === 'custom' ? override.color.toLowerCase() : defaultColor,
      ...(observedColor && validColor(observedColor) ? { observedColor } : {}),
      requiresReview: false,
      reasons: [
        override.mode === 'custom'
          ? '사용자가 제품 표면색을 직접 확인했어요.'
          : '사용자가 중립 기본색 사용을 확인했어요.',
      ],
    };
  if (PRODUCT_NEUTRAL_OPTICS.includes(kind))
    return {
      version: 1,
      method: 'neutral-optics',
      source: 'default',
      color: defaultColor,
      ...(observedColor && validColor(observedColor) ? { observedColor } : {}),
      requiresReview: false,
      reasons: [
        '반사 풍경이나 유리 뒤 배경은 제품 고유색으로 사용하지 않아요. 중립 표면과 별도 투명도를 유지해요.',
      ],
    };
  if (observation?.colorEvidence?.method === 'semantic-interior' && !observation.colorEvidence.observedColor)
    return structuredClone(observation.colorEvidence);
  if (!observedColor || !validColor(observedColor))
    return {
      version: 1,
      method: 'default',
      source: 'default',
      color: defaultColor,
      requiresReview: true,
      reasons: ['확인할 수 있는 제품 색 관측이 없어 수정 가능한 기본색을 사용해요.'],
    };
  const previous = observation?.colorEvidence;
  if (previous?.version === 1 && previous.method === 'semantic-interior')
    return observedDecision(kind, {
      ...structuredClone(previous),
      color: observedColor,
      observedColor,
      source: previous.interiorCount && previous.interiorCount >= 12 ? 'inferred' : 'default',
    });
  // Old reports retain their original bytes. Replays identify their unverifiable sampling instead of calling it a default observation.
  return observedDecision(kind, {
    version: 1,
    method: 'legacy-observation',
    source: 'inferred',
    color: observedColor,
    observedColor,
    requiresReview: true,
    reasons: [
      '이전 분석의 사진 관측색이에요. 당시 내부 픽셀 선택 기록이 없어 고유색으로 검증하지 않았어요. 색을 확인해 주세요.',
    ],
  });
}

/** Erode the actual connected semantic mask. Never fill a bounding rectangle with background pixels. */
export function observeProductColor(input: {
  kind: ReconstructionKind;
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  pixels: readonly number[];
}): ProductColorEvidence {
  const { kind, rgba, width, height, pixels } = input;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    rgba.length !== width * height * 4
  )
    throw new Error('제품 색 관측 이미지의 크기와 픽셀 배열이 맞지 않아요.');
  if (PRODUCT_NEUTRAL_OPTICS.includes(kind)) return resolveProductColor(kind);
  const members = new Set(pixels.filter((p) => Number.isInteger(p) && p >= 0 && p < width * height));
  const interior: number[] = [];
  for (const p of members) {
    const x = p % width,
      y = Math.floor(p / width);
    if (x <= 0 || y <= 0 || x >= width - 1 || y >= height - 1 || rgba[p * 4 + 3] < 250) continue;
    let inside = true;
    for (let dy = -1; dy <= 1 && inside; dy++)
      for (let dx = -1; dx <= 1; dx++)
        if (!members.has(p + dy * width + dx)) {
          inside = false;
          break;
        }
    if (inside) interior.push(p);
  }
  if (interior.length < 12)
    return {
      version: 1,
      method: 'semantic-interior',
      source: 'default',
      color: reconstructionDefaults(kind).color,
      requiresReview: true,
      sampleCount: 0,
      interiorCount: interior.length,
      reasons: ['경계·반투명 픽셀을 제외하고 확인할 제품 내부 픽셀이 부족해 기본색을 사용해요.'],
    };
  const sample: number[][] = [];
  const stride = Math.max(1, Math.ceil(interior.length / 4096));
  for (let i = 0; i < interior.length; i += stride) {
    const p = interior[i] * 4;
    sample.push([rgba[p], rgba[p + 1], rgba[p + 2]]);
  }
  // Highlight pixels of a coloured/black product must not become its material. First select the dominant coarse colour family.
  const families = new Map<string, number[][]>();
  for (const channels of sample) {
    const high = Math.max(...channels),
      low = Math.min(...channels);
    const key =
      high - low < Math.max(14, high * 0.12)
        ? 'neutral'
        : channels[0] >= channels[1] && channels[1] >= channels[2]
          ? 'warm'
          : channels[2] >= channels[0]
            ? 'cool'
            : 'other';
    const family = families.get(key) ?? [];
    family.push(channels);
    families.set(key, family);
  }
  const dominant = [...families.values()].sort((a, b) => b.length - a.length)[0];
  const coherent = dominant.length / sample.length >= 0.55;
  const body = (coherent ? dominant : sample).sort((a, b) => light(a) - light(b));
  // A disconnected small bright tail is a highlight, not the colour of a black body.
  // Within the remaining body use illuminated pixels: midtones over-weight a basin's shaded pedestal.
  let tail = body.length;
  for (let i = Math.ceil(body.length * 0.75); i < body.length; i++) {
    if (light(body[i]) - light(body[i - 1]) >= 45) {
      tail = i;
      break;
    }
  }
  const retained = body.slice(0, tail);
  const selected = retained.slice(
    Math.floor(retained.length * 0.7),
    Math.max(Math.floor(retained.length * 0.7) + 1, Math.ceil(retained.length * 0.95)),
  );
  const observedColor = hex([0, 1, 2].map((channel) => median(selected.map((p) => p[channel]))));
  const evidence: ProductColorEvidence = {
    version: 1,
    method: 'semantic-interior',
    source: 'inferred',
    color: observedColor,
    observedColor,
    requiresReview: !coherent,
    sampleCount: sample.length,
    interiorCount: interior.length,
    reasons: [
      '연결된 제품 분류 영역의 내부 픽셀에서 경계·반투명 픽셀과 밝기 극단을 제외해 추정했어요. 사진 조명을 분리한 실측 고유색은 아니에요.',
      ...(!coherent ? ['서로 다른 색이 섞인 내부 영역이어서 제품 색 확인이 필요해요.'] : []),
    ],
  };
  return observedDecision(kind, evidence);
}
