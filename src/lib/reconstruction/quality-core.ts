import { resolveClassificationConflicts, type ClassificationResolution } from './classification-resolution';
import { analyzeShowerInstallations, validateShowerInstallationRecord } from './analysis-client';
import type { ShowerInstallationContext, ShowerInstallationRecord } from './shower-installation-observation';
import { requireCloudGemmaAppearanceContract } from './cloud-gemma-appearance';
import { parseCloudGemmaExtendedInventory } from './cloud-gemma-coordinates';
import {
  applyDividerObservations,
  dividerObservationTargets,
  type DividerApplication,
} from './divider-application';
import {
  DIVIDER_OBSERVATION_CONTRACT,
  DIVIDER_OBSERVATION_PROMPT_REVISION,
  parseDividerObservation,
  dividerTargetsSignature,
  type DividerTarget,
} from './divider-observation';
import { analyzeDividerMaterials, type LocalDividerAnalysis } from './analysis-client';
import {
  applyReflectionRechecks,
  reflectionRecheckCandidates,
  REFLECTION_RECHECK_RULE_REVISION,
  type ReflectionRecheckContext,
  type ReflectionRecheckEvidence,
} from './reflection-recheck';
import { analyzeReflectionRechecks, prepareReflectionRecheckRequests } from './analysis-client';
import {
  SHOWER_OBSERVATION_CONTRACT,
  SHOWER_OBSERVATION_PROMPT_REVISION,
  showerObservationTargets,
  parseShowerObservation,
} from './shower-observation';
import { analyzeShowerDetails, type LocalShowerAnalysis } from './analysis-client';
import {
  FIXTURE_APPEARANCE_CONTRACT,
  FIXTURE_APPEARANCE_PROMPT_REVISION,
  parseFixtureAppearance,
  type LocalFixtureAppearanceAnalysis,
} from './fixture-appearance-observation';
import { segmentRoom, type RoomSegmentation } from '../segmentation';
import type { RoomDefinition } from '../room-types';
import type { ReconstructionReview } from './types';
import type { SceneUnderstanding } from './pipeline-contract';
import type { ProductColorOverride } from './product-color';
import {
  analyzeScene,
  analyzeExtendedScene,
  analyzeLayout,
  analyzeFixtureAppearance,
  analyzeInstallation,
  analyzeIdentity,
  type LocalSceneAnalysis,
} from './analysis-client';
import type { analyzeGeometryInBrowser } from './geometry-browser-client';
import {
  LOCAL_GEOMETRY_REVISION,
  BROWSER_GEOMETRY_REVISION,
  validateLocalGeometryAnalysis,
  validateBrowserGeometryAnalysis,
} from './geometry-contract';
import { providerForModel, validAnalysisResponse } from './analysis-provider';
import {
  INSTALLATION_OUTPUT_CONTRACT,
  INSTALLATION_PROMPT_REVISION,
  validateInstallationInventory,
  parseInstallationObservation,
  skippedInstallationAnalysis,
} from './installation-observation';
import {
  IDENTITY_OUTPUT_CONTRACT,
  IDENTITY_PROMPT_REVISION,
  IDENTITY_RULE_REVISION,
  identityObservationTargets,
  parseIdentityObservation,
  skippedIdentityAnalysis,
  type LocalIdentityAnalysis,
} from './identity-observation';
import { buildCandidatePipeline, type ManualCandidatePlacement } from './candidate-pipeline';
import {
  LOCAL_QUALITY_REVISION,
  CLOUD_BROWSER_QUALITY_REVISION,
  type ReconstructionQualityEvidence,
} from './quality-contract';

import { buildEstimatedCandidatePipeline, ESTIMATED_LAYOUT_REVISION } from './estimated-layout';
import {
  LAYOUT_OUTPUT_CONTRACT,
  LAYOUT_PROMPT_REVISION,
  parseLayoutObservation,
  layoutInventorySignature,
  type LocalLayoutAnalysis,
} from './layout-observation';

export type QualityRunInput = {
  profile?: 'local-quality-v1' | 'cloud-browser-v1';
  baseline: ReconstructionReview;
  photo: Blob;
  image: { width: number; height: number };
  room: RoomDefinition;
  inputFingerprint: string;
  segmentation?: RoomSegmentation;
  signal: AbortSignal;
  inventory?: LocalSceneAnalysis;
  reuse?: ReconstructionQualityEvidence;
  /** Explicit experiment until visual acceptance; historical replays never trigger extra AI. */
  estimatedLayout?: boolean;
  layoutObservation?: LocalLayoutAnalysis;
  refineAppearance?: boolean;
  appearanceObservation?: LocalFixtureAppearanceAnalysis;
  refineShowerDetails?: boolean;
  refineShowerInstallation?: boolean;
  showerInstallationObservation?: ShowerInstallationRecord;
  refineDividerMaterials?: boolean;
  dividerMaterialsObservation?: LocalDividerAnalysis;
  refineReflection?: boolean;
  reflectionRecheckObservation?: ReflectionRecheckEvidence;
  showerDetailsObservation?: LocalShowerAnalysis;
  understandingOverride?: SceneUnderstanding;
  manualPlacements?: Record<string, ManualCandidatePlacement>;
  toiletLidStates?: Record<string, 'open' | 'closed'>;
  productColors?: Record<string, ProductColorOverride>;
  pedestalShapes?: Record<string, 'round' | 'rectangular'>;
  onStage?: (message: string) => void;
  onCheckpoint?: (name: string, value: unknown) => void;
  onPhase?: (phase: import('./lab-diagnostics').DiagnosticPhase) => void;
};
export type QualityDependencies = {
  inventory: typeof analyzeScene;
  identity: typeof analyzeIdentity;
  installation: typeof analyzeInstallation;
  geometry: typeof analyzeGeometryInBrowser;
  segmentation: typeof segmentRoom;
  layout?: typeof analyzeLayout;
  appearance?: typeof analyzeFixtureAppearance;
  showerDetails?: typeof analyzeShowerDetails;
  showerInstallation?: typeof analyzeShowerInstallations;
  dividerMaterials?: typeof analyzeDividerMaterials;
  reflectionRecheck?: typeof analyzeReflectionRechecks;
  extendedInventory?: typeof analyzeExtendedScene;
};
/** Default is offline-only for saved-result replay. New inference uses cloud-quality dependencies. */
const unavailableAnalysis = async (): Promise<never> => {
  throw new Error('기존 로컬 AI 실행은 종료됐어요. Gemma와 브라우저 MoGe 분석을 시작해 주세요.');
};
const defaultDependencies: QualityDependencies = {
  inventory: unavailableAnalysis, identity: unavailableAnalysis, installation: unavailableAnalysis,
  geometry: unavailableAnalysis, segmentation: segmentRoom,
  layout: unavailableAnalysis, appearance: unavailableAnalysis, showerDetails: unavailableAnalysis,
  showerInstallation: unavailableAnalysis, dividerMaterials: unavailableAnalysis,
  reflectionRecheck: unavailableAnalysis, extendedInventory: unavailableAnalysis,
};
const assertActive = (signal: AbortSignal) => {
  if (signal.aborted) throw new DOMException('사진 정밀 분석을 취소했어요.', 'AbortError');
};
export async function photoFingerprint(blob: Blob) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

