import { INVENTORY_OUTPUT_CONTRACT } from '../src/lib/reconstruction/inventory-observation';
import { describe, expect, it } from 'vitest';
import { DEFAULT_ROOM } from '../src/lib/room-geometry';
import {
  baselineCacheKey,
  baselineReuseCompatible,
  historicalCorrectionCompatible,
  modelCacheKey,
  modelReuseCompatible,
} from '../src/lib/reconstruction/lab-cache';
import {
  LAB_BASELINE_MODEL_REVISION,
  LAB_BASELINE_REVISION,
  LAB_CANDIDATE_REVISION,
  LAB_QWEN_MODEL,
  LAB_QWEN_PROMPT_REVISION,
  LAB_QWEN_SETTINGS,
} from '../src/lib/reconstruction/lab-engine';
import { labExecution, labExecutionLabel } from '../src/lib/reconstruction/lab-report';
import type { ReconstructionLabReport } from '../src/lib/reconstruction/lab';

function report(): ReconstructionLabReport {
  return {
    inputFingerprint: 'photo-sha',
    room: { ...DEFAULT_ROOM },
    runId: 'source-run',
    engineMetadata: {
      id: 'baseline',
      revision: LAB_BASELINE_REVISION,
      modelId: 'DeepLab ADE20K',
      modelRevision: LAB_BASELINE_MODEL_REVISION,
      settings: {},
    },
    reuse: {
      baseline: {
        reused: false,
        cacheKey: baselineCacheKey('photo-sha', DEFAULT_ROOM),
        compatibility: 'current',
      },
      model: { reused: false },
      newStages: [],
    },
    review: { version: 2, candidates: [], planes: [], warnings: [], analysis: 'complete' },
    rawReview: { version: 2, candidates: [], planes: [], warnings: [], analysis: 'complete' },
    fixtures: [],
    rawSegmentationCandidates: [],
  } as unknown as ReconstructionLabReport;
}
function candidateReport() {
  const r = report();
  const understanding = {
    schemaVersion: 1,
    candidates: [],
    relations: [],
    roomLayout: { orthogonal: 'unknown', evidence: [], uncertainty: [] },
  };
  r.pipeline = {
    model: {
      understanding,
      modelId: LAB_QWEN_MODEL,
      modelRevision: 'a'.repeat(64),
      promptRevision: LAB_QWEN_PROMPT_REVISION,
      outputContract: INVENTORY_OUTPUT_CONTRACT,
      settings: { ...LAB_QWEN_SETTINGS },
    },
    automaticUnderstanding: understanding,
    understanding,
    baselineReview: r.rawReview,
    camera: { status: 'held', reasons: ['구도 근거 부족'] },
    placements: [],
  } as unknown as NonNullable<ReconstructionLabReport['pipeline']>;
  r.engineMetadata = {
    id: 'candidate',
    revision: LAB_CANDIDATE_REVISION,
    modelId: LAB_QWEN_MODEL,
    modelRevision: 'a'.repeat(64),
    settings: {},
  };
  r.reuse!.model.cacheKey = modelCacheKey(r, 'photo-sha', DEFAULT_ROOM);
  return r;
}
describe('lab cache compatibility and correction provenance', () => {
  it('uses stable room fields and matches the exact input, model and analysis revision key', () => {
    const r = report();
    const reordered = {
      heightMm: DEFAULT_ROOM.heightMm,
      depthMm: DEFAULT_ROOM.depthMm,
      widthMm: DEFAULT_ROOM.widthMm,
      version: DEFAULT_ROOM.version,
      kind: DEFAULT_ROOM.kind,
    };
    expect(baselineReuseCompatible(r, 'photo-sha', reordered)).toBe(true);
    expect(baselineReuseCompatible(r, 'other-image', DEFAULT_ROOM)).toBe(false);
    expect(baselineReuseCompatible(r, 'photo-sha', { ...DEFAULT_ROOM, widthMm: 3600 })).toBe(false);
    r.reuse!.baseline.cacheKey = r.reuse!.baseline.cacheKey.replace(
      LAB_BASELINE_MODEL_REVISION,
      'other-model',
    );
    expect(baselineReuseCompatible(r, 'photo-sha', DEFAULT_ROOM)).toBe(false);
  });
  it('invalidates automatic reuse for changed sampling, digest or code revision', () => {
    const r = candidateReport();
    expect(modelReuseCompatible(r, 'photo-sha', DEFAULT_ROOM, 'a'.repeat(64))).toBe(true);
    expect(modelReuseCompatible(r, 'photo-sha', DEFAULT_ROOM, 'b'.repeat(64))).toBe(false);
    r.pipeline!.model.settings!.temperature = 0;
    expect(modelReuseCompatible(r, 'photo-sha', DEFAULT_ROOM)).toBe(false);
    r.pipeline!.model.settings = { ...LAB_QWEN_SETTINGS };
    r.engineMetadata.revision = 'previous-code';
    expect(modelReuseCompatible(r, 'photo-sha', DEFAULT_ROOM)).toBe(false);
  });
  it('does not reuse another output contract even when its prompt number matches', () => {
    const r = candidateReport();
    const key = r.reuse!.model.cacheKey;
    delete r.pipeline!.model.outputContract;
    expect(modelCacheKey(r, 'photo-sha', DEFAULT_ROOM)).not.toBe(key);
    r.reuse!.model.cacheKey = modelCacheKey(r, 'photo-sha', DEFAULT_ROOM);
    expect(modelReuseCompatible(r, 'photo-sha', DEFAULT_ROOM)).toBe(false);
  });
  it('allows a historical correction source but never treats it as a current automatic cache', () => {
    const r = candidateReport();
    delete r.reuse;
    r.pipeline!.model.promptRevision = 1;
    r.engineMetadata.revision = 'previous-code';
    const source = structuredClone(r);
    expect(historicalCorrectionCompatible(r, 'photo-sha', DEFAULT_ROOM)).toBe(true);
    expect(historicalCorrectionCompatible(r, 'different', DEFAULT_ROOM)).toBe(false);
    expect(modelReuseCompatible(r, 'photo-sha', DEFAULT_ROOM)).toBe(false);
    expect(r).toEqual(source);
  });
  it('does not promote historical observations after current code renders a correction', () => {
    const r = candidateReport();
    r.reuse!.baseline.compatibility = 'historical-correction';
    r.reuse!.model.compatibility = 'historical-correction';
    expect(baselineReuseCompatible(r, 'photo-sha', DEFAULT_ROOM)).toBe(false);
    expect(modelReuseCompatible(r, 'photo-sha', DEFAULT_ROOM)).toBe(false);
    expect(historicalCorrectionCompatible(r, 'photo-sha', DEFAULT_ROOM)).toBe(true);
  });
});

