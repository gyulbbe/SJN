import type { Point } from '../types';
import { homography, transformPoint, validateQuad } from '../render/math';
import {
  hasSupportedReconstructionKind,
  type ReconstructionCandidate,
  type ReconstructionPlane,
  type ReconstructionReview,
  type ReconstructionInstallation,
} from './types';
import {
  hasPhysicalFloorExtent,
  projectSourcePlanePoint,
  type SourcePlanePosition,
} from './source-plane-mapping';

function inPlane(plane: ReconstructionPlane, point: Point, tolerance = 0.08) {
  if (
    !validateQuad(plane.quad) ||
    plane.depthStart < 0 ||
    plane.depthEnd > 1 ||
    plane.depthStart >= plane.depthEnd
  )
    return;
  try {
    const uv = transformPoint(homography(plane.quad), point);
    if (uv.x < -tolerance || uv.x > 1 + tolerance || uv.y < -tolerance || uv.y > 1 + tolerance) return;
    return uv;
  } catch {
    return;
  }
}
/** A paint/semantic crop may cover only part of a wall and cannot identify a physical wall. */
export function isAppearancePlane(plane: ReconstructionPlane): boolean {
  return (
    plane.geometrySource === 'appearance-region' ||
    (plane.geometrySource === undefined && plane.id.startsWith('observed-'))
  );
}
function spatialWall(plane: ReconstructionPlane) {
  return plane.face !== 'floor' && (!isAppearancePlane(plane) || plane.confirmed);
}
/** Installation judgment is separate from detection and is never a measured product dimension. */
export function judgeCandidateInstallation(
  candidate: ReconstructionCandidate,
  review: ReconstructionReview,
): ReconstructionInstallation {
  if (candidate.installation && candidate.installation.mode !== 'unknown') {
    const previous = candidate.installation;
    if (
      previous.source === 'user' ||
      previous.mode === 'floor' ||
      previous.mode === 'suspended' ||
      !previous.wall ||
      review.planes.some((p) => p.face === previous.wall && spatialWall(p))
    )
      return { ...previous };
    return {
      ...previous,
      wall: undefined,
      reason:
        '벽 설치 후보는 찾았지만 마감 영역만으로 설치 벽을 확정할 수 없어요. 설치 벽과 높이를 확인해 주세요.',
    };
  }
  if (candidate.detectedLabel === 'cabinet' && !candidate.proposedKind)
    return { mode: 'unknown', source: 'inferred', reason: '수납장의 종류와 설치 방식을 확인해 주세요.' };
  if (candidate.kind === 'basin') {
    const floor = review.planes.find((p) => p.face === 'floor');
    const floorContact = floor && inPlane(floor, candidate.foot);
    const aspect =
      (candidate.bounds.bottom - candidate.bounds.top) /
      Math.max(0.001, candidate.bounds.right - candidate.bounds.left);
    const wallRegions = review.planes.filter((p) => p.face !== 'floor' && inPlane(p, candidate.foot, 0.01));
    const walls = wallRegions.filter(spatialWall);
    const support = candidate.evidence.pedestalSupport;
    // A floor-adjacent bowl alone is ambiguous; require an observed, continuous narrow support.
    if (
      floorContact &&
      support &&
      support.stemWidthRatio <= 0.6 &&
      support.stemHeightRatio >= 0.3 &&
      support.coverage >= 0.7
    )
      return {
        mode: 'floor',
        basinVariant: 'pedestal',
        source: 'inferred',
        reason:
          '세면볼 아래로 이어지는 좁고 긴 지지대와 바닥 접점을 관측해 기둥형으로 추정했어요. 설치 방식과 위치를 확인해 주세요.',
      };
    if (!floorContact && walls.length === 1 && aspect < 1.2)
      return {
        mode: 'wall',
        wall: walls[0].face as 'left' | 'back' | 'right',
        basinVariant: 'wall',
        source: 'inferred',
        reason: '세면볼 하단이 바닥에 닿지 않고 하나의 관측 벽 영역에 있어 벽걸이형으로 추정했어요.',
      };
    if (!floorContact && wallRegions.length && aspect < 1.2)
      return {
        mode: 'wall',
        basinVariant: 'wall',
        source: 'inferred',
        reason:
          '바닥과 떨어진 세면볼을 찾아 벽걸이형을 제안했지만 관측한 마감 영역만으로 설치 벽과 높이를 알 수 없어요. 설치 벽과 높이를 확인해 주세요.',
      };
    return {
      mode: 'unknown',
      source: 'inferred',
      reason: floorContact
        ? '세면볼 영역만으로 기둥·하부장 유무를 판단할 수 없어요. 설치 방식을 선택해 주세요.'
        : '세면대는 찾았지만 설치 벽이나 지지 형태 확인이 필요해요.',
    };
  }
  if (candidate.kind === 'showerCurtain')
    return {
      mode: 'suspended',
      source: 'inferred',
      reason: '매달린 커튼이에요. 바닥 접점으로 설치 높이를 확정하지 않으며 지지 위치를 확인해 주세요.',
    };
  if (['toilet', 'vanity', 'bath', 'glassPartition'].includes(candidate.kind))
    return {
      mode: 'floor',
      source: 'inferred',
      reason: '설비 종류에 따른 바닥 설치를 제안했어요. 접지점과 높이는 별도 확인이 필요해요.',
    };
  return {
    mode: 'wall',
    source: 'inferred',
    reason: review.planes.some(spatialWall)
      ? '설비 종류에 따른 벽 설치를 제안했어요. 관측 방 경계에서 위치를 추정하며 실제 높이는 확인이 필요해요.'
      : '벽 설치 설비는 찾았지만 관측한 마감 영역만으로 실제 설치 벽과 높이를 알 수 없어요. 설치 벽과 높이를 확인해 주세요.',
  };
}

