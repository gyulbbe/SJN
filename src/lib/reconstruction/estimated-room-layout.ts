import { Vector3, Vector4 } from 'three';
import type { RoomDefinition } from '../room-types';
import { validateRoomDimensions } from '../room-geometry';
import { buildCandidatePipeline } from './candidate-pipeline';
import { buildEstimatedCandidatePipeline, type EstimatedCandidatePipelineInput } from './estimated-layout';
import { createSourceCamera, validateSourceFixture, type SourceCamera } from './source-camera';
import type { SceneRoomLayout, SourceRoomCorner } from './pipeline-contract';

type PipelineResult = ReturnType<typeof buildEstimatedCandidatePipeline>;
export type EstimatedRoomExperimentInput = Omit<
  EstimatedCandidatePipelineInput,
  'sizeFactors' | 'cameraPenalty'
> & {
  /** Default grid uses ratios to the unchanged room height, not image-specific dimensions. */
  widthHeightRatios?: readonly number[];
  depthHeightRatios?: readonly number[];
  onProgress?: (progress: { completed: number; total: number; room: RoomDefinition; score: number }) => void;
};
export type RoomStructureDiagnostic = {
  score: number;
  cornerCount: number;
  lineCount: number;
  meanCornerNormalizedError: number | null;
  meanLineDirectionError: number | null;
  reasons: string[];
};
export type RoomHypothesisSummary = {
  room: RoomDefinition;
  originalRoom: boolean;
  score: number;
  scoreTerms: Record<string, number>;
  placedCount: number;
  heldCandidateIds: string[];
  camera: SourceCamera | undefined;
  cameraNearTieCount: number;
  structure: RoomStructureDiagnostic;
  truncation: { candidateId: string; edges: string[] }[];
  selectedCollisionCount: number;
  reportedRejectedCollisionAlternatives: number;
  durationMs: number;
};
const widths = [0.45, 0.65, 0.85, 1, 1.25] as const;
const depths = [0.65, 0.85, 1, 1.25, 1.5] as const;

function cornerWorld(room: RoomDefinition, name: SourceRoomCorner) {
  return new Vector3(
    name.endsWith('left') ? -room.widthMm / 2 : room.widthMm / 2,
    name.includes('-top-') ? room.heightMm : 0,
    name.startsWith('front-') ? room.depthMm : 0,
  );
}

/** Optional sparse observed geometry. An absent edge is not an observation of a perfect cuboid. */
export function inspectEstimatedRoomStructure(
  room: RoomDefinition,
  cameraData: SourceCamera,
  layout: SceneRoomLayout,
): RoomStructureDiagnostic {
  const camera = createSourceCamera(cameraData);
  const corners = [...(layout.corners ?? [])].filter((c) => c.evidence.length > 0);
  if (layout.backWallQuad && layout.evidence.length)
    for (const [index, corner] of (
      ['back-top-left', 'back-top-right', 'back-bottom-right', 'back-bottom-left'] as const
    ).entries())
      if (!corners.some((c) => c.corner === corner))
        corners.push({ corner, point: layout.backWallQuad[index], evidence: layout.evidence });
  const cornerErrors = corners.map((c) => {
    const p = cornerWorld(room, c.corner).applyMatrix4(camera.matrixWorldInverse);
    if (p.z >= -1) return 4;
    p.applyMatrix4(camera.projectionMatrix);
    return ((p.x + 1) / 2 - c.point.x) ** 2 + ((1 - p.y) / 2 - c.point.y) ** 2;
  });
  const lineErrors: number[] = [];
  for (const line of layout.lines ?? []) {
    if (!line.evidence.length) continue;
    const direction = new Vector4(
      line.axis === 'width' ? 1 : 0,
      line.axis === 'height' ? 1 : 0,
      line.axis === 'depth' ? 1 : 0,
      0,
    )
      .applyMatrix4(camera.matrixWorldInverse)
      .applyMatrix4(camera.projectionMatrix);
    const centreX = (line.start.x + line.end.x) / 2;
    const centreY = (line.start.y + line.end.y) / 2;
    const vx =
      Math.abs(direction.w) < 1e-8
        ? direction.x * cameraData.image.width
        : ((direction.x / direction.w + 1) / 2 - centreX) * cameraData.image.width;
    const vy =
      Math.abs(direction.w) < 1e-8
        ? -direction.y * cameraData.image.height
        : ((1 - direction.y / direction.w) / 2 - centreY) * cameraData.image.height;
    const dx = (line.end.x - line.start.x) * cameraData.image.width;
    const dy = (line.end.y - line.start.y) * cameraData.image.height;
    const norm = Math.hypot(vx, vy) * Math.hypot(dx, dy);
    if (norm > 1e-8) lineErrors.push(((vx * dy - vy * dx) / norm) ** 2);
  }
  const mean = (values: number[]) =>
    values.length ? values.reduce((sum, n) => sum + n, 0) / values.length : null;
  const cornerError = mean(cornerErrors);
  const lineError = mean(lineErrors);
  return {
    score: (cornerError ?? 0) * 8 + (lineError ?? 0) * 4,
    cornerCount: cornerErrors.length,
    lineCount: lineErrors.length,
    meanCornerNormalizedError: cornerError === null ? null : Math.sqrt(cornerError),
    meanLineDirectionError: lineError,
    reasons: [
      ...(!cornerErrors.length ? ['관측된 방 모서리가 없어 방 폭·깊이를 직접 제약하지 못해요.'] : []),
      ...(!lineErrors.length ? ['관측된 구조 선이 없어 카메라 방향을 독립적으로 확인하지 못해요.'] : []),
      '사진 속 실제 선·모서리로 기록된 근거만 사용하며, 보이지 않는 방 경계는 추가하지 않았어요.',
    ],
  };
}

