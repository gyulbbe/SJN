import type { ReconstructionCandidate, ReconstructionKind } from './types';
import type { SemanticLogits } from '../segmentation/wall-refinement';

// Official Google DeepLab ADE20K includes background at index 0.
// https://github.com/tensorflow/tfjs-models/blob/master/deeplab/src/config.ts
export const ADE_OBJECTS: Readonly<Record<number, ReconstructionKind>> = {
  9: 'window',
  15: 'door',
  28: 'mirror',
  38: 'bath',
  48: 'basin',
  66: 'toilet',
};
const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 192;
export function representativeColor(rgba: Uint8ClampedArray, pixels: number[]): string {
  const usable = pixels.filter((i) => {
    const light = (rgba[i * 4] + rgba[i * 4 + 1] + rgba[i * 4 + 2]) / 3;
    return rgba[i * 4 + 3] > 0 && light >= 35 && light <= 245;
  });
  const source = usable.length >= 8 ? usable : pixels;
  const channels = [0, 1, 2].map((channel) => median(source.map((i) => rgba[i * 4 + channel])));
  return '#' + channels.map((n) => Math.round(n).toString(16).padStart(2, '0')).join('');
}
/** Use the illuminated body, excluding dark recesses and the brightest specular tail. */
export function representativeObjectColor(rgba: Uint8ClampedArray, pixels: number[]): string {
  const visible = pixels.filter((i) => rgba[i * 4 + 3] > 0);
  if (!visible.length) return '#c0c0c0';
  const light = (i: number) => rgba[i * 4] * 0.2126 + rgba[i * 4 + 1] * 0.7152 + rgba[i * 4 + 2] * 0.0722;
  const body = visible
    .filter((i) => rgba[i * 4 + 3] > 0 && light(i) >= 25 && light(i) < 248)
    .sort((a, b) => light(a) - light(b));
  if (body.length < 12) return representativeColor(rgba, visible);
  return representativeColor(
    rgba,
    body.slice(
      Math.floor(body.length * 0.7),
      Math.max(Math.floor(body.length * 0.7) + 8, Math.ceil(body.length * 0.95)),
    ),
  );
}
function marginAt(pixel: number, label: number, width: number, height: number, logits?: SemanticLogits) {
  if (!logits || label >= logits.channels) return 0;
  const x = pixel % width,
    y = Math.floor(pixel / width);
  const gx = Math.min(
    logits.width - 1,
    Math.round((((x * logits.cropWidth) / width) * (logits.width - 1)) / Math.max(1, logits.paddedWidth - 1)),
  );
  const gy = Math.min(
    logits.height - 1,
    Math.round(
      (((y * logits.cropHeight) / height) * (logits.height - 1)) / Math.max(1, logits.paddedHeight - 1),
    ),
  );
  const base = (gy * logits.width + gx) * logits.channels;
  let other = -Infinity;
  for (let c = 0; c < logits.channels; c++) if (c !== label) other = Math.max(other, logits.values[base + c]);
  const result = logits.values[base + label] - other;
  return Number.isFinite(result) ? Math.max(-1000, Math.min(1000, result)) : 0;
}
/** Bounded connected components. Only compact object summaries leave the worker. */
export function extractReconstructionCandidates(input: {
  width: number;
  height: number;
  labels: Uint8Array;
  rgba: Uint8ClampedArray;
  logits?: SemanticLogits;
}): ReconstructionCandidate[] {
  const { width, height, labels, rgba, logits } = input;
  const size = width * height;
  const componentPixels = new Map<string, number[]>();
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 512 ||
    height > 512 ||
    labels.length !== size ||
    rgba.length !== size * 4
  )
    throw new Error('재구성 분석 이미지의 크기가 올바르지 않아요.');
  if (
    logits &&
    (logits.values.length !== logits.width * logits.height * logits.channels || logits.channels < 67)
  )
    throw new Error('재구성 분석 점수의 크기가 올바르지 않아요.');
  const visited = new Uint8Array(size),
    queue = new Int32Array(size);
  const candidates: ReconstructionCandidate[] = [];
  const minimum = Math.max(12, Math.ceil(size * 0.00015));
  for (let origin = 0; origin < size; origin++) {
    const label = labels[origin],
      kind = ADE_OBJECTS[label] ?? (label === 11 ? 'vanity' : undefined);
    if (!kind || visited[origin]) continue;
    visited[origin] = 1;
    let read = 0,
      written = 1,
      left = width,
      right = 0,
      top = height,
      bottom = 0;
    queue[0] = origin;
    while (read < written) {
      const pixel = queue[read++],
        x = pixel % width,
        y = Math.floor(pixel / width);
      left = Math.min(left, x);
      right = Math.max(right, x + 1);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y + 1);
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx,
            ny = y + dy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          const next = ny * width + nx;
          if (!visited[next] && labels[next] === label) {
            visited[next] = 1;
            queue[written++] = next;
          }
        }
    }
    if (written < minimum || right - left < 3 || bottom - top < 3) continue;
    const samples: number[] = [],
      feet: number[] = [];
    const stride = Math.max(1, Math.floor(written / 256));
    for (let i = 0; i < written; i++) {
      const pixel = queue[i];
      if (i % stride === 0) samples.push(pixel);
      if (Math.floor(pixel / width) >= bottom - Math.max(2, (bottom - top) * 0.07))
        feet.push(((pixel % width) + 0.5) / width);
    }
    const touched = left === 0 || right === width || top === 0 || bottom === height;
    const id = `object-${label}-${origin}`;
    componentPixels.set(id, Array.from(queue.subarray(0, written)));
    candidates.push({
      id,
      kind,
      bounds: { left: left / width, right: right / width, top: top / height, bottom: bottom / height },
      foot: { x: median(feet), y: bottom / height },
      color: representativeObjectColor(rgba, samples),
      pixels: written,
      evidence: {
        semanticPixels: written,
        meanMargin:
          samples.reduce((sum, p) => sum + marginAt(p, label, width, height, logits), 0) / samples.length,
      },
      status: 'unplaced',
      warning: touched
        ? '사진 가장자리에서 잘린 후보예요. 종류·위치·크기를 확인해 주세요.'
        : '자동 분석 후보예요. 종류·위치·크기를 확인해 주세요.',
    });
  }
  return contextualCandidates(candidates, componentPixels, input)
    .sort((a, b) => b.pixels - a.pixels)
    .slice(0, 32);
}