/** JSON key order is not evidence; array order and every represented value are. */
function canonicalEvidence(value: unknown): string {
  const ancestors = new Set<object>();
  function visit(item: unknown, depth: number): unknown {
    if (depth > 64) throw new Error('관측 데이터의 중첩 깊이가 올바르지 않아요.');
    if (typeof item === 'number' && !Number.isFinite(item))
      throw new Error('관측 데이터에 유한하지 않은 수치가 있어요.');
    if (item === null || item === undefined || ['string', 'number', 'boolean'].includes(typeof item))
      return item;
    if (
      typeof item !== 'object' ||
      (!Array.isArray(item) &&
        Object.getPrototypeOf(item) !== Object.prototype &&
        Object.getPrototypeOf(item) !== null)
    )
      throw new Error('관측 데이터가 JSON 저장 형식과 달라요.');
    if (ancestors.has(item)) throw new Error('관측 데이터가 순환 참조를 포함해요.');
    ancestors.add(item);
    try {
      if (Array.isArray(item)) return item.map((entry) => visit(entry, depth + 1));
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, entry]) => [key, visit(entry, depth + 1)]),
      );
    } finally {
      ancestors.delete(item);
    }
  }
  return JSON.stringify(visit(value, 0));
}

function validateCloudInventoryRaw(inventory: LocalSceneAnalysis) {
  const checked = parseCloudGemmaExtendedInventory(inventory);
  if (canonicalEvidence(checked.understanding) !== canonicalEvidence(inventory.understanding))
    throw new Error('그룹 설비 원문에서 재검증한 목록과 저장된 후보가 달라요.');
}

