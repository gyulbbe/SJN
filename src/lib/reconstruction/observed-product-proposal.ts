import {
  proposeObservedProductPose,
  type ObservedProductPoseInput,
  type ObservedProductPoseResult,
  type ProductPosePoint,
} from './observed-product-pose';
import { validateSourceFixture } from './source-camera';
import { validateRoomDimensions } from '../room-geometry';
import type { RoomDefinition } from '../room-types';

export type ObservedProductProposalContext = {
  room: RoomDefinition;
  expectedFingerprint: string;
  /** Existing installation assumption, kept explicit; not derived from the visible body minimum. */
  baseHeightMm: number;
  sources: { inputFingerprint: string; pointsSha256: string; labelsSha256: string; cameraSha256: string };
};
export type ObservedProductProposal = {
  version: 1;
  status: 'review-required' | 'held';
  candidateId: string;
  /** Deterministic source/configuration identity; not a user acceptance record. */
  proposalId: string;
  scope: 'visible-surface-proxy-not-complete-product';
  fixedCheck: ObservedProductPoseResult;
  reasons: { code: string; message: string }[];
  dimensionEvidence: {
    axisWorld: ProductPosePoint;
    supportingFace: number;
    faceSampleCount: number;
    observedTangentSpanMm: number;
    /** Model-scale support sensitivity, not a confidence interval for a true physical dimension. */
    sampleExtentSensitivityMm: [number, number];
    proxySpanMm: number;
    completeDimension: {
      minimumSupportedSpanMm: number;
      upperMm: null;
      endpoints: 'unverified-may-be-occluded-or-clipped';
    };
  }[];
  alternatives: {
    id: string;
    kind: 'visible-surface-proxy';
    centerXZMm: [number, number];
    yawDegrees: number;
    widthMm: number;
    depthMm: number;
    heightMm: number;
    baseHeightMm: number;
    placement: {
      face: 'floor';
      u: number;
      v: number;
      baseHeightMm: number;
      yawDegrees: number;
      widthMm: number;
      depthMm: number;
      heightMm: number;
    };
    sources: {
      width: 'observed-surface-proxy';
      depth: 'observed-surface-proxy';
      height: 'unchanged-default';
      position: 'observed-face-offsets-and-proxy-extents';
      baseHeight: 'caller-installation-assumption';
      front: 'user-choice-required';
    };
    fit: {
      containedBodyFraction: number;
      verticalSurfaceResidualP95Mm: number;
      toleranceMm: number;
      /** Diagnostic ablation only: identical proxy at the original fixed-dimension tolerance. */
      originalFixedTolerance: {
        toleranceMm: number;
        containedBodyFraction: number;
        heightInlierFraction: number;
        surfaceFitPass: boolean;
        heightFitPass: boolean;
      };
      observedWalls: { wallId: string; minimumSignedCornerDistanceMm: number }[];
    };
  }[];
  rejectedAlternatives: { yawDegrees: number; codes: string[]; details: string[] }[];
  requiredConfirmations: (
    | 'same-product-region'
    | 'unseen-extents-use-visible-proxy'
    | 'model-scale-is-unmeasured'
    | 'front-and-width-axis'
    | 'default-height-and-installation'
  )[];
  provenance: {
    inputFingerprint: string;
    sources: ObservedProductProposalContext['sources'];
    originalDimensions?: ObservedProductPoseInput['knownDimensions'];
    evidence: ObservedProductPoseInput['evidence'];
    measured: false;
    automaticallyApplied: false;
    lockedDimensionsChanged: false;
    scalarPolicy: 'separate-face-support-percentiles-no-rescaling-no-clamping';
    bodyLabel: 11;
    excludedBoxFitLabel: 48;
  };
};