type Bounds = ReconstructionCandidate['bounds'];
type CandidateInput = Parameters<typeof extractReconstructionCandidates>[0];
const area = (b: Bounds) => Math.max(0, b.right - b.left) * Math.max(0, b.bottom - b.top);
const intersectionArea = (a: Bounds, b: Bounds) =>
  Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
  Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
const unionBounds = (a: Bounds, b: Bounds): Bounds => ({
  left: Math.min(a.left, b.left),
  top: Math.min(a.top, b.top),
  right: Math.max(a.right, b.right),
  bottom: Math.max(a.bottom, b.bottom),
});
const expanded = (b: Bounds, padding: number): Bounds => ({
  left: Math.max(0, b.left - padding),
  top: Math.max(0, b.top - padding),
  right: Math.min(1, b.right + padding),
  bottom: Math.min(1, b.bottom + padding),
});
function logitsAt(pixel: number, input: CandidateInput): Float32Array | undefined {
  const l = input.logits;
  if (!l) return;
  const x = pixel % input.width,
    y = Math.floor(pixel / input.width);
  const gx = Math.min(
    l.width - 1,
    Math.round((((x * l.cropWidth) / input.width) * (l.width - 1)) / Math.max(1, l.paddedWidth - 1)),
  );
  const gy = Math.min(
    l.height - 1,
    Math.round((((y * l.cropHeight) / input.height) * (l.height - 1)) / Math.max(1, l.paddedHeight - 1)),
  );
  return l.values.subarray((gy * l.width + gx) * l.channels, (gy * l.width + gx + 1) * l.channels);
}
function contextualCandidates(
  candidates: ReconstructionCandidate[],
  pixels: Map<string, number[]>,
  input: CandidateInput,
) {
  const consumed = new Set<string>(),
    additions: ReconstructionCandidate[] = [];
  // A sink above a sizeable cabinet is one vanity, even when the toe kick is labelled bathtub.
  for (const cabinet of candidates.filter((c) => c.kind === 'vanity')) {
    const b = cabinet.bounds,
      w = b.right - b.left,
      h = b.bottom - b.top;
    const basins = candidates.filter(
      (c) =>
        c.kind === 'basin' &&
        !consumed.has(c.id) &&
        Math.max(0, Math.min(c.bounds.right, b.right) - Math.max(c.bounds.left, b.left)) >=
          Math.min(w, c.bounds.right - c.bounds.left) * 0.45 &&
        c.bounds.bottom >= b.top - 0.035 &&
        c.bounds.top < b.top + h * 0.32 &&
        c.bounds.bottom < b.bottom - h * 0.25,
    );
    if (!basins.length || cabinet.pixels < Math.max(80, input.width * input.height * 0.002)) continue;
    let bounds = basins.reduce((sum, basin) => unionBounds(sum, basin.bounds), b);
    consumed.add(cabinet.id);
    basins.forEach((c) => consumed.add(c.id));
    for (const fragment of candidates) {
      if (fragment.kind !== 'bath' || fragment.pixels > cabinet.pixels * 0.3) continue;
      if (fragment.bounds.top < b.top + h * 0.55 || fragment.bounds.bottom - fragment.bounds.top > h * 0.65)
        continue;
      if (intersectionArea(expanded(b, h * 0.22), fragment.bounds) / area(fragment.bounds) < 0.8) continue;
      bounds = unionBounds(bounds, fragment.bounds);
      consumed.add(fragment.id);
    }
    const bodyPixels = pixels.get(cabinet.id) ?? [];
    const lowest = bodyPixels.filter(
      (p) => Math.floor(p / input.width) >= b.bottom * input.height - Math.max(2, h * input.height * 0.05),
    );
    additions.push({
      ...cabinet,
      id: `vanity-${cabinet.id}`,
      bounds,
      foot: {
        x: lowest.length
          ? median(lowest.map((p) => ((p % input.width) + 0.5) / input.width))
          : (b.left + b.right) / 2,
        y: bounds.bottom,
      },
      ...(w / Math.max(0.001, h) < 0.45 && cabinet.evidence.meanMargin < 3 ? { requiresReview: true } : {}),
      pixels: cabinet.pixels + basins.reduce((sum, c) => sum + c.pixels, 0),
      warning:
        '세면볼과 하부장의 연결을 확인해 하나의 세면대 하부장으로 묶었어요. 상판 길이와 볼 개수를 확인해 주세요.',
    });
  }
  const result = candidates.filter((c) => c.kind !== 'vanity' && !consumed.has(c.id)).concat(additions);
  for (const candidate of result) {
    if (candidate.kind !== 'toilet') continue;
    const body = pixels.get(candidate.id) ?? [],
      b = candidate.bounds;
    if (!body.length) continue;
    const fill = body.length / Math.max(1, area(b) * input.width * input.height);
    let competitors = 0,
      sampled = 0;
    for (let i = 0; i < body.length; i += Math.max(1, Math.floor(body.length / 128))) {
      const scores = logitsAt(body[i], input);
      if (!scores || scores.length <= 139) continue;
      const bin = scores[139];
      let rank = 1;
      for (const score of scores) if (score > bin) rank++;
      if (rank <= 5 && scores[66] - bin < 7) competitors++;
      sampled++;
    }
    const middleWidths: number[] = [];
    const x0 = Math.floor(b.left * input.width),
      x1 = Math.ceil(b.right * input.width);
    for (
      let y = Math.ceil((b.top + (b.bottom - b.top) * 0.2) * input.height);
      y < (b.top + (b.bottom - b.top) * 0.75) * input.height;
      y++
    ) {
      let left = x1,
        right = x0;
      for (let x = x0; x < x1; x++)
        if (input.labels[y * input.width + x] === 66) {
          left = Math.min(left, x);
          right = Math.max(right, x + 1);
        }
      middleWidths.push(Math.max(0, right - left) / Math.max(1, x1 - x0));
    }
    const average = middleWidths.reduce((sum, n) => sum + n, 0) / Math.max(1, middleWidths.length);
    const variation = Math.sqrt(
      middleWidths.reduce((sum, n) => sum + (n - average) ** 2, 0) / Math.max(1, middleWidths.length),
    );
    if (fill > 0.78 && variation < 0.09 && sampled && competitors / sampled > 0.65) {
      candidate.requiresReview = true;
      candidate.warning = '원통형 물체이며 휴지통 분류 근거도 강해요. 변기로 자동 배치하지 않았어요.';
    }
    if (candidate.pixels < input.width * input.height * 0.001 && candidate.evidence.meanMargin < 2.5) {
      candidate.requiresReview = true;
      candidate.warning = '작은 물체 일부가 변기로 분류됐어요. 종류를 확인한 후 배치해 주세요.';
    }
  }
  return result;
}