describe('analysis completion is separate from reconstruction placement', () => {
  it('does not call a valid empty report successful reconstruction', () => {
    expect(labExecution(report())).toMatchObject({
      status: 'no-observations',
      counts: { rawCandidates: 0, organizedFixtures: 0, placedFixtures: 0, needsReview: 0 },
    });
  });
  it('labels all-excluded observations separately from an empty model output without rewriting counts', () => {
    const observed = {
      status: 'no-observations' as const,
      counts: { rawCandidates: 4, organizedFixtures: 0, placedFixtures: 0, needsReview: 0 },
      reasons: [],
    };
    const original = structuredClone(observed);
    expect(labExecutionLabel(observed)).toBe('분석 완료, 관측 후보 전부 배치 대상에서 제외됨 · 확인 필요');
    expect(labExecutionLabel(labExecution(report()))).toBe('분석 완료, 원출력 후보 없음 · 확인 필요');
    expect(observed).toEqual(original);
  });
  it('preserves recognized fixtures when geometry holds every placement', () => {
    const r = candidateReport();
    r.pipeline!.understanding.candidates = [{ id: 'sink' }, { id: 'partition' }] as never;
    r.pipeline!.automaticUnderstanding = structuredClone(r.pipeline!.understanding);
    expect(labExecution(r)).toMatchObject({
      status: 'review-required',
      counts: { rawCandidates: 2, organizedFixtures: 2, placedFixtures: 0, needsReview: 2 },
      reasons: ['구도 근거 부족'],
    });
  });
  it('counts duplicates and components separately from actual fixtures and keeps conflicts for review', () => {
    const r = candidateReport();
    r.pipeline!.understanding.candidates = ['sink', 'duplicate', 'bowl', 'reflected', 'conflict'].map(
      (id) => ({ id }),
    ) as never;
    r.pipeline!.automaticUnderstanding = structuredClone(r.pipeline!.understanding);
    r.pipeline!.resolution = {
      entries: [
        { candidateId: 'sink', disposition: 'fixture', relatedIds: [], reasons: [] },
        {
          candidateId: 'duplicate',
          disposition: 'duplicate',
          representativeId: 'sink',
          relatedIds: [],
          reasons: [],
        },
        {
          candidateId: 'bowl',
          disposition: 'component',
          representativeId: 'sink',
          relatedIds: [],
          reasons: [],
        },
        { candidateId: 'reflected', disposition: 'reflection', relatedIds: [], reasons: [] },
        { candidateId: 'conflict', disposition: 'conflict', relatedIds: [], reasons: ['거울/창 판단 충돌'] },
      ],
      assemblies: [],
      rawCount: 5,
      organizedCount: 2,
      duplicateCount: 1,
      componentCount: 1,
    };
    r.review.candidates = [
      { id: 'sink', status: 'placed', fixtureId: 'visible-sink' },
      { id: 'conflict', status: 'unplaced', warning: '종류 확인 필요' },
    ] as never;
    r.fixtures = [{ id: 'visible-sink' }] as never;
    expect(labExecution(r)).toMatchObject({
      status: 'partial',
      counts: { rawCandidates: 5, organizedFixtures: 2, placedFixtures: 1, needsReview: 1 },
    });
  });
  it('requires an actual fixture record rather than a stale placed flag', () => {
    const r = report();
    r.review.candidates = [{ id: 'sink', fixtureId: 'missing', status: 'placed' }] as never;
    expect(labExecution(r).status).toBe('review-required');
    r.fixtures = [{ id: 'missing' }] as never;
    expect(labExecution(r)).toMatchObject({
      status: 'placed',
      counts: { placedFixtures: 1, needsReview: 0 },
    });
  });
});

