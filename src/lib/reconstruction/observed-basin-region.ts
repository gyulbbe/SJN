import type { SceneCandidate } from './pipeline-contract';

export const OBSERVED_BASIN_REGION_REVISION = 'pedestal-bowl-pixel-aspect-v1';
const BOWL_REGION_ASPECT_LIMIT = 0.65;

export type ObservedBasinRegion = {
  revision: typeof OBSERVED_BASIN_REGION_REVISION;
  source: 'aspect-heuristic-not-observed-part';
  status: 'heuristic' | 'not-applicable' | 'invalid-input';
  bowlOnly: boolean;
  reason:
    | 'not-a-pedestal-basin'
    | 'invalid-image-dimensions'
    | 'invalid-normalized-bounds'
    | 'invalid-pixel-extent'
    | 'wide-pixel-region-use-upper-bowl'
    | 'pixel-region-use-whole-model';
  threshold: number;
  normalizedAspect?: number;
  pixelAspect?: number;
  pixelWidth?: number;
  pixelHeight?: number;
};

/**
 * Preserve the existing pedestal-only, aspect < 0.65 heuristic, with consistent pixel units.
 * Normalized x and y have different scales when a photograph is not square. This is only a
 * comparison-region heuristic: it does not observe a pedestal, a contact point or a real size.
 * Invalid inputs cannot trigger a bowl-only fit. Candidate bounds and installation are untouched.
 */
export function inspectObservedBasinRegion(
  candidate: Pick<SceneCandidate, 'kind' | 'basinStyle' | 'bounds'>,
  image: { width: number; height: number },
): ObservedBasinRegion {
  const base: Pick<ObservedBasinRegion, 'revision' | 'source' | 'bowlOnly' | 'threshold'> = {
    revision: OBSERVED_BASIN_REGION_REVISION,
    source: 'aspect-heuristic-not-observed-part' as const,
    bowlOnly: false,
    threshold: BOWL_REGION_ASPECT_LIMIT,
  };
  if (candidate.kind !== 'basin' || candidate.basinStyle !== 'pedestal')
    return { ...base, status: 'not-applicable', reason: 'not-a-pedestal-basin' };
  if (
    !Number.isSafeInteger(image.width) ||
    !Number.isSafeInteger(image.height) ||
    image.width <= 0 ||
    image.height <= 0
  )
    return { ...base, status: 'invalid-input', reason: 'invalid-image-dimensions' };
  const { left, top, right, bottom } = candidate.bounds;
  if (
    ![left, top, right, bottom].every(Number.isFinite) ||
    left < 0 ||
    top < 0 ||
    right > 1 ||
    bottom > 1 ||
    left >= right ||
    top >= bottom
  )
    return { ...base, status: 'invalid-input', reason: 'invalid-normalized-bounds' };
  const pixelWidth = (right - left) * image.width;
  const pixelHeight = (bottom - top) * image.height;
  const pixelAspect = pixelHeight / pixelWidth;
  if (![pixelWidth, pixelHeight, pixelAspect].every((value) => Number.isFinite(value) && value > 0))
    return { ...base, status: 'invalid-input', reason: 'invalid-pixel-extent' };
  const bowlOnly = pixelAspect < BOWL_REGION_ASPECT_LIMIT;
  return {
    ...base,
    status: 'heuristic',
    bowlOnly,
    reason: bowlOnly ? 'wide-pixel-region-use-upper-bowl' : 'pixel-region-use-whole-model',
    normalizedAspect: (bottom - top) / (right - left),
    pixelAspect,
    pixelWidth,
    pixelHeight,
  };
}
