/** Upstream TripoSR MIT; this ONNX export Apache-2.0. Verified 2026-09-11. */
export const PRODUCT3D_MODEL_ID = 'dcharlot65-aurasense/triposr-onnx-web';
export const PRODUCT3D_MODEL_REVISION = 'e23007c3ce90bb968eae014c0168981871fe2d0d';
export const PRODUCT3D_MODEL_CACHE = 'sjn-multiview-model-v1';
export const PRODUCT3D_RUNTIME_URL = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.29.0/dist/';
export const PRODUCT3D_FILES = {
  encoder: { file: 'encoder_fp16.onnx', bytes: 173_383_497 },
  backbone: { file: 'backbone_fp16.onnx', bytes: 666_470_899 },
  decoder: { file: 'decoder_fp16.onnx', bytes: 97_734 },
} as const;
export type Product3dModelPart = keyof typeof PRODUCT3D_FILES;
export const PRODUCT3D_DOWNLOAD_BYTES = Object.values(PRODUCT3D_FILES).reduce((sum, f) => sum + f.bytes, 0);
export function product3dModelUrl(part: Product3dModelPart) {
  return `https://huggingface.co/${PRODUCT3D_MODEL_ID}/resolve/${PRODUCT3D_MODEL_REVISION}/${PRODUCT3D_FILES[part].file}`;
}

export const PRODUCT3D_PART_LABELS = {
  encoder: '사진 분석',
  backbone: '제품 형태 복원',
  decoder: '표면·색상',
} as const;
