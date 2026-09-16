import { CLOUD_GEMMA_MODEL, CLOUD_GEMMA_REVISION } from './cloud-gemma-contract';
import {
  SHOWER_INSTALLATION_CONTRACT, SHOWER_INSTALLATION_PROMPT_REVISION, SHOWER_INSTALLATION_DECISION_REVISION,
  createShowerInstallationReceipt, validateShowerInstallationAnalysis, decideShowerInstallation,
  type ShowerInstallationContext, type ShowerInstallationRecord, type ShowerInstallationReceipt, type ShowerInstallationAnalysis,
} from './shower-installation-observation';
import { showerObservationTargets } from './shower-observation';
import { canonicalTargetValue } from './target-existence-observation';
import { requireCloudGemmaAppearanceContract } from './cloud-gemma-appearance';
import { buildCloudFixtureCropBoard, validateCloudFixtureCropReceipt } from './cloud-fixture-crops';
import { normalizeCloudGemmaOutput, parseCloudGemmaExtendedInventory } from './cloud-gemma-coordinates';
import {
  analysisModelId,
  validAnalysisResponse,
  validAnalysisModelPair,
  type AnalysisProvider,
} from './analysis-provider';
import { fetchAnalysis } from './analysis-transport';
import {
  DIVIDER_OBSERVATION_CONTRACT,
  DIVIDER_OBSERVATION_PROMPT_REVISION,
  parseDividerObservation,
  validateDividerTargetsForInventory,
  dividerTargetsSignature,
  type DividerTarget,
  type ParsedDividerObservation,
} from './divider-observation';
import { readImageHeader, previewDimensions } from '../images';
import {
  createTargetExistenceReceipt,
  targetExistenceCropTransform,
  targetExistenceSha256,
  validateTargetExistenceAnalysis,
  TARGET_EXISTENCE_CONTRACT,
  TARGET_EXISTENCE_PROMPT_REVISION,
  type TargetExistenceReceipt,
  type TargetExistenceAnalysis,
} from './target-existence-observation';
import {
  applyReflectionRechecks,
  reflectionRecheckCandidates,
  reflectionRecheckSignature,
  type ReflectionRecheckContext,
  type ReflectionRecheckEvidence,
} from './reflection-recheck';
import {
  SHOWER_OBSERVATION_CONTRACT,
  SHOWER_OBSERVATION_PROMPT_REVISION,
  parseShowerObservation,
  type ParsedShowerObservation,
} from './shower-observation';
import {
  FIXTURE_APPEARANCE_CONTRACT,
  FIXTURE_APPEARANCE_PROMPT_REVISION,
  parseFixtureAppearance,
  type LocalFixtureAppearanceAnalysis,
} from './fixture-appearance-observation';
import {
  IDENTITY_OUTPUT_CONTRACT,
  IDENTITY_PROMPT_REVISION,
  identityObservationTargets,
  skippedIdentityAnalysis,
  parseIdentityObservation,
  type LocalIdentityAnalysis,
} from './identity-observation';
export type { LocalIdentityAnalysis } from './identity-observation';
import { canvasBlob } from '../images';
import { parseSceneUnderstanding } from './scene-understanding';
import {
  parseFixtureInventory,
  isFixtureInventoryOutputContract,
  EXTENDED_INVENTORY_OUTPUT_CONTRACT,
  EXTENDED_INVENTORY_PROMPT_REVISION,
  type FixtureInventoryOutputContract,
} from './inventory-observation';
import type { LocalModelMeasurement } from './lab-engine';
import {
  LAYOUT_OUTPUT_CONTRACT,
  LAYOUT_PROMPT_REVISION,
  parseLayoutObservation,
  layoutInventorySignature,
  type LocalLayoutAnalysis,
} from './layout-observation';
import type { SceneUnderstanding } from './pipeline-contract';

import {
  INSTALLATION_OUTPUT_CONTRACT,
  INSTALLATION_PROMPT_REVISION,
  validateInstallationInventory,
  skippedInstallationAnalysis,
  parseInstallationObservation,
  type LocalInstallationAnalysis,
} from './installation-observation';
export type { LocalInstallationAnalysis } from './installation-observation';