/** Saved observations cross a persistence boundary and must pass current contracts again. */
async function validateReusableQuality(
  previous: ReconstructionQualityEvidence,
  fingerprint: string,
  image: QualityRunInput['image'],
  photo: Blob,
  signal: AbortSignal,
  profile: 'local-quality-v1' | 'cloud-browser-v1',
  manualPlacements: QualityRunInput['manualPlacements'],
) {
  try {
    // Also covers arbitrary diagnostics, which otherwise allow NaN to silently serialize as null.
    canonicalEvidence(previous);
    if (
      previous.version !== 1 ||
      previous.revision !==
        (profile === 'cloud-browser-v1' ? CLOUD_BROWSER_QUALITY_REVISION : LOCAL_QUALITY_REVISION)
    )
      throw new Error('정밀 분석 버전이 현재 구현과 달라요.');
    if (
      previous.photoFingerprint !== fingerprint ||
      previous.image.width !== image.width ||
      previous.image.height !== image.height
    )
      throw new Error('사진 해시 또는 해상도가 현재 입력과 달라요.');
    const inventory = structuredClone(previous.inventory);
    inventory.understanding = validateInstallationInventory(inventory.understanding);
    if (
      !validAnalysisResponse(
        inventory,
        profile === 'cloud-browser-v1' ? 'cloudflare-workers-ai' : 'local-ollama',
      )
    )
      throw new Error('설비 목록 모델의 식별 정보를 확인할 수 없어요.');
    if (profile === 'cloud-browser-v1') validateCloudInventoryRaw(inventory);
    if (!previous.identity) throw new Error('형태 관측 단계가 없는 이전 분석이에요.');
    const identity = structuredClone(previous.identity);
    if (
      identity.outputContract !== IDENTITY_OUTPUT_CONTRACT ||
      identity.promptRevision !== IDENTITY_PROMPT_REVISION
    )
      throw new Error('형태 관측 계약 또는 프롬프트 버전이 현재 구현과 달라요.');
    if (identity.modelId !== inventory.modelId) throw new Error('형태 관측과 설비 목록의 모델이 달라요.');
    let checkedIdentity: Pick<LocalIdentityAnalysis, 'understanding' | 'validation'>;
    const hasTargets = identityObservationTargets(inventory.understanding).length > 0;
    if (identity.skipped !== undefined) {
      if (
        identity.skipped !== 'no-eligible-candidates' ||
        hasTargets ||
        identity.rawText !== '{"observations":[]}' ||
        identity.modelRevision !== null
      )
        throw new Error('형태 관측 생략 기록이 올바르지 않아요.');
      checkedIdentity = skippedIdentityAnalysis(inventory.understanding);
    } else {
      if (!hasTargets || identity.modelRevision !== inventory.modelRevision)
        throw new Error('형태 관측의 모델 revision 또는 생략 상태가 달라요.');
      checkedIdentity = parseIdentityObservation(identity.rawText, inventory.understanding);
    }
    if (
      identity.validation.proposals.some((p) => p.ruleRevision !== IDENTITY_RULE_REVISION) ||
      canonicalEvidence(checkedIdentity.understanding) !== canonicalEvidence(identity.understanding) ||
      canonicalEvidence(checkedIdentity.validation) !== canonicalEvidence(identity.validation)
    )
      throw new Error('형태 원문에서 재검증한 결과와 저장된 보정 관측이 달라요.');
    const installation = structuredClone(previous.installation);
    if (
      installation.outputContract !== INSTALLATION_OUTPUT_CONTRACT ||
      installation.promptRevision !== INSTALLATION_PROMPT_REVISION
    )
      throw new Error('설치 관측 계약 또는 프롬프트 버전이 현재 구현과 달라요.');
    if (installation.modelId !== inventory.modelId) throw new Error('설치 관측과 설비 목록의 모델이 달라요.');
    let checked: Pick<typeof installation, 'understanding' | 'validation'>;
    if (installation.skipped !== undefined) {
      if (
        installation.skipped !== 'empty-inventory' ||
        inventory.understanding.candidates.length !== 0 ||
        installation.rawText !== '' ||
        installation.modelRevision !== null
      )
        throw new Error('빈 설비 목록의 설치 분석 생략 기록이 올바르지 않아요.');
      checked = skippedInstallationAnalysis(identity.understanding);
    } else {
      if (
        !inventory.understanding.candidates.length ||
        installation.modelRevision !== inventory.modelRevision
      )
        throw new Error('설치 관측과 설비 목록의 모델 revision 또는 생략 상태가 달라요.');
      checked = parseInstallationObservation(
        installation.rawText,
        identity.understanding,
        installation.outputContract,
      );
    }
    const appearance = previous.appearance
      ? validateAppearanceAnalysis(previous.appearance, checked.understanding, fingerprint, inventory)
      : undefined;
    let expectedEffective = appearance?.understanding ?? checked.understanding;
    if (previous.reflectionRecheck) {
      if (!appearance) throw new Error('거울 재확인에 연결된 형태 관측이 없어요.');
      const corrected = await validateReflectionRecord(
        previous.reflectionRecheck,
        photo,
        {
          identity: checkedIdentity.understanding,
          installation: checked.understanding,
          appearance,
          protectedCandidateIds: manualReflectionProtection(appearance, manualPlacements),
        },
        fingerprint,
        image,
        inventory,
        signal,
      );
      expectedEffective = corrected.understanding;
    }
    const preDividerEffective = structuredClone(expectedEffective);
    if (previous.dividerMaterials) {
      const targets = dividerObservationTargets(expectedEffective, appearance);
      const checkedDivider = validateDividerAnalysis(
        previous.dividerMaterials,
        expectedEffective,
        targets,
        fingerprint,
        inventory,
      );
      const appliedDivider = applyDividerObservations(
        expectedEffective,
        checkedDivider.observations,
        appearance,
      );
      if (canonicalEvidence(appliedDivider) !== canonicalEvidence(previous.dividerApplication))
        throw new Error('칸막이 원문에서 재계산한 적용 결과와 저장된 기록이 달라요.');
      expectedEffective = appliedDivider.understanding;
    } else if (previous.dividerApplication) throw new Error('적용 기록에 대응하는 칸막이 원관측이 없어요.');
    if (profile === 'cloud-browser-v1' && appearance) {
      const resolved = resolveClassificationConflicts({
        appearance,
        effective: expectedEffective,
        reflection: previous.reflectionRecheck,
        divider: previous.dividerApplication,
        protectedCandidateIds: manualReflectionProtection(appearance, manualPlacements),
      });
      if (canonicalEvidence(resolved.record) !== canonicalEvidence(previous.classificationResolution))
        throw new Error('종류 충돌의 원관측 판정과 저장된 추정·확인 기록이 달라요.');
      expectedEffective = resolved.understanding;
    } else if (previous.classificationResolution)
      throw new Error('분류 충돌 기록에 대응하는 형태 관측이 없어요.');
    const showerUnderstanding = profile === 'cloud-browser-v1' ? expectedEffective : preDividerEffective;
    if (previous.showerDetails)
      validateShowerAnalysis(previous.showerDetails, showerUnderstanding, fingerprint, inventory);
    if (previous.showerInstallation) {
      if (profile !== 'cloud-browser-v1') throw new Error('설치 상태 독립 관측은 Gemma 프로필에만 연결돼요.');
      await validateShowerInstallationRecord(
        previous.showerInstallation,
        photo,
        showerInstallationContext(showerUnderstanding, previous.showerDetails, manualPlacements),
        inventory.modelRevision,
        signal,
      );
    }
    if (
      canonicalEvidence(checked.understanding) !== canonicalEvidence(installation.understanding) ||
      canonicalEvidence(expectedEffective) !== canonicalEvidence(previous.effectiveUnderstanding) ||
      canonicalEvidence(checked.validation) !== canonicalEvidence(installation.validation)
    )
      throw new Error('설치 원문에서 재검증한 결과와 저장된 설치·배치 관측이 달라요.');
    const geometry =
      profile === 'cloud-browser-v1'
        ? validateBrowserGeometryAnalysis(previous.geometry, fingerprint)
        : validateLocalGeometryAnalysis(previous.geometry, fingerprint);
    if (
      geometry.evidence.revision !==
      (profile === 'cloud-browser-v1' ? BROWSER_GEOMETRY_REVISION : LOCAL_GEOMETRY_REVISION)
    )
      throw new Error('공간 관측의 추출 알고리즘 버전이 현재 구현과 달라요.');
    if (
      geometry.observation.image.width !== image.width ||
      geometry.observation.image.height !== image.height
    )
      throw new Error('공간 관측의 해상도가 현재 사진과 달라요.');
    return {
      inventory,
      identity: { ...identity, ...checkedIdentity },
      installation: { ...installation, ...checked },
      geometry: structuredClone(geometry),
    };
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message.slice(0, 700) : '관측 데이터가 손상되었어요.';
    throw new Error(
      `보관된 정밀 관측을 재사용할 수 없어요: ${reason} AI를 자동 재실행하지 않았고 이전 자료는 보존했어요.`,
      { cause },
    );
  }
}