export type CandidateMappingInspection = {
  placement?: SourcePlanePosition;
  /** An unconfirmed numeric proposal for review only; never permission to create a fixture. */
  provisionalPlacement?: SourcePlanePosition;
  reasons: string[];
};

export function inspectReconstructionCandidateMapping(
  candidate: ReconstructionCandidate,
  review: ReconstructionReview,
): CandidateMappingInspection {
  if (candidate.requiresReview || (candidate.source !== 'user' && !hasSupportedReconstructionKind(candidate)))
    return { reasons: [candidate.warning ?? '종류·반사·분류 근거를 먼저 확인해 주세요.'] };
  const installation = judgeCandidateInstallation(candidate, review);
  if (installation.mode === 'unknown') return { reasons: [installation.reason] };
  if (installation.mode === 'suspended')
    return {
      reasons: [
        '매달린 커튼의 위치·높이는 바닥 접점으로 계산할 수 없어요. 추정 배치나 직접 입력한 걸이 위치를 사용해 주세요.',
      ],
    };
  if (installation.mode === 'floor') {
    const plane = review.planes.find((p) => p.face === 'floor');
    if (!plane) return { reasons: ['바닥 기준점은 있지만 사진과 실제 바닥을 연결할 평면이 없어요.'] };
    const mapped = projectSourcePlanePoint(plane, candidate.foot);
    if (!mapped)
      return { reasons: ['바닥 평면의 네 점이나 대응 범위가 유효하지 않아 위치를 계산하지 못했어요.'] };
    const reasons: string[] = [];
    if (!hasPhysicalFloorExtent(plane))
      reasons.push(
        '바닥 무늬 영역은 찾았지만 실제 방 바닥과의 대응 범위는 미확정이에요. 표시한 수치는 임시 범위로 계산한 검토용 제안이며 설치 위치를 확인해야 해요.',
      );
    if (candidate.bounds.bottom >= 0.995 || candidate.foot.y >= 0.995)
      reasons.push(
        '제품 하단이 사진 경계에 닿아 실제 바닥 접점을 확인할 수 없어요. 잘린 윤곽을 접점으로 확정하지 않았어요.',
      );
    if (!mapped.inside)
      reasons.push(
        '관측한 접점이 선언된 바닥 평면 밖에 있어요. 경계 안으로 이동하지 않고 계산값을 보존했어요.',
      );
    return reasons.length
      ? { provisionalPlacement: mapped.position, reasons }
      : {
          placement: mapped.position,
          reasons: [
            '선언된 바닥 구간에 접점을 변환했어요. 제품 하단을 앞쪽 접점으로 가정한 추정이며 실제 접점·방향·규격은 별도 확인이 필요해요.',
          ],
        };
  }
  const point =
    candidate.kind === 'door' || candidate.kind === 'basin' || candidate.kind === 'wallShelf'
      ? candidate.foot
      : {
          x: (candidate.bounds.left + candidate.bounds.right) / 2,
          y: (candidate.bounds.top + candidate.bounds.bottom) / 2,
        };
  const matching = review.planes
    .filter(
      (p) =>
        p.face !== 'floor' &&
        (!installation.wall || p.face === installation.wall) &&
        (spatialWall(p) || (installation.source === 'user' && installation.wall === p.face)),
    )
    .map((plane) => projectSourcePlanePoint(plane, point))
    .filter((entry) => entry?.inside);
  if (matching.length !== 1)
    return {
      reasons: [
        installation.reason,
        matching.length > 1
          ? '기준점이 여러 벽에 대응해 설치 벽을 확인해야 해요.'
          : '기준점을 포함하는 물리 벽이 없어요. 사진의 좌우 위치만으로 설치 벽을 지정하지 않았어요.',
      ],
    };
  return {
    placement: matching[0]!.position,
    reasons: [
      '기준점이 하나의 설치 벽에 대응해 선언된 폭·높이·깊이 구간으로 변환했어요. 미확정 촬영 카메라의 실측 복원은 아니에요.',
    ],
  };
}

export function mapReconstructionCandidate(
  candidate: ReconstructionCandidate,
  review: ReconstructionReview,
): SourcePlanePosition | undefined {
  return inspectReconstructionCandidateMapping(candidate, review).placement;
}
