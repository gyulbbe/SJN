import { describe, expect, it } from 'vitest';
import {
  baselineCacheKey,
  modelCacheKey,
  baselineReuseCompatible,
  modelReuseCompatible,
  LAB_ANALYSIS_CACHE_REVISION,
} from '../src/lib/reconstruction/lab-cache';
import {
  LAB_BASELINE_REVISION,
  LAB_BASELINE_OBSERVATION_REVISION,
  LAB_CANDIDATE_REVISION,
  LAB_CANDIDATE_OBSERVATION_REVISION,
  LAB_QWEN_MODEL,
  LAB_QWEN_PROMPT_REVISION,
  LAB_QWEN_SETTINGS,
} from '../src/lib/reconstruction/lab-engine';
import { INVENTORY_OUTPUT_CONTRACT } from '../src/lib/reconstruction/inventory-observation';
import type { ReconstructionLabReport } from '../src/lib/reconstruction/lab';
import { DEFAULT_ROOM } from '../src/lib/room-geometry';
const fingerprint = 'f'.repeat(64),
  modelRevision = 'a'.repeat(64);
/** Cache metadata fixture only: no claim of model observations or reconstruction quality. */
function cacheReport() {
  const report = {
    room: DEFAULT_ROOM,
    inputFingerprint: fingerprint,
    rawReview: { version: 2, analysis: 'partial', candidates: [], planes: [], warnings: [] },
    engineMetadata: {
      id: 'candidate',
      revision: LAB_CANDIDATE_REVISION,
      modelId: LAB_QWEN_MODEL,
      modelRevision,
      settings: {},
    },
    pipeline: {
      model: {
        modelId: LAB_QWEN_MODEL,
        modelRevision,
        promptRevision: LAB_QWEN_PROMPT_REVISION,
        outputContract: INVENTORY_OUTPUT_CONTRACT,
        settings: { ...LAB_QWEN_SETTINGS },
      },
    },
    reuse: { baseline: { cacheKey: baselineCacheKey(fingerprint, DEFAULT_ROOM) }, model: {} },
  } as unknown as ReconstructionLabReport;
  report.reuse!.model!.cacheKey = modelCacheKey(report, fingerprint, DEFAULT_ROOM)!;
  return report;
}
describe('observation cache excludes placement-only output identity', () => {
  it('uses stable observation identity while current render identity changes', () => {
    const report = cacheReport(),
      raw = JSON.stringify(report);
    expect(LAB_BASELINE_REVISION).not.toBe(LAB_BASELINE_OBSERVATION_REVISION);
    expect(LAB_CANDIDATE_REVISION).not.toBe(LAB_CANDIDATE_OBSERVATION_REVISION);
    expect(JSON.parse(report.reuse!.baseline.cacheKey!).codeRevision).toBe(LAB_BASELINE_OBSERVATION_REVISION);
    expect(JSON.parse(report.reuse!.model!.cacheKey!).codeRevision).toBe(LAB_CANDIDATE_OBSERVATION_REVISION);
    expect(baselineReuseCompatible(report, fingerprint, DEFAULT_ROOM)).toBe(true);
    expect(modelReuseCompatible(report, fingerprint, DEFAULT_ROOM, modelRevision)).toBe(true);
    expect(JSON.stringify(report)).toBe(raw);
  });
  it('permits an explicitly equivalent earlier render only when current analysis revision is present', () => {
    const report = cacheReport();
    report.engineMetadata.revision = LAB_CANDIDATE_OBSERVATION_REVISION;
    expect(modelReuseCompatible(report, fingerprint, DEFAULT_ROOM)).toBe(true);
    const key = JSON.parse(report.reuse!.baseline.cacheKey!);
    key.analysisRevision = 'observations-semantic-interior-color-v6';
    report.reuse!.baseline.cacheKey = JSON.stringify(key);
    expect(LAB_ANALYSIS_CACHE_REVISION).toContain('illuminated-body');
    expect(baselineReuseCompatible(report, fingerprint, DEFAULT_ROOM)).toBe(false);
    expect(modelReuseCompatible(report, fingerprint, DEFAULT_ROOM)).toBe(false);
  });
  it('reuses the previous placement renderer observations without adopting its output', () => {
    const report = cacheReport();
    report.engineMetadata.revision = 'structured-scene-v12-strict-placement-relations-1';
    expect(report.engineMetadata.revision).not.toBe(LAB_CANDIDATE_REVISION);
    expect(modelReuseCompatible(report, fingerprint, DEFAULT_ROOM)).toBe(true);
    report.reuse!.model!.compatibility = 'historical-correction';
    expect(modelReuseCompatible(report, fingerprint, DEFAULT_ROOM)).toBe(false);
  });
  it.each([
    'modelId',
    'modelRevision',
    'promptRevision',
    'outputContract',
    'settings',
    'engine',
    'photo',
    'room',
  ] as const)('rejects incompatible %s', (change) => {
    const report = cacheReport();
    let input = fingerprint;
    let room = { ...DEFAULT_ROOM };
    if (change === 'modelId') report.pipeline!.model.modelId = 'other-model';
    if (change === 'modelRevision') report.pipeline!.model.modelRevision = 'b'.repeat(64);
    if (change === 'promptRevision') report.pipeline!.model.promptRevision = LAB_QWEN_PROMPT_REVISION - 1;
    if (change === 'outputContract') report.pipeline!.model.outputContract = undefined;
    if (change === 'settings') report.pipeline!.model.settings = { ...LAB_QWEN_SETTINGS, temperature: 0 };
    if (change === 'engine') report.engineMetadata.revision = 'unrelated-old-code';
    if (change === 'photo') input = 'c'.repeat(64);
    if (change === 'room') room = { ...room, widthMm: 3000 };
    expect(modelReuseCompatible(report, input, room)).toBe(false);
  });
  it('does not promote manually corrected historical reports to an automatic cache hit', () => {
    const report = cacheReport();
    report.reuse!.baseline.compatibility = 'historical-correction';
    expect(baselineReuseCompatible(report, fingerprint, DEFAULT_ROOM)).toBe(false);
    expect(modelReuseCompatible(report, fingerprint, DEFAULT_ROOM)).toBe(false);
  });
});
