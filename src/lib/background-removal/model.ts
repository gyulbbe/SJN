/** MIT model, immutable commit verified 2026-09-10. See docs/ai-background-removal.md. */
export const BACKGROUND_MODEL_ID = 'studioludens/birefnet-lite-512';
export const BACKGROUND_MODEL_REVISION = '4a3c40c36c94093cc1e724d9ea428b8fa4b57dc7';
export const BACKGROUND_MODEL_SIZE = 512 as const;
export const BACKGROUND_MODEL_CACHE = 'sjn-background-removal-model-v1';
export const BACKGROUND_RUNTIME_VERSION = '1.29.0';
export const BACKGROUND_RUNTIME_URL = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.29.0/dist/';

export const BACKGROUND_MODEL_FILES = {
  fp16: { file: 'model_fp16.onnx', bytes: 98_484_532 },
  fp32: { file: 'model.onnx', bytes: 191_877_254 },
} as const;

export function backgroundModelUrl(precision: keyof typeof BACKGROUND_MODEL_FILES) {
  return `https://huggingface.co/${BACKGROUND_MODEL_ID}/resolve/${BACKGROUND_MODEL_REVISION}/onnx/${BACKGROUND_MODEL_FILES[precision].file}`;
}