type Sample = { p: ProductPosePoint; n: ProductPosePoint };
const dot = (a: ProductPosePoint, b: ProductPosePoint) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const finite = (p: number[]) => p.length === 3 && p.every(Number.isFinite);
const horizontal = (n: ProductPosePoint): ProductPosePoint => {
  const size = Math.hypot(n[0], n[2]);
  return [n[0] / size, 0, n[2] / size];
};
const quantile = (a: number[], q: number) => {
  const s = [...a].sort((a, b) => a - b);
  const at = (s.length - 1) * q;
  const low = Math.floor(at);
  return s[low] + (s[Math.ceil(at)] - s[low]) * (at - low);
};
const yawOf = (front: ProductPosePoint) =>
  ((((Math.atan2(front[0], front[2]) * 180) / Math.PI) % 360) + 360) % 360;
const validHash = (value: string) => /^[a-f0-9]{64}$/.test(value);

/**
 * Separate experiment: a visible-surface proxy may replace only an unlocked default.
 * It neither relaxes the fixed-dimension diagnostic nor claims hidden physical boundaries.
 * Four width/depth/front interpretations of one observed horizontal envelope remain distinct.
 */
export function proposeObservedProductProposal(
  input: ObservedProductPoseInput,
  context: ObservedProductProposalContext,
): ObservedProductProposal {
  const fixedCheck = proposeObservedProductPose(input, context.expectedFingerprint);
  // Full canonical source/configuration tuple avoids truncated-hash collisions. Caller verifies raw bytes.
  const proposalId =
    'observed-product-proxy-v1:' +
    JSON.stringify([
      input.candidateId,
      input.inputFingerprint,
      context.sources.inputFingerprint,
      context.sources.pointsSha256,
      context.sources.labelsSha256,
      context.sources.cameraSha256,
      context.room.widthMm,
      context.room.depthMm,
      context.room.heightMm,
      context.baseHeightMm,
      input.knownDimensions?.provenance,
      input.knownDimensions?.widthMm,
      input.knownDimensions?.depthMm,
      input.knownDimensions?.heightMm,
      input.evidence.association,
      input.evidence.reflections,
      input.evidence.contamination,
    ]);
  const result: ObservedProductProposal = {
    version: 1,
    status: 'held',
    candidateId: input.candidateId,
    proposalId,
    scope: 'visible-surface-proxy-not-complete-product',
    fixedCheck,
    reasons: [],
    dimensionEvidence: [],
    alternatives: [],
    rejectedAlternatives: [],
    requiredConfirmations: [
      'same-product-region',
      'unseen-extents-use-visible-proxy',
      'model-scale-is-unmeasured',
      'front-and-width-axis',
      'default-height-and-installation',
    ],
    provenance: {
      inputFingerprint: input.inputFingerprint,
      sources: { ...context.sources },
      originalDimensions: input.knownDimensions ? { ...input.knownDimensions } : undefined,
      evidence: { ...input.evidence },
      measured: false,
      automaticallyApplied: false,
      lockedDimensionsChanged: false,
      scalarPolicy: 'separate-face-support-percentiles-no-rescaling-no-clamping',
      bodyLabel: 11,
      excludedBoxFitLabel: 48,
    },
  };
  const held = (code: string, message: string) => {
    result.reasons.push({ code, message });
    return result;
  };
  if (
    !validateRoomDimensions(context.room) ||
    !Number.isFinite(context.baseHeightMm) ||
    context.baseHeightMm < 0 ||
    context.baseHeightMm >= context.room.heightMm ||
    context.sources.inputFingerprint !== context.expectedFingerprint ||
    !Object.values(context.sources).every(validHash)
  )
    return held(
      'invalid-source-context',
      '사진·포인트·라벨·카메라의 해시 또는 기존 설치 기준이 맞지 않아요.',
    );
  if (
    fixedCheck.reasons.some((r) =>
      ['invalid-input', 'fingerprint-mismatch', 'unsupported-kind'].includes(r.code),
    )
  )
    return held('invalid-observation', '유효한 같은 사진의 하부장 관측이 아니에요.');
  if (
    input.walls.some(
      (wall) =>
        !wall.id.trim() ||
        !finite(wall.normalWorld) ||
        !finite(wall.medianPointWorldMm) ||
        Math.abs(Math.hypot(...wall.normalWorld) - 1) >= 0.01 ||
        Math.abs(wall.normalWorld[1]) >= Math.sin((12 * Math.PI) / 180) ||
        !Number.isFinite(wall.offsetMm) ||
        !Number.isInteger(wall.inlierCount) ||
        wall.inlierCount < 96 ||
        !Number.isFinite(wall.rmsResidualMm) ||
        wall.rmsResidualMm < 0 ||
        wall.rmsResidualMm > 50 ||
        Math.abs(dot(wall.normalWorld, wall.medianPointWorldMm) + wall.offsetMm) >
          Math.max(12, 3 * wall.rmsResidualMm),
    )
  )
    return held('invalid-observed-wall', '제품 proxy의 침범 검사에 사용한 관측 벽 근거가 유효하지 않아요.');
  const dimensions = input.knownDimensions;
  if (dimensions && dimensions.provenance !== 'default')
    return held(
      'locked-dimensions',
      '사용자·카탈로그 규격을 관측 proxy로 바꾸지 않아요. 원래 고정 규격 검사를 확인해 주세요.',
    );
  if (!dimensions || dimensions.heightMm === undefined)
    return held(
      'default-height-unavailable',
      '전체 높이를 관측 범위로 만들지 않아요. 유지할 기존 기본 높이가 필요해요.',
    );
  if (!fixedCheck.axes || fixedCheck.axes.faces.length < 2)
    return held(
      'insufficient-independent-faces',
      '독립된 두 수직 제품 면이 없어 규격·위치 proxy를 만들 수 없어요.',
    );
  if (input.evidence.reflections !== 'known-regions-excluded' || input.evidence.contamination === 'detected')
    return held(
      'unsafe-surface-association',
      '확인된 반사·다른 물체의 혼입을 사용자 선택만으로 제품 표면으로 바꾸지 않아요.',
    );
  if (
    fixedCheck.reasons.some((r) =>
      ['non-planar-or-mixed-surfaces', 'observed-wall-missing', 'wall-axis-inconsistent'].includes(r.code),
    )
  )
    return held('inconsistent-plane-evidence', '상자형 제품 면과 관측 벽의 지지가 일치하지 않아요.');
  const { horizontalWorld: axes, faces } = fixedCheck.axes;
  const originalTolerance = Math.max(
    12,
    Math.min(50, Math.hypot(dimensions.widthMm, dimensions.depthMm) * 0.025),
  );
  const body: Sample[] = input.samples
    .filter(
      (s) =>
        s.semanticLabel === 11 &&
        finite(s.pointWorldMm) &&
        finite(s.normalWorld) &&
        Math.abs(Math.hypot(...s.normalWorld) - 1) <= 0.05,
    )
    .map((s) => ({ p: s.pointWorldMm, n: s.normalWorld }));
  const vertical = body
    .filter((s) => Math.abs(s.n[1]) <= Math.sin((20 * Math.PI) / 180))
    .map((s) => ({ p: s.p, n: horizontal(s.n) }));
  const faceSamples = faces.map((face) =>
    vertical.filter(
      (s) =>
        dot(s.n, face.normalWorld) >= Math.cos((12 * Math.PI) / 180) &&
        Math.abs(dot(face.normalWorld, s.p) + face.planeOffsetMm) <= originalTolerance,
    ),
  );
  if (faceSamples.some((s) => s.length < 48))
    return held('insufficient-face-inliers', '서로 다른 두 면에 남은 안정적인 표면 지지가 부족해요.');
  const offsets = axes.map((axis, i) =>
    quantile(
      faceSamples[i].map((s) => dot(axis, s.p)),
      0.5,
    ),
  );
  const minimums: number[] = [];
  const spans: number[] = [];
  for (let axisIndex = 0; axisIndex < 2; axisIndex++) {
    // Tangential extent comes from the OTHER face, independently of how much projected pixel area the end face occupies.
    const samples = faceSamples[1 - axisIndex];
    const values = samples.map((s) => dot(axes[axisIndex], s.p));
    const low = quantile(values, 0.005);
    const proxySpan = offsets[axisIndex] - low;
    const observedSpan = quantile(values, 0.98) - quantile(values, 0.02);
    if (!Number.isFinite(proxySpan) || proxySpan <= originalTolerance * 3)
      return held(
        'partial-product-fragment',
        '작은 면 조각만으로 보이지 않는 전체 제품 규격을 정하지 않아요.',
      );
    minimums.push(low);
    spans.push(proxySpan);
    result.dimensionEvidence.push({
      axisWorld: [...axes[axisIndex]],
      supportingFace: 1 - axisIndex,
      faceSampleCount: samples.length,
      observedTangentSpanMm: observedSpan,
      sampleExtentSensitivityMm: [observedSpan, quantile(values, 1) - quantile(values, 0)],
      proxySpanMm: proxySpan,
      completeDimension: {
        minimumSupportedSpanMm: observedSpan,
        upperMm: null,
        endpoints: 'unverified-may-be-occluded-or-clipped',
      },
    });
  }
  const centerComponents = offsets.map((max, axis) => (max + minimums[axis]) / 2);
  const center: ProductPosePoint = [
    axes[0][0] * centerComponents[0] + axes[1][0] * centerComponents[1],
    0,
    axes[0][2] * centerComponents[0] + axes[1][2] * centerComponents[1],
  ];
  const fronts: ProductPosePoint[] = [
    axes[0],
    axes[1],
    axes[0].map((n) => -n) as ProductPosePoint,
    axes[1].map((n) => -n) as ProductPosePoint,
  ];
  for (let i = 0; i < fronts.length; i++) {
    const front = fronts[i];
    const width: ProductPosePoint = [front[2], 0, -front[0]];
    const widthMm = i % 2 === 0 ? spans[1] : spans[0];
    const depthMm = i % 2 === 0 ? spans[0] : spans[1];
    const heightMm = dimensions.heightMm;
    const yawDegrees = yawOf(front);
    const tolerance = Math.max(12, Math.min(50, Math.hypot(widthMm, depthMm) * 0.025));
    const local = (s: Sample) => {
      const d: ProductPosePoint = [s.p[0] - center[0], 0, s.p[2] - center[2]];
      return [dot(d, width), dot(d, front)];
    };
    const containedBodyFraction =
      body.filter((s) => {
        const [x, z] = local(s);
        return Math.abs(x) <= widthMm / 2 + tolerance && Math.abs(z) <= depthMm / 2 + tolerance;
      }).length / body.length;
    const originalContainedFraction =
      body.filter((s) => {
        const [x, z] = local(s);
        return (
          Math.abs(x) <= widthMm / 2 + originalTolerance && Math.abs(z) <= depthMm / 2 + originalTolerance
        );
      }).length / body.length;
    const originalHeightFraction =
      body.filter(
        (s) =>
          s.p[1] >= context.baseHeightMm - originalTolerance &&
          s.p[1] <= context.baseHeightMm + heightMm + originalTolerance,
      ).length / body.length;
    const verticalSurfaceResidualP95Mm = quantile(
      vertical.map((s) => {
        const [x, z] = local(s);
        return Math.min(Math.abs(Math.abs(x) - widthMm / 2), Math.abs(Math.abs(z) - depthMm / 2));
      }),
      0.95,
    );
    const placement = {
      face: 'floor' as const,
      u: (center[0] + context.room.widthMm / 2) / context.room.widthMm,
      v: center[2] / context.room.depthMm,
      baseHeightMm: context.baseHeightMm,
      yawDegrees,
      widthMm,
      depthMm,
      heightMm,
    };
    const roomCheck = validateSourceFixture(context.room, undefined, {
      kind: 'vanity',
      version: 2,
      ...placement,
    });
    const corners: ProductPosePoint[] = [];
    for (const a of [-1, 1])
      for (const b of [-1, 1])
        for (const y of [context.baseHeightMm, context.baseHeightMm + heightMm])
          corners.push([
            center[0] + (a * width[0] * widthMm) / 2 + (b * front[0] * depthMm) / 2,
            y,
            center[2] + (a * width[2] * widthMm) / 2 + (b * front[2] * depthMm) / 2,
          ]);
    const observedWalls = input.walls.map((wall) => ({
      wallId: wall.id,
      minimumSignedCornerDistanceMm: Math.min(
        ...corners.map((p) => dot(wall.normalWorld, p) + wall.offsetMm),
      ),
    }));
    const codes: string[] = [],
      details: string[] = [];
    if (containedBodyFraction < 0.97 || verticalSurfaceResidualP95Mm > tolerance) {
      codes.push('surface-fit-inconsistent');
      details.push(
        `contained=${containedBodyFraction.toFixed(4)}, residual95=${verticalSurfaceResidualP95Mm.toFixed(2)}mm, tolerance=${tolerance.toFixed(2)}mm`,
      );
    }
    const heightInliers =
      body.filter(
        (s) =>
          s.p[1] >= context.baseHeightMm - tolerance && s.p[1] <= context.baseHeightMm + heightMm + tolerance,
      ).length / body.length;
    if (heightInliers < 0.97) {
      codes.push('default-height-or-support-inconsistent');
      details.push('관측 높이가 유지한 기본 높이·설치 기준과 맞지 않아요. 높이를 확장하지 않았어요.');
    }
    if (!roomCheck.valid) {
      codes.push('room-bounds-inconsistent');
      details.push(...roomCheck.reasons);
    }
    if (observedWalls.some((wall) => wall.minimumSignedCornerDistanceMm < -tolerance)) {
      codes.push('observed-wall-intersection');
      details.push('proxy가 관측 벽을 침범해요. 방 안으로 clamp하지 않아요.');
    }
    if (codes.length) {
      result.rejectedAlternatives.push({ yawDegrees, codes, details });
      continue;
    }
    result.alternatives.push({
      id: proposalId + ':alternative:' + i,
      kind: 'visible-surface-proxy',
      centerXZMm: [center[0], center[2]],
      yawDegrees,
      widthMm,
      depthMm,
      heightMm,
      baseHeightMm: context.baseHeightMm,
      placement,
      sources: {
        width: 'observed-surface-proxy',
        depth: 'observed-surface-proxy',
        height: 'unchanged-default',
        position: 'observed-face-offsets-and-proxy-extents',
        baseHeight: 'caller-installation-assumption',
        front: 'user-choice-required',
      },
      fit: {
        containedBodyFraction,
        verticalSurfaceResidualP95Mm,
        toleranceMm: tolerance,
        observedWalls,
        originalFixedTolerance: {
          toleranceMm: originalTolerance,
          containedBodyFraction: originalContainedFraction,
          heightInlierFraction: originalHeightFraction,
          surfaceFitPass:
            originalContainedFraction >= 0.97 && verticalSurfaceResidualP95Mm <= originalTolerance,
          heightFitPass: originalHeightFraction >= 0.97,
        },
      },
    });
  }
  if (!result.alternatives.length)
    return held(
      'no-physically-compatible-proxy',
      '현재 관측 범위와 기본 높이로 방·벽·표면 검사에 맞는 proxy가 없어요. 규격이나 위치를 억지로 맞추지 않았어요.',
    );
  result.status = 'review-required';
  result.reasons.push({
    code: 'incomplete-product-extent',
    message:
      '보이는 면의 범위로 만든 임시 모형이에요. 가려지거나 잘린 전체 외곽과 실측 크기는 확인하지 않았어요.',
  });
  if (input.evidence.contamination === 'unassessed')
    result.reasons.push({
      code: 'same-product-confirmation-required',
      message:
        '이 표면들이 같은 하부장인지 사용자 확인이 필요해요. 실제 혼입이 있으면 이 제안을 적용하지 마세요.',
    });
  result.reasons.push({
    code: 'axis-and-front-choice-required',
    message: '폭·깊이 축과 앞뒤는 정하지 않았어요. 표시된 모형의 방향을 선택해야 해요.',
  });
  return result;
}
