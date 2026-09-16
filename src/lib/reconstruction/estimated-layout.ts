import { estimatedSizeFactors } from './estimated-size-prior';
import { canonicalTargetValue } from './target-existence-observation';
import { SHOWER_INSTALLATION_DECISION_REVISION, type ShowerInstallationDecision } from './shower-installation-observation';
import type { DividerApplication } from './divider-application';
import { curtainHangingOffset } from './curtain-model';
import { assessCameraRanking, type CameraRankingAssessment } from './camera-ranking';
import { type ShowerObservation } from './shower-observation';
import { decideObservedShowerModel, type ObservedShowerModelDecision } from './shower-model-observation';
import { showerObservedCorners } from './shower-layout-evidence';
import { inspectObservedBasinRegion, type ObservedBasinRegion } from './observed-basin-region';
import {
  inspectEstimatedDepthRelations,
  type EstimatedDepthRelationEvidence,
} from './estimated-depth-relation-evidence';
import { PerspectiveCamera, Vector3 } from 'three';
import {
  buildEstimatedDepthWallEvidence,
  estimatedDepthWallOrientation,
  type EstimatedDepthWallInput,
  type EstimatedDepthWallEvidence,
} from './estimated-plane-evidence';
import {
  inspectEstimatedPhotoRelations,
  type EstimatedPhotoRelationConsistency,
} from './estimated-relation-evidence';
import {
  buildEstimatedCameraDirections,
  type EstimatedCameraDirectionResult,
  type EstimatedCameraDirection,
} from './estimated-camera-directions';
import { estimateAssemblyObservationBounds, type EstimatedAssemblyBounds } from './estimated-assembly-bounds';
import { observedBasinComponent, PROMOTED_BASIN_COMPONENT_REASON } from './observed-basin-component';
import { openCounterDefaults, showerVariantDefaults } from './fixture-variants';
import { candidateBoxIoU } from './candidate-resolution';
import {
  DEFAULT_CANDIDATE_TOILET_LID_POLICY,
  inspectCandidateToiletLid,
  resolveCandidateToiletLid,
  type CandidateToiletLidPolicy,
  type CandidateToiletLidDiagnostic,
} from './candidate-toilet-lid';
import type { ParsedFixtureAppearance, FixtureAppearanceOptions } from './fixture-appearance-observation';
import type { RoomDefinition, RoomFace } from '../room-types';
import type { ProductBounds } from '../room-types';
import type { CandidateFixturePlan, buildCandidatePipeline } from './candidate-pipeline';
import type { SceneCandidate, SceneUnderstanding } from './pipeline-contract';
import { reconstructionModelTransform } from './projection';
import {
  createSourceCamera,
  validateSourceFixture,
  type SourceCamera,
  type SourceFixtureCheck,
} from './source-camera';
import { reconstructionDefaults, type ReconstructionReview } from './types';
import { placementFromWallReference } from './wall-relative-placement';
import {
  resolveCandidateBathRim,
  resolveCandidatePartitionTop,
  type CandidateBathRim,
  type CandidatePartitionTop,
} from './candidate-bath-rim';

export const ESTIMATED_LAYOUT_REVISION = 'visible-relation-layout-v13-inconclusive-direction-hold';
type StrictResult = ReturnType<typeof buildCandidatePipeline>;
type Wall = Exclude<RoomFace, 'floor'>;
export type LayoutFieldSource = 'model-observed' | 'geometry-derived' | 'estimated' | 'default' | 'user';
export type LayoutObservationInput = {
  observations: {
    id: string;
    wall: Wall | 'unknown';
    orientation?: 'toward-camera' | 'toward-left' | 'toward-right' | 'unknown';
    note?: string;
  }[];
  relations: {
    fromId: string;
    toId: string;
    type:
      | 'leftOf'
      | 'rightOf'
      | 'inFrontOf'
      | 'behind'
      | 'above'
      | 'below'
      | 'supportedBy'
      | 'attachedTo'
      | 'visibleThrough';
    note?: string;
  }[];
};
export type EstimatedProposalSearch = {
  /** Rank by image/size/support score before considering other fixtures. One-based. */
  unaryRank: number;
  projectableProposalCount: number;
};
export type EstimatedLayoutNode = {
  candidateId: string;
  status: 'placed-estimate' | 'kept-observed' | 'held' | 'excluded';
  observed: SceneCandidate;
  basinRegion?: ObservedBasinRegion;
  toiletLidObservation?: CandidateToiletLidDiagnostic;
  showerModelDecision?: ObservedShowerModelDecision;
  selected?: {
    plan: CandidateFixturePlan;
    sources: Record<
      'kind' | 'mounting' | 'wall' | 'position' | 'yaw' | 'width' | 'height' | 'depth',
      LayoutFieldSource
    >;
    anchorRole: 'floor-footprint-centre' | 'wall-rear-bottom' | 'suspension-support-centre';
    hangingAnchorMm?: [number, number, number];
    reasons: string[];
    physicalCheck: SourceFixtureCheck;
    scoreTerms: Record<string, number>;
    proposalSearch?: EstimatedProposalSearch;
    sceneChecks?: { otherCandidateId: string; collision: boolean; relationPenalty: number }[];
  };
  alternatives: { plan: CandidateFixturePlan; score: number; reasons: string[]; rejectedBy: string[] }[];
  observationChecks?: {
    field: 'wall' | 'orientation';
    observed: string;
    selected: string;
    status: 'agrees' | 'conflicts';
    reason: string;
  }[];
  reasons: string[];
};
export type EstimatedLayout = {
  toiletLidPolicy?: CandidateToiletLidPolicy;
  version: 1;
  revision: typeof ESTIMATED_LAYOUT_REVISION;
  observationIds: string[];
  camera: { source: 'observed-fit' | 'layout-hypothesis'; value?: SourceCamera; reasons: string[] };
  nodes: EstimatedLayoutNode[];
  cameraSearch: 'compact' | 'expanded-v1';
  cameraRankingPolicy?: 'joint-score' | 'kind-conflict-image-hold-v1';
  cameraRanking?: CameraRankingAssessment;
  appearance?: Pick<ParsedFixtureAppearance, 'modelOptions' | 'duplicates' | 'decisions'>;
  showerDetails?: readonly ShowerObservation[];
  showerInstallationDecisions?: readonly ShowerInstallationDecision[];
  dividerApplication?: Pick<DividerApplication, 'revision' | 'decisions' | 'modelOptions'>;
  depthWallEvidence?: EstimatedDepthWallEvidence;
  photoRelationPolicy: 'checked' | 'raw-experiment';
  relationConsistency?: EstimatedPhotoRelationConsistency;
  depthRelationPolicy?: 'hold-unverified' | 'legacy-model-prior';
  depthRelationEvidence?: EstimatedDepthRelationEvidence;
  basinRegionPolicy?: 'pixel-aspect' | 'legacy-normalized';
  cameraDirectionObservation?: Omit<EstimatedCameraDirectionResult, 'hypotheses'>;
  hypotheses: {
    id: string;
    score: number;
    cameraRankingScore?: number;
    placedCount: number;
    cameraSource: 'observed-fit' | 'layout-hypothesis';
    camera: SourceCamera;
    directionEvidence?: Omit<EstimatedCameraDirection, 'camera'>;
    scoreTerms: Record<string, number>;
    heldCandidateIds: string[];
    projectionAvailability: {
      candidateId: string;
      physicalProposalCount: number;
      projectableProposalCount: number;
    }[];
  }[];
  relations: LayoutObservationInput['relations'];
  assemblyBoundsPolicy: 'combined' | 'parent-only-experiment';
  assemblies: {
    parentId: string;
    componentIds: string[];
    source: 'model-observed';
    reasons: string[];
    observationBounds?: EstimatedAssemblyBounds;
  }[];
  warnings: string[];
};
export type EstimatedCandidatePipelineInput = {
  toiletLidPolicy?: CandidateToiletLidPolicy;
  strictResult: StrictResult;
  understanding: SceneUnderstanding;
  baseline: ReconstructionReview;
  room: RoomDefinition;
  image: { width: number; height: number };
  manualIdSet?: ReadonlySet<string>;
  layoutObservation?: LayoutObservationInput;
  appearance?: Pick<ParsedFixtureAppearance, 'modelOptions' | 'duplicates' | 'decisions'>;
  showerDetails?: readonly ShowerObservation[];
  showerInstallationDecisions?: readonly ShowerInstallationDecision[];
  dividerApplication?: Pick<DividerApplication, 'revision' | 'decisions' | 'modelOptions'>;
  /** Parent-only bounds are retained only for isolated historical scoring experiments. */
  assemblyBoundsPolicy?: 'combined' | 'parent-only-experiment';
  /** Raw relations are retained only for controlled baseline experiments. */
  photoRelationPolicy?: 'checked' | 'raw-experiment';
  /** Depth hold remains an unadopted trial; normalized basin units are a historical control only. */
  depthRelationPolicy?: 'hold-unverified' | 'legacy-model-prior';
  basinRegionPolicy?: 'pixel-aspect' | 'legacy-normalized';
  /** Optional independent model-plane evidence; strict camera failures remain unchanged. */
  depthWallEvidence?: EstimatedDepthWallInput;
  /** Experimental: orientation/FOV from planes, translation from the unchanged prior positions. */
  cameraDirectionEvidence?: EstimatedDepthWallInput;
  /** Evaluation only: changes source-view hypotheses, never room or product dimensions. */
  cameraSearch?: 'compact' | 'expanded-v1';
  /** Camera reliability affects ranking only; joint-score remains an explicit historical control. */
  cameraRankingPolicy?: 'joint-score' | 'kind-conflict-image-hold-v1';
  /** Optional experimental dimension prior; [1] keeps every candidate at its nominal size. */
  sizeFactors?: readonly number[];
  /** Pure opt-in room-structure score, never a source of model observations. */
  cameraPenalty?: (camera: SourceCamera) => number;
};
type Box = NonNullable<SourceFixtureCheck['worldBoundsMm']>;
type Proposal = {
  candidate: SceneCandidate;
  plan: CandidateFixturePlan;
  check: SourceFixtureCheck;
  box: Box;
  corners: Vector3[];
  wall: Wall;
  prior: number;
  reasons: string[];
  strict: boolean;
};
type Scored = Proposal & {
  score: number;
  projected: ProductBounds;
  terms: Record<string, number>;
  proposalSearch?: EstimatedProposalSearch;
};
type CameraHypothesis = {
  id: string;
  source: 'observed-fit' | 'layout-hypothesis';
  camera: PerspectiveCamera;
  serialized: SourceCamera;
  prior: number;
  directionEvidence?: Omit<EstimatedCameraDirection, 'camera'>;
};
const WALLS: Wall[] = ['back', 'left', 'right'];
const sq = (value: number) => value * value;
const centre = (b: ProductBounds) => ({ x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2 });
const span = (b: ProductBounds) => ({ width: b.right - b.left, height: b.bottom - b.top });
const finiteBounds = (b: ProductBounds) =>
  [b.left, b.top, b.right, b.bottom].every(Number.isFinite) &&
  b.left >= 0 &&
  b.top >= 0 &&
  b.right <= 1 &&
  b.bottom <= 1 &&
  b.right > b.left &&
  b.bottom > b.top;

