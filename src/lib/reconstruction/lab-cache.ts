import {
  INVENTORY_OUTPUT_CONTRACT,
  EXTENDED_INVENTORY_OUTPUT_CONTRACT,
  EXTENDED_INVENTORY_PROMPT_REVISION,
} from './inventory-observation';
import type { RoomDefinition } from '../room-types';
import type { ReconstructionLabReport } from './lab';
import {
  LAB_BASELINE_OBSERVATION_REVISION,
  LAB_CANDIDATE_OBSERVATION_REVISION,
  LAB_BASELINE_MODEL_REVISION,
  LAB_CANDIDATE_REVISION,
  LAB_QWEN_MODEL,
  LAB_QWEN_PROMPT_REVISION,
  LAB_QWEN_SETTINGS,
} from './lab-engine';

/** Bump when baseline observations or normalization semantics change, not for view-only UI edits. */
export const LAB_ANALYSIS_CACHE_REVISION = 'observations-semantic-interior-illuminated-body-color-v7';
export const LAB_BASELINE_SETTINGS = {
  quality: 'reconstruction',
  segmentation: 'TFJS-WASM-single-thread',
  sourceAnalysisEdge: 512,
} as const;

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  return (
    '{' +
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => JSON.stringify(key) + ':' + stable(entry))
      .join(',') +
    '}'
  );
}
function roomKey(room: RoomDefinition) {
  return {
    kind: room.kind,
    version: room.version,
    widthMm: room.widthMm,
    depthMm: room.depthMm,
    heightMm: room.heightMm,
  };
}
export function baselineCacheKey(inputFingerprint: string, room: RoomDefinition) {
  return stable({
    inputFingerprint,
    room: roomKey(room),
    analysisRevision: LAB_ANALYSIS_CACHE_REVISION,
    modelId: 'DeepLab ADE20K',
    modelRevision: LAB_BASELINE_MODEL_REVISION,
    codeRevision: LAB_BASELINE_OBSERVATION_REVISION,
    settings: LAB_BASELINE_SETTINGS,
  });
}
export function sameLabInput(
  report: ReconstructionLabReport,
  inputFingerprint: string,
  room: RoomDefinition,
) {
  return (
    report.inputFingerprint === inputFingerprint && stable(roomKey(report.room)) === stable(roomKey(room))
  );
}
/** Historical observations are a correction source, not a current automatic cache hit. */
export function historicalCorrectionCompatible(
  report: ReconstructionLabReport,
  inputFingerprint: string,
  room: RoomDefinition,
) {
  const baseline = report.pipeline?.baselineReview ?? report.rawReview;
  const observed = report.pipeline?.model.understanding;
  return (
    sameLabInput(report, inputFingerprint, room) &&
    !!baseline &&
    Array.isArray(baseline.candidates) &&
    Array.isArray(baseline.planes) &&
    !!observed &&
    observed.schemaVersion === 1 &&
    Array.isArray(observed.candidates) &&
    Array.isArray(observed.relations) &&
    !!observed.roomLayout
  );
}
export function baselineReuseCompatible(
  report: ReconstructionLabReport,
  inputFingerprint: string,
  room: RoomDefinition,
) {
  return (
    sameLabInput(report, inputFingerprint, room) &&
    report.reuse?.baseline.compatibility !== 'historical-correction' &&
    report.reuse?.baseline.cacheKey === baselineCacheKey(inputFingerprint, room) &&
    !!(report.pipeline?.baselineReview ?? report.rawReview)
  );
}
export function modelCacheKey(
  report: ReconstructionLabReport,
  inputFingerprint: string,
  room: RoomDefinition,
) {
  const model = report.pipeline?.model;
  return model
    ? stable({
        inputFingerprint,
        room: roomKey(room),
        analysisRevision: LAB_ANALYSIS_CACHE_REVISION,
        codeRevision: LAB_CANDIDATE_OBSERVATION_REVISION,
        modelId: model.modelId,
        modelRevision: model.modelRevision,
        promptRevision: model.promptRevision,
        outputContract: model.outputContract ?? 'scene-understanding-v1',
        settings: model.settings,
      })
    : undefined;
}
export function modelReuseCompatible(
  report: ReconstructionLabReport,
  inputFingerprint: string,
  room: RoomDefinition,
  expectedModelRevision?: string,
  extendedInventory = false,
) {
  const model = report.pipeline?.model;
  return (
    baselineReuseCompatible(report, inputFingerprint, room) &&
    report.reuse?.model.compatibility !== 'historical-correction' &&
    !!model &&
    [
      LAB_CANDIDATE_REVISION,
      LAB_CANDIDATE_OBSERVATION_REVISION,
      'structured-scene-v12-strict-placement-relations-1',
    ].includes(report.engineMetadata.revision) &&
    model.modelId === LAB_QWEN_MODEL &&
    model.promptRevision ===
      (extendedInventory ? EXTENDED_INVENTORY_PROMPT_REVISION : LAB_QWEN_PROMPT_REVISION) &&
    model.outputContract ===
      (extendedInventory ? EXTENDED_INVENTORY_OUTPUT_CONTRACT : INVENTORY_OUTPUT_CONTRACT) &&
    stable(model.settings) === stable(LAB_QWEN_SETTINGS) &&
    (!expectedModelRevision || model.modelRevision === expectedModelRevision) &&
    /^[a-f0-9]{64}$/.test(model.modelRevision) &&
    report.engineMetadata.modelRevision === model.modelRevision &&
    report.reuse?.model.cacheKey === modelCacheKey(report, inputFingerprint, room)
  );
}
