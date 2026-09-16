import { describe, expect, it } from 'vitest';
import { cloudStageUsage, summarizeCloudUsage } from '../src/lib/reconstruction/cloud-usage';
import type { LocalModelMeasurement } from '../src/lib/reconstruction/lab-engine';
const measured = (values: object) => ({ requestMs: 1, modelDownload: 'provider-managed', memoryScope: 'unavailable', ...values }) as LocalModelMeasurement;
describe('cloud usage accounting', () => {
  it('does not count historical cached tokens as another request', () => {
    const usage = summarizeCloudUsage([
      cloudStageUsage('inventory', measured({ cacheHit: true, inferenceCalls: 1, inputTokens: 500, outputTokens: 100 })),
      cloudStageUsage('installation', measured({ cacheHit: false, inferenceCalls: 3, httpAttempts: 3, inputTokens: 700, outputTokens: 120 })),
    ]);
    expect(usage).toMatchObject({ inferenceCalls: 3, cachedStages: 1, knownInputTokens: 700, knownOutputTokens: 120 });
  });
  it('separates unavailable counts and tokens from explicit zero', () => {
    const usage = summarizeCloudUsage([cloudStageUsage('unknown', measured({})), cloudStageUsage('skipped', measured({ inferenceCalls: 0 }))]);
    expect(usage).toMatchObject({ unknownCallCountStages: 1, unknownTokenStages: 1, inferenceCalls: 0 });
  });
});