/** Keep each pass's actual model evidence. Agreement does not manufacture a confidence score. */
export function mergeReconstructionPasses(
  primary: ReconstructionCandidate[],
  secondary: ReconstructionCandidate[],
): ReconstructionCandidate[] {
  const result = structuredClone(primary);
  for (const source of secondary) {
    const candidate = structuredClone(source);
    const same = result
      .filter(
        (c) =>
          c.kind === candidate.kind &&
          intersectionArea(c.bounds, candidate.bounds) / Math.min(area(c.bounds), area(candidate.bounds)) >
            0.4,
      )
      .sort(
        (a, b) => intersectionArea(b.bounds, candidate.bounds) - intersectionArea(a.bounds, candidate.bounds),
      )[0];
    if (!same) {
      result.push(candidate);
      continue;
    }
    const replace =
      candidate.evidence.meanMargin > same.evidence.meanMargin &&
      area(candidate.bounds) >= area(same.bounds) * 0.55;
    const review = same.requiresReview || candidate.requiresReview;
    const warning = same.requiresReview
      ? same.warning
      : candidate.requiresReview
        ? candidate.warning
        : undefined;
    const envelope = same.kind === 'vanity' ? unionBounds(same.bounds, candidate.bounds) : undefined;
    if (replace) Object.assign(same, candidate, { id: same.id });
    if (envelope) {
      same.bounds = envelope;
      same.foot.y = envelope.bottom;
    }
    if (review) {
      same.requiresReview = true;
      if (warning) same.warning = warning;
    }
  }
  // A weak window-like reflection fragment inside a stronger mirror is not an extra window.
  return result
    .filter(
      (c) =>
        !result.some(
          (other) =>
            other !== c &&
            ((other.kind === c.kind && area(other.bounds) > area(c.bounds) * 1.5) ||
              (other.kind === 'mirror' && c.kind === 'window' && c.evidence.meanMargin < 2)) &&
            other.evidence.meanMargin >= c.evidence.meanMargin &&
            intersectionArea(other.bounds, c.bounds) / area(c.bounds) > 0.65,
        ),
    )
    .sort((a, b) => b.pixels - a.pixels)
    .slice(0, 32);
}

