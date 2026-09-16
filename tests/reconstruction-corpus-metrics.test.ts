import { describe, expect, it } from 'vitest';
import {
  evaluateCorpusCase,
  evaluateObservations,
  intersectionOverUnion,
  maximumWeightAssignment,
  summarizeCorpusMetrics,
} from './reconstruction-corpus-metrics.mjs';

const truth = (id: string, bounds = [0.1, 0.1, 0.4, 0.5], changes = {}) => ({
  id,
  kind: 'basin',
  bounds,
  mounting: 'wall',
  installationWall: 'left',
  shape: 'rectangular',
  basinVariant: 'wall',
  boundsUncertainty: 'approximate',
  ...changes,
});
const prediction = (id: string, bounds = [0.1, 0.1, 0.4, 0.5], changes = {}) => ({
  id,
  kind: 'basin',
  bounds,
  mounting: 'wall',
  wall: 'left',
  shape: 'rectangular',
  basinVariant: 'wall',
  reflection: 'physical',
  ...changes,
});
const annotation = (fixtures = [truth('expected')], changes = {}) => ({
  fixtures,
  ignore: [],
  reflections: [],
  relations: [],
  ...changes,
});
const corpusCase = (changes = {}) => ({
  id: 'bath-test',
  split: 'heldout',
  annotation: annotation(),
  ...changes,
});

