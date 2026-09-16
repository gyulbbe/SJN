import { MOGE_POSTPROCESS_VERSION } from './moge-browser/postprocess';
import { MOGE_PLANES_VERSION } from './moge-browser/planes';
import { MOGE_BROWSER_MODEL, MOGE_BROWSER_MODEL_REVISION, MOGE_BROWSER_MODEL_SHA256, MOGE_BROWSER_PREPROCESS_REVISION, MOGE_NUM_TOKENS, mogeInputSize } from './moge-browser/artifact';
import type { DepthRoomObservation } from './depth-room-geometry';
import { z } from 'zod';

export const LOCAL_GEOMETRY_MODEL = 'Ruicheng/moge-2-vits-normal';
export const LOCAL_GEOMETRY_MODEL_REVISION = '26b477f41595707c5db6770294c0d1721e8ed4ed';
export const BROWSER_GEOMETRY_REVISION = 'moge2-browser-semantic-planes-v1';
export const LOCAL_GEOMETRY_REVISION = 'moge2-semantic-planes-v2-consensus-support';
export const GEOMETRY_MAX_MASK_PIXELS = 1024 * 1024;
export const GEOMETRY_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

const finite = z.number().finite();
const unit = finite.min(0).max(1);
const vector = z.tuple([finite, finite, finite]);
const box = z
  .object({ left: unit, top: unit, right: unit, bottom: unit })
  .refine((b) => b.left < b.right && b.top < b.bottom);
export const geometryRegionSchema = z.object({
  id: z.string().min(1).max(128),
  kind: z.string().min(1).max(64),
  bounds: box,
  source: z.enum(['segmentation', 'inventory']),
  reflection: z.enum(['physical', 'reflected', 'uncertain']).optional(),
});
export const geometryRequestMetadataSchema = z.object({
  version: z.literal(1),
  inputFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  image: z
    .object({ width: z.number().int().positive().max(40000), height: z.number().int().positive().max(40000) })
    .refine((i) => i.width * i.height <= 40_000_000),
  mask: z
    .object({ width: z.number().int().min(8).max(2048), height: z.number().int().min(8).max(2048) })
    .refine((i) => i.width * i.height <= GEOMETRY_MAX_MASK_PIXELS),
  regions: z.array(geometryRegionSchema).max(128),
});
export type GeometryRequestMetadata = z.infer<typeof geometryRequestMetadataSchema>;
const support = z.object({
  bounds: box,
  width: z.literal(64),
  height: z.literal(64),
  /** Row-major binary occupied support cells; NOT a full physical face mask. */
  occupied: z.string().regex(/^[01]{4096}$/),
});
const plane = z.object({
  id: z.string().min(1).max(64),
  normalCamera: vector,
  offset: finite,
  medianPointCamera: vector,
  inlierCount: z.number().int().nonnegative(),
  inlierFraction: unit,
  imageAreaFraction: unit,
  rmsResidual: finite.nonnegative(),
  imageSupport: support.optional(),
});
export const depthRoomObservationSchema = z.object({
  version: z.literal(1),
  inputFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  image: geometryRequestMetadataSchema.shape.image,
  model: z.object({
    id: z.literal(LOCAL_GEOMETRY_MODEL),
    revision: z.literal(LOCAL_GEOMETRY_MODEL_REVISION),
  }),
  coordinateSystem: z.literal('opencv-camera'),
  scale: z.literal('model-estimated-metres'),
  intrinsics: z.object({ fx: finite.positive(), fy: finite.positive(), cx: unit, cy: unit }),
  floor: plane.nullable(),
  walls: z.array(plane).max(16),
});
export type LocalGeometryMeasurement = {
  requestMs: number;
  queueMs?: number;
  modelLoadMs: number;
  inferenceMs: number;
  planeExtractionMs: number;
  cacheHit: boolean;
  modelCacheHit: boolean;
  modelDownload: 'not-performed-cached-model-required' | 'network' | 'cache' | 'memory';
  backend?: 'webgpu' | 'wasm';
  downloadMs?: number;
  cacheMs?: number;
  preprocessingMs?: number;
  postprocessingMs?: number;
  wasmThreads?: number;
  fallbackReason?: string;
  cacheWarning?: string;
  memoryScope: string;
  memory?: { pythonRssPeakBytes?: number; cudaPeakAllocatedBytes?: number; cudaPeakReservedBytes?: number };
};
export type LocalGeometryAnalysis = {
  observation: DepthRoomObservation;
  inputFingerprint: string;
  measurement: LocalGeometryMeasurement;
  evidence: Record<string, unknown>;
};
const measurement = z.object({
  requestMs: finite.nonnegative(),
  queueMs: finite.nonnegative().optional(),
  modelLoadMs: finite.nonnegative(),
  inferenceMs: finite.nonnegative(),
  planeExtractionMs: finite.nonnegative(),
  cacheHit: z.boolean(),
  modelCacheHit: z.boolean(),
  modelDownload: z.literal('not-performed-cached-model-required'),
  memoryScope: z.string().max(500),
  memory: z
    .object({
      pythonRssPeakBytes: finite.nonnegative().optional(),
      cudaPeakAllocatedBytes: finite.nonnegative().optional(),
      cudaPeakReservedBytes: finite.nonnegative().optional(),
    })
    .optional(),
});
export function validateLocalGeometryAnalysis(value: unknown, fingerprint: string): LocalGeometryAnalysis {
  const parsed = z
    .object({
      observation: depthRoomObservationSchema,
      inputFingerprint: z.string(),
      measurement,
      evidence: z.record(z.string(), z.unknown()),
    })
    .parse(value);
  if (parsed.inputFingerprint !== fingerprint || parsed.observation.inputFingerprint !== fingerprint)
    throw new Error('기하 결과와 사진의 해시가 달라요.');
  if (JSON.stringify(parsed).length > GEOMETRY_MAX_RESPONSE_BYTES)
    throw new Error('기하 관측 결과가 너무 커요.');
  return parsed;
}