/** Development experiment only. Returns suggestions; never writes a room, project or observation. */
export function buildEstimatedRoomLayoutExperiment(input: EstimatedRoomExperimentInput) {
  if (input.manualIdSet?.size) throw new Error('방 비율 실험에는 사용자 배치가 없는 원관측을 사용해 주세요.');
  const ratioWidths = input.widthHeightRatios ?? widths;
  const ratioDepths = input.depthHeightRatios ?? depths;
  if (
    !ratioWidths.length ||
    !ratioDepths.length ||
    ratioWidths.length * ratioDepths.length > 36 ||
    [...ratioWidths, ...ratioDepths].some((r) => !Number.isFinite(r) || r < 0.2 || r > 2)
  )
    throw new Error('방 비율 가설 범위가 올바르지 않아요.');
  const rooms: RoomDefinition[] = [{ ...input.room }];
  for (const width of ratioWidths)
    for (const depth of ratioDepths) {
      const room = {
        ...input.room,
        widthMm: input.room.heightMm * width,
        depthMm: input.room.heightMm * depth,
      };
      if (
        validateRoomDimensions(room) &&
        !rooms.some((r) => r.widthMm === room.widthMm && r.depthMm === room.depthMm)
      )
        rooms.push(room);
    }
  const summaries: RoomHypothesisSummary[] = [];
  let original: { room: RoomDefinition; result: PipelineResult } | undefined;
  let best: { room: RoomDefinition; result: PipelineResult } | undefined;
  for (const [index, room] of rooms.entries()) {
    const started = performance.now();
    // Recompute strict coordinate checks from the same original photo observations for each
    // hypothetical room. Old millimetre placements/cameras are not copied into another room.
    const strictResult = buildCandidatePipeline(
      input.understanding,
      input.baseline,
      room,
      input.image,
      {},
      input.strictResult.pipeline.automaticUnderstanding,
      input.strictResult.pipeline.userToiletLidStates,
      undefined,
      undefined,
      undefined,
      undefined,
      input.toiletLidPolicy,
    );
    const result = buildEstimatedCandidatePipeline({
      ...input,
      strictResult,
      room,
      sizeFactors: [1],
      cameraSearch: input.cameraSearch ?? 'expanded-v1',
      cameraPenalty: (camera) =>
        inspectEstimatedRoomStructure(room, camera, input.understanding.roomLayout).score,
    });
    const estimated = result.pipeline.estimatedLayout;
    const selected = estimated.hypotheses[0];
    const score = selected?.score ?? 0;
    const structure = estimated.camera.value
      ? inspectEstimatedRoomStructure(room, estimated.camera.value, input.understanding.roomLayout)
      : {
          score: 0,
          cornerCount: 0,
          lineCount: 0,
          meanCornerNormalizedError: null,
          meanLineDirectionError: null,
          reasons: ['카메라 가설을 만들지 못했어요.'],
        };
    const truncation: RoomHypothesisSummary['truncation'] = [];
    let collisions = 0,
      rejectedCollisions = 0;
    for (const node of estimated.nodes) {
      if (!node.selected) continue;
      const plan = node.selected.plan;
      const check = validateSourceFixture(
        room,
        estimated.camera.value,
        {
          ...plan,
          widthMm: plan.widthMm!,
          heightMm: plan.heightMm!,
          depthMm: plan.depthMm!,
        },
        node.observed.bounds,
      );
      if (check.projectedBounds) {
        const box = check.projectedBounds;
        const observed = node.observed.bounds;
        const edges = [
          ...(observed.left > 0.015 && box.left < 0 ? ['left'] : []),
          ...(observed.top > 0.015 && box.top < 0 ? ['top'] : []),
          ...(observed.right < 0.985 && box.right > 1 ? ['right'] : []),
          ...(observed.bottom < 0.985 && box.bottom > 1 ? ['bottom'] : []),
        ];
        if (edges.length) truncation.push({ candidateId: node.candidateId, edges });
      }
      collisions += node.selected.sceneChecks?.filter((entry) => entry.collision).length ?? 0;
      rejectedCollisions += node.alternatives.filter((entry) =>
        entry.rejectedBy.some((reason) => reason.startsWith('physical-collision:')),
      ).length;
    }
    summaries.push({
      room: { ...room },
      originalRoom: index === 0,
      score,
      scoreTerms: selected?.scoreTerms ?? {},
      placedCount: selected?.placedCount ?? 0,
      heldCandidateIds: selected?.heldCandidateIds ?? [],
      camera: estimated.camera.value,
      cameraNearTieCount: estimated.hypotheses.filter(
        (h) => h.score <= score + Math.max(0.15, Math.abs(score) * 0.05),
      ).length,
      structure,
      truncation,
      selectedCollisionCount: collisions / 2,
      reportedRejectedCollisionAlternatives: rejectedCollisions,
      durationMs: performance.now() - started,
    });
    if (!original) original = { room, result };
    if (!best || score < best.result.pipeline.estimatedLayout.hypotheses[0].score) best = { room, result };
    input.onProgress?.({ completed: index + 1, total: rooms.length, room: { ...room }, score });
  }
  summaries.sort((a, b) => a.score - b.score);
  const threshold = summaries[0].score + Math.max(0.15, Math.abs(summaries[0].score) * 0.05);
  const near = summaries.filter((row) => row.score <= threshold);
  return {
    version: 1 as const,
    status: 'unconfirmed-experiment' as const,
    original: original!,
    selected: best!,
    summaries,
    ambiguity: {
      diagnosticThreshold: threshold,
      nearTieCount: near.length,
      widthRangeMm: [
        Math.min(...near.map((r) => r.room.widthMm)),
        Math.max(...near.map((r) => r.room.widthMm)),
      ],
      depthRangeMm: [
        Math.min(...near.map((r) => r.room.depthMm)),
        Math.max(...near.map((r) => r.room.depthMm)),
      ],
      explanation: '근접 점수 범위는 식별 불가능성을 보는 진단이며 통계적 신뢰 구간이 아니에요.',
    },
    provenance: {
      roomDimensions: 'estimated-hypothesis',
      productDimensions: 'nominal-default',
      camera: 'estimated-hypothesis',
    } as const,
    warnings: [
      '실측 치수나 확정된 공간 구조가 아니며, 기존 프로젝트 치수를 변경하지 않았어요.',
      '동일 사진의 후보·관계·관측된 구조 선/모서리만 사용했어요. 단일 사진에서는 방 비율과 카메라가 서로 대체될 수 있어요.',
      '원래 방과 모든 대안에 동일한 제품 기본 규격을 사용했고, 기존 깊이 모델 관측은 이 독립 실험에 새로 혼합하지 않았어요.',
      '외곽 AABB 충돌은 보수적인 검사예요. 샤워 호스 주변 빈 공간의 실제 충돌과 같다고 볼 수 없어요.',
      '원본에서 잘린 설비는 사진 경계 밖 연장을 허용하지만 새로 잘린 가장자리는 별도로 기록해요.',
    ],
  };
}
