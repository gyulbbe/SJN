/** Engine identities shared by Lab and explicit local-quality project analysis. */
export type LabEngineId = 'baseline' | 'candidate';
export const LAB_BASELINE_MODEL_REVISION =
  'model-json-sha256:32740c83ed674645762d0d664ee84c4854b96e80f16ba6a80202d3af176bf4e1';
export const LAB_BASELINE_REVISION = 'deeplab-observed-v10-source-plane-contract-2026-09-14';
export const LAB_CANDIDATE_REVISION = 'structured-scene-v15-fixture-identity-3';
/** Observation identity is separate from later placement/rendering changes. */
export const LAB_BASELINE_OBSERVATION_REVISION = 'deeplab-observed-v8-product-color-2026-09-14';
export const LAB_CANDIDATE_OBSERVATION_REVISION = 'structured-scene-v11-product-color-relations-1';
export const LAB_QWEN_MODEL = 'qwen3-vl:4b-instruct-q4_K_M';
export const LAB_QWEN_PROMPT_REVISION = 8;
export type LabEngineAvailability = {
  available: boolean;
  reason?: string;
  modelId: string;
  revision?: string;
  modelBytes?: number;
};
export type LabEngineMetadata = {
  id: LabEngineId;
  revision: string;
  modelId: string;
  modelRevision: string;
  settings: Record<string, string | number | boolean>;
};
export type LocalModelMeasurement = {
  requestMs: number;
  modelLoadMs?: number;
  imageAndPromptEvaluationMs?: number;
  textGenerationMs?: number;
  runtimeTotalMs?: number;
  inputWidth: number;
  inputHeight: number;
  memoryScope: string;
  modelDownload: 'not-performed-cached-model-required' | 'provider-managed';
  cacheHit?: boolean;
  inferenceCalls?: number;
  httpAttempts?: number;
  unknownAttempts?: number;
  inputTokens?: number;
  outputTokens?: number;
};

/** Qwen's published VL sampling defaults; fixed seed helps repeat the experiment, not a correctness guarantee. */
export const LAB_QWEN_SETTINGS = {
  temperature: 0.7,
  top_p: 0.8,
  top_k: 20,
  presence_penalty: 1.5,
  repeat_penalty: 1,
  seed: 17,
  num_ctx: 8192,
  num_predict: 4096,
} as const;
