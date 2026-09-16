import { CLOUD_GEMMA_APPEARANCE_METADATA } from './cloud-gemma-appearance';
import { CLOUD_GEMMA_GROUPED_INVENTORY_METADATA } from './cloud-gemma-inventory';
import {
  CLOUD_GEMMA_CONTRACT_REVISION,
  CLOUD_GEMMA_MODEL,
  CLOUD_GEMMA_REVISION,
  CLOUD_GEMMA_SETTINGS,
  type CloudGemmaOperation,
} from './cloud-gemma-contract';
import { LAB_QWEN_PROMPT_REVISION } from './lab-engine';
import {
  INVENTORY_OUTPUT_CONTRACT,
  EXTENDED_INVENTORY_OUTPUT_CONTRACT,
  EXTENDED_INVENTORY_PROMPT_REVISION,
} from './inventory-observation';
import { IDENTITY_OUTPUT_CONTRACT, IDENTITY_PROMPT_REVISION } from './identity-observation';
import { INSTALLATION_OUTPUT_CONTRACT, INSTALLATION_PROMPT_REVISION } from './installation-observation';
import {
  LAYOUT_OUTPUT_CONTRACT,
  LAYOUT_PROMPT_REVISION,
  LAYOUT_RELATION_RULE_REVISION,
} from './layout-observation';
import {
  FIXTURE_APPEARANCE_CONTRACT,
  FIXTURE_APPEARANCE_PROMPT_REVISION,
} from './fixture-appearance-observation';
import { SHOWER_OBSERVATION_CONTRACT, SHOWER_OBSERVATION_PROMPT_REVISION } from './shower-observation';
import {
  SHOWER_INSTALLATION_CONTRACT,
  SHOWER_INSTALLATION_PROMPT_REVISION,
  SHOWER_INSTALLATION_INPUT_REVISION,
  SHOWER_INSTALLATION_DECISION_REVISION,
} from './shower-installation-observation';
import { DIVIDER_OBSERVATION_CONTRACT, DIVIDER_OBSERVATION_PROMPT_REVISION } from './divider-observation';
import {
  TARGET_EXISTENCE_CONTRACT,
  TARGET_EXISTENCE_PROMPT_REVISION,
  TARGET_EXISTENCE_INPUT_REVISION,
} from './target-existence-observation';

/** Separate from the identity module to avoid a target-receipt/provider-validation import cycle. */
const stages: Record<CloudGemmaOperation, readonly [string, number]> = {
  inventory: [INVENTORY_OUTPUT_CONTRACT, LAB_QWEN_PROMPT_REVISION],
  'inventory-extended': [EXTENDED_INVENTORY_OUTPUT_CONTRACT, EXTENDED_INVENTORY_PROMPT_REVISION],
  identity: [IDENTITY_OUTPUT_CONTRACT, IDENTITY_PROMPT_REVISION],
  installation: [INSTALLATION_OUTPUT_CONTRACT, INSTALLATION_PROMPT_REVISION],
  layout: [LAYOUT_OUTPUT_CONTRACT, LAYOUT_PROMPT_REVISION],
  appearance: [FIXTURE_APPEARANCE_CONTRACT, FIXTURE_APPEARANCE_PROMPT_REVISION],
  'shower-detail': [SHOWER_OBSERVATION_CONTRACT, SHOWER_OBSERVATION_PROMPT_REVISION],
  'shower-installation': [SHOWER_INSTALLATION_CONTRACT, SHOWER_INSTALLATION_PROMPT_REVISION],
  'divider-material': [DIVIDER_OBSERVATION_CONTRACT, DIVIDER_OBSERVATION_PROMPT_REVISION],
  'target-existence': [TARGET_EXISTENCE_CONTRACT, TARGET_EXISTENCE_PROMPT_REVISION],
};
/** Prompt/format/settings changes invalidate completed stages alongside photo, inventory and auth scope. */
export function cloudOperationCacheIdentity(operation: unknown): string {
  if (typeof operation !== 'string' || !Object.hasOwn(stages, operation))
    throw new Error('지원하지 않는 Cloudflare 관측 단계예요.');
  const [outputContract, promptRevision] = stages[operation as CloudGemmaOperation];
  return JSON.stringify({
    providerContract: CLOUD_GEMMA_CONTRACT_REVISION,
    modelId: CLOUD_GEMMA_MODEL,
    modelRevision: CLOUD_GEMMA_REVISION,
    operation,
    outputContract,
    promptRevision,
    ...(operation === 'inventory-extended' ? CLOUD_GEMMA_GROUPED_INVENTORY_METADATA : {}),
    ...(operation === 'appearance' ? CLOUD_GEMMA_APPEARANCE_METADATA : {}),
    ...(operation === 'layout' ? { relationRuleRevision: LAYOUT_RELATION_RULE_REVISION } : {}),
    ...(operation === 'shower-installation'
      ? { decisionRevision: SHOWER_INSTALLATION_DECISION_REVISION }
      : {}),
    settings: CLOUD_GEMMA_SETTINGS,
    inputRevision:
      operation === 'target-existence'
        ? TARGET_EXISTENCE_INPUT_REVISION
        : operation === 'shower-installation'
          ? SHOWER_INSTALLATION_INPUT_REVISION
          : 'normalized-photo-max1600-v1',
  });
}