/** Shared by normal creation, Before reanalysis and Lab; no project writes or UI dependencies. */
export async function runQualityPipeline(input: QualityRunInput, dependencies = defaultDependencies) {
  const start = performance.now();
  assertActive(input.signal);
  if (
    (input.refineAppearance ||
      input.appearanceObservation ||
      input.reuse?.appearance ||
      input.refineShowerDetails ||
      input.refineShowerInstallation ||
      input.showerInstallationObservation ||
      input.reuse?.showerInstallation ||
      input.showerDetailsObservation ||
      input.reuse?.showerDetails ||
      input.refineDividerMaterials ||
      input.dividerMaterialsObservation ||
      input.reuse?.dividerMaterials ||
      input.refineReflection ||
      input.reflectionRecheckObservation ||
      input.reuse?.reflectionRecheck) &&
    !input.estimatedLayout
  )
    throw new Error('새 형태 관측은 명시적으로 선택한 재구성 경로에서만 적용해요.');
  const fingerprint = await photoFingerprint(input.photo);
  assertActive(input.signal);
  let inventory: LocalSceneAnalysis;
  let identity: LocalIdentityAnalysis;
  let installation: ReconstructionQualityEvidence['installation'];
  let geometry: ReconstructionQualityEvidence['geometry'];
  let inventoryMs = 0,
    identityMs = 0,
    installationMs = 0,
    geometryMs = 0;
  if (input.reuse) {
    const previous = input.reuse;
    ({ inventory, identity, installation, geometry } = await validateReusableQuality(
      previous,
      fingerprint,
      input.image,
      input.photo,
      input.signal,
      input.profile ?? 'local-quality-v1',
      input.manualPlacements,
    ));
    input.onStage?.('AI 재실행 없이 같은 사진의 설치·공간 관측으로 다시 계산 중');
    input.onCheckpoint?.('qualityReuse', {
      reused: true,
      photoFingerprint: fingerprint,
      revision: previous.revision,
    });
  } else {
    let step = performance.now();
    input.onPhase?.('candidate-model');
    input.onStage?.(
      input.profile === 'cloud-browser-v1'
        ? 'Cloudflare에서 사진 속 설비 목록 확인 중'
        : '로컬 AI로 사진 속 설비 목록 확인 중',
    );
    inventory = input.inventory
      ? structuredClone(input.inventory)
      : await (
          input.estimatedLayout && dependencies.extendedInventory
            ? dependencies.extendedInventory
            : dependencies.inventory
        )(input.photo, input.signal);
    if (input.profile === 'cloud-browser-v1' && !validAnalysisResponse(inventory, 'cloudflare-workers-ai'))
      throw new Error('AI 정밀 분석의 설비 공급자 정보가 현재 선택과 달라요.');
    if (input.profile === 'cloud-browser-v1') validateCloudInventoryRaw(inventory);
    inventoryMs = input.inventory ? 0 : performance.now() - step;
    assertActive(input.signal);
    input.onCheckpoint?.('modelResponse', inventory);
    step = performance.now();
    input.onPhase?.('identity');
    input.onStage?.('세면대 구조와 실제 거울 표면을 별도로 확인 중');
    identity = await dependencies.identity(input.photo, inventory.understanding, input.signal);
    identityMs = performance.now() - step;
    assertActive(input.signal);
    input.onCheckpoint?.('identityResponse', identity);
    if (
      identity.modelId !== inventory.modelId ||
      (identity.skipped
        ? identity.modelRevision !== null
        : identity.modelRevision !== inventory.modelRevision)
    )
      throw new Error('형태 관측과 원설비 목록의 모델 가중치가 달라 후속 분석을 중단했어요.');
    step = performance.now();
    input.onPhase?.('installation');
    input.onStage?.('찾은 설비의 바닥 지지·벽 부착 근거 확인 중');
    installation = await dependencies.installation(input.photo, identity.understanding, input.signal);
    installationMs = performance.now() - step;
    assertActive(input.signal);
    input.onCheckpoint?.('installationResponse', installation);
    if (
      installation.modelId !== inventory.modelId ||
      (installation.skipped
        ? installation.modelRevision !== null
        : installation.modelRevision !== inventory.modelRevision)
    )
      throw new Error('설치 관측과 원설비 목록의 모델 가중치가 달라 후속 분석을 중단했어요.');
    step = performance.now();
    input.onPhase?.('geometry');
    input.onStage?.(
      input.profile === 'cloud-browser-v1'
        ? '이 기기에서 MoGe로 깊이와 벽·바닥 분석 중'
        : '바닥·벽 픽셀과 로컬 깊이 모델로 공간 구조 분석 중',
    );
    const segmentation =
      input.segmentation ??
      (await dependencies.segmentation(input.photo, input.onStage, {
        quality: 'reconstruction',
        signal: input.signal,
      }));
    assertActive(input.signal);
    geometry = await dependencies.geometry(
      input.photo,
      segmentation,
      installation.understanding,
      input.signal,
    );
    if (input.profile === 'cloud-browser-v1')
      geometry = validateBrowserGeometryAnalysis(geometry, fingerprint);
    geometryMs = performance.now() - step;
    assertActive(input.signal);
    input.onCheckpoint?.('geometryResponseReceived', geometry);
    if (
      geometry.inputFingerprint !== fingerprint ||
      geometry.observation.inputFingerprint !== fingerprint ||
      geometry.observation.image.width !== input.image.width ||
      geometry.observation.image.height !== input.image.height
    )
      throw new Error('공간 관측이 현재 정규화된 사진과 일치하지 않아 배치를 중단했어요.');
    input.onCheckpoint?.('geometryResponse', geometry);
  }
  // An unknown installation stays unknown. New candidates/coordinates cannot be injected by this stage.
  const originalIds = new Set(inventory.understanding.candidates.map((candidate) => candidate.id));
  if (
    installation.understanding.candidates.length !== originalIds.size ||
    installation.understanding.candidates.some((candidate) => !originalIds.has(candidate.id))
  )
    throw new Error('설치 분석의 설비 목록이 원관측과 달라요.');
  let appearance = input.appearanceObservation ?? input.reuse?.appearance;
  let appearanceMs = 0;
  if (input.refineAppearance && input.reuse && !appearance && installation.understanding.candidates.length)
    throw new Error(
      '보관된 결과에 새 형태 관측이 없어요. 새 분석을 명시적으로 실행해 주세요. AI를 자동 재실행하지 않았어요.',
    );
  if (input.refineAppearance && !appearance && !input.reuse && installation.understanding.candidates.length) {
    input.onPhase?.('appearance');
    input.onStage?.('설비의 실제 형태와 같은 물체 중복 여부를 다시 확인 중');
    const started = performance.now();
    appearance = await (dependencies.appearance ?? analyzeFixtureAppearance)(
      input.photo,
      installation.understanding,
      input.signal,
    );
    appearanceMs = performance.now() - started;
    assertActive(input.signal);
  }
  if (appearance) {
    if (!input.estimatedLayout)
      throw new Error('새 형태 관측은 명시적으로 선택한 재구성 경로에서만 적용해요.');
    appearance = validateAppearanceAnalysis(appearance, installation.understanding, fingerprint, inventory);
    input.onCheckpoint?.('appearanceResponse', appearance);
  }
  let effective = structuredClone(appearance?.understanding ?? installation.understanding);
  let reflectionRecheck = input.reflectionRecheckObservation ?? input.reuse?.reflectionRecheck;
  let reflectionRecheckMs = 0;
  if (reflectionRecheck && !appearance) throw new Error('거울 재확인에 연결된 형태 관측이 없어요.');
  if (appearance) {
    const context: ReflectionRecheckContext = {
      identity: identity.understanding,
      installation: installation.understanding,
      appearance,
      protectedCandidateIds: manualReflectionProtection(appearance, input.manualPlacements),
    };
    if (
      input.refineReflection &&
      !reflectionRecheck &&
      reflectionRecheckCandidates(context).some((value) => value.eligible)
    ) {
      if (input.reuse)
        throw new Error('보관 결과에 거울 재확인이 없어요. 새 분석을 명시적으로 실행해 주세요.');
      input.onPhase?.('appearance');
      input.onStage?.('거울 표면과 반사된 물체를 다시 구분 중');
      const started = performance.now();
      const result = await (dependencies.reflectionRecheck ?? analyzeReflectionRechecks)(
        input.photo,
        context,
        input.signal,
        inventory.modelRevision,
      );
      assertActive(input.signal);
      reflectionRecheckMs = performance.now() - started;
      reflectionRecheck = result.record;
      input.onCheckpoint?.('reflectionRecheckResponse', result);
    }
    if (reflectionRecheck) {
      const checked = await validateReflectionRecord(
        reflectionRecheck,
        input.photo,
        context,
        fingerprint,
        input.image,
        inventory,
        input.signal,
      );
      effective = checked.understanding;
      reflectionRecheck = checked.record;
      input.onCheckpoint?.('reflectionRecheckValidated', reflectionRecheck);
    }
  }
  const preDividerEffective = structuredClone(effective);
  let dividerMaterials = input.dividerMaterialsObservation ?? input.reuse?.dividerMaterials;
  let dividerApplication: DividerApplication | undefined;
  let dividerMaterialsMs = 0;
  async function resolveDividerStage() {
    const dividerTargets = dividerObservationTargets(effective, appearance);
    if (input.refineDividerMaterials && dividerTargets.length && !dividerMaterials) {
      if (input.reuse)
        throw new Error('보관 결과에 칸막이 재질 관측이 없어요. 새 분석을 명시적으로 실행해 주세요.');
      input.onPhase?.('appearance');
      input.onStage?.('가림막의 천·유리·벽 재질과 보이는 범위를 확인 중');
      const started = performance.now();
      dividerMaterials = await (dependencies.dividerMaterials ?? analyzeDividerMaterials)(
        input.photo,
        effective,
        dividerTargets,
        input.signal,
      );
      dividerMaterialsMs = performance.now() - started;
      assertActive(input.signal);
    }
    if (dividerMaterials) {
      dividerMaterials = validateDividerAnalysis(
        dividerMaterials,
        effective,
        dividerTargets,
        fingerprint,
        inventory,
      );
      dividerApplication = applyDividerObservations(effective, dividerMaterials.observations, appearance);
      effective = dividerApplication.understanding;
      input.onCheckpoint?.('dividerMaterialsResponse', dividerMaterials);
      input.onCheckpoint?.('dividerApplication', dividerApplication);
    }
  }
  if (input.profile === 'cloud-browser-v1') await resolveDividerStage();
  let classificationResolution: ClassificationResolution | undefined;
  let effectiveAppearance = appearance;
  if (input.profile === 'cloud-browser-v1' && appearance) {
    const resolved = resolveClassificationConflicts({
      appearance,
      effective,
      reflection: reflectionRecheck,
      divider: dividerApplication,
      protectedCandidateIds: manualReflectionProtection(appearance, input.manualPlacements),
    });
    effective = resolved.understanding;
    effectiveAppearance = { ...appearance, ...resolved.appearance };
    classificationResolution = resolved.record;
    input.onCheckpoint?.('classificationResolution', classificationResolution);
  }
  const showerUnderstanding = input.profile === 'cloud-browser-v1' ? effective : preDividerEffective;
  let showerDetails = input.showerDetailsObservation ?? input.reuse?.showerDetails;
  let showerDetailsMs = 0;
  if (input.refineShowerDetails && showerObservationTargets(showerUnderstanding).length && !showerDetails) {
    if (input.reuse)
      throw new Error('보관 결과에 샤워 세부 관측이 없어요. 새 분석을 명시적으로 실행해 주세요.');
    input.onPhase?.('appearance');
    input.onStage?.('샤워 종류와 실제 보이는 부위를 확인 중');
    const started = performance.now();
    showerDetails = await (dependencies.showerDetails ?? analyzeShowerDetails)(
      input.photo,
      showerUnderstanding,
      input.signal,
    );
    showerDetailsMs = performance.now() - started;
    assertActive(input.signal);
  }
  if (showerDetails) {
    showerDetails = validateShowerAnalysis(showerDetails, showerUnderstanding, fingerprint, inventory);
    input.onCheckpoint?.('showerDetailsResponse', showerDetails);
  }
  let showerInstallation = input.showerInstallationObservation ?? input.reuse?.showerInstallation;
  let showerInstallationMs = 0;
  const installednessContext = showerInstallationContext(
    showerUnderstanding,
    showerDetails,
    input.manualPlacements,
  );
  if ((input.refineShowerInstallation || showerInstallation) && input.profile !== 'cloud-browser-v1')
    throw new Error('샤워 설치 상태 독립 관측은 기존 Gemma 분석에만 연결돼요.');
  if (input.refineShowerInstallation && !showerInstallation) {
    const targets = showerObservationTargets(showerUnderstanding).filter(
      (candidate) => !installednessContext.protectedCandidateIds.has(candidate.id),
    );
    if (input.reuse && targets.length)
      throw new Error(
        '이전 결과에는 현재 샤워의 설치 상태 관측 계약이 없어요. 프로젝트는 보존했으며 AI를 자동 실행하지 않았어요. 새 분석을 명시적으로 실행해 주세요.',
      );
    if (!input.reuse) {
      input.onPhase?.('appearance');
      if (targets.length)
        input.onStage?.(`샤워 설치 상태 확인 중 · 대상 ${targets.length}개, 대상별 AI 관측 1단계 추가`);
      const started = performance.now();
      const result = await (dependencies.showerInstallation ?? analyzeShowerInstallations)(
        input.photo,
        installednessContext,
        input.signal,
        inventory.modelRevision,
      );
      assertActive(input.signal);
      showerInstallationMs = performance.now() - started;
      showerInstallation = result.record;
    }
  }
  if (showerInstallation) {
    showerInstallation = await validateShowerInstallationRecord(
      showerInstallation,
      input.photo,
      installednessContext,
      inventory.modelRevision,
      input.signal,
    );
    assertActive(input.signal);
    input.onCheckpoint?.('showerInstallationResponse', showerInstallation);
  }
  if (input.profile !== 'cloud-browser-v1') await resolveDividerStage();
  const understanding = input.understandingOverride ?? effective;
  if (
    Object.keys(input.manualPlacements ?? {}).some(
      (id) => !understanding.candidates.some((item) => item.id === id),
    )
  )
    throw new Error('수동 배치가 알 수 없는 설비를 참조해요.');
  input.onPhase?.('placement');
  input.onStage?.('관측한 공간 구조와 제품 기준점으로 위치·방향 검증 중');
  const placementStart = performance.now();
  let result = buildCandidatePipeline(
    understanding,
    input.baseline,
    input.room,
    input.image,
    input.manualPlacements,
    effective,
    input.toiletLidStates,
    { observation: geometry.observation, inputFingerprint: fingerprint },
    {
      candidateInputFingerprint: input.inputFingerprint,
      observationInputFingerprint: input.inputFingerprint,
    },
    input.productColors,
    input.pedestalShapes,
    undefined,
    providerForModel(inventory.modelId) === 'cloudflare-workers-ai' ? 'gemma' : 'qwen',
  );
  assertActive(input.signal);
  let layout: LocalLayoutAnalysis | undefined;
  let layoutMs = 0;
  if (input.estimatedLayout) {
    layout = input.layoutObservation ?? input.reuse?.layout;
    if (
      !layout &&
      !input.reuse &&
      effective.candidates.some((candidate) => candidate.reflection !== 'reflected')
    ) {
      input.onPhase?.('layout');
      input.onStage?.('설비의 설치 벽과 앞뒤 관계를 별도로 확인 중');
      const started = performance.now();
      layout = await (dependencies.layout ?? analyzeLayout)(input.photo, effective, input.signal);
      layoutMs = performance.now() - started;
      assertActive(input.signal);
    }
    if (layout) {
      if (
        layout.outputContract !== LAYOUT_OUTPUT_CONTRACT ||
        layout.promptRevision !== LAYOUT_PROMPT_REVISION ||
        layout.modelId !== inventory.modelId ||
        layout.modelRevision !== inventory.modelRevision ||
        layout.photoFingerprint !== fingerprint ||
        layout.inventorySignature !== layoutInventorySignature(effective)
      )
        throw new Error('공간 관계 관측이 현재 사진·후보·모델과 달라요. 이전 결과는 보존했어요.');
      const checked = parseLayoutObservation(layout.rawText, effective);
      if (
        canonicalEvidence(checked.observations) !== canonicalEvidence(layout.observations) ||
        canonicalEvidence(checked.relations) !== canonicalEvidence(layout.relations)
      )
        throw new Error('공간 관계 원문과 적용하려는 관측이 달라요.');
      layout = { ...structuredClone(layout), ...checked };
      input.onCheckpoint?.('layoutResponse', layout);
    }
    input.onPhase?.('placement');
    input.onStage?.('관측 관계와 기본 규격으로 수정 가능한 추정 배치 계산 중');
    result = buildEstimatedCandidatePipeline({
      strictResult: result,
      understanding,
      baseline: input.baseline,
      room: input.room,
      image: input.image,
      manualIdSet: new Set(Object.keys(input.manualPlacements ?? {})),
      layoutObservation: layout,
      appearance: effectiveAppearance,
      showerDetails: showerDetails?.observations,
      showerInstallationDecisions: showerInstallation?.decisions,
      dividerApplication,
      depthWallEvidence: { observation: geometry.observation, expectedInputFingerprint: fingerprint },
    });
  }
  const evidence: ReconstructionQualityEvidence = {
    version: 1,
    revision: input.profile === 'cloud-browser-v1' ? CLOUD_BROWSER_QUALITY_REVISION : LOCAL_QUALITY_REVISION,
    photoFingerprint: fingerprint,
    image: { ...input.image },
    inventory: structuredClone(inventory),
    identity: structuredClone(identity),
    installation: structuredClone(installation),
    geometry: structuredClone(geometry),
    effectiveUnderstanding: effective,
    ...(layout ? { layout } : {}),
    ...(appearance ? { appearance } : {}),
    ...(showerDetails ? { showerDetails } : {}),
    ...(showerInstallation ? { showerInstallation } : {}),
    ...(dividerMaterials ? { dividerMaterials, dividerApplication } : {}),
    ...(reflectionRecheck ? { reflectionRecheck } : {}),
    ...(classificationResolution ? { classificationResolution } : {}),
    placementPolicy: input.estimatedLayout ? 'visible-relation-estimate' : 'strict',
    timing: {
      inventoryMs,
      identityMs,
      installationMs,
      geometryMs,
      layoutMs,
      appearanceMs,
      showerDetailsMs,
      showerInstallationMs,
      dividerMaterialsMs,
      reflectionRecheckMs,
      placementMs: performance.now() - placementStart - layoutMs,
      totalMs: performance.now() - start,
    },
    reused: !!input.reuse,
  };
  for (const decision of classificationResolution?.decisions ?? []) {
    if (!decision.needsReview) continue;
    const candidate = result.review.candidates.find((c) => c.id === decision.candidateId);
    if (candidate) {
      candidate.requiresReview = true;
      candidate.warning = [...decision.reasons, candidate.warning].filter(Boolean).join(' ');
    }
  }
  result.review.analysisProfile = input.profile ?? 'local-quality-v1';
  result.review.analysisSummary = {
    profile: input.profile ?? 'local-quality-v1',
    revision: input.profile === 'cloud-browser-v1' ? CLOUD_BROWSER_QUALITY_REVISION : LOCAL_QUALITY_REVISION,
    modelId: inventory.modelId,
    modelRevision: inventory.modelRevision,
    geometryModelId: geometry.observation.model.id,
    geometryModelRevision: geometry.observation.model.revision,
    cameraStatus: result.pipeline.camera.status,
    placementPolicy: input.estimatedLayout ? 'visible-relation-estimate' : 'strict',
    ...(input.estimatedLayout ? { layoutRevision: ESTIMATED_LAYOUT_REVISION } : {}),
    estimated: true,
  };
  input.onCheckpoint?.('qualityEvidence', evidence);
  input.onCheckpoint?.('candidatePipeline', result.pipeline);
  return { ...result, evidence, model: inventory };
}

