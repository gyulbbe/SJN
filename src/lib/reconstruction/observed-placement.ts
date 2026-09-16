import { homography, transformPoint, validateQuad } from '../render/math';
import type { RoomDefinition } from '../room-types';
import type { Point, Quad } from '../types';
import { candidateBoxIoU } from './candidate-resolution';
import { judgeCandidateInstallation, mapReconstructionCandidate } from './installation';
import type { SceneCandidate } from './pipeline-contract';
import type { SourcePlacement } from './source-camera';
import {
  reconstructionDefaults,
  hasSupportedReconstructionKind,
  type ReconstructionCandidate,
  type ReconstructionInstallation,
  type ReconstructionReview,
} from './types';

/** Shared by contact-to-centre placement and the actual standard model. */
export function candidateFloorYaw(candidate: SceneCandidate, defaultYaw = 0) {
  if (['toilet', 'basin', 'vanity'].includes(candidate.kind) && candidate.wall !== 'unknown')
    return candidate.wall === 'left' ? 90 : candidate.wall === 'right' ? -90 : 0;
  return defaultYaw;
}

export type ObservedPlacementDiagnosticCode =
  | 'reused'
  | 'unknown-kind'
  | 'reflection-unresolved'
  | 'invalid-candidate'
  | 'unsupported-mounting'
  | 'suspended-anchor-unobserved'
  | 'observation-match-missing'
  | 'observation-match-ambiguous'
  | 'observation-shared'
  | 'installation-unknown'
  | 'installation-user-evidence'
  | 'installation-conflict'
  | 'candidate-cropped'
  | 'observed-plane-missing'
  | 'floor-extent-unconfirmed'
  | 'point-outside-observed-plane'
  | 'plane-projection-failed'
  | 'observed-plane-ambiguous'
  | 'plane-extent-invalid'
  | 'baseline-mapping-unavailable'
  | 'estimated-height-outside-room';

type ObservationMatchDiagnostic = {
  candidateId: string;
  intersectionOverUnion: number;
  eligible: boolean;
  exclusions: string[];
};
type PlaneReuseDiagnostic = {
  planeId: string;
  face: ReconstructionReview['planes'][number]['face'];
  geometrySource?: ReconstructionReview['planes'][number]['geometrySource'];
  eligible: boolean;
  exclusion?: 'not-room-boundaries' | 'invalid-quad' | 'different-face' | 'projection-failed';
  pointUv?: Point;
  inside?: boolean;
  /** Photo boundary distance only, never a placement tolerance or physical distance. */
  nearestBoundary?: { edge: 'top' | 'right' | 'bottom' | 'left'; distancePx: number; point: Point };
};
export type ObservedPlacementDiagnostic = {
  candidateId: string;
  status: 'reused' | 'held';
  code: ObservedPlacementDiagnosticCode;
  message: string;
  baselineCandidateId?: string;
  /** Strongest same-kind observations, including reasons they cannot be borrowed. */
  matches?: ObservationMatchDiagnostic[];
  details?: string[];
  point?: Point;
  pointRole?: NonNullable<SourcePlacement['baselineEvidence']>['pointRole'];
  image?: { width: number; height: number };
  planes?: PlaneReuseDiagnostic[];
};
export type ObservedPlacementInspection = {
  placement?: SourcePlacement;
  diagnostic: ObservedPlacementDiagnostic;
};
export type ObservedInstallationInspection = {
  installation?: {
    mode: 'floor' | 'wall';
    wall?: ReconstructionInstallation['wall'];
    basinVariant?: ReconstructionInstallation['basinVariant'];
    /** Independent rule/geometry inference, never a measured installation. */
    source: 'geometry';
  };
  baselineEvidence?: {
    candidateId: string;
    source: 'deeplab';
    intersectionOverUnion: number;
    matchMode: 'bounds-overlap' | 'pedestal-bowl-part';
    candidateCoverage?: number;
    positionBorrowed: false;
    wallGeometrySource?: 'room-boundaries';
  };
  diagnostic: ObservedPlacementDiagnostic;
};