function cameras(
  input: EstimatedCandidatePipelineInput,
  directionLog?: { value?: EstimatedCameraDirectionResult },
): CameraHypothesis[] {
  const { room, image } = input;
  const result: CameraHypothesis[] = [];
  const observed = input.strictResult.pipeline.camera.camera;
  if (observed)
    result.push({
      id: 'observed-source-camera',
      source: 'observed-fit',
      camera: createSourceCamera(observed),
      serialized: structuredClone(observed),
      prior: 0,
    });
  // These are camera priors for comparing layout hypotheses, never observed room corners or a
  // replacement for the editor's common display camera. No image-specific coordinates enter here.
  for (const yaw of [-22, 0, 22])
    for (const tilt of [0.18, 0.38]) {
      const camera = new PerspectiveCamera(65, image.width / image.height, 1, 100000);
      const eyeHeight = room.heightMm * 0.62;
      camera.position.set(
        -Math.sin((yaw * Math.PI) / 180) * room.widthMm * 0.28,
        eyeHeight,
        room.depthMm * 1.18,
      );
      camera.lookAt(Math.sin((yaw * Math.PI) / 180) * room.widthMm * 0.32, room.heightMm * tilt, 0);
      camera.updateMatrixWorld(true);
      const serialized: SourceCamera = {
        version: 1,
        positionMm: camera.position.toArray() as [number, number, number],
        quaternion: camera.quaternion.toArray() as [number, number, number, number],
        verticalFovDegrees: camera.fov,
        image: { ...image },
      };
      result.push({
        id: `layout-camera-yaw-${yaw}-target-${tilt}`,
        source: 'layout-hypothesis',
        camera,
        serialized,
        prior: observed ? 0.1 : 0,
      });
    }
  if (input.cameraSearch === 'expanded-v1') {
    // A controlled source-camera experiment. Compact hypotheses keep their identical scores.
    // These FOV/distance priors are not measurements or a change to the common display camera.
    for (const distance of [0.72, 1, 1.55, 2.1])
      for (const fov of [45, 65, 85])
        for (const yaw of [-35, 0, 35])
          for (const tilt of [0.18, 0.38]) {
            const camera = new PerspectiveCamera(fov, image.width / image.height, 1, 100000);
            camera.position.set(
              -Math.sin((yaw * Math.PI) / 180) * room.widthMm * 0.28,
              room.heightMm * 0.62,
              room.depthMm * distance,
            );
            camera.lookAt(Math.sin((yaw * Math.PI) / 180) * room.widthMm * 0.32, room.heightMm * tilt, 0);
            camera.updateMatrixWorld(true);
            result.push({
              id: `expanded-camera-distance-${distance}-fov-${fov}-yaw-${yaw}-target-${tilt}`,
              source: 'layout-hypothesis',
              camera,
              serialized: {
                version: 1,
                positionMm: camera.position.toArray() as [number, number, number],
                quaternion: camera.quaternion.toArray() as [number, number, number, number],
                verticalFovDegrees: fov,
                image: { ...image },
              },
              prior: observed ? 0.1 : 0,
            });
          }
  }
  if (input.cameraDirectionEvidence) {
    const directions = buildEstimatedCameraDirections(
      input.cameraDirectionEvidence,
      image,
      result.map((h) => h.serialized.positionMm),
    );
    if (directionLog) directionLog.value = directions;
    for (const entry of directions.hypotheses) {
      const { camera, ...directionEvidence } = entry;
      result.push({
        id: entry.id,
        source: 'layout-hypothesis',
        camera: createSourceCamera(camera),
        serialized: camera,
        prior: observed ? 0.1 : 0,
        directionEvidence,
      });
    }
  }
  return result;
}

function mounting(item: SceneCandidate): 'floor' | 'wall' | 'suspended' | undefined {
  if (item.kind === 'showerCurtain') return 'suspended';
  if (['toilet', 'bath', 'glassPartition', 'lowPartition'].includes(item.kind)) return 'floor';
  if (['mirror', 'mirrorCabinet', 'wallShelf', 'window', 'door', 'wallCabinet', 'shower'].includes(item.kind))
    return 'wall';
  if (item.kind === 'basin') {
    if (item.basinStyle === 'wall') return 'wall';
    if (item.basinStyle === 'pedestal') return 'floor';
    if (item.basinStyle === 'vanity') return item.mounting === 'wall' ? 'wall' : 'floor';
    // Unknown support is not permission to invent a pedestal or cabinet.
    return undefined;
  }
  if (item.kind === 'vanity') return item.mounting === 'wall' ? 'wall' : 'floor';
  return undefined;
}
function heights(item: SceneCandidate, defaults: ReturnType<typeof reconstructionDefaults>): number[] {
  if ('showerVariant' in defaults && defaults.showerVariant) {
    const base = defaults.baseHeightMm ?? 750;
    return [base, Math.max(0, base - 150), base + 150];
  }
  if (defaults.vanityStyle === 'open-counter') return [defaults.baseHeightMm ?? 650, 550, 750];
  if (item.kind === 'door') return [0];
  if (item.kind === 'basin') return [defaults.baseHeightMm ?? 650, 500, 800];
  if (item.kind === 'vanity') return [250, 450];
  if (item.kind === 'wallShelf') return [850, 1100, 1400, 1700, 1950];
  return [defaults.baseHeightMm ?? 1200, 850, 1050, 1400, 1600];
}

function proposal(
  input: Pick<EstimatedCandidatePipelineInput, 'room' | 'image' | 'basinRegionPolicy'>,
  item: SceneCandidate,
  plan: CandidateFixturePlan,
  wall: Wall,
  prior: number,
  strict = false,
  showerPart?: ShowerObservation['observedPart'],
): Proposal | undefined {
  const { room } = input;
  const physicalPlan = { ...plan, widthMm: plan.widthMm!, heightMm: plan.heightMm!, depthMm: plan.depthMm! };
  const check = validateSourceFixture(room, undefined, physicalPlan);
  if (!check.valid || !check.worldBoundsMm) return undefined;
  const transform = reconstructionModelTransform(room, physicalPlan);
  const corners: Vector3[] = [];
  // A bowl-only observation of a pedestal sink must be compared with the bowl portion,
  // not mistaken for the lower contact or the full-height model.
  const imageSpan = span(item.bounds);
  const bowlOnly =
    input.basinRegionPolicy !== 'legacy-normalized'
      ? inspectObservedBasinRegion(item, input.image).bowlOnly
      : item.kind === 'basin' && item.basinStyle === 'pedestal' && imageSpan.height / imageSpan.width < 0.65;
  const partCorners = showerPart ? showerObservedCorners(room, plan, showerPart) : undefined;
  if (showerPart && showerPart !== 'whole-kit' && !partCorners) return undefined;
  if (partCorners) {
    for (const point of partCorners)
      corners.push(point.applyAxisAngle(new Vector3(0, 1, 0), transform.angle).add(transform.origin));
  } else
    for (const x of [-plan.widthMm! / 2, plan.widthMm! / 2])
      for (const y of [bowlOnly ? plan.heightMm! * 0.72 : 0, plan.heightMm!])
        for (const z of [-plan.depthMm! / 2, plan.depthMm! / 2])
          corners.push(
            new Vector3(x, y, z).applyAxisAngle(new Vector3(0, 1, 0), transform.angle).add(transform.origin),
          );
  return {
    candidate: item,
    plan,
    check,
    box: check.worldBoundsMm,
    corners,
    wall,
    prior,
    strict,
    reasons: [
      strict
        ? '기존 관측 배치를 독립 가설로 보존했어요.'
        : '관측된 설비의 사진 영역과 설치 제약에 맞는 배치 가설이에요. 실측 위치가 아니에요.',
      ...(item.kind === 'showerCurtain'
        ? [
            '매달린 천 모형이에요. 하단은 바닥 접점이 아니며 걸이 높이·하드웨어와 전체 규격은 확인 가능한 기본값·추정값이에요.',
          ]
        : []),
      ...(partCorners
        ? [
            '사진에서 관측한 ' +
              showerPart +
              ' 부위만 모형의 실제 정점 범위와 비교했어요. 전체 규격과 보이지 않는 기본 부품은 관측치가 아니에요.',
          ]
        : []),
      ...(bowlOnly
        ? [
            '사진 영역의 비율로 세면볼 부분을 추정하여 모형 상단과 비교했어요. 실제 부위 관측이나 기둥 접지점 확인은 아니에요.',
          ]
        : []),
    ],
  };
}