/** Protect only current observation IDs; keep all caller-owned placements intact. */
function manualReflectionProtection(
  appearance: LocalFixtureAppearanceAnalysis,
  manualPlacements: QualityRunInput['manualPlacements'],
): ReadonlySet<string> {
  return new Set(
    appearance.understanding.candidates
      .filter(({ id }) => Object.hasOwn(manualPlacements ?? {}, id))
      .map(({ id }) => id),
  );
}

function validateAppearanceAnalysis(
  value: LocalFixtureAppearanceAnalysis,
  inventory: SceneUnderstanding,
  fingerprint: string,
  model: LocalSceneAnalysis,
): LocalFixtureAppearanceAnalysis {
  if (
    value.outputContract !== FIXTURE_APPEARANCE_CONTRACT ||
    value.promptRevision !== FIXTURE_APPEARANCE_PROMPT_REVISION ||
    value.modelId !== model.modelId ||
    value.modelRevision !== model.modelRevision ||
    value.photoFingerprint !== fingerprint ||
    value.inventorySignature !== layoutInventorySignature(inventory)
  )
    throw new Error('형태 관측이 현재 사진·후보·모델과 달라요. 이전 결과는 보존했어요.');
  if (providerForModel(model.modelId) === 'cloudflare-workers-ai') requireCloudGemmaAppearanceContract(value);
  const parsed = parseFixtureAppearance(value.rawText, inventory);
  for (const key of [
    'understanding',
    'observations',
    'decisions',
    'modelOptions',
    'duplicates',
    'ruleRevision',
  ] as const)
    if (canonicalEvidence(parsed[key]) !== canonicalEvidence(value[key]))
      throw new Error('형태 원문과 적용하려는 교정·중복 정보가 달라요.');
  return { ...structuredClone(value), ...parsed };
}