function nearestPhotoBoundary(point: Point, quad: Quad, image?: { width: number; height: number }) {
  if (!image || ![image.width, image.height].every((value) => Number.isFinite(value) && value > 0)) return;
  if (![point.x, point.y].every(Number.isFinite)) return;
  const edges = ['top', 'right', 'bottom', 'left'] as const;
  return quad
    .map((start, index) => {
      const end = quad[(index + 1) % quad.length];
      const dx = (end.x - start.x) * image.width;
      const dy = (end.y - start.y) * image.height;
      const px = (point.x - start.x) * image.width;
      const py = (point.y - start.y) * image.height;
      const lengthSquared = dx * dx + dy * dy;
      const t = lengthSquared ? Math.max(0, Math.min(1, (px * dx + py * dy) / lengthSquared)) : 0;
      return {
        edge: edges[index],
        distancePx: Math.hypot(px - t * dx, py - t * dy),
        point: { x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t },
      };
    })
    .sort((a, b) => a.distancePx - b.distancePx)[0];
}

/** Backward-compatible success-only API. Diagnostics do not change any placement decisions. */
export function reuseObservedPlacement(
  candidate: SceneCandidate,
  eligibleCandidates: readonly SceneCandidate[],
  baseline: ReconstructionReview,
  room: RoomDefinition,
): SourcePlacement | undefined {
  return inspectObservedPlacement(candidate, eligibleCandidates, baseline, room).placement;
}

