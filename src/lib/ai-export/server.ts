import { getRuntimeEnvironment } from '@/lib/platform/runtime';
import { readImageHeader } from '@/lib/images';
import { assertCloudGemmaRequest } from '@/lib/reconstruction/cloud-gemma-server';
import {
  CloudGemmaError,
  classifyCloudGemmaFailure,
  cloudProviderException,
} from '@/lib/reconstruction/cloud-gemma-errors';
import { FLUX_MODEL, FLUX_INPUT_EDGE, FLUX_MAX_IMAGE_BYTES } from './contract';
import { buildFluxPrompt } from './prompt';
import { FLUX_MAX_SCENE_BYTES, fluxSceneSchema, type FluxScene } from './scene-contract';

const MAX_REQUEST_BYTES = FLUX_MAX_IMAGE_BYTES + FLUX_MAX_SCENE_BYTES + 4096;

export type FluxEnvironment = ReturnType<typeof getRuntimeEnvironment>;
type FluxBinding = {
  run: (
    model: string,
    input: { multipart: { body: ReadableStream; contentType: string } },
    options: { returnRawResponse: true; signal: AbortSignal },
  ) => Promise<Response>;
};
export function fail(message: string, status = 400): never {
  throw new CloudGemmaError(message, status === 400 ? 'invalid_input' : 'invalid_response', status);
}
export async function bounded(message: Request | Response, limit: number, signal: AbortSignal, status = 400) {
  if (Number(message.headers.get('content-length')) > limit) fail('이미지 데이터가 너무 커요.', status);
  if (!message.body) fail('이미지 데이터가 비어 있어요.', status);
  const reader = message.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.length;
      if (size > limit) {
        await reader.cancel();
        fail('이미지 데이터가 너무 커요.', status);
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
/** Same-origin and login checks, then the Workers AI binding (absent in a plain Next dev server). */
export async function openFluxRequest(request: Request, environment: FluxEnvironment) {
  await assertCloudGemmaRequest(request, environment);
  const ai = environment.AI as FluxBinding | undefined;
  if (environment.platform !== 'cloudflare' || typeof ai?.run !== 'function')
    throw new CloudGemmaError(
      'Cloudflare AI 연결이 없는 실행 환경이에요. Cloudflare에 배포하거나 Workers 개발 서버에서 실행해 주세요.',
      'binding_unavailable',
      503,
    );
  return ai;
}
/** The multipart body of a FLUX request, read within `limit` bytes. */
export async function readFluxForm(request: Request, limit: number): Promise<FormData> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.startsWith('multipart/form-data;')) fail('이미지를 multipart 형식으로 전달해 주세요.');
  const bytes = await bounded(request, limit, request.signal);
  try {
    return await new Response(bytes, { headers: { 'Content-Type': contentType } }).formData();
  } catch {
    return fail('이미지 요청 형식이 올바르지 않아요.');
  }
}
/** Only these fields, each once, and every required one. */
export function checkFluxFields(form: FormData, required: string[], optional: string[]) {
  const allowed = [...required, ...optional];
  if (
    [...form.keys()].some((key) => !allowed.includes(key)) ||
    required.some((key) => form.getAll(key).length !== 1) ||
    allowed.some((key) => form.getAll(key).length > 1)
  )
    fail('이미지 요청 필드를 확인해 주세요.');
}
export function readFluxSeed(form: FormData): number {
  const seedText = form.get('seed');
  if (typeof seedText !== 'string' || !/^\d{1,10}$/.test(seedText)) fail('이미지 seed가 올바르지 않아요.');
  const seed = Number(seedText);
  if (!Number.isInteger(seed) || seed < 0 || seed > 2147483647) fail('이미지 seed가 올바르지 않아요.');
  return seed;
}
/** A PNG within the model's input size: sides 128–496 px in 16 px steps. */
export async function readFluxPng(image: unknown, message: string) {
  if (!(image instanceof Blob) || image.size === 0 || image.size > FLUX_MAX_IMAGE_BYTES)
    fail('입력 이미지는 2MB 이하여야 해요.');
  let header: ReturnType<typeof readImageHeader>;
  try {
    header = readImageHeader(new Uint8Array(await image.arrayBuffer()));
  } catch {
    return fail(message);
  }
  if (
    header.mime !== 'image/png' ||
    [header.width, header.height].some((n) => n < 128 || n > FLUX_INPUT_EDGE || n % 16 !== 0)
  )
    fail('AI 변환용 PNG의 크기가 올바르지 않아요.');
  return { blob: image, header };
}
/**
 * One explicit request -> one model call, for every FLUX route. No AI Gateway here: FLUX takes its
 * images as a multipart stream and the gateway rejects stream bodies ("AI Gateway does not support
 * ReadableStreams yet"), which surfaced as a generic failure in production. The binding does not
 * retry, and neither does this. The answer is the model's image, checked, as a response.
 */
