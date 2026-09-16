import type { RoomDefinition, ProductBounds } from '../room-types';
import type { SceneCandidate, SceneUnderstanding } from './pipeline-contract';
import { resolveSceneCandidates } from './candidate-resolution';
import { proposeWallAlignment, type WallAlignmentParent, type WallAlignmentTarget } from './wall-alignment';
import type { InstallationWall } from './wall-relative-placement';

/** A same-photo observation snapshot, never a measured installation relationship. */
type ObservationItem = Pick<SceneCandidate, 'id' | 'bounds' | 'wall' | 'provenance'>;
export type WallAlignmentObservation = {
  sourceKey: string;
  coordinateSpace: 'normalized-oriented-photo';
  target: ObservationItem;
  parents: ObservationItem[];
};
export type WallAlignmentRecommendationEvidence = {
  version: 1;
  basis: 'photo-relative-position';
  source: 'inferred';
  confirmation: 'pending' | 'user';
  sourceKey: string;
  targetId: string;
  parentId: string;
  targetBounds: ProductBounds;
  parentBounds: ProductBounds;
  targetWall: SceneCandidate['wall'];
  parentWall: SceneCandidate['wall'];
  targetWallSource: string;
  parentWallSource: string;
  reason: string;
};
export type WallAlignmentReference = {
  id: string;
  label: string;
  wall?: InstallationWall;
  plan?: WallAlignmentParent;
  reason?: string;
};
export type WallAlignmentSuggestion = {
  reference: WallAlignmentReference;
  evidence: WallAlignmentRecommendationEvidence;
  result?: ReturnType<typeof proposeWallAlignment>;
};

function validBounds(bounds: ProductBounds) {
  return (
    [bounds.left, bounds.top, bounds.right, bounds.bottom].every(
      (value) => Number.isFinite(value) && value >= 0 && value <= 1,
    ) &&
    bounds.left < bounds.right &&
    bounds.top < bounds.bottom
  );
}

/** Keep exclusions visible elsewhere; this helper cannot rescue reflections, conflicts or occluded evidence. */
export function wallAlignmentObservation(
  scene: SceneUnderstanding,
  automatic: SceneUnderstanding,
  targetId: string,
  sourceKey: string,
): WallAlignmentObservation | undefined {
  if (!sourceKey.trim()) return;
  const { effective, resolution } = resolveSceneCandidates(scene, automatic);
  const blocked = new Set(
    [
      ...scene.relations.filter((relation) => relation.relation !== 'partOf'),
      ...(scene.validation?.quarantinedRelations ?? []).map((entry) => entry.relation),
    ].flatMap((relation) => [relation.frontId, relation.behindId]),
  );
  const safe = (candidate: SceneCandidate) => {
    const original = automatic.candidates.find((item) => item.id === candidate.id);
    return (
      original &&
      validBounds(candidate.bounds) &&
      validBounds(original.bounds) &&
      ['left', 'right', 'top', 'bottom'].every(
        (axis) =>
          candidate.bounds[axis as keyof ProductBounds] === original.bounds[axis as keyof ProductBounds],
      ) &&
      candidate.reflection === 'physical' &&
      !candidate.validation &&
      !blocked.has(candidate.id) &&
      resolution.entries.find((entry) => entry.candidateId === candidate.id)?.disposition === 'fixture'
    );
  };
  const target = effective.find((candidate) => candidate.id === targetId);
  if (
    !target ||
    !['mirror', 'mirrorCabinet', 'wallShelf'].includes(target.kind) ||
    !safe(target) ||
    !['wall', 'unknown'].includes(target.mounting)
  )
    return;
  const snapshot = (candidate: SceneCandidate): ObservationItem =>
    structuredClone({
      id: candidate.id,
      bounds: candidate.bounds,
      wall: candidate.wall,
      provenance: candidate.provenance,
    });
  return {
    sourceKey,
    coordinateSpace: 'normalized-oriented-photo',
    target: snapshot(target),
    parents: effective
      .filter(
        (candidate) =>
          candidate.id !== targetId && ['basin', 'vanity'].includes(candidate.kind) && safe(candidate),
      )
      .map(snapshot),
  };
}

/** Rank possible references only. Camera-space left is never an installation wall; no coordinate is applied here. */
export function suggestWallAlignments(input: {
  observation?: WallAlignmentObservation;
  references: WallAlignmentReference[];
  room: RoomDefinition;
  target: WallAlignmentTarget;
  gapMm: number;
}): WallAlignmentSuggestion[] {
  const { observation, references, room, target, gapMm } = input;
  if (
    !observation ||
    observation.coordinateSpace !== 'normalized-oriented-photo' ||
    !observation.sourceKey.trim() ||
    !validBounds(observation.target.bounds)
  )
    return [];
  const top = observation.target.bounds;
  const topWidth = top.right - top.left;
  const topCenterX = (top.left + top.right) / 2;
  return observation.parents
    .flatMap((parent) => {
      const reference = references.find((item) => item.id === parent.id);
      if (!reference?.plan || !validBounds(parent.bounds)) return [];
      const bottom = parent.bounds;
      const bottomWidth = bottom.right - bottom.left;
      const overlap = Math.min(top.right, bottom.right) - Math.max(top.left, bottom.left);
      const centerDistance = Math.abs(topCenterX - (bottom.left + bottom.right) / 2);
      // A picture relation may suggest a reference, but never yields millimetres or a camera/wall assignment.
      if (
        (top.top + top.bottom) / 2 >= bottom.top ||
        top.bottom > (bottom.top + bottom.bottom) / 2 ||
        overlap / Math.min(topWidth, bottomWidth) < 0.35 ||
        centerDistance > Math.max(topWidth, bottomWidth) * 0.75
      )
        return [];
      if (
        observation.target.wall !== 'unknown' &&
        parent.wall !== 'unknown' &&
        observation.target.wall !== parent.wall
      )
        return [];
      if (
        reference.wall &&
        ((observation.target.wall !== 'unknown' && observation.target.wall !== reference.wall) ||
          (parent.wall !== 'unknown' && parent.wall !== reference.wall))
      )
        return [];
      const result = reference.wall
        ? proposeWallAlignment({ room, parent: reference.plan, wall: reference.wall, target, gapMm })
        : undefined;
      const reason =
        '같은 사진에서 위쪽에 있고 가로 범위가 겹쳐 위치 참고 후보로 제안했어요. 실제 연결·거리·벽을 사진 좌표로 확정한 것은 아니에요.';
      return [
        {
          reference,
          result,
          evidence: {
            version: 1 as const,
            basis: 'photo-relative-position' as const,
            source: 'inferred' as const,
            confirmation: 'pending' as const,
            sourceKey: observation.sourceKey,
            targetId: observation.target.id,
            parentId: parent.id,
            targetBounds: structuredClone(top),
            parentBounds: structuredClone(bottom),
            targetWall: observation.target.wall,
            parentWall: parent.wall,
            targetWallSource: observation.target.provenance?.wall ?? 'model',
            parentWallSource: parent.provenance?.wall ?? 'model',
            reason,
          },
          rank: overlap / Math.min(topWidth, bottomWidth) - centerDistance,
        },
      ];
    })
    .sort((a, b) => b.rank - a.rank || a.reference.id.localeCompare(b.reference.id))
    .slice(0, 3)
    .map(({ reference, evidence, result }) => ({ reference, evidence, result }));
}
