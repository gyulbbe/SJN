/** Official FP32 forward graph; never copy this 141 MB artifact into public/ or a Worker bundle. */
export const MOGE_ARTIFACT = {
  repository: 'Ruicheng/moge-2-vits-normal-onnx',
  revision: 'e50ffda41565591092adea54c6ac83d6212e1e23',
  filename: 'model.onnx',
  sha256: '24eacb5dc7a2c54c7bc98f7de085ffbed79ad006ea5b664c2c2cdc02ff3a52f0',
  bytes: 140852051,
  precision: 'fp32',
  sourceRevision: '925b8ed835a7a9cdb7578ba15c658a0afc969030',
  // The ONNX repository has no model card. The corresponding original weights declare MIT.
  weightsLicense: 'MIT',
  weightsLicenseUrl:
    'https://huggingface.co/Ruicheng/moge-2-vits-normal/blob/26b477f41595707c5db6770294c0d1721e8ed4ed/README.md',
  sourceLicense: 'MIT; DINOv2 code Apache-2.0',
} as const;

export const MOGE_DEFAULT_MODEL_URL = `https://huggingface.co/${MOGE_ARTIFACT.repository}/resolve/${MOGE_ARTIFACT.revision}/${MOGE_ARTIFACT.filename}`;
export const MOGE_MODEL_CACHE = `sjn-moge2-onnx-${MOGE_ARTIFACT.sha256}`;
export const MOGE_RUNTIME_VERSION = '1.29.0';
export const MOGE_RUNTIME_URL = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${MOGE_RUNTIME_VERSION}/dist/`;
export const MOGE_PREPROCESS_VERSION = 'oriented-full-frame-rgb01-nchw-canvas-v1';
export const MOGE_MAX_INPUT_SIDE = 512;
export const MOGE_NUM_TOKENS = 1200;
export const MOGE_BROWSER_MODEL = MOGE_ARTIFACT.repository;
export const MOGE_BROWSER_MODEL_REVISION = MOGE_ARTIFACT.revision;
export const MOGE_BROWSER_MODEL_SHA256 = MOGE_ARTIFACT.sha256;
export const MOGE_BROWSER_PREPROCESS_REVISION = MOGE_PREPROCESS_VERSION;

/** A mirror may change hosting, never the exact graph accepted by the integrity check. */
export function mogeModelUrl(override = process.env.NEXT_PUBLIC_MOGE_MODEL_URL): string {
  const url = new URL(override?.trim() || MOGE_DEFAULT_MODEL_URL);
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))
  )
    throw new Error('MoGe 모델 URL은 HTTPS 주소여야 해요.');
  if (url.username || url.password) throw new Error('MoGe 모델 URL에는 인증 정보를 넣을 수 없어요.');
  return url.href;
}

export function mogeInputSize(width: number, height: number) {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width * height > 40_000_000
  )
    throw new Error('사진은 4천만 화소(40MP) 이하여야 해요.');
  const ratio = Math.min(1, MOGE_MAX_INPUT_SIDE / Math.max(width, height));
  const result = {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
  };
  if (Math.min(result.width, result.height) < 32)
    throw new Error('사진의 가로세로 비율이 공간 분석에 적합하지 않아요.');
  return result;
}
