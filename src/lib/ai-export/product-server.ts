import { getRuntimeEnvironment } from '@/lib/platform/runtime';
import { FLUX_MAX_IMAGE_BYTES } from './contract';
import { buildFluxProductPrompt, fluxProductSchema } from './product-prompt';
import {
  callFlux,
  checkFluxFields,
  fail,
  openFluxRequest,
  readFluxForm,
  readFluxPng,
  readFluxSeed,
  type FluxEnvironment,
} from './server';

/** One product's facts: a few enums, numbers and a colour. */
export const FLUX_MAX_PRODUCT_BYTES = 4 * 1024;
const MAX_REQUEST_BYTES = 2 * FLUX_MAX_IMAGE_BYTES + FLUX_MAX_PRODUCT_BYTES + 4096;

/**
 * POST /api/export/photoreal/product: one product's close-up (a render on plain white) redrawn as a
 * studio photograph. A route of its own, with its own contract: the room route stays as strict as it
 * was (`image`, `seed`, `scene`). Fields: `image` (the crop), `seed`, `product` (JSON, see
 * fluxProductSchema) and optionally `reference` (the real product's photo on white). No free
 * sentence is ever accepted: the prompt is written here from the product's enums and numbers.
 * One call per request, no retry; same-origin and login checks as the room route.
 */
export async function runFluxProductRefine(
  request: Request,
  environment: FluxEnvironment = getRuntimeEnvironment(),
) {
  const ai = await openFluxRequest(request, environment);
  const form = await readFluxForm(request, MAX_REQUEST_BYTES);
  checkFluxFields(form, ['image', 'seed', 'product'], ['reference']);
  const seed = readFluxSeed(form);
  const { blob: image, header } = await readFluxPng(
    form.get('image'),
    '올바른 제품 PNG 이미지를 전달해 주세요.',
  );
  const referenceField = form.get('reference');
  const reference =
    referenceField === null
      ? undefined
      : (await readFluxPng(referenceField, '올바른 제품 사진 PNG를 전달해 주세요.')).blob;
  const productText = form.get('product');
  if (
    typeof productText !== 'string' ||
    new TextEncoder().encode(productText).length > FLUX_MAX_PRODUCT_BYTES
  )
    fail('제품 정보가 너무 커요.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(productText);
  } catch {
    fail('제품 정보 형식이 올바르지 않아요.');
  }
  const product = fluxProductSchema.safeParse(parsed);
  if (!product.success) fail('제품 정보 형식이 올바르지 않아요.');
  const prompt = buildFluxProductPrompt(product.data, !!reference);
  const model = new FormData();
  model.set('input_image_0', image, 'product.png');
  if (reference) model.set('input_image_1', reference, 'photo.png');
  model.set('prompt', prompt);
  model.set('width', String(header.width * 2));
  model.set('height', String(header.height * 2));
  model.set('seed', String(seed));
  return callFlux({
    request,
    ai,
    model,
    diagnostics: { promptLength: prompt.length, product: product.data.kind, references: reference ? 1 : 0 },
  });
}
