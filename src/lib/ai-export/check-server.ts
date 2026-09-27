import { getRuntimeEnvironment } from '@/lib/platform/runtime';
import { readImageHeader } from '@/lib/images';
import {
  CLOUD_GEMMA_GATEWAY_ID,
  CLOUD_GEMMA_MODEL,
  CLOUD_GEMMA_SETTINGS,
  type CloudGemmaInput,
} from '@/lib/reconstruction/cloud-gemma-contract';
import { prepareCloudGemmaSchema } from '@/lib/reconstruction/cloud-gemma-coordinates';
import {
  CloudGemmaError,
  classifyCloudGemmaFailure,
  cloudProviderException,
} from '@/lib/reconstruction/cloud-gemma-errors';
import {
  assertCloudGemmaRequest,
  binding,
  boundedBytes,
  completionSchema,
  dataUrl,
} from '@/lib/reconstruction/cloud-gemma-server';
import {
  FLUX_CHECK_MAX_EDGE,
  FLUX_CHECK_MAX_IMAGE_BYTES,
  FLUX_CHECK_MAX_SCENE_BYTES,
  FLUX_CHECK_PROMPT_REVISION,
  fluxCheckJsonSchema,
  fluxCheckPrompt,
  fluxCheckSceneSchema,
  parseFluxCheck,
  type FluxCheckResult,
  type FluxCheckScene,
} from './check-contract';

const MAX_REQUEST = FLUX_CHECK_MAX_IMAGE_BYTES + FLUX_CHECK_MAX_SCENE_BYTES + 4096;
const MAX_RESPONSE = 64 * 1024;
const DEADLINE_MS = 120_000;
/** A short JSON answer; the schema bounds it well below this. */
const MAX_OUTPUT_TOKENS = 512;
const MODELS = [
  CLOUD_GEMMA_MODEL,
  CLOUD_GEMMA_MODEL + '-external',
  'google/gemma-4-26b-a4b-it',
  'gemma-4-26b-a4b-it',
];

const invalid = (message: string): never => {
  throw new CloudGemmaError(message, 'invalid_input', 400);
};

/** Reads and validates the check request before any model call: an image, the fixtures and walls only. */
export async function readFluxCheckRequest(request: Request) {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.startsWith('multipart/form-data;'))
    invalid('검사할 이미지를 multipart 형식으로 전달해 주세요.');
  const bytes = await boundedBytes(request, MAX_REQUEST, request.signal);
  let form: FormData;
  try {
    form = await new Response(bytes, { headers: { 'Content-Type': contentType } }).formData();
  } catch {
    return invalid('검사 요청 형식이 올바르지 않아요.');
  }
  const allowed = ['image', 'scene'];
  if (
    [...form.keys()].some((key) => !allowed.includes(key)) ||
    allowed.some((key) => form.getAll(key).length !== 1)
  )
    invalid('검사 요청 필드를 확인해 주세요.');
  const image = form.get('image');
  if (!(image instanceof Blob) || image.size === 0 || image.size > FLUX_CHECK_MAX_IMAGE_BYTES)
    invalid('검사할 이미지는 1.5MB 이하여야 해요.');
  const imageBytes = new Uint8Array(await (image as Blob).arrayBuffer());
  let header: ReturnType<typeof readImageHeader>;
  try {
    header = readImageHeader(imageBytes);
  } catch {
    return invalid('올바른 PNG, JPG, WebP 이미지를 전달해 주세요.');
  }
  if (Math.max(header.width, header.height) > FLUX_CHECK_MAX_EDGE)
    invalid('검사할 이미지는 긴 변 1024px 이하여야 해요.');
  const sceneText = form.get('scene');
  if (
    typeof sceneText !== 'string' ||
    new TextEncoder().encode(sceneText).length > FLUX_CHECK_MAX_SCENE_BYTES
  )
    invalid('설비 정보가 너무 커요.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(sceneText as string);
  } catch {
    return invalid('설비 정보 형식이 올바르지 않아요.');
  }
  const scene = fluxCheckSceneSchema.safeParse(parsed);
  if (!scene.success) return invalid('설비 정보 형식이 올바르지 않아요.');
  return {
    scene: scene.data,
    image: { bytes: imageBytes, mime: header.mime, width: header.width, height: header.height },
  };
}

