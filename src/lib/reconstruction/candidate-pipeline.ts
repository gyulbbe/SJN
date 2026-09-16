import { resolveProductColor, type ProductColorOverride } from './product-color';
import {
  inspectObservedSupportContact,
  type ObservedSupportContactInspection,
} from './observed-support-contact';
import {
  resolveCandidateBathRim,
  resolveCandidatePartitionTop,
  type CandidateBathRim,
  type CandidatePartitionTop,
} from './candidate-bath-rim';
import {
  fitDepthRoomCamera,
  depthObservedWallAtPoint,
  type DepthRoomObservation,
  type DepthRoomCameraResult,
} from './depth-room-geometry';
import { raisedGlassSupportErrors, raisedGlassSupportLabels } from './raised-glass-support';
import { placementFromWallReference, type WallRelativePosition } from './wall-relative-placement';
import type { RoomDefinition, RoomFace } from '../room-types';
import type { SceneUnderstanding } from './pipeline-contract';
import {
  candidateFloorYaw,
  inspectObservedPlacement,
  inspectObservedInstallation,
  type ObservedInstallationInspection,
  type ObservedPlacementDiagnostic,
} from './observed-placement';
import { inferToiletLidState } from './toilet-observations';
import {
  DEFAULT_CANDIDATE_TOILET_LID_POLICY,
  inspectCandidateToiletLid,
  resolveCandidateToiletLid,
  type CandidateToiletLidPolicy,
  type CandidateToiletLidDiagnostic,
} from './candidate-toilet-lid';
import { candidateBoxIoU, resolveSceneCandidates, type CandidateResolution } from './candidate-resolution';
import {
  fitSourceCamera,
  solveSourcePlacement,
  validateSourceFixture,
  type SourceCameraFit,
  type SourcePlacement,
  type SourceFixtureCheck,
} from './source-camera';
import {
  reconstructionDefaults,
  reconstructionLabels,
  type ReconstructionCandidate,
  type ReconstructionReview,
  type ReconstructionStandardOptions,
  type ReconstructionKind,
} from './types';