import { EXTENDED_INVENTORY_OUTPUT_CONTRACT, EXTENDED_INVENTORY_PROMPT_REVISION } from '../src/lib/reconstruction/inventory-observation';
describe('extended observation cache remains an explicit choice',()=>{
 it('keeps v2/v3 cache compatibility separate and includes contract/prompt in its key',()=>{
  const r=candidateReport(),originalKey=r.reuse!.model.cacheKey;
  expect(modelReuseCompatible(r,'photo-sha',DEFAULT_ROOM,undefined,true)).toBe(false);
  r.pipeline!.model.outputContract=EXTENDED_INVENTORY_OUTPUT_CONTRACT;r.pipeline!.model.promptRevision=EXTENDED_INVENTORY_PROMPT_REVISION;
  r.reuse!.model.cacheKey=modelCacheKey(r,'photo-sha',DEFAULT_ROOM);
  expect(r.reuse!.model.cacheKey).not.toBe(originalKey);
  expect(modelReuseCompatible(r,'photo-sha',DEFAULT_ROOM)).toBe(false);
  expect(modelReuseCompatible(r,'photo-sha',DEFAULT_ROOM,'a'.repeat(64),true)).toBe(true);
  expect(modelReuseCompatible(r,'photo-sha',DEFAULT_ROOM,'b'.repeat(64),true)).toBe(false);
 });
});
