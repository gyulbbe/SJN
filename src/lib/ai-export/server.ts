import { getRuntimeEnvironment } from '@/lib/platform/runtime';
import { readImageHeader } from '@/lib/images';
import { assertCloudGemmaRequest } from '@/lib/reconstruction/cloud-gemma-server';
import { CloudGemmaError, classifyCloudGemmaFailure } from '@/lib/reconstruction/cloud-gemma-errors';
import {
  FLUX_MODELS,
  FLUX_GATEWAY,
  FLUX_INPUT_EDGE,
  FLUX_MAX_IMAGE_BYTES,
  FLUX_PROMPT,
  type FluxVariant,
} from './contract';

type Environment = ReturnType<typeof getRuntimeEnvironment>;
type FluxBinding = {
  run: (
    model: string,
    input: { multipart: { body: ReadableStream; contentType: string } },
    options: {
      gateway: { id: string; retries: { maxAttempts: number }; skipCache: boolean };
      returnRawResponse: true;
      signal: AbortSignal;
    },
  ) => Promise<Response>;
};
function fail(message: string, status = 400): never {
  throw new CloudGemmaError(message, status === 400 ? 'invalid_input' : 'invalid_response', status);
}
async function bounded(message: Request | Response, limit: number, signal: AbortSignal, status = 400) {
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
export async function runFluxExport(request: Request, environment: Environment = getRuntimeEnvironment()) {
  await assertCloudGemmaRequest(request, environment);
  const ai = environment.AI as FluxBinding | undefined;
  if (environment.platform !== 'cloudflare' || typeof ai?.run !== 'function')
    throw new CloudGemmaError(
      'Cloudflare AI 연결이 없는 실행 환경이에요. Cloudflare에 배포하거나 Workers 개발 서버에서 실행해 주세요.',
      'binding_unavailable',
      503,
    );
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.startsWith('multipart/form-data;')) fail('이미지를 multipart 형식으로 전달해 주세요.');
  const bytes = await bounded(request, FLUX_MAX_IMAGE_BYTES + 4096, request.signal);
  let form: FormData;
  try {
    form = await new Response(bytes, { headers: { 'Content-Type': contentType } }).formData();
  } catch {
    return fail('이미지 요청 형식이 올바르지 않아요.');
  }
  const fields = ['model', 'image', 'seed'];
  if (
    [...form.keys()].some((key) => !fields.includes(key)) ||
    fields.some((key) => form.getAll(key).length !== 1)
  )
    fail('이미지 요청 필드를 확인해 주세요.');
  const variant = form.get('model');
  if (variant !== '4b' && variant !== '9b') fail('지원하지 않는 이미지 모델이에요.');
  const seedText = form.get('seed');
  if (typeof seedText !== 'string' || !/^\d{1,10}$/.test(seedText))
    fail('이미지 비교 seed가 올바르지 않아요.');
  const seed = Number(seedText);
  if (!Number.isInteger(seed) || seed < 0 || seed > 2147483647) fail('이미지 비교 seed가 올바르지 않아요.');
  const image = form.get('image');
  if (!(image instanceof Blob) || image.size === 0 || image.size > FLUX_MAX_IMAGE_BYTES)
    fail('입력 이미지는 2MB 이하여야 해요.');
  let header: ReturnType<typeof readImageHeader>;
  try {
    header = readImageHeader(new Uint8Array(await image.arrayBuffer()));
  } catch {
    return fail('올바른 PNG 이미지를 전달해 주세요.');
  }
  if (
    header.mime !== 'image/png' ||
    [header.width, header.height].some((n) => n < 128 || n > FLUX_INPUT_EDGE || n % 16 !== 0)
  )
    fail('AI 비교용 PNG의 크기가 올바르지 않아요.');
  const input = new FormData();
  input.set('input_image_0', image, 'after.png');
  input.set('prompt', FLUX_PROMPT);
  input.set('width', String(header.width * 2));
  input.set('height', String(header.height * 2));
  input.set('seed', String(seed));
  const serialized = new Response(input);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  request.signal.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => controller.abort(), 180_000);
  try {
    request.signal.throwIfAborted();
    // One explicit click -> one model call. Override gateway automatic retries.
    const response = await ai.run(
      FLUX_MODELS[variant as FluxVariant],
      {
        multipart: { body: serialized.body!, contentType: serialized.headers.get('content-type')! },
      },
      {
        gateway: { id: FLUX_GATEWAY, retries: { maxAttempts: 1 }, skipCache: true },
        returnRawResponse: true,
        signal: controller.signal,
      },
    );
    const raw = await bounded(response, 12 * 1024 * 1024, controller.signal, 502);
    const text = new TextDecoder().decode(raw);
    if (!response.ok)
      throw classifyCloudGemmaFailure(response.status, text, response.headers.get('Retry-After'));
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return fail('AI 이미지 응답을 읽지 못했어요.', 502);
    }
    if (body?.success === false) throw classifyCloudGemmaFailure(502, body);
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
        'X-SJN-Image-Model': FLUX_MODELS[variant as FluxVariant],
      },
    });
  } catch (error) {
    if (request.signal.aborted) throw new CloudGemmaError('이미지 변환 요청이 종료됐어요.', 'cancelled', 499);
    if (controller.signal.aborted)
      throw new CloudGemmaError(
        '이미지 변환 응답 시간이 초과됐어요. 자동 재시도하지 않았어요.',
        'timeout',
        504,
      );
    if (error instanceof CloudGemmaError) throw error;
    throw classifyCloudGemmaFailure(502, error instanceof Error ? error.message : '');
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener('abort', cancel);
  }
}