function observedAppearance(
  input: EstimatedCandidatePipelineInput,
  item: SceneCandidate,
): FixtureAppearanceOptions {
  if (input.manualIdSet?.has(item.id)) return {};
  const supplied = input.appearance?.modelOptions[item.id];
  const decision = input.appearance?.decisions.find((entry) => entry.candidateId === item.id);
  const existing = input.strictResult.plans[item.id];
  const isPedestal = item.kind === 'basin' && item.basinStyle === 'pedestal';
  // A strict placement may be held, so its absent plan cannot erase an explicit user choice.
  const userPedestalShape = isPedestal
    ? input.strictResult.pipeline.userPedestalShapes?.[item.id] ??
      (existing?.provenance?.pedestalShape === 'user' ? existing.pedestalShape : undefined)
    : undefined;
  if ((!supplied || decision?.status === 'held') && !userPedestalShape) return {};
  const options: FixtureAppearanceOptions =
    supplied && decision?.status !== 'held' ? structuredClone(supplied) : {};
  // Explicit model-option edits win over a later automatic observation, field by field.
  for (const field of ['mirrorShape', 'vanityStyle', 'counterSupport', 'showerVariant'] as const)
    if (existing?.provenance?.[field] === 'user') {
      Object.assign(options, { [field]: existing[field] });
      options.provenance = { ...options.provenance, [field]: 'user' };
    }
  if (userPedestalShape) {
    options.pedestalShape = userPedestalShape;
    options.provenance = { ...options.provenance, pedestalShape: 'user' };
  }
  if (!isPedestal) {
    delete options.pedestalShape;
    delete options.provenance?.pedestalShape;
  }
  if (item.kind !== 'mirror') {
    delete options.mirrorShape;
    delete options.provenance?.mirrorShape;
  }
  if (item.kind !== 'vanity' && !(item.kind === 'basin' && item.basinStyle === 'vanity')) {
    delete options.vanityStyle;
    delete options.counterSupport;
    delete options.provenance?.vanityStyle;
    delete options.provenance?.counterSupport;
  }
  if (options.vanityStyle !== 'open-counter') {
    delete options.counterSupport;
    delete options.provenance?.counterSupport;
  }
  return options;
}

function independentToiletLid(input: EstimatedCandidatePipelineInput, item: SceneCandidate) {
  if (input.toiletLidPolicy !== 'independent-semantic-v1' || item.kind !== 'toilet') return undefined;
  const pipeline = input.strictResult.pipeline;
  // Recompute from current invocation data; an old saved diagnostic with the same ID is not evidence.
  const diagnostic = inspectCandidateToiletLid({
    candidate: item,
    canonicalCandidate: pipeline.understanding.candidates.find((candidate) => candidate.id === item.id),
    baselineCandidates: pipeline.baselineReview.candidates,
    resolution: pipeline.resolution,
    relations: pipeline.understanding.relations,
  });
  const choice = resolveCandidateToiletLid(
    diagnostic,
    pipeline.userToiletLidStates?.[item.id],
    input.strictResult.plans[item.id] ?? undefined,
  );
  return {
    diagnostic,
    options: { toiletLidState: choice.value, provenance: { toiletLidState: choice.source } },
  };
}

function observedShowerModel(input: EstimatedCandidatePipelineInput, item: SceneCandidate) {
  const detail = input.showerDetails?.find((entry) => entry.id === item.id);
  if (item.kind !== 'shower' || !detail) return undefined;
  return decideObservedShowerModel({
    candidate: item, detail,
    installation: input.showerInstallationDecisions?.find((entry) => entry.candidateId === item.id),
    protectedByUser: input.manualIdSet?.has(item.id),
    existingOptions: input.strictResult.plans[item.id] ?? undefined,
  });
}