export class CandidateExperimentError extends Error {
  constructor(
    message: string,
    public readonly diagnostics?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'CandidateExperimentError';
  }
}
export type LocalSceneAnalysis = {
  /** Absent only on historical full-scene responses. Never guess the format from model text. */
  outputContract?: FixtureInventoryOutputContract;
  providerInventoryContract?: string;
  providerInventorySchemaRevision?: number;
  providerInventoryTransform?: string;
  /** Optional for historical saved/local records; current cloud appearance reuse requires both. */
  providerAppearanceContract?: string;
  providerAppearancePromptRevision?: number;
  understanding: SceneUnderstanding;
  rawText: string;
  measurement: LocalModelMeasurement;
  modelId: string;
  modelRevision: string;
  promptRevision: number;
  settings?: Record<string, string | number | boolean>;
  completion?: {
    done: boolean;
    doneReason?: string;
    runtimeError?: string;
    inputTokens?: number;
    outputTokens?: number;
    outputTokenLimit: number;
  };
};
async function prepareLocalPhoto(photo: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(photo);
  let input: Blob;
  try {
    const scale = Math.min(1, 1024 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('후보 분석용 사진을 준비하지 못했어요.');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    input = await canvasBlob(canvas, 'image/jpeg', 0.95);
    canvas.width = canvas.height = 1;
  } finally {
    bitmap.close();
  }
  return input;
}
export async function analyzeScene(
  photo: Blob,
  signal: AbortSignal,
  provider: AnalysisProvider = 'cloudflare-workers-ai',
): Promise<LocalSceneAnalysis> {
  return analyzeInventory(photo, signal, provider === 'cloudflare-workers-ai', provider);
}
export async function analyzeExtendedScene(
  photo: Blob,
  signal: AbortSignal,
  provider: AnalysisProvider = 'cloudflare-workers-ai',
): Promise<LocalSceneAnalysis> {
  return analyzeInventory(photo, signal, true, provider);
}
async function analyzeInventory(
  photo: Blob,
  signal: AbortSignal,
  extended: boolean,
  provider: AnalysisProvider = 'cloudflare-workers-ai',
): Promise<LocalSceneAnalysis> {
  const input = await prepareLocalPhoto(photo);
  if (signal.aborted) throw new DOMException('후보 분석을 취소했어요.', 'AbortError');
  const form = new FormData();
  form.set('operation', 'inventory-extended');
  form.set('photo', input, 'photo.jpg');
  const response = await fetchAnalysis(
    provider,
    {
      method: 'POST',
      signal,
      headers: extended
        ? { 'X-SJN-Analysis': 'cloud-explicit' }
        : { 'Content-Type': input.type, 'X-SJN-Analysis': 'cloud-explicit' },
      body: extended ? form : input,
    },
  );
  const result = await response.json();
  if (signal.aborted) throw new DOMException('후보 분석을 취소했어요.', 'AbortError');
  if (!response.ok || result.error)
    throw new CandidateExperimentError(result.error ?? '설비 분석에 실패했어요.', result.diagnostics);
  if (!validAnalysisResponse(result, provider)) throw new Error('실험 모델의 실행 정보를 확인할 수 없어요.');
  try {
    if (
      extended &&
      (result.outputContract !== EXTENDED_INVENTORY_OUTPUT_CONTRACT ||
        result.promptRevision !== EXTENDED_INVENTORY_PROMPT_REVISION)
    )
      throw new Error('확장 관측의 계약 또는 프롬프트가 요청한 실험과 달라요.');
    if (result.outputContract !== undefined && !isFixtureInventoryOutputContract(result.outputContract))
      throw new Error('지원하지 않는 후보 모델 출력 형식이에요. 원문과 형식을 보존했어요.');
    const understanding = provider === 'cloudflare-workers-ai' && extended
      ? parseCloudGemmaExtendedInventory(result).understanding
      : isFixtureInventoryOutputContract(result.outputContract)
      ? parseFixtureInventory(
          provider === 'cloudflare-workers-ai'
            ? normalizeCloudGemmaOutput(result.rawText, extended ? 'inventory-extended' : 'inventory')
            : result.rawText,
          result.outputContract,
        ).understanding
      : parseSceneUnderstanding(result.rawText);
    return { ...result, understanding };
  } catch (error) {
    throw new CandidateExperimentError('후보 모델의 구조화 출력을 검증하지 못했어요.', {
      outputContract: result.outputContract,
      rawText: result.rawText,
      measurement: result.measurement,
      modelId: result.modelId,
      modelRevision: result.modelRevision,
      promptRevision: result.promptRevision,
      completion: result.completion,
      settings: result.settings,
      failure: {
        stage: 'client-response-validation',
        category:
          result.outputContract !== undefined && !isFixtureInventoryOutputContract(result.outputContract)
            ? 'unsupported-output-contract'
            : 'analysis-structure',
      },
      validationError: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Fixed-ID structural appearance is validated again locally; transported merges are never trusted. */
export async function analyzeFixtureAppearance(
  photo: Blob,
  inventory: SceneUnderstanding,
  signal: AbortSignal,
  provider: AnalysisProvider = 'cloudflare-workers-ai',
): Promise<LocalFixtureAppearanceAnalysis> {
  const original = validateInstallationInventory(inventory);
  if (signal.aborted) throw new DOMException('설비 형태 분석을 취소했어요.', 'AbortError');
  const input = await prepareLocalPhoto(photo);
  if (signal.aborted) throw new DOMException('설비 형태 분석을 취소했어요.', 'AbortError');
  const form = new FormData();
  form.set('operation', 'appearance');
  form.set('photo', input, 'photo.jpg');
  form.set('inventory', JSON.stringify(original));
  const appearanceCrops =
    provider === 'cloudflare-workers-ai'
      ? await buildCloudFixtureCropBoard(input, original.candidates, signal)
      : undefined;
  if (appearanceCrops) {
    form.set('appearanceBoard', appearanceCrops.board, 'appearance-board.jpg');
    form.set('appearanceReceipt', JSON.stringify(appearanceCrops.receipt));
  }
  if (signal.aborted) throw new DOMException('설비 형태 분석을 취소했어요.', 'AbortError');
  const response = await fetchAnalysis(provider, {
    method: 'POST',
    signal,
    headers: { 'X-SJN-Analysis': 'cloud-explicit' },
    body: form,
  });
  const result = await response.json();
  if (signal.aborted) throw new DOMException('설비 형태 분석을 취소했어요.', 'AbortError');
  if (!response.ok || result.error)
    throw new CandidateExperimentError(result.error ?? '설비 형태 분석에 실패했어요.', result.diagnostics);
  try {
    if (
      result.outputContract !== FIXTURE_APPEARANCE_CONTRACT ||
      result.promptRevision !== FIXTURE_APPEARANCE_PROMPT_REVISION ||
      !validAnalysisResponse(result, provider)
    )
      throw new Error('설비 형태 관측의 계약 또는 모델 정보를 확인할 수 없어요.');
    if (appearanceCrops) {
      requireCloudGemmaAppearanceContract(result);
      await validateCloudFixtureCropReceipt(
        result.appearanceReceipt,
        new Uint8Array(await input.arrayBuffer()),
        new Uint8Array(await appearanceCrops.board.arrayBuffer()),
        original.candidates,
      );
    }
    const photoFingerprint = Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', await photo.arrayBuffer())),
      (value) => value.toString(16).padStart(2, '0'),
    ).join('');
    if (signal.aborted) throw new DOMException('설비 형태 분석을 취소했어요.', 'AbortError');
    return { ...result, ...parseFixtureAppearance(result.rawText, original), photoFingerprint };
  } catch (cause) {
    throw new CandidateExperimentError('설비 형태 관측을 검증하지 못했어요.', {
      ...result,
      validationError: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

/** Fixed-ID layout evidence stays separate from physical coordinates and the original inventory. */
export async function analyzeLayout(
  photo: Blob,
  inventory: SceneUnderstanding,
  signal: AbortSignal,
  provider: AnalysisProvider = 'cloudflare-workers-ai',
): Promise<LocalLayoutAnalysis> {
  const original = validateInstallationInventory(inventory);
  if (signal.aborted) throw new DOMException('공간 관계 분석을 취소했어요.', 'AbortError');
  const input = await prepareLocalPhoto(photo);
  if (signal.aborted) throw new DOMException('공간 관계 분석을 취소했어요.', 'AbortError');
  const form = new FormData();
  form.set('operation', 'layout');
  form.set('photo', input, 'photo.jpg');
  form.set('inventory', JSON.stringify(original));
  const response = await fetchAnalysis(provider, {
    method: 'POST',
    signal,
    headers: { 'X-SJN-Analysis': 'cloud-explicit' },
    body: form,
  });
  const result = await response.json();
  if (signal.aborted) throw new DOMException('공간 관계 분석을 취소했어요.', 'AbortError');
  if (!response.ok || result.error)
    throw new CandidateExperimentError(result.error ?? '공간 관계 분석에 실패했어요.', result.diagnostics);
  try {
    if (
      result.outputContract !== LAYOUT_OUTPUT_CONTRACT ||
      result.promptRevision !== LAYOUT_PROMPT_REVISION ||
      !validAnalysisResponse(result, provider)
    )
      throw new Error('공간 관계 관측의 계약 또는 모델 정보를 확인할 수 없어요.');
    const photoFingerprint = Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', await photo.arrayBuffer())),
      (value) => value.toString(16).padStart(2, '0'),
    ).join('');
    if (signal.aborted) throw new DOMException('공간 관계 분석을 취소했어요.', 'AbortError');
    return { ...result, ...parseLayoutObservation(result.rawText, original), photoFingerprint };
  } catch (cause) {
    throw new CandidateExperimentError('공간 관계 관측을 검증하지 못했어요.', {
      ...result,
      validationError: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

/** Second pass is bound to a snapshot of the first inventory; never trust a transported merge. */
export async function analyzeInstallation(
  photo: Blob,
  inventory: SceneUnderstanding,
  signal: AbortSignal,
  provider: AnalysisProvider = 'cloudflare-workers-ai',
): Promise<LocalInstallationAnalysis> {
  if (signal.aborted) throw new DOMException('설치 분석을 취소했어요.', 'AbortError');
  const original = validateInstallationInventory(inventory);
  if (!original.candidates.length)
    return { ...skippedInstallationAnalysis(original), modelId: analysisModelId(provider) };
  const input = await prepareLocalPhoto(photo);
  if (signal.aborted) throw new DOMException('설치 분석을 취소했어요.', 'AbortError');
  const form = new FormData();
  form.set('operation', 'installation');
  form.set('photo', input, 'photo.jpg');
  form.set('inventory', JSON.stringify(original));
  const response = await fetchAnalysis(provider, {
    method: 'POST',
    signal,
    headers: { 'X-SJN-Analysis': 'cloud-explicit' },
    body: form,
  });
  const result = await response.json();
  if (signal.aborted) throw new DOMException('설치 분석을 취소했어요.', 'AbortError');
  if (!response.ok || result.error)
    throw new CandidateExperimentError(result.error ?? '설치 분석에 실패했어요.', result.diagnostics);
  try {
    if (
      result.outputContract !== INSTALLATION_OUTPUT_CONTRACT ||
      result.promptRevision !== INSTALLATION_PROMPT_REVISION
    )
      throw new Error('지원하지 않는 설치 관측 출력 형식이에요.');
    if (!validAnalysisResponse(result, provider))
      throw new Error('설치 관측 모델의 실행 정보를 확인할 수 없어요.');
    const checked = parseInstallationObservation(result.rawText, original);
    return { ...result, ...checked };
  } catch (error) {
    throw new CandidateExperimentError('설치 관측의 구조화 출력을 검증하지 못했어요.', {
      outputContract: result.outputContract,
      rawText: result.rawText,
      measurement: result.measurement,
      modelId: result.modelId,
      modelRevision: result.modelRevision,
      promptRevision: result.promptRevision,
      completion: result.completion,
      settings: result.settings,
      failure: { stage: 'client-response-validation', category: 'installation-structure' },
      validationError: error instanceof Error ? error.message : String(error),
    });
  }
}

/** A fixed-ID second look. Revalidate its raw response against the captured original inventory. */
export async function analyzeIdentity(
  photo: Blob,
  inventory: SceneUnderstanding,
  signal: AbortSignal,
  provider: AnalysisProvider = 'cloudflare-workers-ai',
): Promise<LocalIdentityAnalysis> {
  if (signal.aborted) throw new DOMException('형태 분석을 취소했어요.', 'AbortError');
  const original = validateInstallationInventory(inventory);
  if (!identityObservationTargets(original).length)
    return { ...skippedIdentityAnalysis(original), modelId: analysisModelId(provider) };
  const input = await prepareLocalPhoto(photo);
  if (signal.aborted) throw new DOMException('형태 분석을 취소했어요.', 'AbortError');
  const form = new FormData();
  form.set('operation', 'identity');
  form.set('photo', input, 'photo.jpg');
  form.set('inventory', JSON.stringify(original));
  const response = await fetchAnalysis(provider, {
    method: 'POST',
    signal,
    headers: { 'X-SJN-Analysis': 'cloud-explicit' },
    body: form,
  });
  const result = await response.json();
  if (signal.aborted) throw new DOMException('형태 분석을 취소했어요.', 'AbortError');
  if (!response.ok || result.error)
    throw new CandidateExperimentError(result.error ?? '로컬 형태 분석에 실패했어요.', result.diagnostics);
  try {
    if (
      result.outputContract !== IDENTITY_OUTPUT_CONTRACT ||
      result.promptRevision !== IDENTITY_PROMPT_REVISION
    )
      throw new Error('지원하지 않는 형태 관측 출력 형식이에요.');
    if (!validAnalysisResponse(result, provider))
      throw new Error('형태 관측 모델의 실행 정보를 확인할 수 없어요.');
    return { ...result, ...parseIdentityObservation(result.rawText, original) };
  } catch (error) {
    throw new CandidateExperimentError('형태 관측의 구조화 출력을 검증하지 못했어요.', {
      outputContract: result.outputContract,
      rawText: result.rawText,
      measurement: result.measurement,
      modelId: result.modelId,
      modelRevision: result.modelRevision,
      promptRevision: result.promptRevision,
      completion: result.completion,
      settings: result.settings,
      failure: { stage: 'client-response-validation', category: 'identity-structure' },
      validationError: error instanceof Error ? error.message : String(error),
    });
  }
}

export type LocalShowerAnalysis = Omit<LocalSceneAnalysis, 'outputContract' | 'understanding'> &
  ParsedShowerObservation & {
    outputContract: typeof SHOWER_OBSERVATION_CONTRACT;
    photoFingerprint: string;
    modelInputSha256: string;
  };
/** The source fingerprint and actual normalized model bytes are deliberately distinct. */
export async function analyzeShowerDetails(
  photo: Blob,
  inventory: SceneUnderstanding,
  signal: AbortSignal,
  provider: AnalysisProvider = 'cloudflare-workers-ai',
): Promise<LocalShowerAnalysis> {
  const original = validateInstallationInventory(inventory);
  const input = await prepareLocalPhoto(photo);
  const digest = async (blob: Blob) =>
    Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())), (value) =>
      value.toString(16).padStart(2, '0'),
    ).join('');
  const photoFingerprint = await digest(photo),
    modelInputSha256 = await digest(input);
  if (signal.aborted) throw new DOMException('샤워 세부 관측을 취소했어요.', 'AbortError');
  const form = new FormData();
  form.set('operation', 'shower-detail');
  form.set('photo', input, 'photo.jpg');
  form.set('inventory', JSON.stringify(original));
  const response = await fetchAnalysis(provider, {
    method: 'POST',
    body: form,
    headers: { 'X-SJN-Analysis': 'cloud-explicit' },
    signal,
  });
  const result = await response.json();
  if (signal.aborted) throw new DOMException('샤워 세부 관측을 취소했어요.', 'AbortError');
  if (!response.ok || result.error)
    throw new CandidateExperimentError(result.error ?? '샤워 세부 관측에 실패했어요.', result.diagnostics);
  try {
    if (
      result.outputContract !== SHOWER_OBSERVATION_CONTRACT ||
      result.promptRevision !== SHOWER_OBSERVATION_PROMPT_REVISION ||
      !validAnalysisResponse(result, provider) ||
      result.modelInputSha256 !== modelInputSha256
    )
      throw new Error('샤워 세부 관측의 입력·계약·모델 정보가 달라요.');
    return {
      ...result,
      ...parseShowerObservation(result.rawText, original),
      photoFingerprint,
      modelInputSha256,
    };
  } catch (cause) {
    throw new CandidateExperimentError('샤워 세부 관측을 검증하지 못했어요.', {
      ...result,
      validationError: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

export type LocalDividerAnalysis = Omit<LocalSceneAnalysis, 'outputContract' | 'understanding'> &
  ParsedDividerObservation & {
    outputContract: typeof DIVIDER_OBSERVATION_CONTRACT;
    inventorySignature: string;
    photoFingerprint: string;
    modelInputSha256: string;
    targetsSignature: string;
  };
/** Observe only verified fixed regions; selection and any later application belong to the caller. */
export async function analyzeDividerMaterials(
  photo: Blob,
  inventory: SceneUnderstanding,
  targets: readonly DividerTarget[],
  signal: AbortSignal,
  provider: AnalysisProvider = 'cloudflare-workers-ai',
): Promise<LocalDividerAnalysis> {
  const cancelled = () => {
    if (signal.aborted) throw new DOMException('칸막이 재질 관측을 취소했어요.', 'AbortError');
  };
  cancelled();
  const original = validateInstallationInventory(inventory),
    fixed = validateDividerTargetsForInventory(original, targets);
  const inventorySignature = layoutInventorySignature(original),
    targetsSignature = dividerTargetsSignature(fixed);
  const input = await prepareLocalPhoto(photo);
  cancelled();
  const digest = async (blob: Blob) =>
    Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())), (value) =>
      value.toString(16).padStart(2, '0'),
    ).join('');
  const photoFingerprint = await digest(photo),
    modelInputSha256 = await digest(input);
  cancelled();
  const form = new FormData();
  form.set('operation', 'divider-material');
  form.set('photo', input, 'photo.jpg');
  form.set('inventory', JSON.stringify(original));
  form.set('targets', JSON.stringify(fixed));
  form.set('modelInputSha256', modelInputSha256);
  const response = await fetchAnalysis(provider, {
    method: 'POST',
    body: form,
    headers: { 'X-SJN-Analysis': 'cloud-explicit' },
    signal,
  });
  const result = await response.json();
  cancelled();
  if (!response.ok || result.error)
    throw new CandidateExperimentError(result.error ?? '칸막이 재질 관측에 실패했어요.', result.diagnostics);
  try {
    if (
      result.outputContract !== DIVIDER_OBSERVATION_CONTRACT ||
      result.promptRevision !== DIVIDER_OBSERVATION_PROMPT_REVISION ||
      !validAnalysisResponse(result, provider) ||
      result.modelInputSha256 !== modelInputSha256 ||
      result.inventorySignature !== inventorySignature ||
      result.targetsSignature !== targetsSignature ||
      result.completion?.done !== true ||
      result.completion?.doneReason === 'length' ||
      result.completion?.runtimeError
    )
      throw new Error('칸막이 관측의 입력·영역·목록·계약·완료 정보가 달라요.');
    return {
      ...result,
      ...parseDividerObservation(result.rawText, fixed),
      outputContract: DIVIDER_OBSERVATION_CONTRACT,
      inventorySignature,
      targetsSignature,
      photoFingerprint,
      modelInputSha256,
    };
  } catch (cause) {
    throw new CandidateExperimentError('칸막이 재질 관측을 검증하지 못했어요.', {
      ...result,
      validationError: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

export type PreparedReflectionRechecks = {
  requests: TargetExistenceReceipt[];
  inputs: { receipt: TargetExistenceReceipt; fullPhoto: Blob; cropPhoto: Blob }[];
  photoFingerprint: string;
  image: { width: number; height: number };
};
function checkReflectionAbort(signal: AbortSignal) {
  if (signal.aborted) throw new DOMException('거울 표면 재확인을 취소했어요.', 'AbortError');
}
/** No network. All model images come from one pinned normalized preview bitmap. */
export async function prepareReflectionRecheckRequests(
  photo: Blob,
  context: ReflectionRecheckContext,
  expectedModelRevision: string,
  signal: AbortSignal,
  provider: AnalysisProvider = 'cloudflare-workers-ai',
): Promise<PreparedReflectionRechecks> {
  checkReflectionAbort(signal);
  const original = structuredClone(context);
  const eligible = reflectionRecheckCandidates(original).filter((e) => e.eligible);
  if (!validAnalysisModelPair(analysisModelId(provider), expectedModelRevision))
    throw new Error('거울 재확인 모델 revision이 올바르지 않아요.');
  const photoBytes = new Uint8Array(await photo.arrayBuffer());
  const header = readImageHeader(photoBytes),
    image = { width: header.width, height: header.height };
  if (Math.max(image.width, image.height) > 2048)
    throw new Error('정규화된 미리보기 사진으로 재확인해 주세요.');
  const photoFingerprint = await targetExistenceSha256(photoBytes);
  checkReflectionAbort(signal);
  const result: PreparedReflectionRechecks = { requests: [], inputs: [], photoFingerprint, image };
  if (!eligible.length) return result;
  const boxes = original.appearance.understanding.candidates.map(({ id, bounds }) => ({ id, bounds }));
  const sourceDecisionSignature = reflectionRecheckSignature(original);
  const bitmap = await createImageBitmap(photo);
  try {
    if (bitmap.width !== image.width || bitmap.height !== image.height)
      throw new Error('정규화 사진의 디코딩 크기가 헤더와 달라요.');
    const encode = async (
      rect: { left: number; top: number; width: number; height: number },
      edge: number,
    ) => {
      const size = previewDimensions(rect.width, rect.height, edge),
        canvas = document.createElement('canvas');
      canvas.width = size.width;
      canvas.height = size.height;
      try {
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('거울 재확인 사진을 준비하지 못했어요.');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(
          bitmap,
          rect.left,
          rect.top,
          rect.width,
          rect.height,
          0,
          0,
          canvas.width,
          canvas.height,
        );
        return await canvasBlob(canvas, 'image/jpeg', 0.95);
      } finally {
        canvas.width = canvas.height = 1;
      }
    };
    const fullPhoto = await encode({ left: 0, top: 0, ...image }, 1024);
    const normalizedFullBytes = new Uint8Array(await fullPhoto.arrayBuffer());
    for (const entry of eligible) {
      checkReflectionAbort(signal);
      const cropTransform = targetExistenceCropTransform(
        image,
        boxes.find((b) => b.id === entry.candidateId)!.bounds,
      );
      const cropPhoto = await encode(cropTransform, 768);
      const receipt = await createTargetExistenceReceipt({
        photoBytes,
        normalizedFullBytes,
        cropBytes: new Uint8Array(await cropPhoto.arrayBuffer()),
        expectedPhotoFingerprint: photoFingerprint,
        targetId: entry.candidateId,
        boxes,
        cropTransform,
        sourceDecisionSignature,
        modelId: analysisModelId(provider),
        modelRevision: expectedModelRevision,
      });
      checkReflectionAbort(signal);
      result.requests.push(receipt);
      result.inputs.push({ receipt, fullPhoto, cropPhoto });
    }
    return result;
  } finally {
    bitmap.close();
  }
}
export type LocalReflectionRecheckAnalysis = {
  understanding: SceneUnderstanding;
  record: ReflectionRecheckEvidence;
  measurements: { candidateId: string; measurement: LocalModelMeasurement }[];
};
/** A narrow observation of conflicting mirror context; never apply unrelated model fields. */
export async function analyzeReflectionRechecks(
  photo: Blob,
  context: ReflectionRecheckContext,
  signal: AbortSignal,
  expectedModelRevision: string,
  provider: AnalysisProvider = 'cloudflare-workers-ai',
  onMeasurement?: (candidateId: string, measurement: LocalModelMeasurement) => void,
): Promise<LocalReflectionRecheckAnalysis> {
  const original = structuredClone(context);
  const prepared = await prepareReflectionRecheckRequests(
    photo,
    original,
    expectedModelRevision,
    signal,
    provider,
  );
  const observations: TargetExistenceAnalysis[] = [],
    measurements: LocalReflectionRecheckAnalysis['measurements'] = [];
  for (const input of prepared.inputs) {
    checkReflectionAbort(signal);
    const form = new FormData();
    form.set('operation', 'target-existence');
    form.set('photo', input.fullPhoto, 'full.jpg');
    form.set('crop', input.cropPhoto, 'crop.jpg');
    form.set('receipt', JSON.stringify(input.receipt));
    const response = await fetchAnalysis(provider, {
      method: 'POST',
      signal,
      headers: { 'X-SJN-Analysis': 'cloud-explicit' },
      body: form,
    });
    const result = await response.json();
    checkReflectionAbort(signal);
    if (!response.ok || result.error)
      throw new CandidateExperimentError(
        result.error ?? '거울 표면 재확인에 실패했어요.',
        result.diagnostics,
      );
    try {
      if (
        result.outputContract !== TARGET_EXISTENCE_CONTRACT ||
        result.promptRevision !== TARGET_EXISTENCE_PROMPT_REVISION ||
        !validAnalysisResponse(result, provider) ||
        result.modelRevision !== expectedModelRevision
      )
        throw new Error('거울 재확인의 계약·모델 정보가 달라요.');
      const observed = await validateTargetExistenceAnalysis(result, input.receipt);
      checkReflectionAbort(signal);
      observations.push(observed);
      measurements.push({ candidateId: input.receipt.targetId, measurement: result.measurement });
      onMeasurement?.(input.receipt.targetId, result.measurement);
    } catch (cause) {
      if (signal.aborted) throw new DOMException('거울 표면 재확인을 취소했어요.', 'AbortError');
      throw new CandidateExperimentError('거울 표면 재확인 입력과 원응답을 검증하지 못했어요.', {
        ...result,
        validationError: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }
  const applied = await applyReflectionRechecks({
    ...original,
    expected: {
      photoFingerprint: prepared.photoFingerprint,
      image: prepared.image,
      modelId: analysisModelId(provider),
      modelRevision: expectedModelRevision,
      requests: prepared.requests,
    },
    observations,
  });
  checkReflectionAbort(signal);
  return { ...applied, measurements };
}

export type PreparedShowerInstallations = {
  requests: ShowerInstallationReceipt[];
  inputs: { receipt: ShowerInstallationReceipt; fullPhoto: Blob; cropPhoto: Blob }[];
  photoFingerprint: string;
};
function checkShowerInstallationAbort(signal: AbortSignal) {
  if (signal.aborted) throw new DOMException('샤워 설치 상태 확인을 취소했어요.', 'AbortError');
}
/** One pinned source bitmap, the same full1024/crop768 transform tested by the independent probe. No network. */
export async function prepareShowerInstallationRequests(
  photo: Blob, context: ShowerInstallationContext, expectedModelRevision: string, signal: AbortSignal,
): Promise<PreparedShowerInstallations> {
  checkShowerInstallationAbort(signal);
  if (expectedModelRevision !== CLOUD_GEMMA_REVISION) throw new Error('설치 상태 관측의 Gemma revision이 달라요.');
  const original = structuredClone(context);
  // Prepare protected targets locally too, so historical observations can be checked without calling AI.
  const candidates = showerObservationTargets(original.understanding);
  const source = new Uint8Array(await photo.arrayBuffer()), header = readImageHeader(source);
  if (Math.max(header.width, header.height) > 2048) throw new Error('정규화된 원본 미리보기로 확인해 주세요.');
  const photoFingerprint = await targetExistenceSha256(source);
  const result: PreparedShowerInstallations = { requests: [], inputs: [], photoFingerprint };
  checkShowerInstallationAbort(signal);
  if (!candidates.length) return result;
  const bitmap = await createImageBitmap(photo), image = { width: header.width, height: header.height };
  try {
    if (bitmap.width !== image.width || bitmap.height !== image.height) throw new Error('사진 디코딩 크기가 원본과 달라요.');
    const encode = async (rect: { left: number; top: number; width: number; height: number }, edge: number) => {
      const size = previewDimensions(rect.width, rect.height, edge), canvas = document.createElement('canvas');
      canvas.width = size.width; canvas.height = size.height;
      try {
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('설치 상태 확대 사진을 준비하지 못했어요.');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(bitmap, rect.left, rect.top, rect.width, rect.height, 0, 0, canvas.width, canvas.height);
        return await canvasBlob(canvas, 'image/jpeg', 0.95);
      } finally { canvas.width = canvas.height = 1; }
    };
    const fullPhoto = await encode({ left: 0, top: 0, ...image }, 1024);
    const normalizedFullBytes = new Uint8Array(await fullPhoto.arrayBuffer());
    for (const candidate of candidates) {
      checkShowerInstallationAbort(signal);
      const cropTransform = targetExistenceCropTransform(image, candidate.bounds), cropPhoto = await encode(cropTransform, 768);
      const receipt = await createShowerInstallationReceipt({
        photoBytes: source, normalizedFullBytes, cropBytes: new Uint8Array(await cropPhoto.arrayBuffer()),
        expectedPhotoFingerprint: photoFingerprint, candidate, cropTransform,
        sourceDecisionSignature: original.sourceDecisionSignature, modelId: CLOUD_GEMMA_MODEL, modelRevision: expectedModelRevision,
      });
      checkShowerInstallationAbort(signal);
      result.requests.push(receipt); result.inputs.push({ receipt, fullPhoto, cropPhoto });
    }
    return result;
  } finally { bitmap.close(); }
}
function showerCandidateProtected(context: ShowerInstallationContext, id: string) {
  const candidate = context.understanding.candidates.find(value => value.id === id);
  return context.protectedCandidateIds.has(id) || Object.values(candidate?.provenance ?? {}).includes('user');
}
async function showerRecordDecisions(context: ShowerInstallationContext, prepared: PreparedShowerInstallations, observations: ShowerInstallationAnalysis[]) {
  const decisions = [];
  for (const observed of observations) {
    const candidate = context.understanding.candidates.find(value => value.id === observed.receipt.targetId);
    const expectedReceipt = prepared.requests.find(value => value.targetId === observed.receipt.targetId);
    if (!candidate || !expectedReceipt) throw new Error('설치 상태 관측이 현재 샤워 후보를 참조하지 않아요.');
    decisions.push(await decideShowerInstallation({ candidate, analysis: observed, expectedReceipt, protectedCandidateIds: context.protectedCandidateIds }));
  }
  return decisions;
}
/** Rebuild byte receipts and decisions before reusing saved observations. This function never calls AI. */
export async function validateShowerInstallationRecord(
  value: ShowerInstallationRecord, photo: Blob, context: ShowerInstallationContext,
  expectedModelRevision: string, signal: AbortSignal,
): Promise<ShowerInstallationRecord> {
  const record = structuredClone(value), original = structuredClone(context);
  if (record.version !== 1 || record.decisionRevision !== SHOWER_INSTALLATION_DECISION_REVISION ||
      record.modelId !== CLOUD_GEMMA_MODEL || record.modelRevision !== expectedModelRevision ||
      record.sourceDecisionSignature !== original.sourceDecisionSignature ||
      !Array.isArray(record.requests) || !Array.isArray(record.observations) || !Array.isArray(record.decisions) ||
      !Array.isArray(record.protectedCandidateIds) || record.requests.length > 24 ||
      record.requests.length !== record.observations.length || new Set(record.requests.map(x => x.targetId)).size !== record.requests.length ||
      new Set(record.observations.map(x => x.receipt.targetId)).size !== record.observations.length)
    throw new Error('보관된 설치 상태 관측의 계약·후보·완료 기록이 달라요.');
  const prepared = await prepareShowerInstallationRequests(photo, original, expectedModelRevision, signal);
  if (record.photoFingerprint !== prepared.photoFingerprint) throw new Error('설치 상태 관측의 원본 사진이 달라요.');
  for (const request of record.requests) {
    const expected = prepared.requests.find(x => x.targetId === request.targetId);
    if (!expected || canonicalTargetValue(request) !== canonicalTargetValue(expected)) throw new Error('설치 상태 관측의 full/crop 또는 이전 후보가 달라요.');
  }
  for (const request of prepared.requests) {
    if (!showerCandidateProtected(original, request.targetId) && !record.requests.some(x => x.targetId === request.targetId))
      throw new Error('보관 기록에 현재 샤워 대상의 설치 상태 관측이 없어요. 명시적으로 새 분석을 실행해 주세요.');
  }
  const observations: ShowerInstallationAnalysis[] = [];
  for (const request of record.requests) {
    const observed = record.observations.find(x => x.receipt.targetId === request.targetId);
    if (!observed) throw new Error('설치 상태 요청에 대응하는 원응답이 없어요.');
    observations.push(await validateShowerInstallationAnalysis(observed, request));
  }
  const protectedIds = [...new Set(record.protectedCandidateIds)].sort();
  if (protectedIds.some(id => !original.understanding.candidates.some(x => x.id === id)) ||
      canonicalTargetValue(protectedIds) !== canonicalTargetValue(record.protectedCandidateIds))
    throw new Error('보관된 수동 보호 후보 기록이 올바르지 않아요.');
  const oldDecisions = await showerRecordDecisions({ ...original, protectedCandidateIds: new Set(protectedIds) }, prepared, observations);
  if (canonicalTargetValue(oldDecisions) !== canonicalTargetValue(record.decisions)) throw new Error('설치 상태 원문과 보관된 적용 결정이 달라요.');
  const decisions = await showerRecordDecisions(original, prepared, observations);
  checkShowerInstallationAbort(signal);
  return { ...record, observations, decisions, protectedCandidateIds: [...original.protectedCandidateIds].sort() };
}
export type LocalShowerInstallationAnalysis = { record: ShowerInstallationRecord; measurements: { candidateId: string; measurement: LocalModelMeasurement }[] };
/** Adds at most one observation per unprotected physical shower target; no model or local-runtime fallback. */
export async function analyzeShowerInstallations(
  photo: Blob, context: ShowerInstallationContext, signal: AbortSignal, expectedModelRevision: string,
  onMeasurement?: (candidateId: string, measurement: LocalModelMeasurement) => void,
): Promise<LocalShowerInstallationAnalysis> {
  const original = structuredClone(context), prepared = await prepareShowerInstallationRequests(photo, original, expectedModelRevision, signal);
  const observations: ShowerInstallationAnalysis[] = [], requests: ShowerInstallationReceipt[] = [], measurements: LocalShowerInstallationAnalysis['measurements'] = [];
  for (const input of prepared.inputs) {
    checkShowerInstallationAbort(signal);
    if (showerCandidateProtected(original, input.receipt.targetId)) continue;
    const form = new FormData(); form.set('operation', 'shower-installation'); form.set('photo', input.fullPhoto, 'full.jpg');
    form.set('crop', input.cropPhoto, 'crop.jpg'); form.set('receipt', JSON.stringify(input.receipt));
    const response = await fetchAnalysis('cloudflare-workers-ai', { method: 'POST', body: form, signal, headers: { 'X-SJN-Analysis': 'cloud-explicit' } });
    const result = await response.json(); checkShowerInstallationAbort(signal);
    if (!response.ok || result.error) throw new CandidateExperimentError(result.error ?? '샤워 설치 상태를 확인하지 못했어요.', result.diagnostics);
    try {
      if (result.outputContract !== SHOWER_INSTALLATION_CONTRACT || result.promptRevision !== SHOWER_INSTALLATION_PROMPT_REVISION ||
          result.modelRevision !== expectedModelRevision || !validAnalysisResponse(result, 'cloudflare-workers-ai'))
        throw new Error('샤워 설치 상태 관측의 계약·모델이 달라요.');
      const observed = await validateShowerInstallationAnalysis(result, input.receipt);
      checkShowerInstallationAbort(signal); requests.push(input.receipt); observations.push(observed);
      measurements.push({ candidateId: input.receipt.targetId, measurement: result.measurement });
      onMeasurement?.(input.receipt.targetId, result.measurement);
    } catch (cause) {
      if (signal.aborted) throw new DOMException('샤워 설치 상태 확인을 취소했어요.', 'AbortError');
      throw new CandidateExperimentError('샤워 설치 상태 입력과 원문을 검증하지 못했어요.', { ...result, validationError: cause instanceof Error ? cause.message : String(cause) });
    }
  }
  const decisions = await showerRecordDecisions(original, prepared, observations);
  checkShowerInstallationAbort(signal);
  return { record: { version: 1, decisionRevision: SHOWER_INSTALLATION_DECISION_REVISION, photoFingerprint: prepared.photoFingerprint,
    sourceDecisionSignature: original.sourceDecisionSignature, modelId: CLOUD_GEMMA_MODEL, modelRevision: CLOUD_GEMMA_REVISION,
    requests, observations, protectedCandidateIds: [...original.protectedCandidateIds].sort(), decisions }, measurements };
}