/** Shared identity and installation checks; this stage never projects or borrows a position. */
function inspectInstallationObservation(
  candidate: SceneCandidate,
  eligibleCandidates: readonly SceneCandidate[],
  baseline: ReconstructionReview,
  installationOnly = false,
) {
  const diagnostic: ObservedPlacementDiagnostic = {
    candidateId: candidate.id,
    status: 'held',
    code: 'unknown-kind',
    message: '',
  };
  const reject = (code: ObservedPlacementDiagnosticCode, message: string, details?: string[]) => ({
    observation: undefined,
    diagnostic: { ...diagnostic, code, message, ...(details ? { details } : {}) },
  });
  if (candidate.kind === 'unknown')
    return reject('unknown-kind', '종류가 미정이라 기존 설비 관측과 연결하지 못했어요.');
  if (candidate.reflection !== 'physical')
    return reject(
      'reflection-unresolved',
      '실제 설비인지 반사인지 미확정이라 기존 설치 근거를 재사용하지 않았어요.',
    );
  if (candidate.validation?.issues.length)
    return reject(
      'invalid-candidate',
      '후보 관측에 확인할 모순이 있어 기존 설치 근거를 재사용하지 않았어요.',
      candidate.validation.issues.map((issue) => issue.message),
    );
  if (candidate.mounting === 'suspended' || candidate.kind === 'showerCurtain')
    return reject(
      'suspended-anchor-unobserved',
      '매달린 설비의 걸이 위치가 관측되지 않아 설치 위치를 확정하지 않았어요. 사진 영역 하단을 바닥 접점으로 사용하지 않으며 후보를 보존해요.',
      [`후보 설치 방식: ${candidate.mounting}`, '걸이 지점 관측 또는 사용자 위치 확인이 필요해요.'],
    );
  if (!['floor', 'wall', 'unknown'].includes(candidate.mounting))
    return reject(
      'unsupported-mounting',
      '기존 바닥·벽 관측과 다른 설치 방식이라 위치를 재사용하지 않았어요.',
      [`후보 설치 방식: ${candidate.mounting}`],
    );
  const matchObservation = (claim: SceneCandidate, observed: ReconstructionCandidate) => {
    if (claim.kind !== observed.kind) return;
    const overlap = candidateBoxIoU(observed.bounds, claim.bounds);
    if (overlap >= 0.5) return { mode: 'bounds-overlap' as const, overlap };
    // A bowl-only model box may omit a real pedestal segmented in the baseline. This exception
    // requires continuous stem evidence; a generic contained part or cabinet width cannot qualify.
    const support = observed.evidence.pedestalSupport;
    if (
      claim.kind !== 'basin' ||
      claim.basinStyle !== 'pedestal' ||
      overlap < 0.25 ||
      !support ||
      ![support.stemWidthRatio, support.stemHeightRatio, support.coverage].every(Number.isFinite) ||
      support.stemWidthRatio <= 0 ||
      support.stemWidthRatio > 0.6 ||
      support.stemHeightRatio < 0.3 ||
      support.stemHeightRatio > 1 ||
      support.coverage < 0.7 ||
      support.coverage > 1
    )
      return;
    const bounds = claim.bounds;
    const area = (bounds.right - bounds.left) * (bounds.bottom - bounds.top);
    const intersection =
      Math.max(
        0,
        Math.min(bounds.right, observed.bounds.right) - Math.max(bounds.left, observed.bounds.left),
      ) *
      Math.max(
        0,
        Math.min(bounds.bottom, observed.bounds.bottom) - Math.max(bounds.top, observed.bounds.top),
      );
    const coverage = intersection / area;
    if (!Number.isFinite(coverage) || coverage < 0.9) return;
    return { mode: 'pedestal-bowl-part' as const, overlap, coverage };
  };
  const sameKindObservations = baseline.candidates.filter((observed) => observed.kind === candidate.kind);
  const observationMatches = sameKindObservations
    .map((observed) => ({
      candidateId: observed.id,
      intersectionOverUnion: candidateBoxIoU(observed.bounds, candidate.bounds),
      eligible:
        observed.source === 'deeplab' &&
        !observed.requiresReview &&
        !observed.reflectionOf &&
        observed.status !== 'ignored',
      exclusions: [
        ...(observed.source !== 'deeplab' ? ['not-deeplab'] : []),
        ...(observed.requiresReview ? ['requires-review'] : []),
        ...(observed.reflectionOf ? ['reflection'] : []),
        ...(observed.status === 'ignored' ? ['ignored'] : []),
      ],
    }))
    .sort((a, b) => b.intersectionOverUnion - a.intersectionOverUnion);
  diagnostic.matches = observationMatches.slice(0, 3);
  const matches = baseline.candidates.flatMap((observed) => {
    if (
      observed.source !== 'deeplab' ||
      observed.requiresReview ||
      observed.reflectionOf ||
      observed.status === 'ignored'
    )
      return [];
    const match = matchObservation(candidate, observed);
    return match ? [{ observed, match }] : [];
  });
  if (matches.length !== 1) {
    if (matches.length > 1)
      return reject(
        'observation-match-ambiguous',
        '같은 설비에 대응하는 기존 관측이 여러 개라 접점을 선택하지 못했어요.',
        matches.map(({ observed }) => observed.id),
      );
    const strongest = observationMatches.find((entry) => entry.eligible);
    const message = strongest
      ? `같은 종류의 기존 관측과 겹침이 부족하거나 기둥 부품 근거가 없어 위치를 재사용하지 못했어요. 가장 가까운 관측의 겹침 비율(IoU)은 ${strongest.intersectionOverUnion.toFixed(3)}이며 전체 영역 기준은 0.5예요.`
      : sameKindObservations.length
        ? '같은 종류의 기존 관측은 있지만 반사·확인 필요 등의 상태라 독립 설치 근거로 재사용하지 못했어요.'
        : '같은 종류에 대응하는 기존 픽셀 관측이 없어 위치를 재사용하지 못했어요. 새 후보 자체는 보존해요.';
    return reject('observation-match-missing', message);
  }
  const { observed, match } = matches[0];
  diagnostic.baselineCandidateId = observed.id;
  // Count partial and full-box claims with the same rule, preventing two claims from borrowing one stem.
  const matchingClaims = eligibleCandidates.filter((other) => matchObservation(other, observed));
  if (matchingClaims.length !== 1)
    return reject(
      'observation-shared',
      '여러 후보가 같은 기존 관측의 접점을 공유해 독립 위치로 재사용하지 못했어요.',
      matchingClaims.map((other) => other.id),
    );
  // The position path checks this again when mapping; installation-only reuse must not bypass it.
  if (installationOnly && !hasSupportedReconstructionKind(observed))
    return reject(
      'baseline-mapping-unavailable',
      '기존 픽셀 관측의 분류 근거가 부족해 설치 방식을 독립 근거로 재사용하지 않았어요.',
    );
  if (installationOnly && observed.installation?.source === 'user')
    return reject(
      'installation-user-evidence',
      '사용자가 보정한 기존 설치를 독립된 자동 관측으로 재사용하지 않았어요.',
    );
  const installation = judgeCandidateInstallation(observed, baseline);
  if (installation.mode === 'suspended')
    return reject(
      'suspended-anchor-unobserved',
      '기존 설치 자료가 매달림 방식이라 바닥·벽 접점을 재사용하지 않았어요. 걸이 위치를 확인해 주세요.',
      [installation.reason],
    );
  if (installation.mode === 'unknown')
    return reject(
      'installation-unknown',
      '기존 픽셀 관측도 설치 방식을 확정하지 못해 위치를 재사용하지 않았어요.',
      [installation.reason],
    );
  if (installation.source === 'user')
    return reject(
      'installation-user-evidence',
      '사용자가 보정한 기존 설치를 독립된 자동 관측으로 재사용하지 않았어요.',
    );
  // The installation-only path has no later containing-plane check. Do not promote a stored
  // photo-side/appearance label to a physical wall, including floor items whose old wall is retained.
  if (
    installationOnly &&
    installation.wall &&
    !baseline.planes.some(
      (plane) =>
        plane.face === installation.wall &&
        plane.geometrySource === 'room-boundaries' &&
        validateQuad(plane.quad),
    )
  )
    installation.wall = undefined;
  if (
    (candidate.mounting !== 'unknown' && installation.mode !== candidate.mounting) ||
    (candidate.wall !== 'unknown' &&
      installation.wall !== undefined &&
      installation.wall !== candidate.wall) ||
    (candidate.kind === 'basin' &&
      (candidate.basinStyle === 'unknown'
        ? !installationOnly || !installation.basinVariant
        : installation.basinVariant !== candidate.basinStyle))
  )
    return reject(
      'installation-conflict',
      '후보와 기존 픽셀 관측의 지지 형태·설치 방식·벽이 일치하지 않아 위치를 재사용하지 않았어요.',
      [
        `후보: 설치 ${candidate.mounting}, 벽 ${candidate.wall}, 세면대 지지 ${candidate.basinStyle}`,
        `기존 관측: 설치 ${installation.mode}, 벽 ${installation.wall ?? 'unknown'}, 세면대 지지 ${installation.basinVariant ?? 'unknown'}`,
      ],
    );
  return {
    diagnostic,
    observation: { observed, match, installation: { ...installation, mode: installation.mode } },
  };
}