export async function callFlux(input: {
  request: Request;
  ai: FluxBinding;
  /** The model's fields (input_image_N, prompt, width, height, seed). */
  model: FormData;
  /** Sizes only: never the prompt text, images or any user data. */
  diagnostics: Record<string, unknown>;
}): Promise<Response> {
  const { request, ai, model } = input;
  const serialized = new Response(model);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  request.signal.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => controller.abort(), 180_000);
  // Kept with the failure (as for Gemma) so a provider error is not reduced to a generic message.
  const diagnostics: Record<string, unknown> = {
    model: FLUX_MODEL,
    phase: 'provider-request',
    ...input.diagnostics,
  };
  try {
    request.signal.throwIfAborted();
    const response = await ai.run(
      FLUX_MODEL,
      {
        multipart: { body: serialized.body!, contentType: serialized.headers.get('content-type')! },
      },
      {
        returnRawResponse: true,
        signal: controller.signal,
      },
    );
    diagnostics.phase = 'provider-response';
    diagnostics.upstreamStatus = response.status;
    diagnostics.providerRequestId =
      response.headers.get('cf-aig-log-id') ?? response.headers.get('cf-ray') ?? undefined;
    const raw = await bounded(response, 12 * 1024 * 1024, controller.signal, 502);
    const text = new TextDecoder().decode(raw);
    if (!response.ok) {
      diagnostics.providerResponse = cloudProviderException({
        name: 'ProviderResponse',
        message: text,
      }).message;
      throw classifyCloudGemmaFailure(response.status, text, response.headers.get('Retry-After'));
    }
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return fail('AI 이미지 응답을 읽지 못했어요.', 502);
    }
    if (body?.success === false) {
      diagnostics.providerResponse = cloudProviderException({
        name: 'ProviderResponse',
        message: text,
      }).message;
      throw classifyCloudGemmaFailure(502, body);
    }
    const encoded = (body?.result ?? body)?.image;
    if (typeof encoded !== 'string' || !encoded.length || encoded.length > 11 * 1024 * 1024)
      fail('AI가 이미지 결과를 반환하지 않았어요.', 502);
    let output: Uint8Array<ArrayBuffer>;
    let outputHeader: ReturnType<typeof readImageHeader>;
    try {
      output = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
      outputHeader = readImageHeader(output);
    } catch {
      return fail('AI 이미지 형식이 올바르지 않아요.', 502);
    }
    if (outputHeader.width > 1920 || outputHeader.height > 1920)
      fail('AI 이미지 크기가 올바르지 않아요.', 502);
    return new Response(output, {
      headers: {
        'Content-Type': outputHeader.mime,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-SJN-Image-Model': FLUX_MODEL,
      },
    });
  } catch (error) {
    if (request.signal.aborted) throw new CloudGemmaError('이미지 변환 요청이 종료됐어요.', 'cancelled', 499);
    const failure = controller.signal.aborted
      ? new CloudGemmaError('이미지 변환 응답 시간이 초과됐어요. 자동 재시도하지 않았어요.', 'timeout', 504)
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
      },
    );
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener('abort', cancel);
  }
}
export async function runFluxExport(
  request: Request,
  environment: FluxEnvironment = getRuntimeEnvironment(),
) {
  const ai = await openFluxRequest(request, environment);
  const form = await readFluxForm(request, MAX_REQUEST_BYTES);
  checkFluxFields(form, ['image', 'seed'], ['scene']);
  const seed = readFluxSeed(form);
  const { blob: image, header } = await readFluxPng(form.get('image'), '올바른 PNG 이미지를 전달해 주세요.');
  // Placed-product facts arrive as enums and numbers only; every sentence is written here.
  let scene: FluxScene | undefined;
  const sceneText = form.get('scene');
  if (sceneText !== null) {
    if (typeof sceneText !== 'string' || new TextEncoder().encode(sceneText).length > FLUX_MAX_SCENE_BYTES)
      fail('제품 정보가 너무 커요.');
    let parsed: unknown;
    try {
      parsed = JSON.parse(sceneText);
    } catch {
      fail('제품 정보 형식이 올바르지 않아요.');
    }
    const result = fluxSceneSchema.safeParse(parsed);
    if (!result.success) fail('제품 정보 형식이 올바르지 않아요.');
    scene = result.data;
  }
  const prompt = buildFluxPrompt(scene);
  const model = new FormData();
  model.set('input_image_0', image, 'after.png');
  model.set('prompt', prompt);
  model.set('width', String(header.width * 2));
  model.set('height', String(header.height * 2));
  model.set('seed', String(seed));
  return callFlux({
    request,
    ai,
    model,
    diagnostics: { promptLength: prompt.length, fixtures: scene?.fixtures.length ?? 0 },
  });
}