function proposals(input: EstimatedCandidatePipelineInput, item: SceneCandidate): Proposal[] {
  if (item.kind === 'unknown') return [];
  const observed = observedAppearance(input, item);
  const lid = independentToiletLid(input, item);
  const appearance = {
    ...observed,
    ...lid?.options,
    ...(lid ? { provenance: { ...observed.provenance, ...lid.options.provenance } } : {}),
    ...(item.kind === 'showerCurtain' && !input.manualIdSet?.has(item.id)
      ? input.dividerApplication?.modelOptions[item.id]
      : {}),
  };
  const showerDecision = observedShowerModel(input, item);
  const shower = showerDecision?.action === 'apply' ? showerDecision : undefined;
  if (shower?.variant) {
    appearance.showerVariant = shower.variant;
    appearance.provenance = { ...appearance.provenance, showerVariant: shower.variantSource };
  }
  const mode =
    appearance.vanityStyle === 'open-counter'
      ? (appearance.counterSupport ?? 'wall') === 'wall'
        ? 'wall'
        : 'floor'
      : mounting(item);
  if (!mode) return [];
  const { room } = input;
  const defaults = {
    ...reconstructionDefaults(item.kind, item.basinStyle === 'unknown' ? undefined : item.basinStyle),
    ...(appearance.vanityStyle === 'open-counter'
      ? openCounterDefaults(appearance.counterSupport ?? 'wall')
      : {}),
    ...(appearance.showerVariant ? showerVariantDefaults(appearance.showerVariant) : {}),
  };
  const previous = input.strictResult.plans[item.id];
  // An enclosing cabinet's old envelope is not a measurement of a newly observed floating counter.
  const existing =
    previous &&
    previous.kind === item.kind &&
    (!shower || previous.showerVariant === shower.variant) &&
    !(appearance.vanityStyle === 'open-counter' && previous.vanityStyle !== 'open-counter')
      ? Object.keys(appearance).length
        ? { ...previous, ...appearance, provenance: { ...previous.provenance, ...appearance.provenance } }
        : previous
      : undefined;
  const result: Proposal[] = [];
  const nominalOnly = input.sizeFactors?.length === 1 && input.sizeFactors[0] === 1;
  const existingHasNominalDimensions =
    existing &&
    ['widthMm', 'heightMm', 'depthMm'].every(
      (name) => existing[name as 'widthMm'] === defaults[name as 'widthMm'],
    );
  if (existing && (!nominalOnly || existingHasNominalDimensions)) {
    const original = proposal(
      input,
      item,
      existing,
      existing.face === 'floor' ? (item.wall === 'unknown' ? 'back' : item.wall) : existing.face,
      0,
      true,
      shower?.projectionPart,
    );
    if (original) result.push(original);
  }
  if (input.manualIdSet?.has(item.id) || (item.kind === 'shower' &&
      (Object.values(item.provenance ?? {}).includes('user') ||
       Object.values(previous?.provenance ?? {}).includes('user')))) return result;
  const layoutObservation = input.layoutObservation?.observations.find((entry) => entry.id === item.id);
  const layoutWall = layoutObservation?.wall;
  const knownWall =
    item.wall !== 'unknown' ? item.wall : layoutWall && layoutWall !== 'unknown' ? layoutWall : undefined;
  // Model wall labels confuse photo left/right with the supporting wall. Only user-confirmed walls are hard.
  const walls = knownWall && item.provenance?.wall === 'user' ? [knownWall] : WALLS;
  const oldReview = input.strictResult.review.candidates.find((candidate) => candidate.id === item.id);
  // Alternative dimensions come from a documented general product-size prior, not shrink-to-fit.
  // Thin glass and shelves keep their thickness; their span may vary within the same prior.
  for (const size of estimatedSizeFactors(item.kind, input.sizeFactors)) {
    const widthMm = defaults.widthMm * size;
    const heightMm = ['door', 'glassPartition', 'showerCurtain'].includes(item.kind)
      ? defaults.heightMm
      : defaults.heightMm * size;
    const depthMm = [
      'mirror',
      'mirrorCabinet',
      'wallShelf',
      'window',
      'door',
      'glassPartition',
      'showerCurtain',
    ].includes(item.kind)
      ? defaults.depthMm
      : defaults.depthMm * size;
    const base: CandidateFixturePlan = {
      ...defaults,
      ...appearance,
      kind: item.kind,
      version: 2,
      placementPolicy: 'preserve',
      widthMm,
      heightMm,
      depthMm,
      face: mode === 'wall' ? 'back' : 'floor',
      u: 0.5,
      v: 0.5,
      color: oldReview?.color ?? defaults.color,
      ...(item.kind === 'bath' ? { bathLiningColor: '#eeefeb' } : {}),
      colorEvidence: oldReview?.colorEvidence,
      basinVariant:
        item.kind === 'basin' && item.basinStyle !== 'unknown' ? item.basinStyle : defaults.basinVariant,
      basinShape: item.shape === 'unknown' ? defaults.basinShape : item.shape,
      bowlCount: item.bowlCount ?? defaults.bowlCount,
      provenance: {
        kind: item.provenance?.kind === 'user' ? 'user' : 'model',
        mounting: item.mounting === 'unknown' ? 'inferred' : 'model',
        wall: knownWall ? 'model' : 'inferred',
        position: 'inferred',
        dimensions: size === 1 ? 'default' : 'inferred',
        width: size === 1 ? 'default' : 'inferred',
        height: size === 1 ? 'default' : 'inferred',
        depth: size === 1 ? 'default' : 'inferred',
        shape: item.shape === 'unknown' ? 'default' : 'model',
        bowlCount: item.bowlCount === undefined ? 'default' :
          item.provenance?.bowlCount === 'geometry' ? 'inferred' :
          (item.provenance?.bowlCount ?? 'model'),
        ...(item.kind === 'bath' ? { bathLiningColor: 'default' as const } : {}),
        ...appearance.provenance,
        ...(item.kind === 'showerCurtain' && item.provenance?.mounting === 'geometry'
          ? { mounting: 'inferred' as const }
          : {}),
      },
    };
    const append = (plan: CandidateFixturePlan, wall: Wall, penalty = 0) => {
      const reportedYaw =
        layoutObservation?.orientation === 'toward-camera'
          ? 0
          : layoutObservation?.orientation === 'toward-left'
            ? -90
            : layoutObservation?.orientation === 'toward-right'
              ? 90
              : undefined;
      const modelWallPenalty = knownWall && knownWall !== wall ? 0.16 : 0;
      const modelOrientationPenalty =
        reportedYaw !== undefined &&
        mode === 'floor' &&
        item.kind !== 'glassPartition' &&
        Math.abs((plan.yawDegrees ?? 0) - reportedYaw) > 1
          ? 0.16
          : 0;
      const effectivePlan = {
        ...plan,
        provenance: {
          ...plan.provenance,
          wall: knownWall === wall ? ('model' as const) : ('inferred' as const),
        },
      };
      const option = proposal(
        input,
        item,
        effectivePlan,
        wall,
        Math.abs(Math.log(size)) * 0.25 + penalty + modelWallPenalty + modelOrientationPenalty,
        false,
        shower?.projectionPart,
      );
      if (option && modelWallPenalty)
        option.reasons.push(
          '모델 설치 벽 ' + knownWall + '와 다른 ' + wall + ' 가설도 사진·물리 근거로 비교했어요.',
        );
      if (option) result.push(option);
    };
    if (item.kind === 'glassPartition' || item.kind === 'showerCurtain') {
      const bottomHeights = item.kind === 'showerCurtain' ? [0, 50, 100, 200] : [0];
      for (const baseHeightMm of bottomHeights)
        for (const yawDegrees of [0, 90])
          for (let ix = 0; ix <= 8; ix++)
            for (let iz = 0; iz <= 8; iz++) {
              const halfX = (yawDegrees === 90 ? depthMm : widthMm) / 2;
              const halfZ = (yawDegrees === 90 ? widthMm : depthMm) / 2;
              if (halfX * 2 > room.widthMm || halfZ * 2 > room.depthMm) continue;
              append(
                {
                  ...base,
                  face: 'floor',
                  baseHeightMm,
                  u: (halfX + (ix / 8) * (room.widthMm - 2 * halfX)) / room.widthMm,
                  v: (halfZ + (iz / 8) * (room.depthMm - 2 * halfZ)) / room.depthMm,
                  yawDegrees,
                },
                'back',
              );
            }
      continue;
    }
    for (const wall of walls) {
      const length = wall === 'back' ? room.widthMm : room.depthMm;
      if (widthMm > length) continue;
      for (let step = 0; step <= 12; step++) {
        const alongMm = widthMm / 2 + (step / 12) * (length - widthMm);
        if (mode === 'floor') {
          const roomAcross = wall === 'back' ? room.depthMm : room.widthMm;
          for (const clearance of [0, 0.18, 0.38]) {
            const clearanceMm = Math.max(0, roomAcross - depthMm) * clearance;
            const floor = placementFromWallReference(room, { wall, alongMm, clearanceMm }, depthMm);
            append({ ...base, ...floor }, wall, clearance * 0.12);
          }
        } else
          for (const baseHeightMm of heights(item, defaults)) {
            const u =
              wall === 'left'
                ? 1 - alongMm / room.depthMm
                : wall === 'right'
                  ? alongMm / room.depthMm
                  : alongMm / room.widthMm;
            append(
              {
                ...base,
                face: wall,
                u,
                v: 1 - baseHeightMm / room.heightMm,
                baseHeightMm,
                yawDegrees: undefined,
              },
              wall,
            );
          }
      }
    }
  }
  return result;
}

/** Generate elevated panes only from a recorded support relation, or from a recorded see-through
 * relation plus an independent lower-edge/upper-support photo cue. The latter remains a hypothesis. */
function supportedGlassChoices(
  input: EstimatedCandidatePipelineInput,
  item: SceneCandidate,
  parents: Scored[],
): Proposal[] {
  if (item.kind !== 'glassPartition' || input.manualIdSet?.has(item.id)) return [];
  const defaults = reconstructionDefaults('glassPartition');
  const result: Proposal[] = [];
  for (const relation of input.layoutObservation?.relations ?? []) {
    if (relation.fromId !== item.id || !['supportedBy', 'visibleThrough'].includes(relation.type)) continue;
    const parent = parents.find((option) => option.candidate.id === relation.toId);
    if (!parent || !['bath', 'lowPartition'].includes(parent.candidate.kind)) continue;
    const bounds = parent.candidate.bounds;
    const overlap = Math.min(item.bounds.right, bounds.right) - Math.max(item.bounds.left, bounds.left);
    const lowerMeetsUpper =
      overlap > 0 &&
      item.bounds.bottom >= bounds.top - (bounds.bottom - bounds.top) * 0.15 &&
      item.bounds.bottom <= bounds.top + (bounds.bottom - bounds.top) * 0.65;
    if (relation.type !== 'supportedBy' && !lowerMeetsUpper) continue;
    const evidence = [
      relation.note || '관측된 ' + relation.type + ' 관계: ' + item.id + ' → ' + parent.candidate.id,
      relation.type === 'supportedBy'
        ? '모델 지지 관계를 실제 표준 모형 상단과 교차검사한 추정 위치예요.'
        : '투과 관계와 사진 속 유리 하단·부모 상단의 위치 단서를 이용한 지지 가설이며, 실제 접합을 확정한 관측은 아니에요.',
    ];
    const oldReview = input.strictResult.review.candidates.find((candidate) => candidate.id === item.id);
    for (const widthMm of (input.sizeFactors ?? [0.85, 1, 1.15]).map((size) => defaults.widthMm * size)) {
      const supportHeights =
        input.sizeFactors?.length === 1 && input.sizeFactors[0] === 1
          ? [defaults.heightMm]
          : [600, 900, 1200, 1500, 1800];
      for (const heightMm of supportHeights) {
        const child: CandidateFixturePlan = {
          ...defaults,
          kind: 'glassPartition',
          version: 2,
          placementPolicy: 'preserve',
          face: 'floor',
          u: 0.5,
          v: 0.5,
          baseHeightMm: 0,
          widthMm,
          heightMm,
          color: oldReview?.color ?? defaults.color,
          provenance: {
            kind: 'model',
            mounting: 'inferred',
            position: 'inferred',
            dimensions: 'inferred',
            width: widthMm === defaults.widthMm ? 'default' : 'inferred',
            height: 'inferred',
            depth: 'default',
          },
        };
        const addResolved = (plan: CandidateFixturePlan) => {
          const value = proposal(
            input,
            item,
            plan,
            parent.wall,
            Math.abs(Math.log(heightMm / defaults.heightMm)) * 0.04,
          );
          if (value) {
            value.reasons.push(...evidence);
            result.push(value);
          }
        };
        if (parent.candidate.kind === 'bath') {
          for (const side of ['front', 'back', 'left', 'right'] as const)
            for (const offsetMm of [0, -widthMm / 4, widthMm / 4]) {
              const link: CandidateBathRim = {
                parentCandidateId: parent.candidate.id,
                side,
                offsetMm,
                provenance: { parent: 'inferred', side: 'inferred', offset: 'inferred' },
                evidence,
              };
              const resolved = resolveCandidateBathRim(input.room, link, parent.plan, child);
              if (resolved.status === 'attached')
                addResolved({
                  ...child,
                  ...resolved.placement,
                  kind: 'glassPartition',
                  bathRimCandidate: link,
                });
            }
        } else
          for (const offsetMm of [0, -widthMm / 4, widthMm / 4]) {
            const link: CandidatePartitionTop = {
              parentCandidateId: parent.candidate.id,
              offsetMm,
              provenance: { parent: 'inferred', offset: 'inferred' },
              evidence,
            };
            const resolved = resolveCandidatePartitionTop(input.room, link, parent.plan, child);
            if (resolved.status === 'attached')
              addResolved({
                ...child,
                ...resolved.placement,
                kind: 'glassPartition',
                partitionTopCandidate: link,
              });
          }
      }
    }
  }
  return result;
}

