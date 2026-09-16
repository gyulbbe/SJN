import { LAB_QWEN_MODEL } from './lab-engine';
import { CLOUD_GEMMA_MODEL, CLOUD_GEMMA_REVISION, isCloudModelIdentity } from './cloud-gemma-contract';

export type AnalysisProvider = 'local-ollama' | 'cloudflare-workers-ai';

/** Managed API identity is deliberately not represented as a model weight digest. */
export function analysisModelId(provider: AnalysisProvider): string {
  return provider === 'local-ollama' ? LAB_QWEN_MODEL : CLOUD_GEMMA_MODEL;
}

export function validAnalysisModelPair(modelId: unknown, revision: unknown): boolean {
  return (
    (modelId === LAB_QWEN_MODEL && typeof revision === 'string' && /^[a-f0-9]{64}$/.test(revision)) ||
    (modelId === CLOUD_GEMMA_MODEL && revision === CLOUD_GEMMA_REVISION)
  );
}

export function providerForModel(modelId: string): AnalysisProvider {
  if (modelId === LAB_QWEN_MODEL) return 'local-ollama';
  if (modelId === CLOUD_GEMMA_MODEL) return 'cloudflare-workers-ai';
  throw new Error('지원하지 않는 설비 분석 모델이에요.');
}

export function validAnalysisResponse(value: unknown, provider: AnalysisProvider): boolean {
  if (!value || typeof value !== 'object') return false;
  const result = value as Record<string, unknown>;
  if (result.modelId !== analysisModelId(provider) || !validAnalysisModelPair(result.modelId, result.modelRevision))
    return false;
  if (provider === 'local-ollama') return result.provider === undefined || result.provider === provider;
  return result.provider === provider && isCloudModelIdentity(result.modelIdentity);
}
