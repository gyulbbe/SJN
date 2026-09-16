import {
  CLOUD_GEMMA_GROUPED_INVENTORY_METADATA,
  cloudGemmaGroupedInventoryJsonSchema,
  cloudGemmaGroupedInventoryPrompt,
} from './cloud-gemma-inventory';
import {
  CLOUD_GEMMA_APPEARANCE_METADATA,
  cloudGemmaFixtureAppearancePrompt,
  cloudGemmaFixtureAppearanceJsonSchemaFor,
} from './cloud-gemma-appearance';
import { validateCloudFixtureCropReceipt, type CloudFixtureCropReceipt } from './cloud-fixture-crops';
import {
  CLOUD_GEMMA_COORDINATE_CONTRACT,
  prepareCloudGemmaPrompt,
  prepareCloudGemmaSchema,
  normalizeCloudGemmaOutput,
} from './cloud-gemma-coordinates';
import { z } from 'zod';
import { getRuntimeEnvironment } from '../platform/runtime';
import { configuredStorage, type RuntimeSettings } from '../storage/config';
import { readImageHeader, type ImageHeader } from '../images';
import {
  CLOUD_GEMMA_PROVIDER,
  CLOUD_GEMMA_MODEL,
  CLOUD_GEMMA_REVISION,
  CLOUD_GEMMA_GATEWAY_ID,
  CLOUD_GEMMA_IDENTITY,
  CLOUD_GEMMA_OPERATIONS,
  CLOUD_GEMMA_SETTINGS,
  type CloudGemmaBinding,
  type CloudGemmaInput,
  type CloudGemmaOperation,
} from './cloud-gemma-contract';
import { CloudGemmaError, classifyCloudGemmaFailure, cloudProviderException } from './cloud-gemma-errors';
import {
  INVENTORY_OUTPUT_CONTRACT,
  EXTENDED_INVENTORY_OUTPUT_CONTRACT,
  EXTENDED_INVENTORY_PROMPT_REVISION,
  fixtureInventoryJsonSchema,
  FIXTURE_INVENTORY_PROMPT,
  parseFixtureInventory,
} from './inventory-observation';
import {
  INSTALLATION_OUTPUT_CONTRACT,
  INSTALLATION_PROMPT_REVISION,
  installationObservationPrompt,
  installationObservationJsonSchemaFor,
  parseInstallationObservation,
  validateInstallationInventory,
  skippedInstallationAnalysis,
} from './installation-observation';
import {
  IDENTITY_OUTPUT_CONTRACT,
  IDENTITY_PROMPT_REVISION,
  identityObservationPrompt,
  identityObservationJsonSchemaFor,
  parseIdentityObservation,
  identityObservationTargets,
  skippedIdentityAnalysis,
} from './identity-observation';
import {
  LAYOUT_OUTPUT_CONTRACT,
  LAYOUT_PROMPT_REVISION,
  LAYOUT_RELATION_RULE_REVISION,
  layoutObservationPrompt,
  layoutObservationJsonSchemaFor,
  parseLayoutObservation,
  layoutInventorySignature,
} from './layout-observation';
import {
  FIXTURE_APPEARANCE_CONTRACT,
  FIXTURE_APPEARANCE_PROMPT_REVISION,
  parseFixtureAppearance,
} from './fixture-appearance-observation';
import {
  SHOWER_OBSERVATION_CONTRACT,
  SHOWER_OBSERVATION_PROMPT_REVISION,
  showerObservationPrompt,
  showerObservationJsonSchemaFor,
  parseShowerObservation,
} from './shower-observation';
import {
  SHOWER_INSTALLATION_CONTRACT,
  SHOWER_INSTALLATION_PROMPT_REVISION,
  showerInstallationPrompt,
  showerInstallationJsonSchema,
  validateShowerInstallationReceipt,
  validateShowerInstallationAnalysis,
  type ShowerInstallationReceipt,
} from './shower-installation-observation';
import {
  DIVIDER_OBSERVATION_CONTRACT,
  DIVIDER_OBSERVATION_PROMPT_REVISION,
  dividerObservationPrompt,
  dividerObservationJsonSchemaFor,
  parseDividerObservation,
  validateDividerTargetsForInventory,
  dividerTargetsSignature,
  type DividerTarget,
} from './divider-observation';
import {
  TARGET_EXISTENCE_CONTRACT,
  TARGET_EXISTENCE_PROMPT_REVISION,
  targetExistencePrompt,
  targetExistenceJsonSchemaFor,
  validateTargetExistenceReceipt,
  validateTargetExistenceAnalysis,
  canonicalTargetValue,
  type TargetExistenceReceipt,
} from './target-existence-observation';
import { LAB_QWEN_PROMPT_REVISION } from './lab-engine';
import type { SceneUnderstanding } from './pipeline-contract';

