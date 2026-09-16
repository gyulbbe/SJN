import type { RoomDefinition } from '../room-types';
import type { DepthRoomObservation } from './depth-room-geometry';
import { inspectDepthRoomCameraHypotheses } from './depth-room-hypotheses';
import { projectSourcePoint, type SourcePlacement } from './source-camera';

export const MAX_DEPTH_ROOM_REPLAY_HYPOTHESES = 8;

type RoomHypothesisReport = ReturnType<typeof inspectDepthRoomCameraHypotheses>;
type RoomHypothesis = RoomHypothesisReport['hypotheses'][number];

/** Candidate replay eligibility, never selection of a room camera or a merged wall. */
export function assessDepthRoomHypothesisCoverage(
  room: RoomDefinition,
  observation: DepthRoomObservation,
  expectedFingerprint: string,
) {
  const report = inspectDepthRoomCameraHypotheses(room, observation, expectedFingerprint);
  const rejected = new Set(report.strict.rejectedPlanes.map((plane) => plane.id));
  const requiredWallIds = observation.walls
    .filter((plane) => !rejected.has(plane.id))
    .map((plane) => plane.id);
  const hypotheses = report.hypotheses.filter(
    (hypothesis) => hypothesis.result.fit.status === 'estimated' && hypothesis.result.fit.camera,
  );
  const covered = new Set(hypotheses.flatMap((hypothesis) => hypothesis.wallIds));
  const uncoveredWallIds = requiredWallIds.filter((id) => !covered.has(id));
  const reasons: string[] = [];
  if (report.strict.fit.status !== 'held') reasons.push('strict-camera-already-estimated');
  if (observation.walls.length > 16) reasons.push('too-many-observed-walls');
  if (new Set(observation.walls.map((plane) => plane.id)).size !== observation.walls.length)
    reasons.push('duplicate-observed-wall-ids');
  if (hypotheses.length < 2) reasons.push('requires-multiple-valid-room-hypotheses');
  if (hypotheses.length > MAX_DEPTH_ROOM_REPLAY_HYPOTHESES) reasons.push('too-many-valid-room-hypotheses');
  if (uncoveredWallIds.length) reasons.push('valid-observed-wall-excluded-from-all-hypotheses');
  return {
    scope: 'candidate-replay-wall-coverage' as const,
    status: reasons.length ? ('held' as const) : ('eligible' as const),
    strict: report.strict,
    hypotheses,
    requiredWallIds,
    uncoveredWallIds,
    reasons,
    promotedRoomCamera: false as const,
  };
}

export type DepthRoomHypothesisCoverage = ReturnType<typeof assessDepthRoomHypothesisCoverage>;
export type DepthHypothesisPlacement = {
  wallIds: RoomHypothesis['wallIds'];
  placement: SourcePlacement;
};

/**
 * Tests the sensitivity of one independently observed photo anchor across every admissible
 * room hypothesis. This does not measure the accuracy of the source camera, model dimensions,
 * fixture type, orientation, wall attachment, or collision. Callers must validate those separately.
 */