export function validateBrowserGeometryAnalysis(value: unknown, fingerprint: string): LocalGeometryAnalysis {
  const parsed = z.object({
    observation: depthRoomObservationSchema.extend({ analysisImage: geometryRequestMetadataSchema.shape.image.optional(), model: z.object({
      id: z.literal(MOGE_BROWSER_MODEL), revision: z.literal(MOGE_BROWSER_MODEL_REVISION),
    }) }),
    inputFingerprint: z.string(),
    measurement: measurement.extend({
      modelDownload: z.enum(['network', 'cache', 'memory']), backend: z.enum(['webgpu', 'wasm']),
      downloadMs: finite.nonnegative(), cacheMs: finite.nonnegative(), preprocessingMs: finite.nonnegative(),
      postprocessingMs: finite.nonnegative(), wasmThreads: z.number().int().min(1).max(32),
      fallbackReason: z.string().max(2000).optional(), cacheWarning: z.string().max(1000).optional(),
    }),
    evidence: z.object({
      revision: z.literal(BROWSER_GEOMETRY_REVISION), artifactSha256: z.literal(MOGE_BROWSER_MODEL_SHA256),
      preprocessRevision: z.literal(MOGE_BROWSER_PREPROCESS_REVISION), postprocessRevision: z.literal(MOGE_POSTPROCESS_VERSION), planeAlgorithmRevision: z.literal(MOGE_PLANES_VERSION),
      precision: z.literal('fp32'), numTokens: z.literal(MOGE_NUM_TOKENS),
      inputWidth: z.number().int().positive().max(512), inputHeight: z.number().int().positive().max(512),
    }).catchall(z.unknown()),
  }).parse(value);
  if (parsed.inputFingerprint !== fingerprint || parsed.observation.inputFingerprint !== fingerprint)
    throw new Error('브라우저 형상 결과와 사진의 해시가 달라요.');
  const size = mogeInputSize(parsed.observation.image.width, parsed.observation.image.height);
  if (parsed.evidence.inputWidth !== size.width || parsed.evidence.inputHeight !== size.height ||
    (parsed.observation.analysisImage && (parsed.observation.analysisImage.width !== size.width || parsed.observation.analysisImage.height !== size.height)))
    throw new Error('분석 해상도와 원본 사진 전체의 축소 비율이 맞지 않아요.');
  if (JSON.stringify(parsed).length > GEOMETRY_MAX_RESPONSE_BYTES) throw new Error('기하 관측 결과가 너무 커요.');
  return parsed;
}
