/** Opt-in offline experiment. This module never changes a candidate, its dimensions, or its placement. */
export type ProductPosePoint = [number, number, number];
export type ObservedProductPoseInput = {
  version: 1;
  inputFingerprint: string;
  coordinateSystem: 'model-world-mm';
  candidateId: string;
  kind: 'vanity';
  samples: {
    pointWorldMm: ProductPosePoint;
    normalWorld: ProductPosePoint;
    /** Only cabinet body=11 can establish this box's vertical faces. Sink=48 stays separate. */
    semanticLabel: number;
  }[];
  walls: {
    id: string;
    /** Inward unit normal; n.point + offsetMm = 0. Same model-world frame as samples. */
    normalWorld: ProductPosePoint;
    offsetMm: number;
    medianPointWorldMm: ProductPosePoint;
    inlierCount: number;
    rmsResidualMm: number;
  }[];
  knownDimensions?: {
    widthMm: number;
    depthMm: number;
    heightMm?: number;
    provenance: 'user' | 'catalog' | 'default';
  };
  evidence: {
    association: 'same-kind-mask-in-candidate';
    reflections: 'known-regions-excluded' | 'unresolved';
    contamination: 'none-detected' | 'detected' | 'unassessed';
  };
  /** Never derive this semantic front from camera visibility or the largest observed face. */
  frontDirectionWorld?: {
    direction: ProductPosePoint;
    provenance: 'user' | 'independent-observation';
  };
  /** A separately established rear-facing-wall relation, not merely the nearest observed wall. */
  backWallRelation?: { wallId: string; provenance: 'user' | 'independent-observation' };
};
export type ProductPoseReasonCode =
  | 'invalid-input'
  | 'fingerprint-mismatch'
  | 'unsupported-kind'
  | 'reflection-unresolved'
  | 'contamination-unresolved'
  | 'insufficient-body-surfaces'
  | 'insufficient-vertical-surfaces'
  | 'single-plane-only'
  | 'non-orthogonal-surfaces'
  | 'non-planar-or-mixed-surfaces'
  | 'observed-wall-missing'
  | 'wall-axis-inconsistent'
  | 'unknown-dimensions'
  | 'fixed-dimensions-inconsistent'
  | 'wall-intersection'
  | 'front-evidence-inconsistent'
  | 'front-back-ambiguous'
  | 'axis-assignment-ambiguous';
export type ObservedProductPoseResult = {
  status: 'proposed' | 'held';
  candidateId: string;
  reasons: { code: ProductPoseReasonCode; message: string }[];
  scope: 'experimental-model-horizontal-pose';
  automaticPlacement: false;
  scale: 'model-estimated-not-measured';
  observedBounds?: {
    minWorldMm: ProductPosePoint;
    maxWorldMm: ProductPosePoint;
    robustMinWorldMm: ProductPosePoint;
    robustMaxWorldMm: ProductPosePoint;
    /** Visible samples only; no hidden outer boundary or object center is asserted. */
    meaning: 'visible-body-surfaces-only';
  };
  axes?: {
    horizontalWorld: [ProductPosePoint, ProductPosePoint];
    orthogonalityErrorDegrees: number;
    faces: {
      normalWorld: ProductPosePoint;
      planeOffsetMm: number;
      supportCount: number;
      residualP95Mm: number;
      observedTangentSpanMm: number;
    }[];
  };
  alternatives: {
    /** Horizontal box center implied by fixed dimensions and two observed outward faces. Y remains unresolved. */
    centerXZMm: [number, number];
    /** Local width=(cos(yaw),0,-sin(yaw)), semantic front=(sin(yaw),0,cos(yaw)). */
    yawDegrees: number;
    dimensions: NonNullable<ObservedProductPoseInput['knownDimensions']>;
    fit: {
      toleranceMm: number;
      containedBodyFraction: number;
      verticalSurfaceResidualP95Mm: number;
      directionEvidence: 'unresolved' | 'explicit-front' | 'explicit-back-wall';
      walls: { wallId: string; minimumSignedCornerDistanceMm: number; aligned: boolean }[];
    };
    assumptions: string[];
  }[];
  diagnostics: {
    suppliedSamples: number;
    bodySamples: number;
    sinkSamplesExcludedFromBoxFit: number;
    otherSemanticSamplesExcluded: number;
    invalidSamples: number;
    verticalSamples: number;
    rejectedFits: { yawDegrees: number; code: ProductPoseReasonCode; detail: string }[];
  };
};