export type CandidateFixturePlan = ReconstructionStandardOptions & {
  /** Candidate-space relation; converted to fixture IDs only after parent generation. */
  bathRimCandidate?: CandidateBathRim;
  partitionTopCandidate?: CandidatePartitionTop;
  kind: ReconstructionKind;
  face: RoomFace;
  u: number;
  v: number;
  widthMm?: number;
  heightMm?: number;
  depthMm?: number;
  color?: string;
};
export type ManualCandidatePlacement = {
  bathRim?: CandidateBathRim;
  partitionTop?: CandidatePartitionTop;
  face: RoomFace;
  u: number;
  v: number;
  baseHeightMm: number;
  widthMm?: number;
  heightMm?: number;
  depthMm?: number;
  yawDegrees?: number;
  wallReference?: WallRelativePosition;
  support?: ReconstructionStandardOptions['support'];
};
export type CandidatePipeline = {
  toiletLidPolicy?: CandidateToiletLidPolicy;
  toiletLidObservations?: CandidateToiletLidDiagnostic[];
  /** Optional explicit estimate; strict camera/placement evidence above is never rewritten. */
  estimatedLayout?: import('./estimated-layout').EstimatedLayout;
  understanding: SceneUnderstanding;
  automaticUnderstanding: SceneUnderstanding;
  baselineReview: ReconstructionReview;
  resolution: CandidateResolution;
  camera: SourceCameraFit;
  /** Opt-in development geometry probe; never a default model or automatic user correction. */
  depthGeometry?: DepthRoomCameraResult & { observation: DepthRoomObservation };
  placements: SourcePlacement[];
  /** Optional for older reports; the actual first rejection of an attempted baseline reuse. */
  observedPlacementChecks?: ObservedPlacementDiagnostic[];
  /** Independent installation judgment; this does not borrow an old physical placement. */
  observedInstallationChecks?: ObservedInstallationInspection[];
  observedSupportChecks?: ObservedSupportContactInspection[];
  modelChecks: {
    candidateId: string;
    source: 'source-camera' | 'room-only';
    /** Diagnostic only; a rejected proposal is never inserted in the scene. Optional for old reports. */
    proposedPlacement?: CandidateFixturePlan;
    result: SourceFixtureCheck;
  }[];
  evidenceChecks: {
    candidateId: string;
    semanticCandidateId?: string;
    intersectionOverUnion?: number;
    agreement: 'supports' | 'conflicts' | 'unobserved';
    reasons: string[];
  }[];
  warnings: string[];
  /** Explicit appearance correction, kept separate from model observations. */
  userBathRimLinks?: {
    candidateId: string;
    parentCandidateId: string;
    status: 'attached' | 'held';
    reason?: string;
    derivedHeightMm?: number;
  }[];
  userToiletLidStates?: Record<string, 'open' | 'closed'>;
  userColors?: Record<string, ProductColorOverride>;
  userPedestalShapes?: Record<string, 'round' | 'rectangular'>;
};
export const boxIoU = candidateBoxIoU;
function assertManual(input: ManualCandidatePlacement, room: RoomDefinition) {
  if (
    !['floor', 'left', 'back', 'right'].includes(input.face) ||
    ![input.u, input.v].every((n) => Number.isFinite(n) && n >= 0 && n <= 1) ||
    !Number.isFinite(input.baseHeightMm) ||
    input.baseHeightMm < 0 ||
    input.baseHeightMm >= room.heightMm ||
    [input.widthMm, input.heightMm, input.depthMm].some(
      (n) => n !== undefined && (!Number.isFinite(n) || n <= 0 || n > 20000),
    ) ||
    (input.yawDegrees !== undefined && !Number.isFinite(input.yawDegrees))
  )
    throw new Error('사용자 배치의 위치와 규격을 확인해 주세요.');
}
function hold(placement: SourcePlacement, reason: string) {
  placement.status = 'held';
  delete placement.placement;
  placement.reasons.push(reason);
}
export function buildCandidatePipeline(
  understanding: SceneUnderstanding,
  baseline: ReconstructionReview,
  room: RoomDefinition,
  image: { width: number; height: number },
  manual: Record<string, ManualCandidatePlacement> = {},
  automaticUnderstanding: SceneUnderstanding = understanding,
  userToiletLidStates: Record<string, 'open' | 'closed'> = {},
  experimentalGeometry?: { observation: DepthRoomObservation; inputFingerprint: string },
  observationIdentity?: { candidateInputFingerprint: string; observationInputFingerprint: string },
  userColors: Record<string, ProductColorOverride> = {},
  userPedestalShapes: Record<string, 'round' | 'rectangular'> = {},
  toiletLidPolicy: CandidateToiletLidPolicy = DEFAULT_CANDIDATE_TOILET_LID_POLICY,
  modelSource: 'qwen' | 'gemma' = 'qwen',
) {
  for (const [id, shape] of Object.entries(userPedestalShapes)) {
    if (!['round', 'rectangular'].includes(shape) || !understanding.candidates.some((item) => item.id === id))
      throw new Error('기둥 단면 보정 대상과 값을 확인해 주세요.');
  }
  for (const [id, override] of Object.entries(userColors)) {
    const candidate = understanding.candidates.find((item) => item.id === id);
    if (!candidate || candidate.kind === 'unknown')
      throw new Error('제품 색상 보정 대상의 종류를 확인해 주세요.');
    resolveProductColor(candidate.kind, undefined, override);
  }
  for (const [id, state] of Object.entries(userToiletLidStates)) {
    if (
      !['open', 'closed'].includes(state) ||
      !understanding.candidates.some((item) => item.id === id && item.kind === 'toilet')
    )
      throw new Error('변기 뚜껑 보정의 대상과 열림·닫힘 값을 확인해 주세요.');
  }
  const cornerCamera = fitSourceCamera(room, image, understanding.roomLayout);
  const depthGeometry = experimentalGeometry
    ? fitDepthRoomCamera(room, experimentalGeometry.observation, experimentalGeometry.inputFingerprint)
    : undefined;
  if (
    depthGeometry &&
    experimentalGeometry &&
    (experimentalGeometry.observation.image.width !== image.width ||
      experimentalGeometry.observation.image.height !== image.height)
  ) {
    depthGeometry.fit.status = 'held';
    delete depthGeometry.fit.camera;
    depthGeometry.fit.reasons.push('기하 분석과 후보 사진의 해상도가 다릅니다.');
  }
  // Rejected text corners invalidate only that observation route, not independent depth planes.
  if (understanding.validation?.roomLayoutIssues.length) {
    cornerCamera.status = 'held';
    delete cornerCamera.camera;
    cornerCamera.reasons.push(...understanding.validation.roomLayoutIssues.map((issue) => issue.message));
  }
  const camera = cornerCamera.status === 'estimated' ? cornerCamera : (depthGeometry?.fit ?? cornerCamera);
  const { effective, resolution } = resolveSceneCandidates(understanding, automaticUnderstanding);
  const pipeline: CandidatePipeline = {
    understanding: structuredClone(understanding),
    automaticUnderstanding: structuredClone(automaticUnderstanding),
    baselineReview: structuredClone(baseline),
    resolution,
    ...(toiletLidPolicy === 'independent-semantic-v1' ? { toiletLidPolicy, toiletLidObservations: [] } : {}),
    camera,
    ...(depthGeometry && experimentalGeometry
      ? {
          depthGeometry: { ...depthGeometry, observation: structuredClone(experimentalGeometry.observation) },
        }
      : {}),
    placements: [],
    modelChecks: [],
    evidenceChecks: [],
    warnings: [...camera.reasons, ...camera.assumptions],
    ...(Object.keys(userToiletLidStates).length ? { userToiletLidStates: { ...userToiletLidStates } } : {}),
  };
  const review: ReconstructionReview = {
    version: 2,
    analysis: 'partial',
    planes: structuredClone(baseline.planes),
    candidates: [],
    warnings: [],
  };
  const plans: Record<string, CandidateFixturePlan | null> = {};
  const ordered = Object.values(manual).some((value) => value.bathRim || value.partitionTop)
    ? [...effective].sort(
        (a, b) =>
          Number(b.kind === 'bath' || b.kind === 'lowPartition') -
          Number(a.kind === 'bath' || a.kind === 'lowPartition'),
      )
    : effective;
  for (const item of ordered) {
    const resolved = resolution.entries.find((entry) => entry.candidateId === item.id)!;
    plans[item.id] = null;
    const similar = baseline.candidates
      .map((entry) => ({ entry, overlap: boxIoU(entry.bounds, item.bounds) }))
      .sort((a, b) => b.overlap - a.overlap)[0];
    const evidence = similar && similar.overlap >= 0.25 ? similar : undefined;
    const agrees =
      evidence?.entry.kind === item.kind ||
      (item.kind === 'mirrorCabinet' && evidence?.entry.kind === 'mirror') ||
      (item.kind === 'vanity' &&
        evidence?.entry.kind === 'basin' &&
        resolution.assemblies.some((assembly) => assembly.parentId === item.id));
    const visibleBehindGlass =
      item.kind === 'glassPartition' &&
      !!evidence &&
      understanding.relations.some(
        (relation) =>
          relation.frontId === item.id &&
          relation.relation === 'visibleThrough' &&
          understanding.candidates.some(
            (other) =>
              other.id === relation.behindId &&
              other.kind === evidence.entry.kind &&
              boxIoU(other.bounds, evidence.entry.bounds) >= 0.25,
          ),
      );
    const unsupportedGlassPixels = item.kind === 'glassPartition' && !!evidence;
    const kindConflict = !!evidence && !agrees && !visibleBehindGlass && !unsupportedGlassPixels;
    pipeline.evidenceChecks.push({
      candidateId: item.id,
      semanticCandidateId: evidence?.entry.id,
      intersectionOverUnion: evidence?.overlap,
      agreement:
        visibleBehindGlass || unsupportedGlassPixels
          ? 'unobserved'
          : evidence
            ? agrees
              ? 'supports'
              : 'conflicts'
            : 'unobserved',
      reasons:
        unsupportedGlassPixels && !visibleBehindGlass
          ? [
              '기존 픽셀 분석은 유리 종류를 지원하지 않아 뒤쪽 물체를 분류할 수 있어요. 유리 관측의 진위와 구분해요.',
            ]
          : visibleBehindGlass
            ? ['유리 뒤에 보이는 설비의 픽셀 분류예요. 유리 자체의 인식 근거와 구분해 두 후보를 유지해요.']
            : evidence
              ? [
                  agrees
                    ? '사진 영역과 픽셀 분류의 종류가 일치해요. 설치 방식·치수의 검증은 별도예요.'
                    : '같은 사진 영역의 픽셀 분류와 설비 종류 판단이 달라요. 사용자 확인이 필요해요.',
                ]
              : [
                  '이 후보를 지지하는 DeepLab 영역이 없어요. 픽셀 미검출만으로 새로운 후보를 삭제하지 않아요.',
                ],
    });
    const toiletLidObservation =
      toiletLidPolicy === 'independent-semantic-v1' && item.kind === 'toilet'
        ? inspectCandidateToiletLid({
            candidate: item,
            canonicalCandidate: understanding.candidates.find((candidate) => candidate.id === item.id),
            baselineCandidates: baseline.candidates,
            resolution,
            relations: understanding.relations,
          })
        : undefined;
    if (toiletLidObservation) pipeline.toiletLidObservations!.push(toiletLidObservation);
    // Support classification does not depend on camera calibration or an existing placement.
    // Keep independently observed mounting available even when all positions are held.
    const installationNotes: string[] = [];
    if (
      understanding.roomLayout.orthogonal !== false &&
      resolved.disposition === 'fixture' &&
      !kindConflict &&
      (item.mounting === 'unknown' ||
        (item.mounting === 'wall' && item.wall === 'unknown') ||
        (item.kind === 'basin' && item.basinStyle === 'unknown'))
    ) {
      const observed = inspectObservedInstallation(
        item,
        effective.filter(
          (other) =>
            resolution.entries.find((entry) => entry.candidateId === other.id)?.disposition === 'fixture',
        ),
        baseline,
      );
      (pipeline.observedInstallationChecks ??= []).push(observed);
      if (observed.installation) {
        const inferred = observed.installation;
        if (item.mounting === 'unknown') {
          item.mounting = inferred.mode;
          item.provenance = { ...item.provenance, mounting: 'geometry' };
        }
        if (item.wall === 'unknown' && inferred.wall) {
          item.wall = inferred.wall;
          item.provenance = { ...item.provenance, wall: 'geometry' };
        }
        if (item.kind === 'basin' && item.basinStyle === 'unknown' && inferred.basinVariant)
          item.basinStyle = inferred.basinVariant;
        installationNotes.push(observed.diagnostic.message);
      }
      if (
        camera.status === 'estimated' &&
        item.mounting === 'wall' &&
        item.wall === 'unknown' &&
        depthGeometry &&
        camera === depthGeometry.fit
      ) {
        const inferred = depthObservedWallAtPoint(
          room,
          depthGeometry,
          item.anchor?.point ?? {
            x: (item.bounds.left + item.bounds.right) / 2,
            y: (item.bounds.top + item.bounds.bottom) / 2,
          },
          experimentalGeometry
            ? { observation: experimentalGeometry.observation, bounds: item.bounds }
            : undefined,
        );
        if (inferred) {
          item.wall = inferred.wall;
          item.provenance = { ...item.provenance, wall: 'geometry' };
          installationNotes.push(inferred.reason);
        }
      }
    }
    const support =
      item.kind === 'basin' &&
      ['pedestal', 'unknown'].includes(item.basinStyle) &&
      !item.anchor &&
      !manual[item.id] &&
      resolved.disposition === 'fixture' &&
      !kindConflict
        ? inspectObservedSupportContact(
            item,
            effective.filter(
              (other) =>
                resolution.entries.find((entry) => entry.candidateId === other.id)?.disposition === 'fixture',
            ),
            baseline,
            observationIdentity
              ? { ...observationIdentity, image, relations: understanding.relations }
              : undefined,
          )
        : undefined;
    if (support) (pipeline.observedSupportChecks ??= []).push(support);
    let placement = solveSourcePlacement(room, camera, item, understanding.relations, support?.contact);
    if (support && !support.contact) placement.reasons.push(support.diagnostic.message);
    placement.reasons.push(...installationNotes);
    if (
      placement.status === 'held' &&
      (!support || !!support.contact) &&
      understanding.roomLayout.orthogonal !== false &&
      resolved.disposition === 'fixture' &&
      !kindConflict &&
      !manual[item.id]
    ) {
      const inspected = inspectObservedPlacement(
        item,
        effective.filter(
          (other) =>
            resolution.entries.find((entry) => entry.candidateId === other.id)?.disposition === 'fixture',
        ),
        baseline,
        room,
        image,
      );
      (pipeline.observedPlacementChecks ??= []).push(inspected.diagnostic);
      const reused = inspected.placement;
      if (!reused) placement.reasons.push(inspected.diagnostic.message);
      if (reused) {
        placement = reused;
        // Only the effective copy receives independently supported missing installation fields.
        // The model observations above and automaticUnderstanding remain exactly as received.
        const derived = reused.derivedInstallation;
        if (derived) {
          if (item.mounting === 'unknown') {
            item.mounting = derived.mode;
            item.provenance = { ...item.provenance, mounting: 'geometry' };
          }
          if (item.wall === 'unknown' && derived.wall) {
            item.wall = derived.wall;
            item.provenance = { ...item.provenance, wall: 'geometry' };
          }
        }
      }
    }
    if (resolved.disposition === 'fixture') placement.reasons.push(...resolved.reasons);
    if (resolved.disposition !== 'fixture')
      hold(placement, resolved.reasons.join(' ') || '종류와 실제 설비 여부를 확인해 주세요.');
    if (kindConflict && item.provenance?.kind !== 'user')
      hold(
        placement,
        '설비 종류가 픽셀 분류와 충돌해요. 종류를 사용자 확인하기 전까지 자동 모형 생성을 보류해요.',
      );
    let manualValue = manual[item.id];
    let bathSupport: ReconstructionStandardOptions['support'];
    let bathHeld: string | undefined;
    if (manualValue?.bathRim || manualValue?.partitionTop) {
      if (
        manualValue.face !== 'floor' ||
        manualValue.wallReference !== undefined ||
        manualValue.support !== undefined ||
        (manualValue.bathRim !== undefined && manualValue.partitionTop !== undefined)
      )
        throw new Error(
          '욕조 연결은 바닥 기준 관계로 지정하며 별도 벽 기준이나 독립 지지 높이와 함께 사용할 수 없어요.',
        );
      const defaults = reconstructionDefaults(item.kind === 'unknown' ? 'glassPartition' : item.kind);
      const parentLink = manualValue.bathRim ?? manualValue.partitionTop!;
      const resolve = manualValue.bathRim
        ? (
            room: RoomDefinition,
            parent: CandidateFixturePlan | null | undefined,
            child: CandidateFixturePlan,
          ) => resolveCandidateBathRim(room, manualValue!.bathRim!, parent, child)
        : (
            room: RoomDefinition,
            parent: CandidateFixturePlan | null | undefined,
            child: CandidateFixturePlan,
          ) => resolveCandidatePartitionTop(room, manualValue!.partitionTop!, parent, child);
      const linked = resolve(room, plans[parentLink.parentCandidateId], {
        ...defaults,
        ...manualValue,
        kind: item.kind === 'unknown' ? 'glassPartition' : item.kind,
        version: 2,
      });
      if (linked.status === 'attached') {
        bathSupport = linked.placement.support;
        manualValue = {
          ...manualValue,
          u: linked.placement.u,
          v: linked.placement.v,
          baseHeightMm: linked.placement.baseHeightMm!,
          yawDegrees: linked.placement.yawDegrees,
        };
      } else bathHeld = linked.status === 'held' ? linked.reason : '욕조 연결을 확인해 주세요.';
      if (manualValue.bathRim)
        (pipeline.userBathRimLinks ??= []).push({
          candidateId: item.id,
          parentCandidateId: manualValue.bathRim!.parentCandidateId,
          status: bathHeld ? 'held' : 'attached',
          ...(bathHeld ? { reason: bathHeld } : { derivedHeightMm: manualValue.baseHeightMm }),
        });
    }
    if (manualValue) {
      assertManual(manualValue, room);
      const supportErrors = raisedGlassSupportErrors({ ...manualValue, kind: item.kind, version: 2 });
      if (supportErrors.length) throw new Error(supportErrors.join(' '));
      if (manualValue.support)
        placement.reasons.push(
          `사용자가 확인한 독립 지지면: ${raisedGlassSupportLabels[manualValue.support.kind]}, 높이 ${manualValue.support.heightMm}mm (${manualValue.support.provenance.height === 'user' ? '사용자 입력' : '확인한 기본값'}). 실제 욕조·턱을 인식하거나 연결한 것이 아니며 실측 검증값이 아닙니다.`,
        );
      if (manualValue.wallReference) {
        const depth =
          manualValue.depthMm ??
          reconstructionDefaults(
            item.kind === 'unknown' ? 'basin' : item.kind,
            item.basinStyle === 'unknown' ? undefined : item.basinStyle,
          ).depthMm;
        const expected = placementFromWallReference(room, manualValue.wallReference, depth);
        if (
          manualValue.face !== 'floor' ||
          Math.abs(expected.u - manualValue.u) > 1e-8 ||
          Math.abs(expected.v - manualValue.v) > 1e-8 ||
          Math.abs(manualValue.baseHeightMm - (manualValue.support?.heightMm ?? 0)) > 1 ||
          manualValue.yawDegrees !== expected.yawDegrees ||
          item.wall !== manualValue.wallReference.wall ||
          item.provenance?.wall !== 'user'
        )
          throw new Error('벽 기준 거리와 사용자 확인한 설치 벽·위치가 일치하지 않아요.');
        placement.reasons.push(
          `사용자 벽 기준: ${manualValue.wallReference.wall}, 모서리에서 제품 중심 ${manualValue.wallReference.alongMm}mm, 벽과 제품 뒤쪽 간격 ${manualValue.wallReference.clearanceMm}mm. 기본 규격은 실측값이 아니에요.`,
        );
      }
      if (
        item.kind === 'unknown' ||
        item.reflection !== 'physical' ||
        understanding.relations.some(
          (relation) => relation.frontId === item.id && relation.relation === 'reflectionOf',
        )
      )
        throw new Error('사용자 모형 배치 전 종류와 실제 물체 여부를 확인해 주세요.');
      if (resolved.disposition !== 'fixture') {
        hold(
          placement,
          '위치만 지정해 중복·부품·종류 충돌을 해소하지 않아요. 관측 목록을 먼저 확인해 주세요.',
        );
      } else if (kindConflict && item.provenance?.kind !== 'user') {
        hold(placement, '수동 위치만으로 종류의 근거 충돌이 해결되지는 않아요. 설비 종류도 확인해 주세요.');
      } else {
        placement.status = 'estimated';
        placement.placement = {
          face: manualValue.face,
          u: manualValue.u,
          v: manualValue.face === 'floor' ? manualValue.v : 1 - manualValue.baseHeightMm / room.heightMm,
          baseHeightMm: manualValue.baseHeightMm,
        };
        placement.provenance = {
          position: 'user',
          dimensions: [manualValue.widthMm, manualValue.heightMm, manualValue.depthMm].some(
            (value) => value !== undefined,
          )
            ? 'user'
            : 'default',
        };
        placement.reasons.push('사용자가 위치를 직접 정했어요. AI 배치 성공으로 집계하지 않아요.');
        delete placement.anchor;
        delete placement.reprojectionErrorPx;
        delete placement.baselineEvidence;
        delete placement.supportEvidence;
        delete placement.derivedInstallation;
      }
    }
    if (manualValue?.bathRim || manualValue?.partitionTop) {
      if (bathHeld) hold(placement, bathHeld);
      else
        placement.reasons.push(
          '선택한 부모 후보의 표준 지지면에 연결해 위치와 높이를 계산했어요. 부모 관계 출처와 근거를 보존하며 실측값이 아니에요.',
        );
    }
    pipeline.placements.push(placement);
    if (item.kind === 'unknown') continue;
    const basinVariant = item.kind === 'basin' && item.basinStyle !== 'unknown' ? item.basinStyle : undefined;
    const defaults = reconstructionDefaults(item.kind, basinVariant);
    if (!['basin', 'vanity'].includes(item.kind) && item.shape !== 'unknown')
      placement.reasons.push(
        '관측한 형태는 이 종류의 기본 모형에 자동 반영하지 않았어요. 종류별 기본 모형과 사진의 형태 차이를 확인해 주세요.',
      );
    if (placement.placement) {
      const face = placement.placement.face;
      const floorOnly =
        ['toilet', 'bath', 'lowPartition', 'showerCurtain'].includes(item.kind) ||
        (item.kind === 'vanity' && item.mounting !== 'wall') ||
        (item.kind === 'basin' &&
          (basinVariant === 'pedestal' || (basinVariant === 'vanity' && item.mounting !== 'wall')));
      const wallOnly =
        ['mirror', 'mirrorCabinet', 'wallShelf', 'window', 'door', 'wallCabinet', 'shower'].includes(
          item.kind,
        ) ||
        (item.kind === 'basin' &&
          (basinVariant === 'wall' || (basinVariant === 'vanity' && item.mounting === 'wall'))) ||
        (item.kind === 'vanity' && item.mounting === 'wall');
      if ((floorOnly && face !== 'floor') || (wallOnly && face === 'floor'))
        hold(
          placement,
          '선택한 표준 모형의 지지 형태와 설치 면이 맞지 않아요. 종류 또는 설치 방식을 확인해 주세요.',
        );
    }

    if (item.kind === 'basin' && !basinVariant)
      hold(placement, '세면대의 지지 형태를 확인해 주세요. 기둥이나 하부장을 임의로 만들지 않아요.');
    const source: ReconstructionCandidate['source'] = item.provenance?.kind === 'user' ? 'user' : modelSource;
    const colorEvidence = resolveProductColor(
      item.kind,
      evidence && agrees ? evidence.entry : undefined,
      userColors[item.id],
    );
    const candidate: ReconstructionCandidate = {
      id: item.id,
      kind: item.kind,
      source,
      bounds: { ...item.bounds },
      foot: placement.supportEvidence?.point ??
        item.anchor?.point ?? { x: (item.bounds.left + item.bounds.right) / 2, y: item.bounds.bottom },
      color: colorEvidence.color,
      colorEvidence,
      pixels: evidence?.entry.pixels ?? 0,
      evidence: evidence ? structuredClone(evidence.entry.evidence) : { semanticPixels: 0, meanMargin: 0 },
      installation: {
        mode:
          item.kind === 'showerCurtain'
            ? 'suspended'
            : manualValue && placement.placement
              ? placement.placement.face === 'floor'
                ? 'floor'
                : 'wall'
              : item.mounting === 'floor'
                ? 'floor'
                : item.mounting === 'wall'
                  ? 'wall'
                  : 'unknown',
        wall:
          manualValue && placement.placement?.face !== 'floor'
            ? placement.placement?.face
            : item.wall === 'unknown'
              ? undefined
              : item.wall,
        basinVariant,
        reason: item.evidence.join(' '),
        source:
          manualValue || item.provenance?.mounting === 'user'
            ? 'user'
            : item.provenance?.mounting === 'geometry' || item.provenance?.wall === 'geometry'
              ? 'inferred'
              : 'model',
      },
      status: 'unplaced',
      requiresReview: !placement.placement,
      trace: [
        {
          stage: 'analysis',
          outcome: 'accepted',
          reason: item.evidence.join(' ') || '구조화된 설비 후보예요.',
        },
        {
          stage: 'installation',
          outcome: item.mounting === 'unknown' && !manualValue ? 'held' : 'accepted',
          reason: `설치 ${item.mounting}, 벽 ${item.wall}; ${manualValue && [manualValue.widthMm, manualValue.heightMm, manualValue.depthMm].some((value) => value !== undefined) ? '입력한 규격은 사용자 값이며 비운 규격은 기본값이에요.' : '규격은 모형 기본값이에요.'}`,
        },
      ],
    };
    review.candidates.push(candidate);
    if (placement.placement) {
      const fieldSource = (field: 'kind' | 'mounting' | 'wall' | 'shape' | 'bowlCount') =>
        item.provenance?.[field] === 'user'
          ? ('user' as const)
          : item.provenance?.[field] === 'geometry'
            ? ('inferred' as const)
            : item.provenance?.[field] === 'default'
              ? ('default' as const)
              : ('model' as const);
      const dimensions = {
        widthMm: manualValue?.widthMm ?? defaults.widthMm,
        heightMm: manualValue?.heightMm ?? defaults.heightMm,
        depthMm: manualValue?.depthMm ?? defaults.depthMm,
      };
      const lid =
        item.kind === 'toilet' && evidence && agrees && evidence.overlap >= 0.5
          ? inferToiletLidState(evidence.entry)
          : undefined;
      const independentLid = toiletLidObservation
        ? resolveCandidateToiletLid(
            toiletLidObservation,
            userToiletLidStates[item.id],
            undefined,
            defaults.toiletLidState,
          )
        : undefined;
      const plan = {
        ...defaults,
        ...dimensions,
        kind: item.kind,
        ...placement.placement,
        support: manualValue?.support ? structuredClone(manualValue.support) : undefined,
        ...(manualValue?.bathRim ? { bathRimCandidate: structuredClone(manualValue.bathRim) } : {}),
        ...(manualValue?.partitionTop
          ? { partitionTopCandidate: structuredClone(manualValue.partitionTop) }
          : {}),
        version: 2 as const,
        color: candidate.color,
        colorEvidence: structuredClone(colorEvidence),
        ...(item.kind === 'bath' ? { bathLiningColor: '#eeefeb' } : {}),
        basinVariant,
        pedestalShape:
          item.kind === 'basin' && basinVariant === 'pedestal' ? userPedestalShapes[item.id] : undefined,
        basinShape:
          ['basin', 'vanity'].includes(item.kind) && item.shape !== 'unknown'
            ? item.shape
            : defaults.basinShape,
        bowlCount: ['basin', 'vanity'].includes(item.kind) ? item.bowlCount : undefined,
        toiletLidState:
          item.kind === 'toilet'
            ? (independentLid?.value ?? userToiletLidStates[item.id] ?? lid?.value ?? defaults.toiletLidState)
            : undefined,
        yawDegrees:
          manualValue?.yawDegrees ??
          (placement.placement.face === 'floor'
            ? candidateFloorYaw(item, defaults.yawDegrees)
            : defaults.yawDegrees),
        provenance: {
          kind: fieldSource('kind'),
          mounting: manualValue ? ('user' as const) : fieldSource('mounting'),
          wall: manualValue && manualValue.face !== 'floor' ? ('user' as const) : fieldSource('wall'),
          position: manualValue ? ('user' as const) : ('inferred' as const),
          dimensions: placement.provenance.dimensions,
          width: manualValue?.widthMm === undefined ? ('default' as const) : ('user' as const),
          height: manualValue?.heightMm === undefined ? ('default' as const) : ('user' as const),
          depth: manualValue?.depthMm === undefined ? ('default' as const) : ('user' as const),
          toiletLidState:
            item.kind === 'toilet'
              ? userToiletLidStates[item.id]
                ? ('user' as const)
                : (independentLid?.source ?? lid?.source ?? ('default' as const))
              : undefined,
          shape:
            !['basin', 'vanity'].includes(item.kind) || item.shape === 'unknown'
              ? ('default' as const)
              : fieldSource('shape'),
          bowlCount: item.bowlCount === undefined ? ('default' as const) : fieldSource('bowlCount'),
          pedestalShape:
            item.kind === 'basin' && basinVariant === 'pedestal' && userPedestalShapes[item.id]
              ? ('user' as const)
              : ('default' as const),
          appearance: colorEvidence.source,
          color: colorEvidence.source,
          ...(item.kind === 'bath' ? { bathLiningColor: 'default' as const } : {}),
        },
      };
      // User-added fixtures have no observed photo bounds; their form uses a full-frame placeholder.
      // Keep the original model box when correcting an existing candidate's position or shape.
      const observedBounds = automaticUnderstanding.candidates.find(
        (original) => original.id === item.id,
      )?.bounds;
      const check = validateSourceFixture(
        room,
        camera.camera,
        bathSupport ? { ...plan, support: bathSupport } : plan,
        camera.camera && !manualValue?.bathRim && !manualValue?.partitionTop ? observedBounds : undefined,
      );
      pipeline.modelChecks.push({
        candidateId: item.id,
        source: camera.camera ? 'source-camera' : 'room-only',
        proposedPlacement: structuredClone(plan),
        result: check,
      });
      if (!check.valid) hold(placement, check.reasons.join(' '));
      else plans[item.id] = plan;
    }
    const linkStatus = pipeline.userBathRimLinks?.find((entry) => entry.candidateId === item.id);
    if (linkStatus && !plans[item.id]) {
      linkStatus.status = 'held';
      linkStatus.reason = placement.reasons.join(' ');
      delete linkStatus.derivedHeightMm;
    }
    candidate.requiresReview =
      !placement.placement && !['duplicate', 'component', 'reflection'].includes(resolved.disposition);
    if (['duplicate', 'component', 'reflection'].includes(resolved.disposition)) candidate.status = 'ignored';
    candidate.warning = [...new Set([...item.uncertainty, ...placement.reasons])].join(' ');
    candidate.trace!.push({
      stage: 'placement',
      outcome: placement.placement ? 'accepted' : 'held',
      reason: candidate.warning || '관측 좌표를 공간으로 역투영했어요.',
    });
  }
  for (const candidate of baseline.candidates) {
    if (!understanding.candidates.some((item) => boxIoU(item.bounds, candidate.bounds) >= 0.25))
      pipeline.warnings.push(
        `기존 분석의 ${reconstructionLabels[candidate.kind]} 후보(${candidate.id})에 대응하는 새 후보가 없어요. 기존 후보 원본은 보존돼요.`,
      );
  }
  review.warnings = [
    ...new Set([
      ...baseline.warnings,
      ...pipeline.warnings,
      '제품 크기·가림·촬영 시점은 사진의 관측 범위에 한정된 추정이며, 실제 치수는 확인되지 않았어요.',
    ]),
  ];
  pipeline.userColors = structuredClone(userColors);
  pipeline.userPedestalShapes = structuredClone(userPedestalShapes);
  return { review, plans, pipeline };
}
