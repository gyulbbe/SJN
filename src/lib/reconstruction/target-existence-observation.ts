import { z } from 'zod';
import { readImageHeader, previewDimensions } from '../images';
import { validAnalysisModelPair } from './analysis-provider';
import { CLOUD_GEMMA_MODEL } from './cloud-gemma-contract';
import { prepareCloudGemmaPrompt, prepareCloudGemmaSchema } from './cloud-gemma-coordinates';
import type { ProductBounds } from '../room-types';

/** Frozen text from the eight-call target-existence-v1 experiment; unrelated kinds are never applied. */
const TARGET_PROMPT =
  "Inspect the visible evidence for one fixed candidate in a bathroom photo. Do not discover new candidates. Do not infer hidden fixtures or invent storage doors.\nThe first image is the complete original photo. A second image, when present, is only a contextual enlargement of the target candidate's region in that same photo. It is not a second room or a separate object. Both images describe the same scene. Use the full photo for identity, position, support, and relationships; use the enlargement only for visible detail.\nTarget candidate ID: __TARGET_ID__\nCandidate boxes below use original-photo coordinates normalized to 0..1000 as [left,top,right,bottom]. IDs identify regions, not confirmed objects. A box can contain only a component, several objects, a wall, or a reflection. Different IDs can overlap or identify the same physical object. No candidate's previous category is supplied.\n__CANDIDATE_BOXES__\nFirst describe the target's visible shapes, edges, lower support, and any actually visible enclosure or door boundaries in note. Then classify targetExistence and whether the box describes a whole object, a component, multiple objects, or is uncertain. whole-object means the candidate refers to one fixture as a unit even if part of its outline is occluded or cut by the image edge. component means the candidate refers specifically to a distinct constituent part rather than the complete fixture. multiple-objects means the region refers to more than one separate fixture. Use uncertain when the region does not establish its scope. targetExistence describes the referent of the target box, not merely the optical appearance of its pixels. directly-visible-surface means the target itself is a tangible surface or panel seen directly in this room; this can be a mirror, glass, opaque wall, or another surface. directly-visible-object means the target itself is a tangible fixture or object seen directly in this room. only-depicted-in-reflection means the target itself is an image of an object shown inside another reflecting surface, not that object seen directly. mixed-targets means the region does not identify a single referent and mixes distinct physical targets or physical surface and depicted content without a clear target. not-an-identifiable-target means no identifiable surface or object is established. Use uncertain when direct versus depicted cannot be determined. A panel or mirror is not automatically directly visible: a mirror itself can appear only in another mirror. Conversely the presence of reflected scenery on a directly seen panel does not make the panel itself a depicted object. Choose from actual target boundaries and scene context; do not force a result from the kind label. Do not select the reflected scenery when the supplied box refers to the surrounding surface, and do not select the surrounding surface when the box isolates a depicted object. A component such as a tank is not a separate complete fixture solely because it has its own box.\nUse unknown or uncertain when the visible evidence does not establish a classification. Mark a structure absent only when its absence is visible; otherwise mark uncertain. Select kind only from the provided schema after considering that evidence. For showerStyle, use hand-spray for a visibly compact hand spray, handheld-rail for a visibly supported handheld shower rail, overhead-set for a visibly overhead shower arrangement, and unknown if the visible structure does not establish a style. For non-shower targets, use unknown. Do not infer unseen shower pieces. Do not assume a generic bathroom layout or standard objects.\nsameObjectAs may reference an earlier or later supplied ID only when both boxes visibly refer to the same physical entity. partOf may reference an ID only when the target visibly represents a component of that object's assembly. Null means not established. Overlap alone is not proof: glass can overlap objects behind it, a mirror can show reflections, and a basin and support can be separate components.\nReturn only one JSON object matching the schema. No code, commands, markdown, or explanation outside JSON.\nkind definitions: wall_basin = basin hanging from wall with no full floor pedestal and no enclosing cabinet; pedestal_basin = basin supported by a narrow pedestal reaching the floor; enclosed_vanity = storage base with visible enclosing cabinet body/doors under basin/counter; open_counter_basin = basin and counter with visibly open space below rather than cabinet doors; mirror = reflective panel; mirror_cabinet = mirror-front storage box with visible body depth, cabinet edges/doors or other storage evidence; wall_cabinet = opaque-front wall storage cabinet; glass_partition = separate transparent/translucent shower divider; opaque_low_partition = solid low wall/divider; shower = showerhead/hose/control fixture; wall_shelf = wall shelf or towel rack; door = visible door leaf; door_frame_only = frame/jamb without an actual visible leaf; window/toilet/bathtub = those fixtures; unknown = insufficient evidence for the listed kinds.";