function projected(option: Proposal, camera: PerspectiveCamera): ProductBounds | undefined {
  const points = option.corners.map((point) => point.clone().applyMatrix4(camera.matrixWorldInverse));
  if (points.some((p) => p.z >= -1)) return undefined;
  points.forEach((p) => p.applyMatrix4(camera.projectionMatrix));
  return {
    left: Math.min(...points.map((p) => (p.x + 1) / 2)),
    right: Math.max(...points.map((p) => (p.x + 1) / 2)),
    top: Math.min(...points.map((p) => (1 - p.y) / 2)),
    bottom: Math.max(...points.map((p) => (1 - p.y) / 2)),
  };
}
function scored(
  option: Proposal,
  camera: CameraHypothesis,
  wallScores?: Map<string, Record<Wall, number>>,
): Scored | undefined {
  const bounds = projected(option, camera.camera);
  if (!bounds) return undefined;
  const observed = option.candidate.bounds;
  // Cropped image edges are one-sided observations. A cut-off object may extend beyond the photo,
  // but it must still remain entirely within the physical room (checked before this score).
  const residual = (key: keyof ProductBounds) => {
    const delta = bounds[key] - observed[key];
    if ((key === 'left' || key === 'top') && observed[key] <= 0.015) return Math.max(0, delta);
    if ((key === 'right' || key === 'bottom') && observed[key] >= 0.985) return Math.min(0, delta);
    return delta;
  };
  const b = span(observed);
  const image =
    (sq(residual('left')) + sq(residual('right'))) / Math.max(0.025, sq(b.width)) +
    (sq(residual('top')) + sq(residual('bottom'))) / Math.max(0.025, sq(b.height));
  const depthWallOrientation =
    !option.strict && option.plan.face !== 'floor'
      ? (wallScores?.get(option.candidate.id)?.[option.wall] ?? 0)
      : 0;
  const terms = {
    image: image * 0.6,
    sizeAndSupportPrior: option.prior,
    ...(wallScores ? { depthWallOrientation } : {}),
  };
  return {
    ...option,
    projected: bounds,
    terms,
    score: terms.image + terms.sizeAndSupportPrior + depthWallOrientation,
  };
}

function intersect(a: Box, b: Box) {
  return [0, 1, 2].map((axis) =>
    Math.max(0, Math.min(a.max[axis], b.max[axis]) - Math.max(a.min[axis], b.min[axis])),
  );
}
function pairScore(
  a: Scored,
  b: Scored,
  input: EstimatedCandidatePipelineInput,
): { penalty: number; collision: boolean } {
  const overlap = intersect(a.box, b.box);
  const dimsA = a.box.max.map((value, axis) => value - a.box.min[axis]);
  const dimsB = b.box.max.map((value, axis) => value - b.box.min[axis]);
  const related = input.understanding.relations.some(
    (r) =>
      r.relation === 'partOf' &&
      ((r.frontId === a.candidate.id && r.behindId === b.candidate.id) ||
        (r.frontId === b.candidate.id && r.behindId === a.candidate.id)),
  );
  const deepIntersection = overlap.every(
    (value, axis) => value > Math.min(dimsA[axis], dimsB[axis]) * 0.2 + 1,
  );
  // Photo occlusion is allowed; actual solid-volume penetration is not. Thin glass touching the
  // edge of a tub is allowed, while a pane cutting through the middle of a toilet is rejected.
  if (deepIntersection && !related) return { penalty: 0, collision: true };
  let penalty = 0;
  const ao = centre(a.candidate.bounds),
    bo = centre(b.candidate.bounds);
  const ap = centre(a.projected),
    bp = centre(b.projected);
  if (Math.abs(ao.x - bo.x) > 0.06 && (ao.x - bo.x) * (ap.x - bp.x) < 0) penalty += 3;
  if (Math.abs(ao.y - bo.y) > 0.12 && (ao.y - bo.y) * (ap.y - bp.y) < 0) penalty += 1;
  for (const r of input.layoutObservation?.relations ?? []) {
    const forward = r.fromId === a.candidate.id && r.toId === b.candidate.id;
    const reverse = r.fromId === b.candidate.id && r.toId === a.candidate.id;
    if (!forward && !reverse) continue;
    const first = forward ? a : b,
      second = forward ? b : a;
    const fc = centre(first.projected),
      sc = centre(second.projected);
    const firstDepth = (first.box.min[2] + first.box.max[2]) / 2;
    const secondDepth = (second.box.min[2] + second.box.max[2]) / 2;
    if (
      (r.type === 'leftOf' && fc.x >= sc.x) ||
      (r.type === 'rightOf' && fc.x <= sc.x) ||
      (r.type === 'above' && fc.y >= sc.y) ||
      (r.type === 'below' && fc.y <= sc.y)
    )
      penalty += 5;
    if (
      (r.type === 'inFrontOf' && firstDepth <= secondDepth) ||
      (r.type === 'behind' && firstDepth >= secondDepth)
    )
      penalty += 4;
    if (r.type === 'attachedTo' && first.wall !== second.wall) penalty += 3;
  }
  return { penalty, collision: false };
}

type Solution = {
  hypothesis: CameraHypothesis;
  selected: Scored[];
  score: number;
  alternatives: Map<string, Scored[]>;
  scoreTerms: Record<string, number>;
  heldCandidateIds: string[];
  projectionAvailability: EstimatedLayout['hypotheses'][number]['projectionAvailability'];
};
function solve(
  input: EstimatedCandidatePipelineInput,
  options: Map<string, Proposal[]>,
  depthWallEvidence?: EstimatedDepthWallEvidence,
  directionLog?: { value?: EstimatedCameraDirectionResult },
): Solution[] {
  const solutions: Solution[] = [];
  // Place physical supports and bulky fixtures first, then wall objects and transparent dividers.
  const order = [...options.keys()].sort((a, b) => {
    const priority = (id: string) => {
      const k = options.get(id)?.[0]?.candidate.kind;
      return k === 'bath'
        ? 0
        : k === 'vanity'
          ? 1
          : k === 'toilet'
            ? 2
            : k === 'basin'
              ? 3
              : k === 'glassPartition' || k === 'showerCurtain'
                ? 5
                : 4;
    };
    return priority(a) - priority(b) || a.localeCompare(b);
  });
  for (const hypothesis of cameras(input, directionLog)) {
    const wallScores = depthWallEvidence ? new Map<string, Record<Wall, number>>() : undefined;
    for (const node of depthWallEvidence?.nodes ?? []) {
      if (node.status !== 'supported' || !node.normalCamera) continue;
      wallScores!.set(
        node.candidateId,
        Object.fromEntries(
          WALLS.map((wall) => [
            wall,
            estimatedDepthWallOrientation(node.normalCamera!, hypothesis.serialized, wall).penalty,
          ]),
        ) as Record<Wall, number>,
      );
    }
    const roomStructure = input.cameraPenalty?.(hypothesis.serialized) ?? 0;
    if (!Number.isFinite(roomStructure) || roomStructure < 0)
      throw new Error('카메라 구조 가설 점수가 올바르지 않아요.');
    let beam: { selected: Scored[]; score: number }[] = [
      { selected: [], score: hypothesis.prior + roomStructure },
    ];
    const alternatives = new Map<string, Scored[]>();
    const projectionAvailability: Solution['projectionAvailability'] = [];
    for (const id of order) {
      const projectedChoices = options.get(id)!.flatMap((option) => {
        const value = scored(option, hypothesis, wallScores);
        return value ? [value] : [];
      });
      projectionAvailability.push({
        candidateId: id,
        physicalProposalCount: options.get(id)!.length,
        projectableProposalCount: projectedChoices.length,
      });
      // A weak image-only rank can still satisfy a scene relation or avoid a collision.
      // Keep every projectable option until pairScore runs; bound diagnostics separately.
      const choices = projectedChoices.sort((a, b) => a.score - b.score).map((choice, index) => ({
        ...choice,
        proposalSearch: { unaryRank: index + 1, projectableProposalCount: projectedChoices.length },
      }));
      alternatives.set(id, choices.slice(0, 36));
      const next: typeof beam = [];
      for (const partial of beam) {
        const item = options.get(id)![0]?.candidate;
        const supports = item
          ? supportedGlassChoices(input, item, partial.selected)
              .flatMap((option) => {
                const value = scored(option, hypothesis, wallScores);
                return value ? [value] : [];
              })
              .sort((a, b) => a.score - b.score)
              .slice(0, 24)
          : [];
        const explicitSupport = input.layoutObservation?.relations.some(
          (relation) =>
            relation.fromId === id &&
            relation.type === 'supportedBy' &&
            partial.selected.some(
              (parent) =>
                parent.candidate.id === relation.toId &&
                ['bath', 'lowPartition'].includes(parent.candidate.kind),
            ),
        );
        const independent =
          explicitSupport && supports.length
            ? choices.map((choice) => ({
                ...choice,
                score: choice.score + 3,
                terms: { ...choice.terms, supportObservationConflict: 3 },
              }))
            : choices;
        if (supports.length)
          alternatives.set(
            id,
            [...(alternatives.get(id) ?? []), ...supports].sort((a, b) => a.score - b.score).slice(0, 60),
          );
        for (const choice of [...supports, ...independent]) {
          const pairs = partial.selected.map((other) => pairScore(choice, other, input));
          if (pairs.some((p) => p.collision)) continue;
          next.push({
            selected: [...partial.selected, choice],
            score: partial.score + choice.score + pairs.reduce((total, p) => total + p.penalty, 0),
          });
        }
        // Retain an explicit held alternative. Missing visible objects are costly, never rewarded
        // as a cleaner-looking empty scene, and remain in diagnostics rather than disappearing.
        next.push({ selected: partial.selected, score: partial.score + 20 });
      }
      beam = next.sort((a, b) => a.score - b.score).slice(0, 8);
    }
    const selected = beam[0].selected;
    const heldCandidateIds = order.filter((id) => !selected.some((choice) => choice.candidate.id === id));
    const scoreTerms: Record<string, number> = {
      cameraPrior: hypothesis.prior,
      roomStructure,
      image: 0,
      sizeAndSupportPrior: 0,
      supportObservationConflict: 0,
      relations: 0,
      missing: heldCandidateIds.length * 20,
    };
    selected.forEach((choice, index) => {
      for (const [name, value] of Object.entries(choice.terms))
        scoreTerms[name] = (scoreTerms[name] ?? 0) + value;
      for (const other of selected.slice(0, index))
        scoreTerms.relations += pairScore(choice, other, input).penalty;
    });
    solutions.push({
      hypothesis,
      ...beam[0],
      alternatives,
      scoreTerms,
      heldCandidateIds,
      projectionAvailability,
    });
  }
  return solutions.sort((a, b) => a.score - b.score);
}

