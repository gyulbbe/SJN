import type { LayoutObservationInput } from './estimated-layout';

type Relation = LayoutObservationInput['relations'][number];

export const ESTIMATED_DEPTH_RELATION_POLICY = 'unverified-depth-prior-held-v1';

export type EstimatedDepthRelationEvidence = {
  version: 1;
  policy: typeof ESTIMATED_DEPTH_RELATION_POLICY;
  evidenceScope: 'no-independent-fixture-depth-in-current-contract';
  /** Original observations, including their notes. Holding a score does not correct an observation. */
  observedRelations: Relation[];
  /** Relations left for the existing scorer; this helper does not validate their other semantics. */
  scoredRelations: Relation[];
  heldRelations: {
    index: number;
    relation: Relation;
    status: 'unverified';
    reason: 'independent-fixture-camera-depth-unavailable';
    effectiveWeight: 0;
  }[];
  checks: {
    index: number;
    relation: Relation;
    status: 'unverified' | 'outside-depth-policy';
    reason: 'independent-fixture-camera-depth-unavailable' | 'non-depth-relation-unchanged';
    effectiveWeight?: 0;
  }[];
};

/**
 * A model-only front/behind statement must not independently overturn a better wall/yaw fit.
 * The current MoGe contract contains room planes and their support, not candidate-volume
 * depths or independently validated occlusion boundaries. A surrounding wall normal, a
 * photo y-coordinate, or a proposed model's world-z centre cannot fill that evidence gap.
 *
 * Preserve the observation and its uncertainty; omit only its scoring contribution. This
 * does not declare the relation false, reverse it, merge candidates, or parse its note.
 * No speculative depth-evidence promotion input is provided until such data actually exists.
 */
export function inspectEstimatedDepthRelations(
  relations: readonly Relation[],
): EstimatedDepthRelationEvidence {
  const result: EstimatedDepthRelationEvidence = {
    version: 1,
    policy: ESTIMATED_DEPTH_RELATION_POLICY,
    evidenceScope: 'no-independent-fixture-depth-in-current-contract',
    observedRelations: structuredClone([...relations]),
    scoredRelations: [],
    heldRelations: [],
    checks: [],
  };
  relations.forEach((relation, index) => {
    if (relation.type === 'inFrontOf' || relation.type === 'behind') {
      const held = {
        index,
        relation: structuredClone(relation),
        status: 'unverified' as const,
        reason: 'independent-fixture-camera-depth-unavailable' as const,
        effectiveWeight: 0 as const,
      };
      result.heldRelations.push(held);
      result.checks.push(structuredClone(held));
    } else {
      result.scoredRelations.push(structuredClone(relation));
      result.checks.push({
        index,
        relation: structuredClone(relation),
        status: 'outside-depth-policy',
        reason: 'non-depth-relation-unchanged',
      });
    }
  });
  return result;
}
