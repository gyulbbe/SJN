import { getRuntimeEnvironment } from '@/lib/platform/runtime';
import { FLUX_MAX_IMAGE_BYTES } from '../ai-export/contract';
import {
  callFlux,
  fail,
  openFluxRequest,
  readFluxForm,
  readFluxPng,
  readFluxSeed,
  type FluxEnvironment,
} from '../ai-export/server';
import { DIRECTION_PHOTO_MAX_SPEC_BYTES, directionPhotoSpecSchema } from './contract';
import { buildDirectionPhotoPrompt } from './prompt';

/** The real product's photos sent with a guide. */
export const DIRECTION_PHOTO_MAX_REFS = 3;
const MAX_REQUEST_BYTES =
  (1 + DIRECTION_PHOTO_MAX_REFS) * FLUX_MAX_IMAGE_BYTES + DIRECTION_PHOTO_MAX_SPEC_BYTES + 4096;

/** `guide`, `seed` and `spec` once each, `refs` one to three times, and nothing else. */
function checkFields(form: FormData) {
  const allowed = ['guide', 'refs', 'seed', 'spec'];
  const refs = form.getAll('refs').length;
  if (
    [...form.keys()].some((key) => !allowed.includes(key)) ||
    ['guide', 'seed', 'spec'].some((key) => form.getAll(key).length !== 1) ||
    refs < 1 ||
    refs > DIRECTION_PHOTO_MAX_REFS
  )
    fail('이미지 요청 필드를 확인해 주세요.');
}

/**
 * POST /api/materials/direction-photo: one direction photo of a product, from the guide (image 0, a
 * grey render of the product's kind at its size, seen from that direction) and one to three photos
 * of the real product on white (images 1–3). A route of its own, as strict as the FLUX export routes:
 * same-origin and login checks, a bounded body, PNGs of 128–496 px in 16 px steps, the facts as
 * enums and numbers only (directionPhotoSpecSchema), every sentence written here. One model call per
 * request, no retry; the answer is twice the guide's size.
 */
export async function runDirectionPhoto(
  request: Request,
  environment: FluxEnvironment = getRuntimeEnvironment(),
) {
  const ai = await openFluxRequest(request, environment);
  const form = await readFluxForm(request, MAX_REQUEST_BYTES);
  checkFields(form);
  const seed = readFluxSeed(form);
  const specText = form.get('spec');
  if (
    typeof specText !== 'string' ||
    new TextEncoder().encode(specText).length > DIRECTION_PHOTO_MAX_SPEC_BYTES
  )
    fail('제품 정보가 너무 커요.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(specText);
  } catch {
    fail('제품 정보 형식이 올바르지 않아요.');
  }
  const spec = directionPhotoSpecSchema.safeParse(parsed);
  if (!spec.success) fail('제품 정보 형식이 올바르지 않아요.');
  const { blob: guide, header } = await readFluxPng(form.get('guide'), '올바른 가이드 PNG를 전달해 주세요.');
  const refs: Blob[] = [];
  for (const ref of form.getAll('refs'))
    refs.push((await readFluxPng(ref, '올바른 제품 사진 PNG를 전달해 주세요.')).blob);
  if (spec.data.photoAngles.length !== refs.length) fail('참고 사진마다 찍은 각도를 보내 주세요.');
  const prompt = buildDirectionPhotoPrompt(spec.data, refs.length);
  const model = new FormData();
  model.set('input_image_0', guide, 'guide.png');
  refs.forEach((ref, index) => model.set(`input_image_${index + 1}`, ref, `photo-${index + 1}.png`));
  model.set('prompt', prompt);
  model.set('width', String(header.width * 2));
  model.set('height', String(header.height * 2));
  model.set('seed', String(seed));
  return callFlux({
    request,
    ai,
    model,
    diagnostics: {
      promptLength: prompt.length,
      category: spec.data.category,
      direction: spec.data.direction,
      references: refs.length,
      guide: [header.width, header.height],
    },
  });
}