const MAX_IMAGE = 8 * 1024 * 1024;
const MAX_REQUEST = MAX_IMAGE * 2 + 800_000;
const MAX_RESPONSE = 240_000;
const DEADLINE_MS = 120_000;
type Environment = ReturnType<typeof getRuntimeEnvironment>;
const metadata = {
  provider: CLOUD_GEMMA_PROVIDER,
  modelId: CLOUD_GEMMA_MODEL,
  modelRevision: CLOUD_GEMMA_REVISION,
  modelIdentity: CLOUD_GEMMA_IDENTITY,
  gatewayId: CLOUD_GEMMA_GATEWAY_ID,
  coordinateContract: CLOUD_GEMMA_COORDINATE_CONTRACT,
};
const invalid = (message: string): never => {
  throw new CloudGemmaError(message, 'invalid_input', 400);
};
function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw new CloudGemmaError('설비 분석을 취소했어요.', 'cancelled', 499);
}
async function sha256(bytes: Uint8Array | string): Promise<string> {
  const copy = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : new Uint8Array(bytes);
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', copy)), (value) =>
    value.toString(16).padStart(2, '0'),
  ).join('');
}
/** Reuse D1 authentication, or allow anonymous AI for intentionally configured local storage. */
export async function assertCloudGemmaRequest(request: Request, environment: Environment): Promise<string> {
  throwIfAborted(request.signal);
  const url = new URL(request.url);
  const origin = request.headers.get('origin');
  if (
    (origin && origin !== url.origin) ||
    request.headers.get('sec-fetch-site') === 'cross-site' ||
    (request.method === 'POST' && origin !== url.origin)
  )
    throw new CloudGemmaError('허용되지 않은 요청 출처예요.', 'access_denied', 403);
  const selection = configuredStorage(environment as RuntimeSettings);
  if (selection.reason === 'invalid_configuration')
    throw new CloudGemmaError('서버 로그인 설정을 확인해 주세요.', 'authentication_unavailable', 503);
  if (selection.mode === 'd1') {
    try {
      const { getD1Actor } = await import('../auth/d1');
      const actor = await getD1Actor(request, environment as unknown as Parameters<typeof getD1Actor>[1]);
      const expectedUser = request.headers.get('X-SJN-User-Id');
      if (expectedUser && expectedUser !== actor.id)
        throw new CloudGemmaError(
          '다른 계정으로 로그인되어 있어요. 계정을 다시 확인해 주세요.',
          'authentication_required',
          401,
        );
      return 'actor-sha256:' + (await sha256('sjn-cloud-gemma:' + actor.id));
    } catch (error) {
      if (error instanceof CloudGemmaError) throw error;
      const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : 503;
      throw new CloudGemmaError(
        status === 401
          ? '로그인이 필요해요. 현재 작업을 보존하고 다시 로그인해 주세요.'
          : status === 403
            ? '허용되지 않은 요청 출처예요.'
            : '설비 분석에 필요한 로그인 설정을 확인해야 해요.',
        status === 401
          ? 'authentication_required'
          : status === 403
            ? 'access_denied'
            : 'authentication_unavailable',
        [401, 403].includes(status) ? status : 503,
      );
    }
  }
  const loopback = (hostname: string) => ['127.0.0.1', 'localhost', '[::1]'].includes(hostname);
  const host = request.headers.get('host');
  let publicUrl: URL;
  try {
    publicUrl = host ? new URL(url.protocol + '//' + host) : new URL(url.origin);
  } catch {
    return invalid('요청 주소가 올바르지 않아요.');
  }
  if (
    environment.APP_ENV !== 'production' &&
    selection.mode === 'local' &&
    url.protocol === 'http:' &&
    loopback(url.hostname) &&
    loopback(publicUrl.hostname) &&
    publicUrl.pathname === '/' &&
    !publicUrl.username &&
    !publicUrl.password &&
    (!origin || origin === publicUrl.origin)
  )
    return 'local-dev';
  const storageMode = environment.STORAGE_MODE ?? environment.NEXT_PUBLIC_STORAGE_MODE ?? 'auto';
  const intentionalLocal =
    selection.reason === 'local_selected' ||
    (environment.APP_ENV === 'local' && (storageMode === 'local' || storageMode === 'auto'));
  if (
    selection.mode === 'local' &&
    intentionalLocal &&
    url.protocol === 'https:' &&
    publicUrl.origin === url.origin &&
    publicUrl.pathname === '/' &&
    !publicUrl.username &&
    !publicUrl.password &&
    !publicUrl.search &&
    !publicUrl.hash
  )
    return 'anonymous-origin-sha256:' + (await sha256('sjn-cloud-gemma-anonymous:' + url.origin));
  throw new CloudGemmaError(
    '설비 분석을 사용하려면 서버의 로컬 저장 모드 또는 D1 로그인 설정을 확인해 주세요.',
    'authentication_unavailable',
    503,
  );
}
function binding(environment: Environment): CloudGemmaBinding {
  const ai = environment.AI;
  if (
    environment.platform !== 'cloudflare' ||
    !ai ||
    typeof ai !== 'object' ||
    !('run' in ai) ||
    typeof ai.run !== 'function'
  )
    throw new CloudGemmaError(
      '이 실행 환경에 Cloudflare Workers AI 바인딩이 없어요. Cloudflare 실행 환경에서 연결해 주세요.',
      'binding_unavailable',
      503,
    );
  return ai as CloudGemmaBinding;
}
/** Checks binding and access only: neither a model request nor a promise of quota/auth upstream readiness. */
export async function cloudGemmaAvailability(request: Request, environment = getRuntimeEnvironment()) {
  const cacheScope = await assertCloudGemmaRequest(request, environment);
  binding(environment);
  return {
    available: true,
    ...metadata,
    revision: CLOUD_GEMMA_REVISION,
    cacheScope,
    readiness: 'binding-configured',
    upstreamVerified: false,
  };
}
async function boundedBytes(
  message: Request | Response,
  limit: number,
  signal: AbortSignal,
  source: 'request' | 'response' = 'request',
): Promise<Uint8Array<ArrayBuffer>> {
  const fail = (message: string): never => {
    throw new CloudGemmaError(
      message,
      source === 'request' ? 'invalid_input' : 'invalid_response',
      source === 'request' ? 400 : 502,
    );
  };
  if (Number(message.headers.get('content-length') ?? 0) > limit) fail('분석 데이터가 너무 커요.');
  if (!message.body) fail('분석 데이터가 비어 있어요.');
  const reader = message.body!.getReader();
  const chunks: Uint8Array[] = [];
  let count = 0;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      throwIfAborted(signal);
      const { value, done } = await reader.read();
      throwIfAborted(signal);
      if (done) break;
      count += value.byteLength;
      if (count > limit) {
        await reader.cancel();
        fail('분석 데이터가 너무 커요.');
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
  const result = new Uint8Array(count);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
function jsonField(form: FormData, key: string, limit: number): unknown {
  const value = form.get(key);
  if (typeof value !== 'string' || new TextEncoder().encode(value).length > limit)
    return invalid('분석 요청의 ' + key + ' 필드가 올바르지 않아요.');
  try {
    return JSON.parse(value);
  } catch {
    return invalid('분석 요청 JSON을 읽을 수 없어요.');
  }
}
async function imageField(form: FormData, key: string) {
  const value = form.get(key);
  if (!(value instanceof Blob) || value.size === 0 || value.size > MAX_IMAGE)
    return invalid('분석 이미지는 8MB 이하여야 해요.');
  const bytes = new Uint8Array(await value.arrayBuffer());
  let header: ImageHeader;
  try {
    header = readImageHeader(bytes);
  } catch {
    return invalid('올바른 JPG, PNG, WebP 이미지를 전달해 주세요.');
  }
  if (Math.max(header.width, header.height) > 1600)
    return invalid('분석 이미지는 긴 변 1600px 이하여야 해요.');
  return { bytes, header, hash: await sha256(bytes) };
}
function dataUrl(bytes: Uint8Array, mime: string): string {
  // Bounded chunks avoid argument/stack overflow and Buffer/Node dependencies in Workers.
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return 'data:' + mime + ';base64,' + btoa(binary);
}
type Input = {
  operation: CloudGemmaOperation;
  photo: Awaited<ReturnType<typeof imageField>>;
  inventory?: SceneUnderstanding;
  target?: { receipt: TargetExistenceReceipt; crop: Awaited<ReturnType<typeof imageField>> };
  showerInstallation?: { receipt: ShowerInstallationReceipt; crop: Awaited<ReturnType<typeof imageField>> };
  divider?: DividerTarget[];
  appearance?: { receipt: CloudFixtureCropReceipt; board: Awaited<ReturnType<typeof imageField>> };
};
async function readInput(request: Request): Promise<Input> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.startsWith('multipart/form-data;'))
    invalid('사진과 분석 종류를 multipart 형식으로 전달해 주세요.');
  const bytes = await boundedBytes(request, MAX_REQUEST, request.signal);
  let form: FormData;
  try {
    form = await new Response(bytes, { headers: { 'Content-Type': contentType } }).formData();
  } catch {
    return invalid('분석 요청의 multipart 데이터를 읽지 못했어요.');
  }
  const allowed = [
    'operation',
    'photo',
    'inventory',
    'crop',
    'receipt',
    'targets',
    'modelInputSha256',
    'appearanceBoard',
    'appearanceReceipt',
  ];
  if (
    [...form.keys()].some((key) => !allowed.includes(key)) ||
    allowed.some((key) => form.getAll(key).length > 1)
  )
    invalid('분석 요청 필드가 올바르지 않아요.');
  const operation = z.enum(CLOUD_GEMMA_OPERATIONS).safeParse(form.get('operation'));
  if (!operation.success) return invalid('지원하지 않는 분석 종류예요.');
  const op = operation.data;
  if (
    !['target-existence', 'shower-installation'].includes(op) &&
    (form.has('crop') || form.has('receipt') || (op !== 'appearance' && bytes.length > MAX_IMAGE + 200_000))
  )
    invalid('전체 이미지 분석 요청 필드나 크기가 올바르지 않아요.');
  if (op !== 'appearance' && (form.has('appearanceBoard') || form.has('appearanceReceipt')))
    invalid('설비 형태 분석 외 요청에 crop board를 전달할 수 없어요.');
  if (op !== 'divider-material' && (form.has('targets') || form.has('modelInputSha256')))
    invalid('칸막이 분석 외 요청에 대상 목록을 전달할 수 없어요.');
  const photo = await imageField(form, 'photo');
  const input: Input = { operation: op, photo };
  if (op === 'target-existence') {
    if (form.has('inventory')) invalid('대상 재확인에는 기존 목록을 전달하지 않아요.');
    const receipt = await validateTargetExistenceReceipt(
      jsonField(form, 'receipt', 780_000) as TargetExistenceReceipt,
    );
    const crop = await imageField(form, 'crop');
    if (
      receipt.modelId !== CLOUD_GEMMA_MODEL ||
      receipt.modelRevision !== CLOUD_GEMMA_REVISION ||
      photo.header.mime !== 'image/jpeg' ||
      crop.header.mime !== 'image/jpeg' ||
      photo.hash !== receipt.normalizedFullSha256 ||
      crop.hash !== receipt.cropSha256 ||
      canonicalTargetValue({ width: photo.header.width, height: photo.header.height }) !==
        canonicalTargetValue(receipt.fullImage) ||
      canonicalTargetValue({ width: crop.header.width, height: crop.header.height }) !==
        canonicalTargetValue(receipt.cropImage)
    )
      invalid('대상 재확인의 모델과 실제 이미지가 고정 입력 기록과 달라요.');
    input.target = { receipt, crop };
  } else if (op === 'shower-installation') {
    if (form.has('inventory')) invalid('샤워 설치 관측에는 기존 목록을 전달하지 않아요.');
    const receipt = await validateShowerInstallationReceipt(
      jsonField(form, 'receipt', 780_000) as ShowerInstallationReceipt,
    );
    const crop = await imageField(form, 'crop');
    if (
      photo.header.mime !== 'image/jpeg' ||
      crop.header.mime !== 'image/jpeg' ||
      photo.hash !== receipt.normalizedFullSha256 ||
      crop.hash !== receipt.cropSha256 ||
      canonicalTargetValue({ width: photo.header.width, height: photo.header.height }) !==
        canonicalTargetValue(receipt.fullImage) ||
      canonicalTargetValue({ width: crop.header.width, height: crop.header.height }) !==
        canonicalTargetValue(receipt.cropImage)
    )
      invalid('샤워 설치 관측의 실제 이미지가 고정 입력 기록과 달라요.');
    input.showerInstallation = { receipt, crop };
  } else if (!['inventory', 'inventory-extended'].includes(op)) {
    input.inventory = validateInstallationInventory(jsonField(form, 'inventory', 150_000));
  } else if (form.has('inventory')) invalid('설비 목록 분석에는 기존 목록을 전달하지 않아요.');
  if (op === 'appearance') {
    const board = await imageField(form, 'appearanceBoard');
    try {
      const receipt = await validateCloudFixtureCropReceipt(
        jsonField(form, 'appearanceReceipt', 96_000),
        photo.bytes,
        board.bytes,
        input.inventory!.candidates,
      );
      input.appearance = { board, receipt };
    } catch {
      invalid('설비 형태 crop board와 원본 사진·후보 영역 기록이 일치하지 않아요.');
    }
  }
  if (op === 'divider-material') {
    const fingerprint = form.get('modelInputSha256');
    if (
      photo.header.mime !== 'image/jpeg' ||
      Math.max(photo.header.width, photo.header.height) > 1024 ||
      typeof fingerprint !== 'string' ||
      photo.hash !== fingerprint
    )
      invalid('칸막이 모델 이미지와 입력 SHA가 달라요.');
    input.divider = validateDividerTargetsForInventory(
      input.inventory!,
      jsonField(form, 'targets', 12_000) as DividerTarget[],
    );
  }
  throwIfAborted(request.signal);
  return input;
}
function stage(input: Input) {
  const inventory = input.inventory!;
  switch (input.operation) {
    case 'identity':
      return {
        outputContract: IDENTITY_OUTPUT_CONTRACT,
        promptRevision: IDENTITY_PROMPT_REVISION,
        prompt: identityObservationPrompt(inventory),
        schema: identityObservationJsonSchemaFor(inventory),
        parse: (text: string) => parseIdentityObservation(text, inventory),
      };
    case 'installation':
      return {
        outputContract: INSTALLATION_OUTPUT_CONTRACT,
        promptRevision: INSTALLATION_PROMPT_REVISION,
        prompt: installationObservationPrompt(inventory),
        schema: installationObservationJsonSchemaFor(inventory),
        parse: (text: string) => parseInstallationObservation(text, inventory),
      };
    case 'layout':
      return {
        outputContract: LAYOUT_OUTPUT_CONTRACT,
        promptRevision: LAYOUT_PROMPT_REVISION,
        prompt: layoutObservationPrompt(inventory),
        schema: layoutObservationJsonSchemaFor(inventory),
        parse: (text: string) => ({
          understanding: structuredClone(inventory),
          ...parseLayoutObservation(text, inventory),
        }),
      };
    case 'appearance':
      return {
        outputContract: FIXTURE_APPEARANCE_CONTRACT,
        promptRevision: FIXTURE_APPEARANCE_PROMPT_REVISION,
        prompt: cloudGemmaFixtureAppearancePrompt(inventory),
        schema: cloudGemmaFixtureAppearanceJsonSchemaFor(inventory),
        parse: (text: string) => parseFixtureAppearance(text, inventory),
      };
    case 'shower-detail':
      return {
        outputContract: SHOWER_OBSERVATION_CONTRACT,
        promptRevision: SHOWER_OBSERVATION_PROMPT_REVISION,
        prompt: showerObservationPrompt(inventory),
        schema: showerObservationJsonSchemaFor(inventory),
        parse: (text: string) => parseShowerObservation(text, inventory),
      };
    case 'divider-material':
      return {
        outputContract: DIVIDER_OBSERVATION_CONTRACT,
        promptRevision: DIVIDER_OBSERVATION_PROMPT_REVISION,
        prompt: dividerObservationPrompt(input.divider!),
        schema: dividerObservationJsonSchemaFor(input.divider!),
        parse: (text: string) => ({
          ...parseDividerObservation(text, input.divider!),
          inventorySignature: layoutInventorySignature(inventory),
          targetsSignature: dividerTargetsSignature(input.divider!),
        }),
      };
    case 'shower-installation': {
      const receipt = input.showerInstallation!.receipt;
      return {
        outputContract: SHOWER_INSTALLATION_CONTRACT,
        promptRevision: SHOWER_INSTALLATION_PROMPT_REVISION,
        prompt: showerInstallationPrompt(),
        schema: showerInstallationJsonSchema(),
        parse: (text: string) => validateShowerInstallationAnalysis({ receipt, rawText: text }, receipt),
      };
    }
    case 'target-existence': {
      const receipt = input.target!.receipt;
      return {
        outputContract: TARGET_EXISTENCE_CONTRACT,
        promptRevision: TARGET_EXISTENCE_PROMPT_REVISION,
        prompt: targetExistencePrompt(receipt.targetId, receipt.boxes),
        schema: targetExistenceJsonSchemaFor(
          receipt.targetId,
          receipt.boxes.map((box) => box.id),
        ),
        parse: (text: string) => validateTargetExistenceAnalysis({ receipt, rawText: text }, receipt),
      };
    }
    case 'inventory-extended': {
      const schema = prepareCloudGemmaSchema(cloudGemmaGroupedInventoryJsonSchema());
      return {
        ...CLOUD_GEMMA_GROUPED_INVENTORY_METADATA,
        outputContract: EXTENDED_INVENTORY_OUTPUT_CONTRACT,
        promptRevision: EXTENDED_INVENTORY_PROMPT_REVISION,
        prompt: cloudGemmaGroupedInventoryPrompt(schema),
        schema,
        parse: (text: string) => ({
          understanding: parseFixtureInventory(text, EXTENDED_INVENTORY_OUTPUT_CONTRACT).understanding,
        }),
      };
    }
    default: {
      return {
        outputContract: INVENTORY_OUTPUT_CONTRACT,
        promptRevision: LAB_QWEN_PROMPT_REVISION,
        prompt: FIXTURE_INVENTORY_PROMPT,
        schema: fixtureInventoryJsonSchema,
        parse: (text: string) => ({
          understanding: parseFixtureInventory(text, INVENTORY_OUTPUT_CONTRACT).understanding,
        }),
      };
    }
  }
}
const completionSchema = z.object({
  model: z.string().optional(),
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullable(),
        message: z.object({ content: z.string().nullable(), refusal: z.string().nullable().optional() }),
      }),
    )
    .min(1)
    .max(1),
  usage: z
    .object({
      prompt_tokens: z.number().int().nonnegative().optional(),
      completion_tokens: z.number().int().nonnegative().optional(),
      total_tokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
  system_fingerprint: z.string().nullable().optional(),
});
/** One upstream request per stage; caller owns deduplication and bounded retry after classified failures. */
export async function runCloudGemmaModel(request: Request, environment = getRuntimeEnvironment()) {
  await assertCloudGemmaRequest(request, environment);
  const ai = binding(environment);
  let input: Input;
  try {
    input = await readInput(request);
  } catch (error) {
    if (error instanceof CloudGemmaError) throw error;
    throw new CloudGemmaError('분석 입력의 관측 계약이 올바르지 않아요.', 'invalid_input', 400);
  }
  if (input.inventory) {
    const skipped =
      input.operation === 'identity' && !identityObservationTargets(input.inventory).length
        ? skippedIdentityAnalysis(input.inventory)
        : input.operation === 'installation' && !input.inventory.candidates.length
          ? skippedInstallationAnalysis(input.inventory)
          : undefined;
    if (skipped)
      return {
        ...skipped,
        ...metadata,
        modelRevision: null,
        measurement: { ...skipped.measurement, modelDownload: 'provider-managed', inferenceCalls: 0 },
      };
  }
  let selected: ReturnType<typeof stage>;
  try {
    selected = stage(input);
  } catch {
    return invalid('이 분석 단계에 필요한 설비 관측 대상이 없거나 올바르지 않아요.');
  }
  const providerPrompt =
    input.operation === 'inventory-extended' || input.operation === 'appearance'
      ? selected.prompt
      : prepareCloudGemmaPrompt(selected.prompt, input.operation);
  const providerSchema = prepareCloudGemmaSchema(selected.schema);
  const content: CloudGemmaInput['messages'][number]['content'] = [
    { type: 'text', text: providerPrompt },
    { type: 'image_url', image_url: { url: dataUrl(input.photo.bytes, input.photo.header.mime) } },
  ];
  if (input.target)
    content.push({
      type: 'image_url',
      image_url: { url: dataUrl(input.target.crop.bytes, input.target.crop.header.mime) },
    });
  if (input.showerInstallation)
    content.push({
      type: 'image_url',
      image_url: {
        url: dataUrl(input.showerInstallation.crop.bytes, input.showerInstallation.crop.header.mime),
      },
    });
  if (input.appearance)
    content.push({
      type: 'image_url',
      image_url: { url: dataUrl(input.appearance.board.bytes, input.appearance.board.header.mime) },
    });
  const payload: CloudGemmaInput = {
    messages: [{ role: 'user', content }],
    stream: false,
    temperature: CLOUD_GEMMA_SETTINGS.temperature,
    max_completion_tokens: CLOUD_GEMMA_SETTINGS.max_completion_tokens,
    chat_template_kwargs: { enable_thinking: false },
    // Inventory retains its schema in the prompt and strict server parsing.
    // Real-photo A/B checks found forced-schema decoding omitted fixtures and bowl counts.
    response_format: ['inventory', 'inventory-extended'].includes(input.operation)
      ? { type: 'json_object' }
      : {
          type: 'json_schema',
          json_schema: {
            name: selected.outputContract.replace(/-/g, '_'),
            strict: true,
            schema: providerSchema,
          },
        },
  };
  const started = performance.now();
  const owner = new AbortController();
  const deadline = setTimeout(() => owner.abort(), DEADLINE_MS);
  const signal = AbortSignal.any([request.signal, owner.signal]);
  let diagnostics: Record<string, unknown> = {
    ...metadata,
    outputContract: selected.outputContract,
    promptRevision: selected.promptRevision,
    providerPromptSha256: await sha256(providerPrompt),
    providerSchemaSha256: await sha256(JSON.stringify(providerSchema)),
    providerResponseFormat: payload.response_format.type,
    ...(input.operation === 'inventory-extended' ? CLOUD_GEMMA_GROUPED_INVENTORY_METADATA : {}),
    ...(input.operation === 'appearance' ? CLOUD_GEMMA_APPEARANCE_METADATA : {}),
    ...(input.operation === 'layout' ? { relationRuleRevision: LAYOUT_RELATION_RULE_REVISION } : {}),
    inferenceCalls: 0,
    ...(input.appearance ? { appearanceReceipt: input.appearance.receipt } : {}),
  };
  try {
    throwIfAborted(signal);
    diagnostics.phase = 'provider-request';
    diagnostics.inferenceCalls = 1;
    const response = await ai.run(CLOUD_GEMMA_MODEL, payload, {
      gateway: { id: CLOUD_GEMMA_GATEWAY_ID, retries: { maxAttempts: 1 } },
      returnRawResponse: true,
      signal,
    });
    throwIfAborted(signal);
    diagnostics.phase = 'provider-response';
    diagnostics.upstreamStatus = response.status;
    diagnostics.providerRequestId =
      response.headers.get('cf-aig-log-id') ?? response.headers.get('cf-ray') ?? undefined;
    const bytes = await boundedBytes(response, MAX_RESPONSE, signal, 'response');
    let body: unknown;
    const text = new TextDecoder().decode(bytes);
    try {
      body = JSON.parse(text);
    } catch {
      if (!response.ok)
        throw classifyCloudGemmaFailure(response.status, text, response.headers.get('Retry-After'));
      throw new CloudGemmaError('Gemma가 올바른 응답 JSON을 반환하지 않았어요.', 'invalid_response', 502);
    }
    if (!response.ok)
      throw classifyCloudGemmaFailure(response.status, body, response.headers.get('Retry-After'));
    if (body && typeof body === 'object' && 'success' in body && body.success === false)
      throw classifyCloudGemmaFailure(502, body, response.headers.get('Retry-After'));
    const unwrapped = body && typeof body === 'object' && 'result' in body ? body.result : body;
    const result = completionSchema.safeParse(unwrapped);
    if (!result.success)
      throw new CloudGemmaError('Gemma 응답의 완료 정보를 검증하지 못했어요.', 'invalid_response', 502);
    const output = result.data;
    const choice = output.choices[0];
    const completion = {
      done: choice.finish_reason === 'stop',
      doneReason: choice.finish_reason,
      inputTokens: output.usage?.prompt_tokens,
      outputTokens: output.usage?.completion_tokens,
      totalTokens: output.usage?.total_tokens,
      outputTokenLimit: CLOUD_GEMMA_SETTINGS.max_completion_tokens,
    };
    const measurement = {
      requestMs: performance.now() - started,
      inputWidth: input.photo.header.width,
      inputHeight: input.photo.header.height,
      memoryScope: 'Cloudflare 서버 메모리는 브라우저에서 측정할 수 없어요.',
      modelDownload: 'provider-managed' as const,
      inferenceCalls: 1,
      inputTokens: output.usage?.prompt_tokens,
      outputTokens: output.usage?.completion_tokens,
    };
    diagnostics = {
      ...diagnostics,
      providerModel: output.model,
      rawText: choice.message.content,
      completion,
      measurement,
    };
    if (
      output.model &&
      // Observed Workers AI vision serving alias; retained as providerModel, never a weights revision.
      ![
        CLOUD_GEMMA_MODEL,
        CLOUD_GEMMA_MODEL + '-external',
        'google/gemma-4-26b-a4b-it',
        'gemma-4-26b-a4b-it',
      ].includes(output.model)
    )
      throw new CloudGemmaError('요청한 Gemma 모델과 응답 모델이 달라요.', 'invalid_response', 502);

    if (choice.finish_reason === 'length')
      throw new CloudGemmaError(
        'Gemma 출력이 토큰 제한에 도달했어요. 이 단계의 결과를 적용하지 않았어요.',
        'output_limit',
        422,
      );
    if (choice.finish_reason !== 'stop' || !choice.message.content || choice.message.refusal)
      throw new CloudGemmaError('Gemma의 완료된 분석 결과를 확인하지 못했어요.', 'invalid_response', 502);
    let analysis: unknown;
    try {
      analysis = await selected.parse(
        normalizeCloudGemmaOutput(
          choice.message.content,
          input.operation,
          input.operation === 'inventory-extended'
            ? CLOUD_GEMMA_GROUPED_INVENTORY_METADATA.providerInventoryContract
            : undefined,
        ),
      );
    } catch {
      throw new CloudGemmaError(
        'Gemma 결과의 관측 구조 검증에 실패했어요. 결과를 적용하지 않았어요.',
        'invalid_response',
        502,
      );
    }
    throwIfAborted(signal);
    return {
      ...(analysis as Record<string, unknown>),
      ...diagnostics,
      settings: CLOUD_GEMMA_SETTINGS,
      ...(input.operation === 'shower-detail' || input.divider ? { modelInputSha256: input.photo.hash } : {}),
      // A provider fingerprint is useful telemetry, never substituted for a verified weights digest.
      providerSystemFingerprint: output.system_fingerprint ?? undefined,
    };
  } catch (error) {
    const failure = request.signal.aborted
      ? new CloudGemmaError('설비 분석을 취소했어요.', 'cancelled', 499)
      : owner.signal.aborted
        ? new CloudGemmaError('설비 분석 시간이 초과되었어요.', 'timeout', 504)
        : error instanceof CloudGemmaError
          ? error
          : classifyCloudGemmaFailure(
              error && typeof error === 'object' && 'status' in error ? Number(error.status) : 502,
              error instanceof Error ? error.message : '',
            );
    throw new CloudGemmaError(
      failure.message,
      failure.code,
      failure.status,
      failure.retryable,
      failure.retryAfterMs,
      {
        ...diagnostics,
        ...(error instanceof CloudGemmaError ? {} : { providerException: cloudProviderException(error) }),
        elapsedMs: performance.now() - started,
      },
    );
  } finally {
    clearTimeout(deadline);
    owner.abort();
  }
}