/** A separate estimated-layout route. It never changes strict camera, observed anchors, original
 * candidates, or failed strict checks. The selected plans are independently checked physical models. */
export function buildEstimatedCandidatePipeline(requestedInput: EstimatedCandidatePipelineInput) {
  const originalInput = {
    ...requestedInput,
    toiletLidPolicy: requestedInput.toiletLidPolicy ?? DEFAULT_CANDIDATE_TOILET_LID_POLICY,
  };
  const relationConsistency = originalInput.layoutObservation
    ? inspectEstimatedPhotoRelations(
        originalInput.understanding.candidates,
        originalInput.layoutObservation.relations,
      )
    : undefined;
  const photoCheckedInput =
    originalInput.layoutObservation &&
    relationConsistency &&
    originalInput.photoRelationPolicy !== 'raw-experiment'
      ? {
          ...originalInput,
          layoutObservation: {
            ...originalInput.layoutObservation,
            relations: relationConsistency.scoredRelations ?? relationConsistency.accepted,
          },
        }
      : originalInput;
  const depthRelationEvidence =
    originalInput.depthRelationPolicy === 'hold-unverified'
      ? inspectEstimatedDepthRelations(photoCheckedInput.layoutObservation?.relations ?? [])
      : undefined;
  const input =
    depthRelationEvidence && photoCheckedInput.layoutObservation
      ? {
          ...photoCheckedInput,
          layoutObservation: {
            ...photoCheckedInput.layoutObservation,
            relations: depthRelationEvidence.scoredRelations,
          },
        }
      : photoCheckedInput;
  if (
    input.sizeFactors &&
    (input.sizeFactors.length < 1 ||
      input.sizeFactors.length > 5 ||
      input.sizeFactors.some((factor) => !Number.isFinite(factor) || factor <= 0 || factor > 2))
  )
    throw new Error('제품 규격 가설 범위가 올바르지 않아요.');
  const { understanding, strictResult } = input;
  const result = structuredClone(strictResult);
  const nodes: EstimatedLayoutNode[] = [];
  const options = new Map<string, Proposal[]>();
  const assemblies: EstimatedLayout['assemblies'] = [];
  for (const relation of input.layoutObservation?.relations ?? []) {
    if (relation.type !== 'supportedBy') continue;
    const child = understanding.candidates.find((item) => item.id === relation.fromId);
    const parent = understanding.candidates.find((item) => item.id === relation.toId);
    const component = child && parent ? observedBasinComponent(child, parent, input.appearance) : null;
    if (
      !child ||
      !parent ||
      !component ||
      parent.kind !== 'vanity' ||
      child.reflection !== 'physical' ||
      parent.reflection !== 'physical' ||
      input.manualIdSet?.has(child.id) ||
      input.manualIdSet?.has(parent.id) ||
      [child, parent].some((item) =>
        Object.values(item.provenance ?? {}).includes('user') ||
        Object.values(strictResult.plans[item.id]?.provenance ?? {}).includes('user') ||
        !!strictResult.pipeline.userColors?.[item.id] ||
        !!strictResult.pipeline.userPedestalShapes?.[item.id] ||
        !!strictResult.pipeline.userToiletLidStates?.[item.id],
      )
    )
      continue;
    if (
      [child, parent].some(
        (item) =>
          strictResult.pipeline.resolution.entries.find((entry) => entry.candidateId === item.id)
            ?.disposition !== 'fixture',
      )
    )
      continue;
    if (centre(child.bounds).y >= centre(parent.bounds).y) continue;
    // The historical part role can select only one explicitly observed support.
    if (child.kind !== 'basin' && new Set((input.layoutObservation?.relations ?? [])
      .filter((entry) => entry.type === 'supportedBy' && entry.fromId === child.id)
      .map((entry) => entry.toId)).size !== 1) continue;
    let assembly = assemblies.find((entry) => entry.parentId === parent.id);
    if (!assembly) {
      assembly = {
        parentId: parent.id,
        componentIds: [],
        source: 'model-observed',
        reasons: [
          '별도 모델이 관측한 세면볼→하부장 지지 관계를 표준 조합 한 개로 표현해요. 원관측과 기존 엄격 분류는 보존해요.',
        ],
      };
      assemblies.push(assembly);
    }
    if (child.kind !== 'basin' && !assembly.reasons.includes(PROMOTED_BASIN_COMPONENT_REASON))
      assembly.reasons.push(PROMOTED_BASIN_COMPONENT_REASON);
    if (!assembly.componentIds.includes(child.id)) assembly.componentIds.push(child.id);
  }
  // Validate the complete component set before hiding any child. A two-bowl standard
  // model cannot silently absorb three observations or a disconnected assembly.
  for (const assembly of assemblies) {
    const parent = understanding.candidates.find((entry) => entry.id === assembly.parentId)!;
    const components = assembly.componentIds.map((id) => {
      const child = understanding.candidates.find((entry) => entry.id === id)!;
      return observedBasinComponent(child, parent, input.appearance) ?? child;
    });
    assembly.observationBounds = estimateAssemblyObservationBounds(parent, components);
    assembly.reasons.push(...assembly.observationBounds.reasons);
  }
  for (const item of understanding.candidates) {
    const disposition = strictResult.pipeline.resolution.entries.find(
      (entry) => entry.candidateId === item.id,
    );
    const node: EstimatedLayoutNode = {
      candidateId: item.id,
      status: 'held',
      observed: structuredClone(item),
      ...(input.basinRegionPolicy !== 'legacy-normalized' &&
      item.kind === 'basin' &&
      item.basinStyle === 'pedestal'
        ? { basinRegion: inspectObservedBasinRegion(item, input.image) }
        : {}),
      alternatives: [],
      reasons: [],
    };
    nodes.push(node);
    const lidObservation = independentToiletLid(input, item);
    if (lidObservation) node.toiletLidObservation = lidObservation.diagnostic;
    const alias = input.appearance?.duplicates.find((entry) => entry.candidateId === item.id);
    const canonical = alias && understanding.candidates.find((entry) => entry.id === alias.canonicalId);
    const aliasDecision = input.appearance?.decisions.find((entry) => entry.candidateId === item.id);
    const userControlled = (candidate: SceneCandidate) =>
      input.manualIdSet?.has(candidate.id) ||
      Object.values(candidate.provenance ?? {}).includes('user') ||
      Object.values(input.strictResult.plans[candidate.id]?.provenance ?? {}).includes('user');
    if (
      alias &&
      aliasDecision?.status === 'duplicate' &&
      aliasDecision.observation.sameObjectAs &&
      canonical &&
      canonical.id !== item.id &&
      item.reflection === 'physical' &&
      canonical.reflection === 'physical' &&
      item.kind !== 'unknown' &&
      item.kind === canonical.kind &&
      candidateBoxIoU(item.bounds, canonical.bounds) >= 0.8 &&
      !userControlled(item) &&
      !userControlled(canonical)
    ) {
      node.status = 'excluded';
      node.reasons.push(
        alias.reason,
        '동일 실물의 원관측은 보존하고 ' + canonical.id + ' 모형으로 연결해요.',
      );
      result.plans[item.id] = null;
      const review = result.review.candidates.find((entry) => entry.id === item.id);
      if (review) {
        review.status = 'ignored';
        review.requiresReview = false;
        review.warning = node.reasons.join(' ');
      }
      continue;
    }
    const appearanceDecision = input.appearance?.decisions.find((entry) => entry.candidateId === item.id);
    if (appearanceDecision) node.reasons.push(...appearanceDecision.reasons);
    const dividerDecision = input.dividerApplication?.decisions.find(
      (entry) => entry.candidateId === item.id,
    );
    if (dividerDecision) node.reasons.push(...dividerDecision.reasons);
    if (input.photoRelationPolicy !== 'raw-experiment') {
      for (const rejected of relationConsistency?.rejected ?? [])
        if (rejected.relation.fromId === item.id || rejected.relation.toId === item.id)
          node.reasons.push(
            '사진의 분리된 영역과 반대인 관계 ' +
              rejected.relation.fromId +
              ' ' +
              rejected.relation.type +
              ' ' +
              rejected.relation.toId +
              '는 배치 점수에서 제외했어요. 원래 모델 응답과 경계 상자는 보존했어요.',
          );
      for (const held of relationConsistency?.held ?? [])
        if (held.relation.fromId === item.id || held.relation.toId === item.id)
          node.reasons.push(
            '사진 영역이 겹치거나 근거가 부족해 확인하지 못한 방향 관계 ' +
              held.relation.fromId +
              ' ' +
              held.relation.type +
              ' ' +
              held.relation.toId +
              '는 배치 점수에서 보류했어요. 잘못된 관계로 단정하지 않고 원래 관측을 보존했어요.',
          );
    }
    for (const held of assemblies.filter((entry) => entry.observationBounds?.status === 'held' &&
      (entry.parentId === item.id || entry.componentIds.includes(item.id)))) {
      node.reasons.push(...held.observationBounds!.reasons, '조합 검증이 보류되어 부품 관측을 자동 결합하거나 숨기지 않았어요.');
    }
    const componentOf = assemblies.find((entry) => entry.observationBounds?.status === 'combined' && entry.componentIds.includes(item.id));
    if (componentOf) {
      node.status = 'excluded';
      node.reasons.push(
        '세면볼은 관측된 지지 관계의 하부장 ' +
          componentOf.parentId +
          '에 결합했어요. 별도 하부장이나 세면대를 중복 생성하지 않아요.',
      );
      result.plans[item.id] = null;
      const review = result.review.candidates.find((entry) => entry.id === item.id);
      if (review) {
        review.status = 'ignored';
        review.requiresReview = false;
        review.warning = node.reasons.join(' ');
      }
      continue;
    }
    if (
      item.kind === 'unknown' ||
      !finiteBounds(item.bounds) ||
      item.reflection !== 'physical' ||
      disposition?.disposition !== 'fixture'
    ) {
      node.status = ['reflection', 'duplicate', 'component'].includes(disposition?.disposition ?? '')
        ? 'excluded'
        : 'held';
      node.reasons.push(
        ...(disposition?.reasons ?? []),
        '독립된 실제 설비로 검증하지 못한 원관측은 추정 배치로 승격하지 않았어요.',
      );
      continue;
    }
    const assembly = assemblies.find((entry) => entry.observationBounds?.status === 'combined' && entry.parentId === item.id);
    const components =
      assembly?.componentIds.map((id) => {
        const child = understanding.candidates.find((entry) => entry.id === id)!;
        return observedBasinComponent(child, item, input.appearance) ?? child;
      }) ?? [];
    const shape = components.find((entry) => entry.shape !== 'unknown')?.shape ?? item.shape;
    const assemblyBounds =
      assembly && components.length ? estimateAssemblyObservationBounds(item, components) : undefined;
    if (assembly && assemblyBounds) {
      assembly.observationBounds = assemblyBounds;
      node.reasons.push(...assemblyBounds.reasons);
    }
    const effective = components.length
      ? {
          ...item,
          ...(input.assemblyBoundsPolicy !== 'parent-only-experiment' && assemblyBounds?.status === 'combined'
            ? { bounds: { ...assemblyBounds.bounds } }
            : {}),
          shape,
          bowlCount: (components.length > 1 ? 2 : (components[0].bowlCount ?? item.bowlCount ?? 1)) as 1 | 2,
        }
      : item;
    // Latest manual protection and candidate snapshot are checked at the point of placement.
    const installedness = !userControlled(item)
      ? input.showerInstallationDecisions?.find(entry => entry.candidateId === item.id)
      : undefined;
    if (installedness?.action === 'hold' && installedness.policyRevision === SHOWER_INSTALLATION_DECISION_REVISION &&
        canonicalTargetValue(item) === installedness.analysis.receipt.candidateSignature) {
      node.status = 'held';
      result.plans[item.id] = null;
      const reason = '완성 샤워 헤드와 조작부가 없는 미설치 배관·임시 구조로 확인되어 샤워 배치를 보류했어요. 원후보와 원문은 남겨 확인할 수 있어요.';
      node.reasons.push(reason);
      const review = result.review.candidates.find(entry => entry.id === item.id);
      if (review) {
        review.status = 'unplaced'; review.requiresReview = true; review.warning = node.reasons.join(' ');
        (review.trace ??= []).push({ stage: 'placement', outcome: 'held', reason });
      }
      continue;
    }
    const showerDecision = observedShowerModel(input, item);
    if (showerDecision) {
      node.showerModelDecision = showerDecision;
      node.reasons.push(...showerDecision.reasons);
    }
    if (showerDecision?.action === 'hold') {
      node.status = 'held';
      result.plans[item.id] = null;
      const review = result.review.candidates.find((entry) => entry.id === item.id);
      if (review) {
        review.status = 'unplaced';
        review.requiresReview = true;
        review.warning = node.reasons.join(' ');
      }
      continue;
    }
    const candidates = proposals(input, effective);
    if (!candidates.length)
      node.reasons.push('지원 방식과 일반 규격 범위에서 가능한 배치 가설이 없어요. 원후보는 보존했어요.');
    else options.set(item.id, candidates);
  }
  const depthWallEvidence = input.depthWallEvidence
    ? buildEstimatedDepthWallEvidence(
        input.depthWallEvidence,
        understanding.candidates,
        input.image,
        input.manualIdSet,
      )
    : undefined;
  const directionLog: { value?: EstimatedCameraDirectionResult } = {};
  const solutions = solve(input, options, depthWallEvidence, directionLog);
  const cameraRanking =
    (input.cameraRankingPolicy ?? 'kind-conflict-image-hold-v1') === 'kind-conflict-image-hold-v1'
      ? assessCameraRanking({
          candidates: understanding.candidates,
          decisions: input.appearance?.decisions ?? [],
          relations: understanding.relations,
          manualIds: input.manualIdSet,
          excludedAnchorIds: new Set([
            ...assemblies.filter((assembly) => assembly.observationBounds?.status === 'combined')
              .flatMap((assembly) => [assembly.parentId, ...assembly.componentIds]),
            ...(input.appearance?.duplicates ?? []).flatMap((alias) =>
              nodes.some((node) => node.candidateId === alias.candidateId && node.status === 'excluded')
                ? [alias.candidateId, alias.canonicalId]
                : [],
            ),
          ]),
          solutions: solutions.map((solution) => ({
            id: solution.hypothesis.id,
            fullScore: solution.score,
            imageContributions: solution.selected.map((choice) => ({
              candidateId: choice.candidate.id,
              image: choice.terms.image,
            })),
          })),
        })
      : undefined;
  if (cameraRanking?.status === 'applied') {
    const rank = new Map(cameraRanking.rows.map((row) => [row.id, row.rankingScore]));
    solutions.sort(
      (a, b) =>
        rank.get(a.hypothesis.id)! - rank.get(b.hypothesis.id)! ||
        a.hypothesis.id.localeCompare(b.hypothesis.id),
    );
  }
  const best = solutions[0];
  for (const node of nodes) {
    const item = node.observed;
    const chosen = best?.selected.find((candidate) => candidate.candidate.id === item.id);
    const rankedAlternatives = [...(best?.alternatives.get(item.id) ?? [])];
    if (chosen && !rankedAlternatives.slice(0, 5).includes(chosen)) rankedAlternatives.unshift(chosen);
    node.alternatives = rankedAlternatives.slice(0, 5).map((candidate) => {
      const conflicts = (best?.selected ?? [])
        .filter((other) => other.candidate.id !== item.id)
        .flatMap((other) => {
          const check = pairScore(candidate, other, input);
          return check.collision
            ? ['physical-collision:' + other.candidate.id]
            : check.penalty > 0
              ? ['relation-penalty:' + other.candidate.id + ':' + check.penalty]
              : [];
        });
      return {
        plan: candidate.plan,
        score: candidate.score,
        reasons: candidate.reasons,
        rejectedBy:
          candidate === chosen
            ? []
            : conflicts.length
              ? conflicts
              : [
                  'lower-joint-layout-score; image=' +
                    candidate.terms.image +
                    '; prior=' +
                    candidate.terms.sizeAndSupportPrior,
                ],
      };
    });
    if (!chosen) {
      if (options.has(item.id)) {
        node.reasons.push(
          '설비 후보는 찾았지만 다른 주요 설비와의 관계 또는 충돌을 해결하는 가설을 선택하지 못했어요.',
        );
        result.plans[item.id] = null;
      }
      continue;
    }
    const manual = input.manualIdSet?.has(item.id) ?? false;
    const depthNode = depthWallEvidence?.nodes.find((entry) => entry.candidateId === item.id);
    if (depthNode?.normalCamera && best && !chosen.strict && chosen.plan.face !== 'floor')
      depthNode.selected = {
        wall: chosen.wall,
        ...estimatedDepthWallOrientation(depthNode.normalCamera, best.hypothesis.serialized, chosen.wall),
      };

    const layoutWall = input.layoutObservation?.observations.find((entry) => entry.id === item.id)?.wall;
    const observedWall =
      item.wall !== 'unknown' ? item.wall : layoutWall && layoutWall !== 'unknown' ? layoutWall : undefined;
    node.observationChecks = observedWall
      ? [
          {
            field: 'wall',
            observed: observedWall,
            selected: chosen.wall,
            status: observedWall === chosen.wall ? 'agrees' : 'conflicts',
            reason:
              observedWall === chosen.wall
                ? '모델 설치 벽 판단과 선택한 배치 가설이 일치해요.'
                : '모델 설치 벽 판단은 보존하고, 사진 투영과 전체 장면 제약에 더 맞는 다른 벽을 추정했어요.',
          },
        ]
      : [];
    node.status = chosen.strict ? 'kept-observed' : 'placed-estimate';
    node.selected = {
      plan: structuredClone(chosen.plan),
      anchorRole:
        item.kind === 'showerCurtain'
          ? 'suspension-support-centre'
          : chosen.plan.face === 'floor'
            ? 'floor-footprint-centre'
            : 'wall-rear-bottom',
      ...(item.kind === 'showerCurtain'
        ? {
            hangingAnchorMm: (() => {
              const transform = reconstructionModelTransform(input.room, {
                ...chosen.plan,
                widthMm: chosen.plan.widthMm!,
                heightMm: chosen.plan.heightMm!,
                depthMm: chosen.plan.depthMm!,
              });
              return new Vector3(
                0,
                curtainHangingOffset(chosen.plan.heightMm!, chosen.plan.curtainHardware),
                0,
              )
                .multiplyScalar(transform.scale)
                .applyAxisAngle(new Vector3(0, 1, 0), transform.angle)
                .add(transform.origin)
                .toArray() as [number, number, number];
            })(),
          }
        : {}),
      physicalCheck: chosen.check,
      scoreTerms: chosen.terms,
      ...(chosen.proposalSearch ? { proposalSearch: { ...chosen.proposalSearch } } : {}),
      sceneChecks: (best?.selected ?? [])
        .filter((other) => other.candidate.id !== item.id)
        .map((other) => {
          const check = pairScore(chosen, other, input);
          return {
            otherCandidateId: other.candidate.id,
            collision: check.collision,
            relationPenalty: check.penalty,
          };
        }),
      sources: {
        kind: item.provenance?.kind === 'user' ? 'user' : 'model-observed',
        mounting:
          item.kind === 'showerCurtain' && item.provenance?.mounting === 'geometry'
            ? 'geometry-derived'
            : item.mounting === 'unknown'
              ? 'estimated'
              : 'model-observed',
        wall: manual ? 'user' : observedWall === chosen.wall ? 'model-observed' : 'estimated',
        position: manual ? 'user' : chosen.strict ? 'geometry-derived' : 'estimated',
        yaw: manual ? 'user' : 'estimated',
        width: manual ? 'user' : chosen.plan.provenance?.width === 'default' ? 'default' : 'estimated',
        height: manual ? 'user' : chosen.plan.provenance?.height === 'default' ? 'default' : 'estimated',
        depth: manual ? 'user' : chosen.plan.provenance?.depth === 'default' ? 'default' : 'estimated',
      },
      reasons: [
        ...node.reasons,
        ...chosen.reasons,
        '원본 카메라 확정 여부와 독립적인 추정 배치이며, 크기와 위치를 확인할 수 있어요.',
      ],
    };
    result.plans[item.id] = structuredClone(chosen.plan);
    const review = result.review.candidates.find((candidate) => candidate.id === item.id);
    if (review) {
      review.requiresReview = !manual && !chosen.strict;
      review.warning = [...item.uncertainty, ...node.selected.reasons].join(' ');
      review.installation = {
        mode: item.kind === 'showerCurtain' ? 'suspended' : chosen.plan.face === 'floor' ? 'floor' : 'wall',
        wall: chosen.wall,
        basinVariant: chosen.plan.basinVariant,
        reason: '관측한 설비와 사진 관계로 선택한 표준 모형의 설치 가설이에요.',
        source: manual ? 'user' : 'inferred',
      };
      review.trace = [
        ...(review.trace ?? []),
        {
          stage: 'placement',
          outcome: 'accepted',
          reason:
            '별도 추정 배치 경로에서 물리 범위와 장면 관계를 검토했어요. 기존 엄격 배치의 보류 진단은 별도로 보존했어요.',
        },
      ];
    }
  }
  const estimatedLayout: EstimatedLayout = {
    ...(input.toiletLidPolicy === 'independent-semantic-v1'
      ? { toiletLidPolicy: input.toiletLidPolicy }
      : {}),
    version: 1,
    revision: ESTIMATED_LAYOUT_REVISION,
    observationIds: understanding.candidates.map((candidate) => candidate.id),
    nodes,
    camera: {
      source: best?.hypothesis.source ?? 'layout-hypothesis',
      value: best?.hypothesis.serialized,
      reasons: [
        '배치 비교용 추정 시점이며 실측 촬영값이 아니에요. 명시적으로 선택한 사진 시점 보기에서는 Before/After에 함께 적용해요.',
      ],
    },
    cameraSearch: input.cameraSearch ?? 'compact',
    ...(cameraRanking
      ? { cameraRankingPolicy: input.cameraRankingPolicy ?? 'kind-conflict-image-hold-v1', cameraRanking }
      : {}),
    ...(input.appearance ? { appearance: structuredClone(input.appearance) } : {}),
    ...(input.showerDetails ? { showerDetails: structuredClone(input.showerDetails) } : {}),
    ...(input.showerInstallationDecisions ? { showerInstallationDecisions: structuredClone(input.showerInstallationDecisions) } : {}),
    ...(input.dividerApplication ? { dividerApplication: structuredClone(input.dividerApplication) } : {}),
    ...(depthWallEvidence ? { depthWallEvidence } : {}),
    hypotheses: solutions.map((solution) => ({
      id: solution.hypothesis.id,
      score: solution.score,
      ...(cameraRanking
        ? {
            cameraRankingScore: cameraRanking.rows.find((row) => row.id === solution.hypothesis.id)
              ?.rankingScore,
          }
        : {}),
      placedCount: solution.selected.length,
      cameraSource: solution.hypothesis.source,
      camera: solution.hypothesis.serialized,
      ...(solution.hypothesis.directionEvidence
        ? { directionEvidence: solution.hypothesis.directionEvidence }
        : {}),
      scoreTerms: solution.scoreTerms,
      heldCandidateIds: solution.heldCandidateIds,
      projectionAvailability: solution.projectionAvailability,
    })),
    relations: structuredClone(originalInput.layoutObservation?.relations ?? []),
    photoRelationPolicy: originalInput.photoRelationPolicy ?? 'checked',
    depthRelationPolicy: originalInput.depthRelationPolicy ?? 'legacy-model-prior',
    basinRegionPolicy: originalInput.basinRegionPolicy ?? 'pixel-aspect',
    ...(depthRelationEvidence ? { depthRelationEvidence } : {}),
    ...(relationConsistency ? { relationConsistency } : {}),
    ...(directionLog.value
      ? {
          cameraDirectionObservation: {
            status: directionLog.value.status,
            reasons: directionLog.value.reasons,
            model: directionLog.value.model,
            inputFingerprint: directionLog.value.inputFingerprint,
            scope: directionLog.value.scope,
          },
        }
      : {}),
    assemblies,
    assemblyBoundsPolicy: input.assemblyBoundsPolicy ?? 'combined',
    warnings: [
      '추정 배치는 관측된 설비만 포함하며, 보이지 않는 설비를 추가하지 않아요. 위치·규격은 실제 측정값이 아니에요.',
    ],
  };
  result.review.warnings = [...result.review.warnings, ...estimatedLayout.warnings];
  return { ...result, pipeline: { ...result.pipeline, estimatedLayout } };
}
