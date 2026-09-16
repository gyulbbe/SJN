/** API identity, not an unavailable Cloudflare model-weights hash. */
export const CLOUD_GEMMA_PROVIDER = 'cloudflare-workers-ai' as const;
export const CLOUD_GEMMA_MODEL = '@cf/google/gemma-4-26b-a4b-it' as const;
export const CLOUD_GEMMA_GATEWAY_ID = 'sjn-gateway' as const;
export const CLOUD_GEMMA_CONTRACT_REVISION = 'sjn-gemma-v7' as const;
export const CLOUD_GEMMA_REVISION = 'cloudflare-managed:gemma-4-26b-a4b-it:api-v1' as const;
export const CLOUD_GEMMA_SETTINGS = {
  temperature: 0,
  max_completion_tokens: 4096,
  enable_thinking: false,
} as const;

export type CloudModelIdentity = {
  provider: typeof CLOUD_GEMMA_PROVIDER;
  modelId: typeof CLOUD_GEMMA_MODEL;
  revisionKind: 'provider-managed';
  contractRevision: typeof CLOUD_GEMMA_CONTRACT_REVISION;
};
export const CLOUD_GEMMA_IDENTITY: CloudModelIdentity = {
  provider: CLOUD_GEMMA_PROVIDER,
  modelId: CLOUD_GEMMA_MODEL,
  revisionKind: 'provider-managed',
  contractRevision: CLOUD_GEMMA_CONTRACT_REVISION,
};
export function isCloudModelIdentity(value: unknown): value is CloudModelIdentity {
  if (!value || typeof value !== 'object') return false;
  const identity = value as Record<string, unknown>;
  return (
    identity.provider === CLOUD_GEMMA_PROVIDER &&
    identity.modelId === CLOUD_GEMMA_MODEL &&
    identity.revisionKind === 'provider-managed' &&
    identity.contractRevision === CLOUD_GEMMA_CONTRACT_REVISION
  );
}

export const CLOUD_GEMMA_OPERATIONS = [
  'inventory',
  'inventory-extended',
  'identity',
  'installation',
  'layout',
  'appearance',
  'shower-detail',
  'shower-installation',
  'divider-material',
  'target-existence',
] as const;
export type CloudGemmaOperation = (typeof CLOUD_GEMMA_OPERATIONS)[number];
export type CloudGemmaErrorCode =
  | 'invalid_input'
  | 'access_denied'
  | 'authentication_required'
  | 'binding_unavailable'
  | 'authentication_unavailable'
  | 'quota_exhausted'
  | 'rate_limited'
  | 'unavailable'
  | 'cancelled'
  | 'timeout'
  | 'invalid_response'
  | 'output_limit';

/** Subset checked against Wrangler 4.131.1 generated runtime types (workerd 2026-09-11).
 * The generated types include Gemma, image_url, JSON Schema, and AiOptions.signal.
 * https://developers.cloudflare.com/workers-ai/models/gemma-4-26b-a4b-it/
 */
export type CloudGemmaInput = {
  messages: Array<{
    role: 'user';
    content: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;
  }>;
  stream: false;
  temperature: number;
  max_completion_tokens: number;
  chat_template_kwargs: { enable_thinking: false };
  response_format:
    | { type: 'json_object' }
    | {
        type: 'json_schema';
        json_schema: { name: string; strict: true; schema: Record<string, unknown> };
      };
};
export interface CloudGemmaBinding {
  run(
    model: typeof CLOUD_GEMMA_MODEL,
    input: CloudGemmaInput,
    options: {
      gateway: { id: typeof CLOUD_GEMMA_GATEWAY_ID; retries: { maxAttempts: 1 } };
      returnRawResponse: true;
      signal: AbortSignal;
    },
  ): Promise<Response>;
}
