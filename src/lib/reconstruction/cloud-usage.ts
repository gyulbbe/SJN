import type { LocalModelMeasurement } from './lab-engine';

export type CloudStageUsage = {
  stage: string;
  cacheHit: boolean;
  httpAttempts: number | null;
  inferenceCalls: number | null;
  unknownAttempts: number;
  inputTokens: number | null;
  outputTokens: number | null;
};
const count = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
/** Binding calls observed by SJN, not a fabricated bill or proof that an upstream job completed. */
export function cloudStageUsage(stage: string, measurement: LocalModelMeasurement): CloudStageUsage {
  const cached = measurement.cacheHit === true;
  return {
    stage, cacheHit: cached, httpAttempts: count(measurement.httpAttempts),
    inferenceCalls: cached ? 0 : count(measurement.inferenceCalls),
    unknownAttempts: count(measurement.unknownAttempts) ?? 0,
    inputTokens: cached ? 0 : count(measurement.inputTokens),
    outputTokens: cached ? 0 : count(measurement.outputTokens),
  };
}
export function summarizeCloudUsage(stages: CloudStageUsage[]) {
  return {
    scope: 'this-run-known-binding-calls-not-billed-completions',
    inferenceCalls: stages.reduce((sum, stage) => sum + (stage.inferenceCalls ?? 0), 0),
    unknownCallCountStages: stages.filter(stage => stage.inferenceCalls === null || stage.unknownAttempts > 0).length,
    cachedStages: stages.filter(stage => stage.cacheHit).length,
    knownInputTokens: stages.reduce((sum, stage) => sum + (stage.inputTokens ?? 0), 0),
    knownOutputTokens: stages.reduce((sum, stage) => sum + (stage.outputTokens ?? 0), 0),
    unknownTokenStages: stages.filter(stage => stage.inferenceCalls !== 0 && (stage.inputTokens === null || stage.outputTokens === null)).length,
    stages,
  };
}