type Sample = { p: ProductPosePoint; n: ProductPosePoint };
type Face = { n: ProductPosePoint; offset: number; samples: Sample[]; residual: number; span: number };
const DEG = 180 / Math.PI;
const ANGLE = 12;
const cosine = Math.cos(ANGLE / DEG);
const verticalLimit = Math.sin(20 / DEG);
const finitePoint = (p: readonly number[]) => p.length === 3 && p.every(Number.isFinite);
const dot = (a: ProductPosePoint, b: ProductPosePoint) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (p: ProductPosePoint) => Math.hypot(...p);
const horizontal = (p: ProductPosePoint): ProductPosePoint => {
  const len = Math.hypot(p[0], p[2]);
  return [p[0] / len, 0, p[2] / len];
};
const quantile = (values: number[], q: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (sorted.length - 1) * q;
  const lo = Math.floor(at);
  return sorted[lo] + (sorted[Math.ceil(at)] - sorted[lo]) * (at - lo);
};
const yawOf = (front: ProductPosePoint) => Math.atan2(front[0], front[2]) * DEG;
const wrapped = (angle: number) => ((angle % 360) + 360) % 360;
const assumed = [
  '모델이 추정한 수평 자세이며 실측하거나 확정한 제품 위치가 아니에요.',
  '알려진 규격을 바꾸지 않고 관측된 두 수직 외측 면에 맞춘 가설이에요. bbox 하단점은 사용하지 않아요.',
  '보이지 않는 제품 외곽과 수직 중심은 관측하지 않았어요. 규격의 유래와 설치 높이는 별도로 확인해야 해요.',
];

function normalFaces(samples: Sample[], tolerance: number): Face[] {
  let remaining = [...samples];
  const faces: Face[] = [];
  const minimum = Math.max(48, Math.ceil(samples.length * 0.05));
  for (let iteration = 0; iteration < 6 && remaining.length >= minimum; iteration++) {
    const bins = Array.from({ length: 72 }, () => 0);
    for (const sample of remaining) bins[Math.floor(wrapped(yawOf(sample.n)) / 5)]++;
    const index = bins.indexOf(Math.max(...bins));
    const angle = ((index + 0.5) * 5) / DEG;
    let normal: ProductPosePoint = [Math.sin(angle), 0, Math.cos(angle)];
    let selected = remaining.filter((sample) => dot(sample.n, normal) >= cosine);
    if (selected.length < minimum) break;
    const average: ProductPosePoint = [0, 0, 0];
    for (const sample of selected) {
      average[0] += sample.n[0];
      average[2] += sample.n[2];
    }
    normal = horizontal(average);
    selected = remaining.filter((sample) => dot(sample.n, normal) >= cosine);
    const chosen = new Set(selected);
    remaining = remaining.filter((sample) => !chosen.has(sample));
    const offsets = selected.map((sample) => dot(normal, sample.p));
    const offset = quantile(offsets, 0.5);
    const residual = quantile(
      offsets.map((value) => Math.abs(value - offset)),
      0.95,
    );
    const tangent: ProductPosePoint = [-normal[2], 0, normal[0]];
    const along = selected.map((sample) => dot(tangent, sample.p));
    const span = quantile(along, 0.98) - quantile(along, 0.02);
    // A normal-direction cluster is not automatically a plane: reject separated offsets and small fragments.
    if (selected.length >= minimum && residual <= tolerance && span >= tolerance * 3)
      faces.push({ n: normal, offset, samples: selected, residual, span });
  }
  return faces.sort((a, b) => b.samples.length - a.samples.length);
}

