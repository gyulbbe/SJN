import { describe, expect, it } from 'vitest';
import {
  ESTIMATED_DEPTH_RELATION_POLICY,
  inspectEstimatedDepthRelations,
} from '../src/lib/reconstruction/estimated-depth-relation-evidence';
import type { LayoutObservationInput } from '../src/lib/reconstruction/estimated-layout';

type Relation = LayoutObservationInput['relations'][number];
const relation = (type: Relation['type'], note = 'Unedited model observation'): Relation => ({
  fromId: 'fixture-a',
  toId: 'fixture-b',
  type,
  note,
});

describe('unverified model depth relations', () => {
  it.each(['inFrontOf', 'behind'] as const)('holds %s from scoring without calling it false', (type) => {
    const input = [relation(type)];
    const result = inspectEstimatedDepthRelations(input);
    expect(result.policy).toBe(ESTIMATED_DEPTH_RELATION_POLICY);
    expect(result.evidenceScope).toBe('no-independent-fixture-depth-in-current-contract');
    expect(result.observedRelations).toEqual(input);
    expect(result.scoredRelations).toEqual([]);
    expect(result.heldRelations).toEqual([
      {
        index: 0,
        relation: input[0],
        status: 'unverified',
        reason: 'independent-fixture-camera-depth-unavailable',
        effectiveWeight: 0,
      },
    ]);
    expect(result.checks).toEqual(result.heldRelations);
  });

  it('leaves every non-depth relation for its existing validator and scorer in input order', () => {
    const input: Relation[] = [
      relation('leftOf'),
      relation('rightOf'),
      relation('above'),
      relation('below'),
      relation('attachedTo'),
      relation('supportedBy'),
      relation('visibleThrough'),
    ];
    const result = inspectEstimatedDepthRelations(input);
    expect(result.scoredRelations).toEqual(input);
    expect(result.heldRelations).toEqual([]);
    expect(result.checks.map((check) => check.status)).toEqual(input.map(() => 'outside-depth-policy'));
    expect(result.checks.every((check) => check.effectiveWeight === undefined)).toBe(true);
  });

  it('preserves order, repeated observations and their original indexes in mixed input', () => {
    const input = [relation('behind'), relation('leftOf'), relation('behind'), relation('supportedBy')];
    const result = inspectEstimatedDepthRelations(input);
    expect(result.observedRelations).toEqual(input);
    expect(result.heldRelations.map((held) => held.index)).toEqual([0, 2]);
    expect(result.scoredRelations).toEqual([input[1], input[3]]);
    expect(result.checks.map((check) => check.index)).toEqual([0, 1, 2, 3]);
  });

  it('does not derive depth truth or reverse a relation from a contradictory note', () => {
    const input = [relation('behind', 'Fixture A is nearer than fixture B.')];
    const result = inspectEstimatedDepthRelations(input);
    expect(result.observedRelations[0]).toEqual(input[0]);
    expect(result.heldRelations[0].relation.type).toBe('behind');
    expect(result.heldRelations[0].status).toBe('unverified');
  });

  it('cannot re-enable a plausible glass occlusion or mirror relation without independent data', () => {
    const input = [
      { ...relation('behind'), fromId: 'shower', toId: 'glass' },
      { ...relation('inFrontOf'), fromId: 'vanity', toId: 'mirror' },
    ];
    const result = inspectEstimatedDepthRelations(input);
    expect(result.scoredRelations).toEqual([]);
    expect(result.observedRelations).toEqual(input);
    expect(result.heldRelations.every((held) => held.effectiveWeight === 0)).toBe(true);
  });

  it('does not mutate inputs or share mutable output entries across provenance lists', () => {
    const input = [relation('behind'), relation('above')];
    const original = structuredClone(input);
    Object.freeze(input[0]);
    Object.freeze(input[1]);
    Object.freeze(input);
    const result = inspectEstimatedDepthRelations(input);
    result.observedRelations[0].note = 'edited display copy';
    result.heldRelations[0].relation.fromId = 'edited held copy';
    result.scoredRelations[0].note = 'edited scorer copy';
    expect(input).toEqual(original);
    expect(result.checks[0].relation).toEqual(original[0]);
    expect(result.checks[1].relation).toEqual(original[1]);
    expect(result.heldRelations[0].relation.note).toBe(original[0].note);
  });

  it('is deterministic and returns an explicit empty result for no observations', () => {
    const first = inspectEstimatedDepthRelations([]);
    expect(first).toEqual(inspectEstimatedDepthRelations([]));
    expect(first.observedRelations).toEqual([]);
    expect(first.scoredRelations).toEqual([]);
    expect(first.checks).toEqual([]);
  });
});