function validateShowerAnalysis(
  value: LocalShowerAnalysis,
  inventory: SceneUnderstanding,
  fingerprint: string,
  model: LocalSceneAnalysis,
): LocalShowerAnalysis {
  if (
    value.outputContract !== SHOWER_OBSERVATION_CONTRACT ||
    value.promptRevision !== SHOWER_OBSERVATION_PROMPT_REVISION ||
    value.modelId !== model.modelId ||
    value.modelRevision !== model.modelRevision ||
    value.photoFingerprint !== fingerprint ||
    value.inventorySignature !== layoutInventorySignature(inventory) ||
    !/^[a-f0-9]{64}$/.test(value.modelInputSha256)
  )
    throw new Error('샤워 세부 관측이 현재 사진·후보·모델과 달라요.');
  const parsed = parseShowerObservation(value.rawText, inventory);
  if (canonicalEvidence(parsed.observations) !== canonicalEvidence(value.observations))
    throw new Error('샤워 세부 원문과 적용 관측이 달라요.');
  return { ...structuredClone(value), ...parsed };
}

async function validateReflectionRecord(
  value: ReflectionRecheckEvidence,
  photo: Blob,
  context: ReflectionRecheckContext,
  fingerprint: string,
  image: QualityRunInput['image'],
  model: LocalSceneAnalysis,
  signal: AbortSignal,
) {
  if (
    value.version !== 1 ||
    value.ruleRevision !== REFLECTION_RECHECK_RULE_REVISION ||
    value.photoFingerprint !== fingerprint ||
    canonicalEvidence(value.image) !== canonicalEvidence(image)
  )
    throw new Error('거울 재확인 기록이 현재 사진·계약과 달라요.');
  const expected = await prepareReflectionRecheckRequests(
    photo,
    context,
    model.modelRevision,
    signal,
    providerForModel(model.modelId),
  );
  assertActive(signal);
  const checked = await applyReflectionRechecks({
    ...context,
    expected: {
      photoFingerprint: fingerprint,
      image,
      modelId: model.modelId,
      modelRevision: model.modelRevision,
      requests: expected.requests,
    },
    observations: value.observations,
  });
  if (canonicalEvidence(checked.record) !== canonicalEvidence(value))
    throw new Error('거울 재확인 원문·입력과 저장된 한 필드 보정 기록이 달라요.');
  return checked;
}

