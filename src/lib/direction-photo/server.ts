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
import {
  DIRECTION_PHOTO_MAX_FEEDBACK_BYTES,
  DIRECTION_PHOTO_MAX_REFS_WITH_FEEDBACK,
  DIRECTION_PHOTO_MAX_SPEC_BYTES,
  directionPhotoFeedbackSchema,
  directionPhotoSpecSchema,
  type DirectionPhotoFeedback,
} from './contract';
import { buildDirectionPhotoPrompt } from './prompt';

/** The real product's photos sent with a guide. */
export const DIRECTION_PHOTO_MAX_REFS = 3;
const MAX_REQUEST_BYTES =
  (1 + DIRECTION_PHOTO_MAX_REFS) * FLUX_MAX_IMAGE_BYTES +
  DIRECTION_PHOTO_MAX_SPEC_BYTES +
  DIRECTION_PHOTO_MAX_FEEDBACK_BYTES +
  4096;

/**
 * `guide`, `seed` and `spec` once each and `refs` one to three times; or, to change an earlier
 * candidate, `previous` and `feedback` once each with one or two `refs`. Nothing else.
 */
function checkFields(form: FormData) {
  const allowed = ['guide', 'refs', 'seed', 'spec', 'previous', 'feedback'];
  const refs = form.getAll('refs').length;
  const fixing = form.has('previous') || form.has('feedback');
  if (
    [...form.keys()].some((key) => !allowed.includes(key)) ||
    ['guide', 'seed', 'spec'].some((key) => form.getAll(key).length !== 1) ||
    (fixing && ['previous', 'feedback'].some((key) => form.getAll(key).length !== 1)) ||
    refs < 1 ||
    refs > (fixing ? DIRECTION_PHOTO_MAX_REFS_WITH_FEEDBACK : DIRECTION_PHOTO_MAX_REFS)
  )
    fail('이미지 요청 필드를 확인해 주세요.');
}

/** "고칠 점": the quick fixes and the person's own words (contract.ts), within 2 KB. */
function readFeedback(form: FormData): DirectionPhotoFeedback {
  const text = form.get('feedback');
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > DIRECTION_PHOTO_MAX_FEEDBACK_BYTES)
    fail('고칠 점이 너무 길어요.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail('고칠 점 형식이 올바르지 않아요.');
  }
  const feedback = directionPhotoFeedbackSchema.safeParse(parsed);
  if (!feedback.success) fail(feedback.error.issues[0]?.message ?? '고칠 점 형식이 올바르지 않아요.');
  return feedback.data;
}

/**
 * POST /api/materials/direction-photo: one direction photo of a product, from the guide (image 0, a
 * grey render of the product's kind at its size, seen from that direction) and one to three photos
 * of the real product on white (images 1–3). A route of its own, as strict as the FLUX export routes:
 * same-origin and login checks, a bounded body, PNGs of 128–496 px in 16 px steps, the facts as
 * enums and numbers only (directionPhotoSpecSchema), every sentence written here. One model call per
 * request, no retry; the answer is twice the guide's size.
 *
 * "고칠 점": with `previous` (an earlier candidate) and `feedback`, the earlier candidate follows one
 * or two photos as the last image, and the prompt ends with what to change in it. The person's own
 * words there are the one free text this route takes: quoted to the model, never logged.
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
  const feedback = form.has('feedback') ? readFeedback(form) : undefined;
  const { blob: guide, header } = await readFluxPng(form.get('guide'), '올바른 가이드 PNG를 전달해 주세요.');
  const refs: Blob[] = [];
  for (const ref of form.getAll('refs'))
    refs.push((await readFluxPng(ref, '올바른 제품 사진 PNG를 전달해 주세요.')).blob);
  const previous = feedback
    ? (await readFluxPng(form.get('previous'), '올바른 이전 후보 PNG를 전달해 주세요.')).blob
    : undefined;
  if (spec.data.photoAngles && spec.data.photoAngles.length !== refs.length)
    fail('참고 사진마다 찍은 각도를 보내 주세요.');
  const prompt = buildDirectionPhotoPrompt(spec.data, refs.length, feedback);
  const model = new FormData();
  model.set('input_image_0', guide, 'guide.png');
  refs.forEach((ref, index) => model.set(`input_image_${index + 1}`, ref, `photo-${index + 1}.png`));
  if (previous) model.set(`input_image_${refs.length + 1}`, previous, 'earlier.png');
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
      // The quick fixes (enums) and how long the person's words were: never the words.
      ...(feedback && { feedback: { fixes: feedback.fixes, textLength: feedback.text.length } }),
    },
  });
}
