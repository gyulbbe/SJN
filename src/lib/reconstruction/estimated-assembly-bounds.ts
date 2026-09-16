import type { ProductBounds } from '../room-types';
import type { SceneCandidate } from './pipeline-contract';

export type EstimatedAssemblyBounds = {
  status: 'combined' | 'held';
  source: 'derived-observation-union';
  bounds: ProductBounds;
  parentId: string;
  componentIds: string[];
  observations: { candidateId: string; bounds: ProductBounds }[];
  reasons: string[];
};
const valid = (b: ProductBounds) =>
  [b.left, b.top, b.right, b.bottom].every(Number.isFinite) &&
  b.left >= 0 &&
  b.top >= 0 &&
  b.right <= 1 &&
  b.bottom <= 1 &&
  b.left < b.right &&
  b.top < b.bottom;

/**
 * Called only after the caller has independently accepted a basin→vanity support assembly.
 * Its rendered model contains both the counter and bowl, so its image comparison must cover
 * both recorded regions. This creates no observation, candidate, support relation or metric size.
 */
export function estimateAssemblyObservationBounds(
  parent: SceneCandidate,
  components: readonly SceneCandidate[],
): EstimatedAssemblyBounds {
  const result: EstimatedAssemblyBounds = {
    status: 'held',
    source: 'derived-observation-union',
    bounds: { ...parent.bounds },
    parentId: parent.id,
    componentIds: components.map((c) => c.id),
    observations: [parent, ...components].map((c) => ({ candidateId: c.id, bounds: { ...c.bounds } })),
    reasons: [],
  };
  if (
    parent.kind !== 'vanity' ||
    parent.reflection !== 'physical' ||
    !valid(parent.bounds) ||
    components.length < 1 ||
    components.length > 2 ||
    new Set([parent.id, ...components.map((c) => c.id)]).size !== components.length + 1
  ) {
    result.reasons.push('유효한 단일 상판·하부장과 서로 다른 세면볼 관측이 필요해요.');
    return result;
  }
  for (const c of components) {
    if (c.kind !== 'basin' || c.reflection !== 'physical' || !valid(c.bounds)) {
      result.reasons.push(c.id + ': 실제 세면볼의 유효한 사진 영역이 아니어서 합치지 않았어요.');
      return result;
    }
    const horizontalOverlap =
      Math.min(parent.bounds.right, c.bounds.right) - Math.max(parent.bounds.left, c.bounds.left);
    const verticalGap = parent.bounds.top - c.bounds.bottom;
    const bowlAbove = (c.bounds.top + c.bounds.bottom) / 2 < (parent.bounds.top + parent.bounds.bottom) / 2;
    if (horizontalOverlap <= 0 || !bowlAbove || verticalGap > (c.bounds.bottom - c.bounds.top) / 2) {
      result.reasons.push(
        c.id + ': 볼과 지지대의 사진 영역이 떨어져 있거나 위아래가 반대여서 합치지 않았어요.',
      );
      return result;
    }
  }
  result.bounds = {
    left: Math.min(...result.observations.map((c) => c.bounds.left)),
    top: Math.min(...result.observations.map((c) => c.bounds.top)),
    right: Math.max(...result.observations.map((c) => c.bounds.right)),
    bottom: Math.max(...result.observations.map((c) => c.bounds.bottom)),
  };
  result.status = 'combined';
  result.reasons.push(
    '세면볼과 지지대를 함께 표현한 모형은 두 원관측 영역의 합집합과 비교해요. 원래 후보 영역은 변경하지 않았어요.',
  );
  return result;
}
