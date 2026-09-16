import type { ProductBounds } from '../room-types';
import type { SceneCandidate } from './pipeline-contract';
import type { LayoutObservationInput } from './estimated-layout';

type Relation = LayoutObservationInput['relations'][number];
export const PHOTO_RELATION_SCORING_REVISION = 'photo-direction-evidence-v2-hold-inconclusive' as const;
export type EstimatedPhotoRelationConsistency = {
  version: 1;
  coordinateSystem: 'normalized-photo-xy';
  accepted: Relation[];
  /** Optional on older stored diagnostics; accepted retains its historical non-contradicted meaning. */
  scoringRevision?: typeof PHOTO_RELATION_SCORING_REVISION;
  scoredRelations?: Relation[];
  held?: { index: number; relation: Relation; reason: string }[];
  checks: {
    index: number;
    relation: Relation;
    status: 'consistent' | 'contradicted' | 'inconclusive' | 'not-photo-relative';
    axis?: 'x' | 'y';
    /** Positive means the first candidate lies farther right/down in the photograph. */
    centreDelta?: number;
    /** Positive only when the full observed intervals are separated in the observed ordering. */
    intervalGap?: number;
    reason: string;
  }[];
  rejected: { index: number; relation: Relation; reason: string }[];
};
const valid = (b: ProductBounds) =>
  Object.values(b).every(Number.isFinite) &&
  b.left >= 0 &&
  b.top >= 0 &&
  b.right <= 1 &&
  b.bottom <= 1 &&
  b.left < b.right &&
  b.top < b.bottom;

/**
 * The layout contract defines photo-left/right and vertical photo ordering separately from
 * physical wall names, usable-front orientation, and room depth. Only a clear disjoint reversal
 * is contradicted; intersecting or nearly touching boxes do not prove the model relation is wrong.
 * An inconclusive direction remains an observation but receives no solver penalty. Non-photo
 * relations retain their existing policy and are not promoted to geometric proof by this check.
 */
export function inspectEstimatedPhotoRelations(
  candidates: readonly SceneCandidate[],
  relations: readonly Relation[],
): EstimatedPhotoRelationConsistency {
  const result: EstimatedPhotoRelationConsistency = {
    version: 1,
    coordinateSystem: 'normalized-photo-xy',
    accepted: [],
    scoringRevision: PHOTO_RELATION_SCORING_REVISION,
    scoredRelations: [],
    held: [],
    checks: [],
    rejected: [],
  };
  const byId = new Map(candidates.map((item) => [item.id, item]));
  relations.forEach((relation, index) => {
    const check: EstimatedPhotoRelationConsistency['checks'][number] = {
      index,
      relation: structuredClone(relation),
      status: 'not-photo-relative',
      reason: 'depth-support-attachment-relations-not-tested-with-photo-order',
    };
    const horizontal = relation.type === 'leftOf' || relation.type === 'rightOf';
    const vertical = relation.type === 'above' || relation.type === 'below';
    if (horizontal || vertical) {
      check.axis = horizontal ? 'x' : 'y';
      const a = byId.get(relation.fromId),
        b = byId.get(relation.toId);
      check.status = 'inconclusive';
      check.reason = 'missing-or-nonphysical-candidate-image-bounds';
      if (
        a &&
        b &&
        a.reflection === 'physical' &&
        b.reflection === 'physical' &&
        valid(a.bounds) &&
        valid(b.bounds)
      ) {
        const first = horizontal ? [a.bounds.left, a.bounds.right] : [a.bounds.top, a.bounds.bottom];
        const second = horizontal ? [b.bounds.left, b.bounds.right] : [b.bounds.top, b.bounds.bottom];
        const delta = (first[0] + first[1] - second[0] - second[1]) / 2;
        const gap = delta >= 0 ? first[0] - second[1] : second[0] - first[1];
        check.centreDelta = delta;
        check.intervalGap = gap;
        // A one-percent visible gap and a three-percent centre difference keep crop/rounding
        // noise and overlapped outlines from masquerading as a contradictory observation.
        if (gap > 0.01 && Math.abs(delta) > 0.03) {
          const expectedSign = relation.type === 'leftOf' || relation.type === 'above' ? -1 : 1;
          check.status = delta * expectedSign < 0 ? 'contradicted' : 'consistent';
          check.reason =
            check.status === 'contradicted'
              ? 'photo-order-opposes-separated-observed-bounds'
              : 'photo-order-agrees-with-separated-observed-bounds';
        } else check.reason = 'overlapping-or-nearby-bounds-do-not-establish-opposite-order';
      }
    }
    result.checks.push(check);
    if (check.status === 'contradicted')
      result.rejected.push({ index, relation: structuredClone(relation), reason: check.reason });
    else {
      result.accepted.push(structuredClone(relation));
      if (check.status === 'inconclusive')
        result.held!.push({ index, relation: structuredClone(relation), reason: check.reason });
      else result.scoredRelations!.push(structuredClone(relation));
    }
  });
  return result;
}