/** Inspect independent support evidence without borrowing a contact, room position or dimensions. */
export function inspectObservedInstallation(
  candidate: SceneCandidate,
  eligibleCandidates: readonly SceneCandidate[],
  baseline: ReconstructionReview,
): ObservedInstallationInspection {
  const inspection = inspectInstallationObservation(candidate, eligibleCandidates, baseline, true);
  if (!inspection.observation) return { diagnostic: inspection.diagnostic };
  const { observed, match, installation } = inspection.observation;
  return {
    installation: {
      mode: installation.mode,
      wall: installation.wall,
      basinVariant: installation.basinVariant,
      source: 'geometry',
    },
    baselineEvidence: {
      candidateId: observed.id,
      source: 'deeplab',
      intersectionOverUnion: match.overlap,
      matchMode: match.mode,
      candidateCoverage: 'coverage' in match ? match.coverage : undefined,
      positionBorrowed: false,
      wallGeometrySource: installation.wall ? 'room-boundaries' : undefined,
    },
    diagnostic: {
      ...inspection.diagnostic,
      status: 'reused',
      code: 'reused',
      message:
        '같은 설비의 독립 픽셀 관측에서 설치 방식만 보완했어요. 종류별 규칙과 관측 기하에 따른 추정이며 실측이 아니고 위치·접점·크기는 재사용하지 않았어요.',
      details: [
        installation.reason,
        ...(installation.wall
          ? ['설치 벽은 기존 방 경계에 대응하는 추정이며 모델의 관측이나 사용자 확인으로 표시하지 않아요.']
          : ['사진의 좌우 위치나 마감 영역만으로 실제 설치 벽을 단정하지 않았어요. 설치 벽은 미확정이에요.']),
      ],
    },
  };
}