export function inspectDepthHypothesisAnchorAgreement(
  coverage: DepthRoomHypothesisCoverage,
  proposals: readonly DepthHypothesisPlacement[],
) {
  const transfers: {
    fromWallIds: RoomHypothesis['wallIds'];
    toWallIds: RoomHypothesis['wallIds'];
    errorPx: number;
    inFront: boolean;
    inFrame: boolean;
  }[] = [];
  const result = {
    scope: 'cross-hypothesis-anchor-sensitivity' as const,
    status: 'held' as 'consistent' | 'held',
    reasons: [] as string[],
    pixelTolerance: null as number | null,
    maxTransferErrorPx: null as number | null,
    transfers,
    toleranceSource: 'existing-source-camera-observation-budget-3px-or-image-diagonal-0.012' as const,
    establishesRoomCamera: false as const,
  };
  const held = (reason: string) => {
    result.reasons.push(reason);
    return result;
  };
  if (coverage.status !== 'eligible' || coverage.hypotheses.length < 2)
    return held('room-hypothesis-coverage-is-incomplete');
  const key = (ids: readonly string[]) => JSON.stringify([...ids].sort());
  const proposalMap = new Map(proposals.map((proposal) => [key(proposal.wallIds), proposal.placement]));
  if (
    proposals.length !== coverage.hypotheses.length ||
    proposalMap.size !== proposals.length ||
    new Set(coverage.hypotheses.map((hypothesis) => key(hypothesis.wallIds))).size !==
      coverage.hypotheses.length
  )
    return held('missing-or-duplicate-hypothesis-placement');
  const cameras = coverage.hypotheses.map((hypothesis) => hypothesis.result.fit.camera);
  const firstCamera = cameras[0];
  if (!firstCamera) return held('missing-hypothesis-camera');
  const image = firstCamera.image;
  for (const camera of cameras) {
    if (
      !camera ||
      ![
        ...camera.positionMm,
        ...camera.quaternion,
        camera.verticalFovDegrees,
        camera.image.width,
        camera.image.height,
      ].every(Number.isFinite) ||
      camera.verticalFovDegrees < 5 ||
      camera.verticalFovDegrees > 150 ||
      Math.abs(Math.hypot(...camera.quaternion) - 1) > 1e-4 ||
      !Number.isInteger(camera.image.width) ||
      !Number.isInteger(camera.image.height) ||
      camera.image.width <= 0 ||
      camera.image.height <= 0 ||
      camera.image.width !== image.width ||
      camera.image.height !== image.height
    )
      return held('invalid-or-mismatched-hypothesis-camera');
  }
  // This is the existing room-observation pixel budget, not a newly tuned mm/degree limit.
  result.pixelTolerance = Math.max(3, Math.hypot(image.width, image.height) * 0.012);
  const placements = coverage.hypotheses.map((hypothesis) => proposalMap.get(key(hypothesis.wallIds)));
  const first = placements[0];
  if (!first?.anchor || first.status !== 'estimated') return held('candidate-held-in-a-room-hypothesis');
  for (const placement of placements) {
    if (!placement?.placement || placement.status !== 'estimated' || !placement.anchor)
      return held('candidate-held-in-a-room-hypothesis');
    if (placement.provenance.position === 'user') return held('manual-placement-is-not-automatic-agreement');
    if (
      !['floor', 'back', 'left', 'right'].includes(placement.placement.face) ||
      ![placement.placement.u, placement.placement.v].every(
        (value) => Number.isFinite(value) && value >= 0 && value <= 1,
      ) ||
      !Number.isFinite(placement.placement.baseHeightMm) ||
      placement.placement.baseHeightMm < 0 ||
      ![placement.anchor.point.x, placement.anchor.point.y].every(
        (value) => Number.isFinite(value) && value >= 0 && value <= 1,
      ) ||
      placement.anchor.worldMm.length !== 3 ||
      !placement.anchor.worldMm.every(Number.isFinite)
    )
      return held('invalid-hypothesis-anchor-or-placement');
    if (
      placement.candidateId !== first.candidateId ||
      placement.placement.face !== first.placement?.face ||
      placement.anchor.source !== first.anchor.source ||
      placement.supportEvidence?.pointRole !== first.supportEvidence?.pointRole ||
      Math.abs(placement.anchor.point.x - first.anchor.point.x) > 1e-9 ||
      Math.abs(placement.anchor.point.y - first.anchor.point.y) > 1e-9
    )
      return held('candidate-surface-or-observed-anchor-disagrees');
  }
  for (let from = 0; from < placements.length; from++) {
    for (let to = 0; to < placements.length; to++) {
      if (from === to) continue;
      const projected = projectSourcePoint(cameras[to]!, placements[from]!.anchor!.worldMm);
      const observed = placements[to]!.anchor!.point;
      const errorPx = Math.hypot(
        (projected.point.x - observed.x) * image.width,
        (projected.point.y - observed.y) * image.height,
      );
      if (!Number.isFinite(errorPx)) return held('non-finite-anchor-transfer');
      result.maxTransferErrorPx = Math.max(result.maxTransferErrorPx ?? 0, errorPx);
      transfers.push({
        fromWallIds: [...coverage.hypotheses[from].wallIds],
        toWallIds: [...coverage.hypotheses[to].wallIds],
        errorPx,
        inFront: projected.inFront,
        inFrame: projected.inFrame,
      });
    }
  }
  if (
    transfers.some(
      (transfer) => !transfer.inFront || !transfer.inFrame || transfer.errorPx > result.pixelTolerance!,
    )
  )
    return held('anchor-changes-under-valid-room-hypotheses');
  result.status = 'consistent';
  return result;
}