function validateDividerAnalysis(
  value: LocalDividerAnalysis,
  inventory: SceneUnderstanding,
  targets: readonly DividerTarget[],
  fingerprint: string,
  model: LocalSceneAnalysis,
): LocalDividerAnalysis {
  if (
    value.outputContract !== DIVIDER_OBSERVATION_CONTRACT ||
    value.promptRevision !== DIVIDER_OBSERVATION_PROMPT_REVISION ||
    value.modelId !== model.modelId ||
    value.modelRevision !== model.modelRevision ||
    value.photoFingerprint !== fingerprint ||
    value.inventorySignature !== layoutInventorySignature(inventory) ||
    value.targetsSignature !== dividerTargetsSignature(targets) ||
    !/^[a-f0-9]{64}$/.test(value.modelInputSha256)
  )
    throw new Error('칸막이 재질 관측이 현재 사진·원후보·모델과 달라요.');
  const parsed = parseDividerObservation(value.rawText, targets);
  if (
    canonicalEvidence(parsed.observations) !== canonicalEvidence(value.observations) ||
    canonicalEvidence(parsed.warnings) !== canonicalEvidence(value.warnings)
  )
    throw new Error('칸막이 재질 원문과 적용하려는 관측이 달라요.');
  return { ...structuredClone(value), ...parsed };
}

function showerInstallationContext(
  understanding: SceneUnderstanding,
  details: LocalShowerAnalysis | undefined,
  manualPlacements: QualityRunInput['manualPlacements'],
): ShowerInstallationContext {
  return {
    understanding: structuredClone(understanding),
    sourceDecisionSignature: canonicalEvidence({
      understanding,
      showerDetails: details
        ? {
            outputContract: details.outputContract,
            promptRevision: details.promptRevision,
            modelId: details.modelId,
            modelRevision: details.modelRevision,
            rawText: details.rawText,
            photoFingerprint: details.photoFingerprint,
            modelInputSha256: details.modelInputSha256,
          }
        : null,
    }),
    protectedCandidateIds: new Set(
      understanding.candidates
        .filter(
          (candidate) =>
            Object.hasOwn(manualPlacements ?? {}, candidate.id) ||
            Object.values(candidate.provenance ?? {}).includes('user'),
        )
        .map((candidate) => candidate.id),
    ),
  };
}