/** Map crop/flip evidence back to oriented original photo coordinates without changing masks. */
export function mapCandidatePass(
  candidates: ReconstructionCandidate[],
  region: Bounds,
  flip = false,
): ReconstructionCandidate[] {
  const w = region.right - region.left,
    h = region.bottom - region.top;
  return candidates.map((candidate) => ({
    ...structuredClone(candidate),
    id: `${flip ? 'flip' : 'crop'}-${candidate.id}`,
    bounds: {
      left: region.left + (flip ? 1 - candidate.bounds.right : candidate.bounds.left) * w,
      right: region.left + (flip ? 1 - candidate.bounds.left : candidate.bounds.right) * w,
      top: region.top + candidate.bounds.top * h,
      bottom: region.top + candidate.bounds.bottom * h,
    },
    foot: {
      x: region.left + (flip ? 1 - candidate.foot.x : candidate.foot.x) * w,
      y: region.top + candidate.foot.y * h,
    },
  }));
}

/** Long RGB frame edges extend an already recognised tall mirror; they never create an object. */
export function refineCandidateFrames(
  candidates: ReconstructionCandidate[],
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
) {
  const difference = (x: number, y: number) => {
    if (x < 1 || x >= width - 1 || y < 0 || y >= height) return 0;
    let total = 0;
    for (let c = 0; c < 3; c++)
      total += Math.abs(rgba[(y * width + x - 1) * 4 + c] - rgba[(y * width + x + 1) * 4 + c]);
    return total / 3;
  };
  return candidates.map((source) => {
    const candidate = structuredClone(source),
      b = candidate.bounds;
    if (
      candidate.kind !== 'mirror' ||
      candidate.evidence.meanMargin < 1.5 ||
      candidate.evidence.meanMargin > 4
    )
      return candidate;
    const w = (b.right - b.left) * width,
      h = (b.bottom - b.top) * height;
    if (h < 30 || w < 8) return candidate;
    const y0 = Math.round(b.top * height),
      y1 = Math.round(b.bottom * height);
    const edge = (from: number, to: number) => {
      let best = { x: 0, score: 0 };
      for (let x = Math.max(1, Math.round(from)); x <= Math.min(width - 2, Math.round(to)); x++) {
        let total = 0,
          strong = 0;
        for (let y = y0; y < y1; y++) {
          const d = difference(x, y);
          total += Math.min(40, d);
          if (d >= 10) strong++;
        }
        const coverage = strong / Math.max(1, y1 - y0),
          score = (total / Math.max(1, y1 - y0)) * coverage;
        if (coverage >= 0.65 && score > best.score) best = { x, score };
      }
      return best.score >= 12 ? best.x : undefined;
    };
    const left = edge(b.left * width - w * 0.3, b.left * width + w * 0.08);
    const right = edge(b.right * width - w * 0.12, b.right * width + w * 0.25);
    if (left === undefined || right === undefined || right - left < w * 0.7) return candidate;
    const band = Math.max(5, Math.round(h * 0.07));
    const sustained = (y: number) =>
      [left, right].some((x) => {
        let strong = 0;
        for (let yy = y; yy < Math.min(height, y + band); yy++) if (difference(x, yy) >= 10) strong++;
        return strong / band >= 0.7;
      });
    let top = y0,
      bottom = y1;
    for (let y = Math.max(1, Math.round(y0 - h * 0.45)); y < y0; y++)
      if (sustained(y)) {
        top = y;
        break;
      }
    for (let y = Math.min(height - 2, Math.round(y1 + h * 0.15)); y > y1; y--)
      if (sustained(y - band)) {
        bottom = y;
        break;
      }
    candidate.bounds = {
      left: left / width,
      right: (right + 1) / width,
      top: top / height,
      bottom: bottom / height,
    };
    candidate.foot = { x: (left + right + 1) / 2 / width, y: bottom / height };
    candidate.warning =
      '두 방향 분석과 사진의 긴 프레임 경계로 거울 범위를 보정했어요. 외곽과 높이를 확인해 주세요.';
    return candidate;
  });
}