/** The Gemma request for one check: the server-written question, the image and a strict schema. */
export function fluxCheckPayload(
  scene: FluxCheckScene,
  image: { bytes: Uint8Array; mime: string },
): CloudGemmaInput {
  return {
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: fluxCheckPrompt(scene) },
          { type: 'image_url', image_url: { url: dataUrl(image.bytes, image.mime) } },
        ],
      },
    ],
    stream: false,
    temperature: CLOUD_GEMMA_SETTINGS.temperature,
    max_completion_tokens: MAX_OUTPUT_TOKENS,
    chat_template_kwargs: { enable_thinking: false },
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'flux_fixture_check',
        strict: true,
        schema: prepareCloudGemmaSchema(fluxCheckJsonSchema(scene.fixtures.length, scene.walls)),
      },
    },
  };
}

/** Validates a finished Gemma completion and reads the per-fixture answers. */
export function readFluxCheckCompletion(body: unknown, scene: FluxCheckScene): FluxCheckResult {
  const unwrapped = body && typeof body === 'object' && 'result' in body ? body.result : body;
  const result = completionSchema.safeParse(unwrapped);
  if (!result.success)
    throw new CloudGemmaError('Gemma 응답의 완료 정보를 검증하지 못했어요.', 'invalid_response', 502);
  const output = result.data;
  if (output.model && !MODELS.includes(output.model))
    throw new CloudGemmaError('요청한 Gemma 모델과 응답 모델이 달라요.', 'invalid_response', 502);
  const choice = output.choices[0];
  if (choice.finish_reason !== 'stop' || !choice.message.content || choice.message.refusal)
    throw new CloudGemmaError('Gemma의 검사 결과를 확인하지 못했어요.', 'invalid_response', 502);
  let answer: Omit<FluxCheckResult, 'usage'>;
  try {
    answer = parseFluxCheck(choice.message.content, scene);
  } catch {
    throw new CloudGemmaError('Gemma 검사 결과의 형식이 올바르지 않아요.', 'invalid_response', 502);
  }
  return {
    ...answer,
    usage: { inputTokens: output.usage?.prompt_tokens, outputTokens: output.usage?.completion_tokens },
  };
}

/** POST /api/export/photoreal/check: one Gemma call through the gateway, no retry. */
export async function runFluxCheck(request: Request, environment = getRuntimeEnvironment()) {
  await assertCloudGemmaRequest(request, environment);
  const ai = binding(environment);
  const { scene, image } = await readFluxCheckRequest(request);
  const payload = fluxCheckPayload(scene, image);
  const owner = new AbortController();
  const deadline = setTimeout(() => owner.abort(), DEADLINE_MS);
  const signal = AbortSignal.any([request.signal, owner.signal]);
  const started = performance.now();
  // Sizes and counts only: never the image, the question text or any user data.
  const diagnostics: Record<string, unknown> = {
    model: CLOUD_GEMMA_MODEL,
    promptRevision: FLUX_CHECK_PROMPT_REVISION,
    phase: 'provider-request',
    fixtures: scene.fixtures.length,
    walls: scene.walls?.length ?? 0,
    imageBytes: image.bytes.length,
    imageWidth: image.width,
    imageHeight: image.height,
  };
  try {
    const response = await ai.run(CLOUD_GEMMA_MODEL, payload, {
      gateway: { id: CLOUD_GEMMA_GATEWAY_ID, retries: { maxAttempts: 1 } },
      returnRawResponse: true,
      signal,
    });
    diagnostics.phase = 'provider-response';
    diagnostics.upstreamStatus = response.status;
    diagnostics.providerRequestId =
      response.headers.get('cf-aig-log-id') ?? response.headers.get('cf-ray') ?? undefined;
    const text = new TextDecoder().decode(await boundedBytes(response, MAX_RESPONSE, signal, 'response'));
    let body: unknown;
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
    const result = readFluxCheckCompletion(body, scene);
    return Response.json(
      {
        ...result,
        promptRevision: FLUX_CHECK_PROMPT_REVISION,
        elapsedMs: Math.round(performance.now() - started),
      },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error) {
    const failure = request.signal.aborted
      ? new CloudGemmaError('결과 검사를 취소했어요.', 'cancelled', 499)
      : owner.signal.aborted
        ? new CloudGemmaError('결과 검사 시간이 초과되었어요. 자동 재시도하지 않았어요.', 'timeout', 504)
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
        elapsedMs: Math.round(performance.now() - started),
      },
    );
  } finally {
    clearTimeout(deadline);
    owner.abort();
  }
}
