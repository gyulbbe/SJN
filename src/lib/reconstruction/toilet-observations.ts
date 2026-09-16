import type { ReconstructionCandidate } from './types';

/** A rule over recorded DeepLab parts, not a separate model classification or a text interpretation. */
export function inferToiletLidState(
  candidate: ReconstructionCandidate,
): { value: 'open'; source: 'inferred'; basis: 'connected-toilet-lid-bowl' } | undefined {
  const parts = candidate.evidence.contextualParts;
  if (
    candidate.kind !== 'toilet' ||
    (candidate.source !== undefined && candidate.source !== 'deeplab') ||
    candidate.reflectionOf ||
    candidate.requiresReview ||
    candidate.status === 'ignored' ||
    candidate.evidence.contextualKind !== 'toilet-assembly' ||
    !parts ||
    parts.toiletPixels < 100 ||
    parts.bowlPixels < 100 ||
    parts.surroundRatio < 0.5 ||
    parts.surroundRatio > 1 ||
    candidate.evidence.meanMargin < 0.8 ||
    ![parts.toiletPixels, parts.bowlPixels, parts.surroundRatio, candidate.evidence.meanMargin].every(
      Number.isFinite,
    )
  )
    return undefined;
  const { lidBounds: lid, bowlBounds: bowl } = parts;
  const valid = (b: ReconstructionCandidate['bounds'] | undefined): b is ReconstructionCandidate['bounds'] =>
    !!b &&
    Object.values(b).every((n) => Number.isFinite(n) && n >= 0 && n <= 1) &&
    b.right > b.left &&
    b.bottom > b.top;
  if (!valid(lid) || !valid(bowl) || !valid(candidate.bounds)) return undefined;
  const contained = (b: ReconstructionCandidate['bounds']) =>
    b.left >= candidate.bounds.left - 0.004 &&
    b.right <= candidate.bounds.right + 0.004 &&
    b.top >= candidate.bounds.top - 0.004 &&
    b.bottom <= candidate.bounds.bottom + 0.004;
  const overlap = Math.max(0, Math.min(lid.right, bowl.right) - Math.max(lid.left, bowl.left));
  // Require the lid above the bowl with overlapping horizontal support. The semantic assembly
  // already recorded actual bowl-to-toilet contact; bounding rectangles alone never create it.
  if (
    !contained(lid) ||
    !contained(bowl) ||
    bowl.top < (lid.top + lid.bottom) / 2 ||
    (bowl.top + bowl.bottom) / 2 <= (lid.top + lid.bottom) / 2 ||
    bowl.top - lid.bottom > Math.max(lid.bottom - lid.top, bowl.bottom - bowl.top) ||
    overlap / Math.min(lid.right - lid.left, bowl.right - bowl.left) < 0.35
  )
    return undefined;
  return { value: 'open', source: 'inferred', basis: 'connected-toilet-lid-bowl' };
}