export const TARGET_EXISTENCE_CONTRACT = 'target-existence-v1' as const;
export const TARGET_EXISTENCE_PROMPT_REVISION = 1;
export const TARGET_EXISTENCE_INPUT_REVISION = 'normalized-source-full-crop-v1' as const;
export const targetExistenceKinds = [
  'wall_basin',
  'pedestal_basin',
  'enclosed_vanity',
  'open_counter_basin',
  'mirror',
  'mirror_cabinet',
  'wall_cabinet',
  'glass_partition',
  'opaque_low_partition',
  'shower',
  'wall_shelf',
  'door',
  'door_frame_only',
  'window',
  'toilet',
  'bathtub',
  'unknown',
] as const;
export const targetExistenceValues = [
  'directly-visible-surface',
  'directly-visible-object',
  'only-depicted-in-reflection',
  'mixed-targets',
  'not-an-identifiable-target',
  'uncertain',
] as const;
const structureNames = [
  'cabinetBody',
  'cabinetDoors',
  'basinBowl',
  'pedestalToFloor',
  'toiletBowl',
  'toiletTank',
  'transparentPanel',
  'reflectivePanel',
] as const;
const scopeValues = ['whole-object', 'component', 'multiple-objects', 'uncertain'] as const;
const styleValues = ['hand-spray', 'handheld-rail', 'overhead-set', 'unknown'] as const;
const supportValues = [
  'wall-hung-open-below',
  'pedestal-to-floor',
  'enclosed-base',
  'counter-with-open-below',
  'separate-component',
  'not-visible',
  'uncertain',
] as const;
const presenceValues = ['present', 'absent', 'uncertain'] as const;
const idSchema = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const boundsSchema = z
  .strictObject({
    left: z.number().finite().min(0).max(1),
    top: z.number().finite().min(0).max(1),
    right: z.number().finite().min(0).max(1),
    bottom: z.number().finite().min(0).max(1),
  })
  .refine((b) => b.left < b.right && b.top < b.bottom, 'Invalid target box');
export const targetExistenceObservationSchema = z.strictObject({
  id: idSchema,
  note: z.string().min(1).max(800),
  targetExistence: z.enum(targetExistenceValues),
  objectScope: z.enum(scopeValues),
  kind: z.enum(targetExistenceKinds),
  showerStyle: z.enum(styleValues),
  visibleStructure: z.strictObject({
    cabinetBody: z.enum(presenceValues),
    cabinetDoors: z.enum(presenceValues),
    basinBowl: z.enum(presenceValues),
    pedestalToFloor: z.enum(presenceValues),
    toiletBowl: z.enum(presenceValues),
    toiletTank: z.enum(presenceValues),
    transparentPanel: z.enum(presenceValues),
    reflectivePanel: z.enum(presenceValues),
  }),
  lowerSupport: z.enum(supportValues),
  sameObjectAs: idSchema.nullable(),
  partOf: idSchema.nullable(),
});
export type TargetExistenceObservation = z.infer<typeof targetExistenceObservationSchema>;
export type TargetCandidateBox = { id: string; bounds: ProductBounds };
const boxesSchema = z
  .array(z.strictObject({ id: idSchema, bounds: boundsSchema }))
  .min(1)
  .max(24);