/** Pure, opt-in diagnostic. Known dimensions are never resized; wall proximity never establishes a rear-wall relation. */
export function proposeObservedProductPose(
  input: ObservedProductPoseInput,
  expectedFingerprint: string,
): ObservedProductPoseResult {
  const result: ObservedProductPoseResult = {
    status: 'held',
    candidateId: input.candidateId,
    reasons: [],
    scope: 'experimental-model-horizontal-pose',
    automaticPlacement: false,
    scale: 'model-estimated-not-measured',
    alternatives: [],
    diagnostics: {
      suppliedSamples: input.samples.length,
      bodySamples: 0,
      sinkSamplesExcludedFromBoxFit: 0,
      otherSemanticSamplesExcluded: 0,
      invalidSamples: 0,
      verticalSamples: 0,
      rejectedFits: [],
    },
  };
  const hold = (code: ProductPoseReasonCode, message: string) => {
    if (!result.reasons.some((reason) => reason.code === code)) result.reasons.push({ code, message });
    return result;
  };
  if (input.inputFingerprint !== expectedFingerprint || !/^[a-f0-9]{64}$/.test(expectedFingerprint))
    return hold('fingerprint-mismatch', '제품 표면과 현재 사진의 해시가 맞지 않아요.');
  if (input.kind !== 'vanity')
    return hold('unsupported-kind', '이 실험은 cabinet 표면을 가진 상자형 하부장만 지원해요.');
  const dims = input.knownDimensions;
  const explicitFront = input.frontDirectionWorld;
  if (
    input.version !== 1 ||
    input.coordinateSystem !== 'model-world-mm' ||
    !input.candidateId.trim() ||
    input.samples.length > 100000 ||
    input.walls.length > 16 ||
    input.evidence.association !== 'same-kind-mask-in-candidate' ||
    (dims &&
      (![dims.widthMm, dims.depthMm, ...(dims.heightMm === undefined ? [] : [dims.heightMm])].every(
        (v) => Number.isFinite(v) && v > 0,
      ) ||
        !['user', 'catalog', 'default'].includes(dims.provenance))) ||
    (explicitFront &&
      (!finitePoint(explicitFront.direction) ||
        norm(explicitFront.direction) < 0.5 ||
        Math.abs(explicitFront.direction[1]) / norm(explicitFront.direction) > verticalLimit ||
        !['user', 'independent-observation'].includes(explicitFront.provenance))) ||
    (input.backWallRelation &&
      !['user', 'independent-observation'].includes(input.backWallRelation.provenance))
  )
    return hold('invalid-input', '제품 표면의 버전·좌표계·규격 또는 별도 방향 근거가 올바르지 않아요.');
  if (input.evidence.reflections !== 'known-regions-excluded')
    hold('reflection-unresolved', '거울·유리·반사 영역의 혼입을 분리하지 못했어요.');
  if (input.evidence.contamination !== 'none-detected')
    hold('contamination-unresolved', '같은 제품인지 확인되지 않았거나 다른 물체의 분류가 섞여 있어요.');
  const body: Sample[] = [];
  for (const sample of input.samples) {
    if (
      !finitePoint(sample.pointWorldMm) ||
      !finitePoint(sample.normalWorld) ||
      Math.abs(norm(sample.normalWorld) - 1) > 0.05
    ) {
      result.diagnostics.invalidSamples++;
      continue;
    }
    if (sample.semanticLabel === 48) result.diagnostics.sinkSamplesExcludedFromBoxFit++;
    else if (sample.semanticLabel !== 11) result.diagnostics.otherSemanticSamplesExcluded++;
    else body.push({ p: [...sample.pointWorldMm], n: [...sample.normalWorld] });
  }
  result.diagnostics.bodySamples = body.length;
  if (result.diagnostics.invalidSamples > Math.max(4, input.samples.length * 0.02))
    hold('invalid-input', '유효하지 않은 좌표나 법선이 많아 제품 표면의 기하를 신뢰하기 어려워요.');
  if (body.length < 96)
    return hold(
      'insufficient-body-surfaces',
      '하부장 몸체의 같은 종류 표면 지지가 부족해요. 세면볼을 몸체 상자로 대신 사용하지 않아요.',
    );
  const axisValues = [0, 1, 2].map((axis) => body.map((sample) => sample.p[axis]));
  const bounds = (q: number) => axisValues.map((values) => quantile(values, q)) as ProductPosePoint;
  result.observedBounds = {
    minWorldMm: bounds(0),
    maxWorldMm: bounds(1),
    robustMinWorldMm: bounds(0.02),
    robustMaxWorldMm: bounds(0.98),
    meaning: 'visible-body-surfaces-only',
  };
  const diagonal = dims
    ? Math.hypot(dims.widthMm, dims.depthMm)
    : Math.hypot(
        result.observedBounds.robustMaxWorldMm[0] - result.observedBounds.robustMinWorldMm[0],
        result.observedBounds.robustMaxWorldMm[2] - result.observedBounds.robustMinWorldMm[2],
      );
  // One common scale-relative noise policy; no image-, candidate-, or kind-specific calibration.
  const tolerance = Math.max(12, Math.min(50, diagonal * 0.025));
  const vertical = body
    .filter((sample) => Math.abs(sample.n[1]) <= verticalLimit)
    .map((sample) => ({ p: sample.p, n: horizontal(sample.n) }));
  result.diagnostics.verticalSamples = vertical.length;
  if (vertical.length < 96)
    return hold('insufficient-vertical-surfaces', '수평 자세를 정할 수 있는 수직 몸체 표면이 부족해요.');
  const faces = normalFaces(vertical, tolerance);
  if (faces.length < 2)
    return hold(
      faces.length ? 'single-plane-only' : 'non-planar-or-mixed-surfaces',
      faces.length
        ? '관측된 수직 면이 하나뿐이라 숨은 외곽과 수평 중심을 정할 수 없어요.'
        : '같은 방향 표면이 하나의 평면으로 모이지 않거나 작은 부분만 남았어요.',
    );
  const first = faces[0];
  const second = faces.find((face) => Math.abs(dot(face.n, first.n)) <= Math.sin(ANGLE / DEG));
  if (!second) return hold('non-orthogonal-surfaces', '서로 직교하는 두 수직 제품 면을 확인하지 못했어요.');
  const axisA = first.n;
  const sign = dot([-axisA[2], 0, axisA[0]], second.n) >= 0 ? 1 : -1;
  const axisB: ProductPosePoint = [-axisA[2] * sign, 0, axisA[0] * sign];
  result.axes = {
    horizontalWorld: [[...axisA], axisB],
    orthogonalityErrorDegrees: Math.abs(
      90 - Math.acos(Math.max(-1, Math.min(1, dot(first.n, second.n)))) * DEG,
    ),
    faces: [first, second].map((face) => ({
      normalWorld: face.n,
      planeOffsetMm: -face.offset,
      supportCount: face.samples.length,
      residualP95Mm: face.residual,
      observedTangentSpanMm: face.span,
    })),
  };
  const supported = vertical.filter(
    (sample) => Math.abs(dot(sample.n, axisA)) >= cosine || Math.abs(dot(sample.n, axisB)) >= cosine,
  ).length;
  if (supported / vertical.length < 0.8)
    hold('non-planar-or-mixed-surfaces', '여러 방향의 표면이 섞여 하나의 직육면체 몸체로 설명하기 어려워요.');
  const walls = input.walls.filter(
    (wall) =>
      wall.id.trim() &&
      finitePoint(wall.normalWorld) &&
      finitePoint(wall.medianPointWorldMm) &&
      Math.abs(norm(wall.normalWorld) - 1) < 0.01 &&
      Math.abs(wall.normalWorld[1]) < Math.sin(ANGLE / DEG) &&
      Number.isFinite(wall.offsetMm) &&
      Number.isInteger(wall.inlierCount) &&
      wall.inlierCount >= 96 &&
      Number.isFinite(wall.rmsResidualMm) &&
      wall.rmsResidualMm >= 0 &&
      wall.rmsResidualMm <= 50 &&
      Math.abs(dot(wall.normalWorld, wall.medianPointWorldMm) + wall.offsetMm) <=
        Math.max(12, 3 * wall.rmsResidualMm),
  );
  if (!walls.length) hold('observed-wall-missing', '같은 좌표계에서 검증할 수 있는 관측 벽 근거가 없어요.');
  else if (
    !walls.some(
      (wall) =>
        Math.max(
          Math.abs(dot(horizontal(wall.normalWorld), axisA)),
          Math.abs(dot(horizontal(wall.normalWorld), axisB)),
        ) >= cosine,
    )
  )
    hold('wall-axis-inconsistent', '제품의 관측 수평 축이 관측 벽 방향과 일치하지 않아요.');
  if (!dims)
    return hold(
      'unknown-dimensions',
      '관측 면의 범위만으로 가려진 전체 규격을 만들지 않아요. 규격을 알려주면 고정해서 맞는지 검사할 수 있어요.',
    );
  if (
    dims.heightMm !== undefined &&
    result.observedBounds.robustMaxWorldMm[1] - result.observedBounds.robustMinWorldMm[1] >
      dims.heightMm + 2 * tolerance
  )
    return hold(
      'fixed-dimensions-inconsistent',
      '관측된 몸체의 높이 범위가 주어진 높이보다 커요. 높이나 수직 중심을 임의로 바꾸지 않아요.',
    );
  const offsetA = quantile(
    first.samples.map((sample) => dot(axisA, sample.p)),
    0.5,
  );
  const offsetB = quantile(
    second.samples.map((sample) => dot(axisB, sample.p)),
    0.5,
  );
  const fronts = [
    axisA,
    axisB,
    axisA.map((v) => -v) as ProductPosePoint,
    axisB.map((v) => -v) as ProductPosePoint,
  ];
  for (const front of fronts) {
    const width: ProductPosePoint = [front[2], 0, -front[0]];
    const halfA =
      (Math.abs(dot(width, axisA)) * dims.widthMm) / 2 + (Math.abs(dot(front, axisA)) * dims.depthMm) / 2;
    const halfB =
      (Math.abs(dot(width, axisB)) * dims.widthMm) / 2 + (Math.abs(dot(front, axisB)) * dims.depthMm) / 2;
    const center: ProductPosePoint = [
      axisA[0] * (offsetA - halfA) + axisB[0] * (offsetB - halfB),
      0,
      axisA[2] * (offsetA - halfA) + axisB[2] * (offsetB - halfB),
    ];
    const local = (sample: Sample) => {
      const delta: ProductPosePoint = [sample.p[0] - center[0], 0, sample.p[2] - center[2]];
      return [dot(delta, width), dot(delta, front)];
    };
    const contained =
      body.filter((sample) => {
        const [x, z] = local(sample);
        return Math.abs(x) <= dims.widthMm / 2 + tolerance && Math.abs(z) <= dims.depthMm / 2 + tolerance;
      }).length / body.length;
    const residual = quantile(
      vertical.map((sample) => {
        const [x, z] = local(sample);
        return Math.min(Math.abs(Math.abs(x) - dims.widthMm / 2), Math.abs(Math.abs(z) - dims.depthMm / 2));
      }),
      0.95,
    );
    const yawDegrees = wrapped(yawOf(front));
    if (contained < 0.97 || residual > tolerance) {
      result.diagnostics.rejectedFits.push({
        yawDegrees,
        code: 'fixed-dimensions-inconsistent',
        detail: `고정 규격 내 표면 비율 ${contained.toFixed(4)}, 수직 면 잔차 p95 ${residual.toFixed(2)} mm, 허용 ${tolerance.toFixed(2)} mm`,
      });
      continue;
    }
    const corners: ProductPosePoint[] = [];
    for (const a of [-1, 1])
      for (const b of [-1, 1])
        for (const y of [
          result.observedBounds.robustMinWorldMm[1],
          result.observedBounds.robustMaxWorldMm[1],
        ])
          corners.push([
            center[0] + (a * width[0] * dims.widthMm) / 2 + (b * front[0] * dims.depthMm) / 2,
            y,
            center[2] + (a * width[2] * dims.widthMm) / 2 + (b * front[2] * dims.depthMm) / 2,
          ]);
    const wallFits = walls.map((wall) => ({
      wallId: wall.id,
      minimumSignedCornerDistanceMm: Math.min(
        ...corners.map((point) => dot(wall.normalWorld, point) + wall.offsetMm),
      ),
      aligned:
        Math.max(
          Math.abs(dot(horizontal(wall.normalWorld), width)),
          Math.abs(dot(horizontal(wall.normalWorld), front)),
        ) >= cosine,
    }));
    if (wallFits.some((fit) => fit.minimumSignedCornerDistanceMm < -tolerance)) {
      result.diagnostics.rejectedFits.push({
        yawDegrees,
        code: 'wall-intersection',
        detail: '고정 규격 가설이 관측 벽을 침범해요. 위치를 벽 안으로 clamp하지 않아요.',
      });
      continue;
    }
    let directionEvidence: 'unresolved' | 'explicit-front' | 'explicit-back-wall' = 'unresolved';
    if (explicitFront) {
      if (dot(front, horizontal(explicitFront.direction)) < cosine) {
        result.diagnostics.rejectedFits.push({
          yawDegrees,
          code: 'front-evidence-inconsistent',
          detail: '별도로 확인된 앞 방향과 맞지 않아요.',
        });
        continue;
      }
      directionEvidence = 'explicit-front';
    }
    if (input.backWallRelation) {
      const wall = walls.find((wall) => wall.id === input.backWallRelation!.wallId);
      if (!wall || dot(front, horizontal(wall.normalWorld)) < cosine) {
        result.diagnostics.rejectedFits.push({
          yawDegrees,
          code: 'front-evidence-inconsistent',
          detail: '별도로 확인된 뒤면-벽 관계와 맞지 않아요.',
        });
        continue;
      }
      directionEvidence = 'explicit-back-wall';
    }
    result.alternatives.push({
      centerXZMm: [center[0], center[2]],
      yawDegrees,
      dimensions: { ...dims },
      fit: {
        toleranceMm: tolerance,
        containedBodyFraction: contained,
        verticalSurfaceResidualP95Mm: residual,
        directionEvidence,
        walls: wallFits,
      },
      assumptions: [...assumed],
    });
  }
  if (!result.alternatives.length) {
    for (const code of [
      'fixed-dimensions-inconsistent',
      'wall-intersection',
      'front-evidence-inconsistent',
    ] as const)
      if (result.diagnostics.rejectedFits.some((fit) => fit.code === code))
        hold(
          code,
          code === 'fixed-dimensions-inconsistent'
            ? '주어진 규격으로 관측된 몸체 표면을 설명하지 못해요. 규격을 늘리거나 줄이지 않았어요.'
            : code === 'wall-intersection'
              ? '고정 규격의 위치 가설이 관측 벽을 침범해요.'
              : '독립적인 앞뒤 방향 근거와 맞는 가설이 없어요.',
        );
    return result;
  }
  if (!explicitFront && !input.backWallRelation)
    hold(
      'front-back-ambiguous',
      '관측 면만으로 제품의 앞뒤를 구분할 수 없어요. 보이는 면을 임의로 전면으로 정하지 않아요.',
    );
  if (
    result.alternatives.length > 2 ||
    ((explicitFront || input.backWallRelation) && result.alternatives.length > 1)
  )
    hold('axis-assignment-ambiguous', '폭과 깊이를 어느 관측 축에 놓을지 여러 가설이 남아요.');
  if (!result.reasons.length && result.alternatives.length === 1) result.status = 'proposed';
  return result;
}