describe('independent reconstruction corpus metrics', () => {
  it('uses global maximum-total-IoU assignment rather than greedy pairs or forced counts', () => {
    const pairs = maximumWeightAssignment([
      [0.7, 0.6],
      [0.65, 0.1],
    ]);
    expect(
      pairs.map((pair: { truthIndex: number; predictionIndex: number }) => [
        pair.truthIndex,
        pair.predictionIndex,
      ]),
    ).toEqual([
      [0, 1],
      [1, 0],
    ]);
    expect(
      maximumWeightAssignment([
        [0, 0],
        [0, 0],
      ]),
    ).toEqual([]);
    expect(maximumWeightAssignment([[0.9], [0.2]])).toEqual([
      { truthIndex: 0, predictionIndex: 0, weight: 0.9 },
    ]);
    expect(() => maximumWeightAssignment([[NaN]])).toThrow();
    expect(intersectionOverUnion([0, 0, 1, 1], [0, 0, 0.5, 1])).toBe(0.5);
  });

  it('separates matching geometry, wrong kind, missing objects, and duplicate additions', () => {
    const expected = annotation([truth('a'), truth('b', [0.6, 0.6, 0.9, 0.9])]);
    const result = evaluateObservations(expected, [
      prediction('wrong', undefined, { kind: 'toilet' }),
      prediction('duplicate'),
    ]);
    expect(result.counts.objectBoxMatches).toBe(1);
    expect(result.counts.missingPhysicalBounds).toBe(1);
    expect(result.counts.duplicateAdded).toBe(1);
    expect(result.counts.falseAdded).toBe(1);
    expect(result.counts.matchedWrongKind).toBe(1);
    expect(result.kindRecall).toMatchObject({ numerator: 0, denominator: 2 });
    expect(result.attributes.mounting.knownMatched).toBe(0);
  });

  it('does not turn unknown or incorrect attributes into a claimed match', () => {
    const result = evaluateObservations(annotation(), [
      prediction('p', undefined, { mounting: 'unknown', wall: 'back', shape: 'unknown' }),
    ]);
    expect(result.attributes.mounting).toMatchObject({ knownMatched: 1, correct: 0, abstained: 1 });
    expect(result.attributes.wall).toMatchObject({ knownMatched: 1, incorrect: 1 });
    expect(result.attributes.shape).toMatchObject({ knownMatched: 1, abstained: 1 });
    const unknownTruth = evaluateObservations(annotation([truth('a', undefined, { mounting: 'unknown' })]), [
      prediction('p'),
    ]);
    expect(unknownTruth.attributes.mounting.knownMatched).toBe(0);
  });

  it('matches actual objects before ignore regions and counts mirror duplicates separately', () => {
    const expected = annotation([truth('physical')], {
      ignore: [{ bounds: [0, 0, 0.5, 0.6] }],
      reflections: [{ id: 'reflection', kind: 'basin', bounds: [0.6, 0.1, 0.9, 0.5], reflectorId: 'mirror' }],
    });
    const result = evaluateObservations(expected, [
      prediction('physical'),
      prediction('reflection-copy', [0.6, 0.1, 0.9, 0.5]),
      prediction('ignore-me', [0.01, 0.01, 0.07, 0.07]),
    ]);
    expect(result.counts.objectBoxMatches).toBe(1);
    expect(result.counts.reflectedFalseAdded).toBe(1);
    expect(result.counts.falseAdded).toBe(1);
    expect(result.counts.ignoredPredictions).toBe(1);
    const marked = evaluateObservations(expected, [
      prediction('physical'),
      prediction('reflected', [0.6, 0.1, 0.9, 0.5], { reflection: 'reflected' }),
      prediction('uncertain', [0.6, 0.6, 0.8, 0.8], { reflection: 'uncertain' }),
    ]);
    expect(marked.counts.falseAdded).toBe(0);
    expect(marked.counts.markedReflected).toBe(1);
    expect(marked.counts.uncertainReflection).toBe(1);
  });

  it('retains uncertain source extents for review without asserting a miss or localization accuracy', () => {
    const expected = annotation([
      truth('glass', undefined, { kind: 'glassPartition', boundsUncertainty: 'high' }),
    ]);
    const missed = evaluateObservations(expected, []);
    expect(missed.counts.missingPhysicalBounds).toBe(0);
    expect(missed.counts.highUncertaintyNeedsReview).toBe(1);
    expect(missed.kindRecall.denominator).toBe(0);
    const matched = evaluateObservations(expected, [
      prediction('glass', undefined, { kind: 'glassPartition' }),
    ]);
    expect(matched.centerErrorsNormalized).toEqual([]);
  });

  it('keeps raw recognition independent of rendered defaults and links applied fixture IDs explicitly', () => {
    const report = {
      runId: 'run',
      engineMetadata: { id: 'baseline' },
      rawSegmentationCandidates: [
        { id: 'raw', kind: 'basin', bounds: { left: 0.1, top: 0.1, right: 0.4, bottom: 0.5 } },
      ],
      review: {
        candidates: [
          {
            id: 'raw',
            fixtureId: 'placed',
            status: 'placed',
            bounds: { left: 0.1, top: 0.1, right: 0.4, bottom: 0.5 },
          },
        ],
      },
      fixtures: [
        {
          id: 'placed',
          reconstruction: { kind: 'basin', basinVariant: 'wall', basinShape: 'rectangular' },
          roomPlacement: { face: 'left' },
        },
        { id: 'unlinked' },
      ],
    };
    const result = evaluateCorpusCase(corpusCase(), report);
    if (!('unlinkedFixtureIds' in result) || !result.recognized || !result.applied)
      throw new Error('Expected a successful automatic report.');
    expect(result.recognized.attributes.shape.abstained).toBe(1);
    expect(result.applied.attributes.shape.correct).toBe(1);
    expect(result.applied.scope).toContain('NOT reprojection');
    expect(result.unlinkedFixtureIds).toEqual(['unlinked']);
    expect(result.reprojections).toEqual([]);
  });

  it('normalizes vanity and shelf aliases without making an untyped cabinet into a basin', () => {
    const expected = corpusCase({
      annotation: annotation([
        truth('vanity', undefined, { basinVariant: 'vanity' }),
        truth('shelf', [0.6, 0.6, 0.9, 0.9], { kind: 'shelf', basinVariant: undefined }),
      ]),
    });
    const report = {
      engineMetadata: { id: 'baseline' },
      rawSegmentationCandidates: [
        { id: 'a', kind: 'vanity', bounds: [0.1, 0.1, 0.4, 0.5] },
        { id: 'b', kind: 'wallShelf', bounds: [0.6, 0.6, 0.9, 0.9] },
      ],
      fixtures: [],
      review: { candidates: [] },
    };
    expect(evaluateCorpusCase(expected, report).recognized?.kindRecall.numerator).toBe(2);
    report.rawSegmentationCandidates[0] = {
      ...report.rawSegmentationCandidates[0],
      detectedLabel: 'cabinet',
    } as (typeof report.rawSegmentationCandidates)[0];
    expect(evaluateCorpusCase(expected, report).recognized?.kindRecall.numerator).toBe(1);
  });

  it('rejects mismatched inputs and mixed or duplicate run denominators', () => {
    const expected = corpusCase({
      input: { sha256: 'fixed' },
      roomMm: { width: 2400, depth: 2400, height: 2400 },
    });
    expect(evaluateCorpusCase(expected, { inputFingerprint: 'other' }).status).toBe('failed');
    expect(
      evaluateCorpusCase(expected, {
        inputFingerprint: 'fixed',
        room: { widthMm: 2000, depthMm: 2400, heightMm: 2400 },
      }).status,
    ).toBe('failed');
    expect(() => summarizeCorpusMetrics([{ caseId: 'same' }, { caseId: 'same' }])).toThrow('one predeclared');
    expect(() =>
      summarizeCorpusMetrics([
        { caseId: 'a', engine: { id: 'baseline' } },
        { caseId: 'b', engine: { id: 'candidate' } },
      ]),
    ).toThrow('separately');
  });

  it('never counts corrected placement as automatic success and preserves failed case denominators', () => {
    const candidate = prediction('raw');
    const report = {
      correctionOfRunId: 'prior',
      engineMetadata: { id: 'candidate' },
      pipeline: {
        automaticUnderstanding: { candidates: [{ ...candidate, basinStyle: 'wall' }] },
        understanding: { candidates: [] },
      },
      fixtures: [],
    };
    const corrected = evaluateCorpusCase(corpusCase(), report);
    if (!('appliedExcludedReason' in corrected) || !corrected.recognized)
      throw new Error('Expected raw observations to remain available.');
    expect(corrected.recognized.counts.objectBoxMatches).toBe(1);
    expect(corrected.applied).toBeNull();
    expect(corrected.appliedExcludedReason).toContain('User-corrected');
    const failed = evaluateCorpusCase(corpusCase({ id: 'failed' }), undefined, {
      error: 'Invalid model JSON',
    });
    const summary = summarizeCorpusMetrics([corrected, failed]);
    expect(summary.groups.heldout.attemptedCases).toBe(2);
    expect(summary.groups.heldout.completedCases).toBe(1);
    expect(summary.groups.heldout.failedCases).toHaveLength(1);
    expect(summary.groups.heldout.totalTruthPhysicalIncludingFailures).toBe(2);
  });
});
