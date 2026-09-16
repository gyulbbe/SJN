import type { SceneCandidate } from './pipeline-contract';

const DEFAULT_FACTORS = Object.freeze([1, 0.85, 1.15]);
const WINDOW_FACTORS = Object.freeze([1, 0.85, 1.15, 0.5, 0.35]);

/** Editable size hypotheses, not measured product dimensions. Windows can be smaller than the
 * single nominal app template. Other kinds retain their previous prior; explicit experiments
 * (including an empty list) take precedence. User plans are protected by the caller. */
export function estimatedSizeFactors(
  kind: SceneCandidate['kind'],
  explicit?: readonly number[],
): readonly number[] {
  return explicit ?? (kind === 'window' ? WINDOW_FACTORS : DEFAULT_FACTORS);
}