function checkedBoxes(targetId: string, values: readonly TargetCandidateBox[]) {
  idSchema.parse(targetId);
  const boxes = boxesSchema.parse(values);
  if (new Set(boxes.map((b) => b.id)).size !== boxes.length || !boxes.some((b) => b.id === targetId))
    throw new Error('대상 ID가 원후보와 다르거나 반복돼요.');
  return boxes;
}
export function targetExistenceJsonSchemaFor(targetId: string, ids: readonly string[]) {
  const boxes = checkedBoxes(
    targetId,
    ids.map((id) => ({ id, bounds: { left: 0, top: 0, right: 1, bottom: 1 } })),
  );
  const other = boxes.map((b) => b.id).filter((id) => id !== targetId),
    en = (values: readonly string[]) => ({ type: 'string', enum: [...values] });
  // With a single candidate only null is possible; avoid unsupported empty-enum grammars.
  const reference = () => (other.length ? { anyOf: [{ type: 'null' }, en(other)] } : { type: 'null' });
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      id: en([targetId]),
      note: { type: 'string', minLength: 1, maxLength: 800 },
      targetExistence: en(targetExistenceValues),
      objectScope: en(scopeValues),
      kind: en(targetExistenceKinds),
      showerStyle: en(styleValues),
      visibleStructure: {
        type: 'object',
        additionalProperties: false,
        properties: Object.fromEntries(structureNames.map((k) => [k, en(presenceValues)])),
        required: [...structureNames],
      },
      lowerSupport: en(supportValues),
      sameObjectAs: reference(),
      partOf: reference(),
    },
    required: [
      'id',
      'note',
      'targetExistence',
      'objectScope',
      'kind',
      'showerStyle',
      'visibleStructure',
      'lowerSupport',
      'sameObjectAs',
      'partOf',
    ],
  };
}
export function targetExistencePrompt(targetId: string, values: readonly TargetCandidateBox[]) {
  const boxes = checkedBoxes(targetId, values),
    input = boxes.map((b) => ({
      id: b.id,
      bbox_2d: [b.bounds.left, b.bounds.top, b.bounds.right, b.bounds.bottom].map((v) =>
        Math.round(v * 1000),
      ),
    }));
  return (
    TARGET_PROMPT.replace('__TARGET_ID__', targetId).replace('__CANDIDATE_BOXES__', JSON.stringify(input)) +
    '\nExact JSON schema (the same schema is supplied as the structured output constraint):\n' +
    JSON.stringify(
      targetExistenceJsonSchemaFor(
        targetId,
        boxes.map((b) => b.id),
      ),
    )
  );
}
/** Hash the same provider-specific prompt/schema sent by the server, without changing canonical boxes. */
function targetExistenceReceiptContract(
  modelId: string,
  targetId: string,
  boxes: readonly TargetCandidateBox[],
) {
  const prompt = targetExistencePrompt(targetId, boxes);
  const schema = targetExistenceJsonSchemaFor(
    targetId,
    boxes.map((box) => box.id),
  );
  return modelId === CLOUD_GEMMA_MODEL
    ? {
        prompt: prepareCloudGemmaPrompt(prompt, 'target-existence'),
        schema: prepareCloudGemmaSchema(schema),
      }
    : { prompt, schema };
}
export function parseTargetExistenceObservation(
  rawText: string,
  targetId: string,
  boxes: readonly TargetCandidateBox[],
): TargetExistenceObservation {
  const checked = checkedBoxes(targetId, boxes);
  if (typeof rawText !== 'string' || new TextEncoder().encode(rawText).length > 64_000)
    throw new Error('대상 재확인 응답 크기가 올바르지 않아요.');
  const result = targetExistenceObservationSchema.parse(JSON.parse(rawText));
  if (result.id !== targetId) throw new Error('응답이 요청한 대상 ID와 달라요.');
  for (const id of [result.sameObjectAs, result.partOf])
    if (id !== null && (id === targetId || !checked.some((b) => b.id === id)))
      throw new Error('응답의 연결 대상이 원후보와 달라요.');
  if (result.sameObjectAs && result.sameObjectAs === result.partOf)
    throw new Error('같은 물체와 부품 관계가 모순돼요.');
  return result;
}
/** Stable JSON values, not object key order, are the binding. No prose is interpreted as code. */
export function canonicalTargetValue(value: unknown): string {
  const seen = new Set<object>();
  const walk = (v: unknown, depth: number): unknown => {
    if (depth > 64) throw new Error('관측 데이터가 너무 깊어요.');
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) throw new Error('유한하지 않은 관측 값이에요.');
      return v;
    }
    if (typeof v !== 'object' || seen.has(v)) throw new Error('관측 값이 JSON 형식이 아니거나 순환해요.');
    if (
      !Array.isArray(v) &&
      Object.getPrototypeOf(v) !== Object.prototype &&
      Object.getPrototypeOf(v) !== null
    )
      throw new Error('관측 값이 일반 JSON이 아니에요.');
    seen.add(v);
    try {
      return Array.isArray(v)
        ? v.map((x) => walk(x, depth + 1))
        : Object.fromEntries(
            Object.entries(v)
              .filter(([, x]) => x !== undefined)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, x]) => [k, walk(x, depth + 1)]),
          );
    } finally {
      seen.delete(v);
    }
  };
  return JSON.stringify(walk(value, 0));
}
export async function targetExistenceSha256(bytes: Uint8Array | string): Promise<string> {
  const copy = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : new Uint8Array(bytes);
  const digest = await crypto.subtle.digest('SHA-256', copy);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const imageSchema = z.strictObject({
  width: z.number().int().positive().max(2048),
  height: z.number().int().positive().max(2048),
});
const rectSchema = z.strictObject({
  left: z.number().int().nonnegative(),
  top: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type TargetCropTransform = { left: number; top: number; width: number; height: number };
export function targetExistenceCropTransform(
  image: { width: number; height: number },
  bounds: ProductBounds,
): TargetCropTransform {
  const size = imageSchema.parse(image),
    b = boundsSchema.parse(bounds),
    cx = ((b.left + b.right) * size.width) / 2,
    cy = ((b.top + b.bottom) * size.height) / 2,
    w = Math.max(64, (b.right - b.left) * size.width * 1.3),
    h = Math.max(64, (b.bottom - b.top) * size.height * 1.3),
    left = Math.max(0, Math.floor(cx - w / 2)),
    top = Math.max(0, Math.floor(cy - h / 2)),
    right = Math.min(size.width, Math.ceil(cx + w / 2)),
    bottom = Math.min(size.height, Math.ceil(cy + h / 2));
  return { left, top, width: right - left, height: bottom - top };
}
export const targetExistenceReceiptSchema = z
  .strictObject({
    outputContract: z.literal(TARGET_EXISTENCE_CONTRACT),
    promptRevision: z.literal(TARGET_EXISTENCE_PROMPT_REVISION),
    inputRevision: z.literal(TARGET_EXISTENCE_INPUT_REVISION),
    photoFingerprint: hashSchema,
    normalizedFullSha256: hashSchema,
    cropSha256: hashSchema,
    sourceImage: imageSchema,
    fullImage: imageSchema,
    cropImage: imageSchema,
    targetId: idSchema,
    targetBounds: boundsSchema,
    cropTransform: rectSchema,
    boxes: boxesSchema,
    sourceDecisionSignature: z.string().min(1).max(750_000),
    modelId: z.string().max(150),
    modelRevision: z.string().max(200),
    promptSha256: hashSchema,
    schemaSha256: hashSchema,
  })
  .refine(
    (value) => validAnalysisModelPair(value.modelId, value.modelRevision),
    'Invalid provider/model identity',
  );
export type TargetExistenceReceipt = z.infer<typeof targetExistenceReceiptSchema>;
/** Actual caller-owned bytes are hashed. This proves byte identity, not pixel-derived crop authenticity. */
export async function createTargetExistenceReceipt(input: {
  photoBytes: Uint8Array;
  normalizedFullBytes: Uint8Array;
  cropBytes: Uint8Array;
  expectedPhotoFingerprint: string;
  targetId: string;
  boxes: readonly TargetCandidateBox[];
  cropTransform: TargetCropTransform;
  sourceDecisionSignature: string;
  modelId: string;
  modelRevision: string;
}): Promise<TargetExistenceReceipt> {
  // Pin metadata before the first await, just as image bytes are pinned below.
  input = { ...input, boxes: structuredClone(input.boxes), cropTransform: { ...input.cropTransform } };
  const copies = [input.photoBytes, input.normalizedFullBytes, input.cropBytes].map((bytes) => {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > 25 * 1024 * 1024)
      throw new Error('입력 이미지 byte 크기가 올바르지 않아요.');
    return new Uint8Array(bytes);
  });
  hashSchema.parse(input.expectedPhotoFingerprint);
  const [photoFingerprint, normalizedFullSha256, cropSha256] = await Promise.all(
    copies.map(targetExistenceSha256),
  );
  if (photoFingerprint !== input.expectedPhotoFingerprint)
    throw new Error('실제 원입력 byte가 현재 정규화 사진 해시와 달라요.');
  const [source, full, crop] = copies.map(readImageHeader);
  const sourceImage = { width: source.width, height: source.height },
    fullImage = { width: full.width, height: full.height },
    cropImage = { width: crop.width, height: crop.height };
  imageSchema.parse(sourceImage);
  if (
    full.mime !== 'image/jpeg' ||
    crop.mime !== 'image/jpeg' ||
    copies[1].length > 8 * 1024 * 1024 ||
    copies[2].length > 8 * 1024 * 1024
  )
    throw new Error('모델 입력은 8MB 이하 JPEG여야 해요.');
  const boxes = checkedBoxes(input.targetId, input.boxes),
    targetBounds = boxes.find((b) => b.id === input.targetId)!.bounds;
  const expectedTransform = targetExistenceCropTransform(sourceImage, targetBounds);
  if (canonicalTargetValue(input.cropTransform) !== canonicalTargetValue(expectedTransform))
    throw new Error('crop 좌표가 정규화 사진의 대상 영역과 달라요.');
  if (
    canonicalTargetValue(fullImage) !==
      canonicalTargetValue(previewDimensions(source.width, source.height, 1024)) ||
    canonicalTargetValue(cropImage) !==
      canonicalTargetValue(previewDimensions(expectedTransform.width, expectedTransform.height, 768))
  )
    throw new Error('모델 이미지 크기가 full/crop 변환 규칙과 달라요.');
  const { prompt, schema } = targetExistenceReceiptContract(input.modelId, input.targetId, boxes);
  return targetExistenceReceiptSchema.parse({
    outputContract: TARGET_EXISTENCE_CONTRACT,
    promptRevision: TARGET_EXISTENCE_PROMPT_REVISION,
    inputRevision: TARGET_EXISTENCE_INPUT_REVISION,
    photoFingerprint,
    normalizedFullSha256,
    cropSha256,
    sourceImage,
    fullImage,
    cropImage,
    targetId: input.targetId,
    targetBounds,
    cropTransform: expectedTransform,
    boxes,
    sourceDecisionSignature: input.sourceDecisionSignature,
    modelId: input.modelId,
    modelRevision: input.modelRevision,
    promptSha256: await targetExistenceSha256(prompt),
    schemaSha256: await targetExistenceSha256(JSON.stringify(schema)),
  });
}
export type TargetExistenceAnalysis = {
  receipt: TargetExistenceReceipt;
  rawText: string;
  rawTextSha256: string;
  observation: TargetExistenceObservation;
};
/** Validates even saved/missing-response request receipts; byte hashes still require an independent caller expectation. */
export async function validateTargetExistenceReceipt(
  value: TargetExistenceReceipt,
): Promise<TargetExistenceReceipt> {
  const receipt = targetExistenceReceiptSchema.parse(value);
  checkedBoxes(receipt.targetId, receipt.boxes);
  if (
    canonicalTargetValue(receipt.targetBounds) !==
      canonicalTargetValue(receipt.boxes.find((b) => b.id === receipt.targetId)!.bounds) ||
    canonicalTargetValue(receipt.cropTransform) !==
      canonicalTargetValue(targetExistenceCropTransform(receipt.sourceImage, receipt.targetBounds))
  )
    throw new Error('보관된 대상/crop 좌표가 원후보와 달라요.');
  if (
    canonicalTargetValue(receipt.fullImage) !==
      canonicalTargetValue(previewDimensions(receipt.sourceImage.width, receipt.sourceImage.height, 1024)) ||
    canonicalTargetValue(receipt.cropImage) !==
      canonicalTargetValue(previewDimensions(receipt.cropTransform.width, receipt.cropTransform.height, 768))
  )
    throw new Error('보관된 모델 입력 크기가 full/crop 변환 규칙과 달라요.');
  const { prompt, schema } = targetExistenceReceiptContract(receipt.modelId, receipt.targetId, receipt.boxes);
  if (
    (await targetExistenceSha256(prompt)) !== receipt.promptSha256 ||
    (await targetExistenceSha256(JSON.stringify(schema))) !== receipt.schemaSha256
  )
    throw new Error('관측 프롬프트 또는 schema가 고정 계약과 달라요.');
  return receipt;
}
/** Server returns request-scoped receipt; caller compares it with independently prepared bytes. */
export async function validateTargetExistenceAnalysis(
  value: {
    receipt: TargetExistenceReceipt;
    rawText: string;
    rawTextSha256?: string;
    observation?: TargetExistenceObservation;
  },
  expected: TargetExistenceReceipt,
): Promise<TargetExistenceAnalysis> {
  const receipt = await validateTargetExistenceReceipt(value.receipt),
    context = await validateTargetExistenceReceipt(expected);
  if (canonicalTargetValue(receipt) !== canonicalTargetValue(context))
    throw new Error('대상 관측의 사진·crop·후보·모델·계약 입력이 현재 요청과 달라요.');
  const observation = parseTargetExistenceObservation(value.rawText, receipt.targetId, receipt.boxes),
    rawTextSha256 = await targetExistenceSha256(value.rawText);
  if (value.rawTextSha256 !== undefined && value.rawTextSha256 !== rawTextSha256)
    throw new Error('원응답 해시가 보관 기록과 달라요.');
  if (
    value.observation !== undefined &&
    canonicalTargetValue(value.observation) !== canonicalTargetValue(observation)
  )
    throw new Error('원응답과 적용하려는 관측이 달라요.');
  return { receipt: structuredClone(receipt), rawText: value.rawText, rawTextSha256, observation };
}