/** Inspect the existing reuse path, preserving the first actual rejection without changing its rules. */
export function inspectObservedPlacement(
  candidate: SceneCandidate,
  eligibleCandidates: readonly SceneCandidate[],
  baseline: ReconstructionReview,
  room: RoomDefinition,
  image?: { width: number; height: number },
): ObservedPlacementInspection {
  const inspection = inspectInstallationObservation(candidate, eligibleCandidates, baseline);
  if (!inspection.observation) return { diagnostic: inspection.diagnostic };
  const {
    diagnostic,
    observation: { observed, match, installation },
  } = inspection;
  const reject = (code: ObservedPlacementDiagnosticCode, message: string, details?: string[]) => ({
    diagnostic: { ...diagnostic, code, message, ...(details ? { details } : {}) },
  });
  const placedCandidate: SceneCandidate = {
    ...candidate,
    mounting: candidate.mounting === 'unknown' ? installation.mode : candidate.mounting,
    wall: candidate.wall === 'unknown' && installation.wall ? installation.wall : candidate.wall,
  };
  if (
    placedCandidate.mounting === 'floor' &&
    (observed.bounds.bottom >= 0.995 || candidate.bounds.bottom >= 0.995)
  )
    return reject(
      'candidate-cropped',
      '후보 또는 기존 관측의 제품 하단이 사진 밖으로 잘려 바닥 접점을 재사용하지 못했어요.',
      [`후보 하단: ${candidate.bounds.bottom}, 기존 관측 하단: ${observed.bounds.bottom}, 잘림 기준: 0.995`],
    );
  const lowerContour = ['door', 'basin', 'wallShelf'].includes(candidate.kind);
  const pointRole =
    placedCandidate.mounting === 'floor'
      ? ('estimated-front-contact' as const)
      : lowerContour
        ? ('lower-contour' as const)
        : ('bounds-center' as const);
  if (placedCandidate.mounting === 'wall') {
    // A partial crop cannot define the unseen bottom, or the whole object's centre. Even an explicit
    // model wall attachment is not its lower edge, and this path borrows the baseline point instead.
    const usableBounds = (bounds: SceneCandidate['bounds']) =>
      bounds.bottom < 0.995 &&
      (lowerContour || (bounds.top > 0.005 && bounds.left > 0.005 && bounds.right < 0.995));
    if (!usableBounds(observed.bounds) || !usableBounds(candidate.bounds))
      return reject(
        'candidate-cropped',
        lowerContour
          ? '벽 설비 하단이 사진 밖으로 잘려 하단 높이 기준점을 재사용하지 못했어요.'
          : '벽 설비 영역이 사진 가장자리에서 잘려 전체 제품의 중심을 재사용하지 못했어요.',
        [
          `후보 범위: ${JSON.stringify(candidate.bounds)}`,
          `기존 관측 범위: ${JSON.stringify(observed.bounds)}`,
        ],
      );
  }
  const point =
    lowerContour || placedCandidate.mounting === 'floor'
      ? observed.foot
      : {
          x: (observed.bounds.left + observed.bounds.right) / 2,
          y: (observed.bounds.top + observed.bounds.bottom) / 2,
        };
  diagnostic.point = { ...point };
  diagnostic.pointRole = pointRole;
  if (image && [image.width, image.height].every((value) => Number.isFinite(value) && value > 0))
    diagnostic.image = { ...image };
  const planeChecks: PlaneReuseDiagnostic[] = [];
  diagnostic.planes = planeChecks;
  const planes = baseline.planes.filter((plane) => {
    const check: PlaneReuseDiagnostic = {
      planeId: plane.id,
      face: plane.face,
      geometrySource: plane.geometrySource,
      eligible: false,
    };
    planeChecks.push(check);
    if (plane.geometrySource !== 'room-boundaries') {
      check.exclusion = 'not-room-boundaries';
      return false;
    }
    if (!validateQuad(plane.quad)) {
      check.exclusion = 'invalid-quad';
      return false;
    }
    if (
      placedCandidate.mounting === 'floor'
        ? plane.face !== 'floor'
        : plane.face === 'floor' ||
          (placedCandidate.wall !== 'unknown' && plane.face !== placedCandidate.wall)
    ) {
      check.exclusion = 'different-face';
      return false;
    }
    check.eligible = true;
    // Diagnostic distances never alter the existing zero-tolerance containment decision.
    check.nearestBoundary = nearestPhotoBoundary(point, plane.quad, image);
    try {
      const uv = transformPoint(homography(plane.quad), point);
      check.pointUv = uv;
      check.inside = [uv.x, uv.y].every((value) => Number.isFinite(value) && value >= 0 && value <= 1);
      return check.inside;
    } catch {
      check.exclusion = 'projection-failed';
      return false;
    }
  });
  if (planes.length !== 1) {
    if (planes.length > 1)
      return reject(
        'observed-plane-ambiguous',
        '기준점을 포함하는 실제 관측 평면이 여러 개라 설치 면을 선택하지 못했어요.',
      );
    // A semantic floor polygon remains useful for appearance/support classification, but its
    // arbitrary visible-depth interval is not evidence for a physical placement.
    if (
      placedCandidate.mounting === 'floor' &&
      baseline.planes.some((p) => p.face === 'floor' && p.geometrySource === 'visible-floor-region')
    )
      return reject(
        'floor-extent-unconfirmed',
        '바닥은 찾았지만 사진에 보이는 영역과 실제 방 바닥의 대응 범위는 미확정이에요. 임시 깊이 비율로 제품 위치를 계산하지 않았어요. 설치 벽과 위치를 확인해 주세요.',
      );
    const eligiblePlanes = planeChecks.filter((check) => check.eligible);
    if (!eligiblePlanes.length)
      return reject(
        'observed-plane-missing',
        placedCandidate.mounting === 'wall'
          ? '설치에 사용할 실제 관측 벽이 없어요. 벽처럼 보이는 마감 영역만으로 설치 벽·높이를 계산하지 않았어요.'
          : '설치에 사용할 실제 관측 바닥이 없어 기존 기준점을 위치로 바꾸지 못했어요.',
      );
    if (eligiblePlanes.every((check) => check.exclusion === 'projection-failed'))
      return reject(
        'plane-projection-failed',
        '기존 기준점을 관측 평면으로 변환하지 못해 위치를 재사용하지 않았어요.',
      );
    const nearest = eligiblePlanes
      .filter((check) => check.inside === false && check.nearestBoundary)
      .sort((a, b) => a.nearestBoundary!.distancePx - b.nearestBoundary!.distancePx)[0];
    const edges = { top: '윗', right: '오른쪽', bottom: '아랫', left: '왼쪽' };
    const distance = nearest?.nearestBoundary;
    return reject(
      'point-outside-observed-plane',
      '기존 기준점이 실제 관측 평면 영역 밖이라 위치를 재사용하지 않았어요.' +
        (nearest && distance
          ? ` 사진에서 가장 가까운 ${nearest.face === 'floor' ? '바닥' : '벽'} ${edges[distance.edge]}경계 밖 약 ${distance.distancePx.toFixed(2)}px예요. 이는 사진 경계와의 거리이며 실측 거리가 아니에요.`
          : '') +
        ' 경계 안으로 강제 이동하지 않았어요.',
    );
  }
  const plane = planes[0];
  const wallFromSinglePlane = placedCandidate.mounting === 'wall' && placedCandidate.wall === 'unknown';
  if (wallFromSinglePlane && plane.face !== 'floor') placedCandidate.wall = plane.face;
  const derivedInstallation = {
    mode: installation.mode,
    wall: installation.mode === 'wall' && plane.face !== 'floor' ? plane.face : installation.wall,
    source: 'geometry' as const,
  };
  const horizontalStart =
    plane.face === 'floor' ? (plane.horizontalStart ?? 0) : plane.face === 'back' ? 0 : undefined;
  const horizontalEnd =
    plane.face === 'floor' ? (plane.horizontalEnd ?? 1) : plane.face === 'back' ? 1 : undefined;
  const validInterval = (start: number | undefined, end: number | undefined) =>
    start !== undefined &&
    end !== undefined &&
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    start >= 0 &&
    end <= 1 &&
    start < end;
  // Missing or corrupt intervals never make a partial wall into a complete one.
  if (
    !validInterval(plane.depthStart, plane.depthEnd) ||
    (plane.face === 'floor' && !validInterval(horizontalStart, horizontalEnd)) ||
    (plane.face !== 'floor' && !validInterval(plane.verticalStart, plane.verticalEnd))
  )
    return reject(
      'plane-extent-invalid',
      '관측 평면의 깊이·높이 구간이 없거나 유효하지 않아 위치를 재사용하지 않았어요.',
    );
  const mapped = mapReconstructionCandidate(observed, { ...baseline, planes: [plane] });
  if (!mapped)
    return reject(
      'baseline-mapping-unavailable',
      '기존 관측의 분류 근거 또는 평면 매핑 검증을 통과하지 못해 위치를 재사용하지 않았어요.',
    );
  const defaults = reconstructionDefaults(
    observed.kind,
    candidate.kind === 'basin' && candidate.basinStyle !== 'unknown' ? candidate.basinStyle : undefined,
  );
  const yawDegrees = candidateFloorYaw(placedCandidate, defaults.yawDegrees);
  const radians = (yawDegrees * Math.PI) / 180;
  const placed =
    mapped.face === 'floor'
      ? {
          ...mapped,
          u: mapped.u - (Math.sin(radians) * defaults.depthMm) / (2 * room.widthMm),
          v: mapped.v - (Math.cos(radians) * defaults.depthMm) / (2 * room.depthMm),
        }
      : mapped;
  const baseHeightMm =
    mapped.face === 'floor' ? 0 : (1 - mapped.v) * room.heightMm - (lowerContour ? 0 : defaults.heightMm / 2);
  if (!Number.isFinite(baseHeightMm) || baseHeightMm < 0 || baseHeightMm + defaults.heightMm > room.heightMm)
    return reject(
      'estimated-height-outside-room',
      '관측 평면과 기본 모형으로 계산한 설치 높이가 방 높이 범위를 벗어났어요.',
    );
  return {
    diagnostic: {
      ...diagnostic,
      status: 'reused',
      code: 'reused',
      message: '기존 관측 평면의 위치를 재사용했어요. 실제 모형의 공간 범위 검증은 별도예요.',
    },
    placement: {
      candidateId: candidate.id,
      status: 'estimated',
      placement: {
        ...placed,
        v: mapped.face === 'floor' ? placed.v : 1 - baseHeightMm / room.heightMm,
        baseHeightMm,
      },
      provenance: { position: 'geometry', dimensions: 'default' },
      derivedInstallation,
      baselineEvidence: {
        candidateId: observed.id,
        planeId: plane.id,
        intersectionOverUnion: match.overlap,
        matchMode: match.mode,
        candidateCoverage: 'coverage' in match ? match.coverage : undefined,
        point: { ...point },
        pointRole,
        assumedYawDegrees: mapped.face === 'floor' ? yawDegrees : undefined,
        planeExtent: {
          face: plane.face,
          depthStart: plane.depthStart,
          depthEnd: plane.depthEnd,
          horizontalStart,
          horizontalEnd,
          horizontalDefaulted:
            plane.face === 'floor'
              ? plane.horizontalStart === undefined || plane.horizontalEnd === undefined
              : plane.face === 'back'
                ? true
                : undefined,
          verticalStart: plane.face === 'floor' ? undefined : plane.verticalStart,
          verticalEnd: plane.face === 'floor' ? undefined : plane.verticalEnd,
          confirmed: plane.confirmed,
        },
      },
      reasons: [
        '원본 촬영 시점은 미확정이에요. 같은 설비의 기존 픽셀 관측과 방 경계에서 얻은 배치를 재사용했어요.',
        '관측 평면의 공간 범위와 제품 크기를 가정한 추정 위치예요. 실제 설치 벽·높이·위치는 확인해 주세요.',
        ...(candidate.mounting === 'unknown' || (candidate.wall === 'unknown' && derivedInstallation.wall)
          ? [
              '모델이 미정으로 남긴 설치 방식·벽은 같은 설비의 기존 설치 근거와 관측 평면에서 보완했어요. 모델 원문과 구분한 기하 추정이에요.',
            ]
          : []),
        ...(wallFromSinglePlane
          ? [
              '모델과 기존 설치 판단 모두 설치 벽을 명시하지 않았어요. 기준점이 실제 관측 벽 한 곳 안에만 있어 그 벽으로 추정했으며 사용자 확인이나 모델의 벽 관측으로 표시하지 않아요.',
            ]
          : []),
        ...(match.mode === 'pedestal-bowl-part'
          ? [
              '모델은 세면볼 부분만 관측했어요. 같은 영역을 포함하는 기존 세면대의 연속 기둥 관측과 바닥 접점을 재사용했으며 사진 범위를 늘려 쓰지 않았어요.',
            ]
          : []),
        ...(mapped.face === 'floor'
          ? [
              '픽셀 영역 하단을 제품 앞쪽 접점으로 가정하고 기본 깊이의 절반만큼 중심을 옮겼어요. 실제 접지 윤곽과 방향은 확인이 필요해요.',
              ...(!['toilet', 'basin', 'vanity'].includes(candidate.kind) ||
              placedCandidate.wall === 'unknown'
                ? [`사진에서 방향을 확정하지 못해 기본 회전 ${yawDegrees}°를 사용했어요.`]
                : []),
            ]
          : pointRole === 'bounds-center'
            ? ['사진 영역 중심을 제품 중심으로 가정하고 기본 높이의 절반을 내려 하단 높이를 추정했어요.']
            : []),
      ],
    },
  };
}
