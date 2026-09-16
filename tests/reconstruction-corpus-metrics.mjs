// Evaluation-only: this module never changes app analysis, annotations, or model responses.
const UNKNOWN = new Set([undefined, null, '', 'unknown', 'notApplicable']);
const known = (value) => !UNKNOWN.has(value);
const canonicalKind = (kind) => ({ vanity: 'basin', wallShelf: 'shelf' })[kind] ?? kind ?? 'unknown';
const box = (value, normalized = true) => {
  const result = Array.isArray(value) ? value : value && [value.left, value.top, value.right, value.bottom];
  return result?.length === 4 &&
    result.every((v) => Number.isFinite(v) && (!normalized || (v >= 0 && v <= 1))) &&
    result[0] < result[2] &&
    result[1] < result[3]
    ? result
    : undefined;
};
export function intersectionOverUnion(a, b) {
  if (!box(a, false) || !box(b, false)) return 0;
  const overlap =
    Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) *
    Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  return overlap / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - overlap);
}
function coverage(inner, outer) {
  const overlap =
    Math.max(0, Math.min(inner[2], outer[2]) - Math.max(inner[0], outer[0])) *
    Math.max(0, Math.min(inner[3], outer[3]) - Math.max(inner[1], outer[1]));
  return overlap / ((inner[2] - inner[0]) * (inner[3] - inner[1]));
}
const centerError = (a, b) => Math.hypot((a[0] + a[2] - b[0] - b[2]) / 2, (a[1] + a[3] - b[1] - b[3]) / 2);

/** Hungarian assignment with per-row dummy columns. Maximizes total weight, not greedy IoU. */
export function maximumWeightAssignment(weights) {
  const rows = weights.length;
  const realColumns = weights[0]?.length ?? 0;
  if (!rows || !realColumns) return [];
  if (
    rows > 256 ||
    realColumns > 256 ||
    weights.some(
      (row) => row.length !== realColumns || row.some((v) => !Number.isFinite(v) || v < 0 || v > 1),
    )
  )
    throw new Error('Invalid evaluation weight matrix.');
  const columns = realColumns + rows;
  const u = Array(rows + 1).fill(0),
    v = Array(columns + 1).fill(0),
    p = Array(columns + 1).fill(0),
    way = Array(columns + 1).fill(0);
  for (let i = 1; i <= rows; i++) {
    p[0] = i;
    let j0 = 0;
    const minimum = Array(columns + 1).fill(Infinity),
      used = Array(columns + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Infinity,
        j1 = 0;
      for (let j = 1; j <= columns; j++) {
        if (used[j]) continue;
        const weight = j <= realColumns ? weights[i0 - 1][j - 1] : 0;
        const current = 1 - weight - u[i0] - v[j];
        if (current < minimum[j]) {
          minimum[j] = current;
          way[j] = j0;
        }
        if (minimum[j] < delta) {
          delta = minimum[j];
          j1 = j;
        }
      }
      for (let j = 0; j <= columns; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else minimum[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0 !== 0);
  }
  const pairs = [];
  for (let j = 1; j <= realColumns; j++)
    if (p[j] && weights[p[j] - 1][j - 1] > 0)
      pairs.push({ truthIndex: p[j] - 1, predictionIndex: j - 1, weight: weights[p[j] - 1][j - 1] });
  return pairs.sort((a, b) => a.truthIndex - b.truthIndex);
}

function normalizeObservation(candidate, structured = false) {
  const untypedCabinet = !structured && candidate.detectedLabel === 'cabinet' && !candidate.proposedKind;
  return {
    id: candidate.id,
    kind: untypedCabinet ? 'unknown' : canonicalKind(candidate.kind),
    bounds: box(candidate.bounds),
    mounting: structured ? candidate.mounting : (candidate.installation?.mode ?? 'unknown'),
    wall: structured ? candidate.wall : (candidate.installation?.wall ?? 'unknown'),
    shape: structured ? candidate.shape : 'unknown',
    basinVariant: structured
      ? candidate.basinStyle
      : (candidate.installation?.basinVariant ??
        (candidate.kind === 'vanity' && !untypedCabinet ? 'vanity' : 'unknown')),
    toiletLid: candidate.toiletLid ?? 'unknown',
    reflection: structured ? candidate.reflection : candidate.reflectionOf ? 'reflected' : 'physical',
    provenance: candidate.provenance ?? {
      scope: structured ? 'model observation' : 'raw segmentation candidate; mounting may be unavailable',
    },
  };
}
function ratio(numerator, denominator) {
  return { numerator, denominator, value: denominator ? numerator / denominator : null };
}

export function evaluateObservations(
  annotation,
  predictions,
  { minimumIoU = 0.25, localizationSource = 'source candidate bounding boxes' } = {},
) {
  const truth = annotation.fixtures;
  const invalid = predictions.filter((candidate) => !box(candidate.bounds));
  const valid = predictions.filter((candidate) => box(candidate.bounds));
  const markedReflected = valid.filter((candidate) => candidate.reflection === 'reflected');
  const uncertainReflection = valid.filter((candidate) => candidate.reflection === 'uncertain');
  // An uncertain reflection is a held observation, never a confirmed physical addition.
  const physical = valid.filter((candidate) => !['reflected', 'uncertain'].includes(candidate.reflection));
  const weights = truth.map((fixture) =>
    physical.map((candidate) => {
      const score = intersectionOverUnion(fixture.bounds, candidate.bounds);
      return score >= minimumIoU ? score : 0;
    }),
  );
  const assignment = maximumWeightAssignment(weights);
  const matchedTruth = new Set(assignment.map((pair) => pair.truthIndex));
  const matchedPredictions = new Set(assignment.map((pair) => pair.predictionIndex));
  const ignored = [],
    reflectedFalseAdds = [],
    falseAdds = [],
    duplicates = [];
  for (let i = 0; i < physical.length; i++) {
    if (matchedPredictions.has(i)) continue;
    const candidate = physical[i];
    if ((annotation.ignore ?? []).some((region) => coverage(candidate.bounds, region.bounds) >= 0.5)) {
      ignored.push(candidate.id);
      continue;
    }
    const reflected = (annotation.reflections ?? []).find(
      (region) => intersectionOverUnion(candidate.bounds, region.bounds) >= minimumIoU,
    );
    if (reflected) reflectedFalseAdds.push({ predictionId: candidate.id, reflectionId: reflected.id });
    const duplicate = truth.find(
      (fixture) => intersectionOverUnion(fixture.bounds, candidate.bounds) >= minimumIoU,
    );
    if (duplicate) duplicates.push({ predictionId: candidate.id, truthId: duplicate.id });
    falseAdds.push(candidate.id);
  }
  const fields = ['mounting', 'wall', 'shape', 'basinVariant', 'toiletLid'];
  const attributes = Object.fromEntries(
    fields.map((field) => [
      field,
      { knownMatched: 0, correct: 0, incorrect: 0, abstained: 0, mismatches: [] },
    ]),
  );
  const matches = assignment.map((pair) => {
    const expected = truth[pair.truthIndex],
      actual = physical[pair.predictionIndex];
    const expectedKinds = (expected.acceptableKinds ?? [expected.kind]).map(canonicalKind);
    const kindCorrect = expectedKinds.includes(actual.kind);
    const exactKindScorable =
      expectedKinds.length === 1 && known(expectedKinds[0]) && expected.boundsUncertainty !== 'high';
    if (kindCorrect)
      for (const field of fields) {
        const expectedValue = field === 'wall' ? expected.installationWall : expected[field];
        if (!known(expectedValue)) continue;
        const stats = attributes[field];
        stats.knownMatched += 1;
        if (!known(actual[field])) stats.abstained += 1;
        else if (actual[field] === expectedValue) stats.correct += 1;
        else {
          stats.incorrect += 1;
          stats.mismatches.push({
            truthId: expected.id,
            predictionId: actual.id,
            expected: expectedValue,
            actual: actual[field],
          });
        }
      }
    return {
      truthId: expected.id,
      predictionId: actual.id,
      iou: pair.weight,
      expectedKind: expected.kind,
      actualKind: actual.kind,
      kindCorrect,
      exactKindScorable,
      highBoundsUncertainty: expected.boundsUncertainty === 'high',
      centerErrorNormalized:
        expected.boundsUncertainty === 'high' ? null : centerError(expected.bounds, actual.bounds),
      provenance: actual.provenance,
    };
  });
  const unresolved = truth.filter((fixture, index) => !matchedTruth.has(index));
  const missing = unresolved.filter((fixture) => fixture.boundsUncertainty !== 'high');
  const highUncertainty = unresolved.filter((fixture) => fixture.boundsUncertainty === 'high');
  const knownKindTruth = truth.filter(
    (fixture) =>
      (!fixture.acceptableKinds || fixture.acceptableKinds.length === 1) &&
      known(fixture.kind) &&
      fixture.boundsUncertainty !== 'high',
  );
  const falseMarkedReflected = markedReflected
    .filter((candidate) =>
      truth.some(
        (fixture) =>
          canonicalKind(fixture.kind) === candidate.kind &&
          intersectionOverUnion(fixture.bounds, candidate.bounds) >= minimumIoU,
      ),
    )
    .map((candidate) => candidate.id);
  return {
    scope: localizationSource,
    counts: {
      truthPhysical: truth.length,
      predictedPhysical: physical.length,
      objectBoxMatches: matches.length,
      missingPhysicalBounds: missing.length,
      highUncertaintyNeedsReview: highUncertainty.length,
      falseAdded: falseAdds.length,
      reflectedFalseAdded: reflectedFalseAdds.length,
      duplicateAdded: duplicates.length,
      ignoredPredictions: ignored.length,
      invalidPredictions: invalid.length,
      markedReflected: markedReflected.length,
      uncertainReflection: uncertainReflection.length,
      falseMarkedReflected: falseMarkedReflected.length,
      matchedWrongKind: matches.filter((match) => !match.kindCorrect).length,
    },
    kindRecall: ratio(
      matches.filter((match) => match.exactKindScorable && match.kindCorrect).length,
      knownKindTruth.length,
    ),
    attributes,
    matches,
    missingTruthIds: missing.map((fixture) => fixture.id),
    highUncertaintyTruthIds: highUncertainty.map((fixture) => fixture.id),
    falseAddedIds: falseAdds,
    reflectedFalseAdds,
    duplicates,
    ignoredIds: ignored,
    invalidIds: invalid.map((candidate) => candidate.id),
    falseMarkedReflectedIds: falseMarkedReflected,
    centerErrorsNormalized: matches
      .map((match) => match.centerErrorNormalized)
      .filter((value) => value !== null),
    limitations: [
      'Bounding-box matches are approximate image-space correspondence, not verified physical placement.',
      'Attribute denominators include only known labels on kind-correct matched physical objects; misses remain separate.',
      'Unmatched high-uncertainty glass extent needs manual review and is not asserted absent.',
      'Ignore regions are applied only to unmatched predictions, after physical one-to-one matching.',
      'Unknown reflection observations are held separately and do not count as physical additions.',
    ],
  };
}

/** One lab report, without user edits. Error records remain in the corpus denominator. */
export function evaluateCorpusCase(corpusCase, report, { error } = {}) {
  const identity = {
    caseId: corpusCase.id,
    split: corpusCase.split,
    truthPhysical: corpusCase.annotation.fixtures.length,
  };
  if (!report || error)
    return {
      ...identity,
      status: 'failed',
      error: String(error?.message ?? error ?? 'Missing lab report'),
      recognized: null,
      applied: null,
    };
  if (corpusCase.input?.sha256 && report.inputFingerprint !== corpusCase.input.sha256)
    return {
      ...identity,
      status: 'failed',
      error: 'Lab input fingerprint does not match frozen corpus bytes.',
      recognized: null,
      applied: null,
    };
  if (
    corpusCase.roomMm &&
    ['width', 'depth', 'height'].some((axis) => report.room?.[axis + 'Mm'] !== corpusCase.roomMm[axis])
  )
    return {
      ...identity,
      status: 'failed',
      error: 'Lab room dimensions do not match the fixed comparison input.',
      recognized: null,
      applied: null,
    };
  const candidate = report.engineMetadata?.id === 'candidate';
  const automatic =
    report.pipeline?.automaticUnderstanding ??
    (!report.correctionOfRunId ? report.pipeline?.understanding : undefined);
  const raw = candidate
    ? automatic?.candidates
    : (report.rawSegmentationCandidates ?? report.rawReview?.candidates);
  if (!Array.isArray(raw))
    return {
      ...identity,
      status: 'failed',
      error:
        'Raw automatic recognition observations are unavailable; rendered fixtures must not substitute for them.',
      recognized: null,
      applied: null,
    };
  const recognized = evaluateObservations(
    corpusCase.annotation,
    raw.map((item) => normalizeObservation(item, candidate)),
    {
      localizationSource: candidate
        ? 'automatic Qwen structured observations, before user corrections or placement'
        : report.rawSegmentationCandidates
          ? 'raw DeepLab segmentation candidates, before placement'
          : 'pre-placement DeepLab review candidates; raw segmentation unavailable',
    },
  );
  const manual = !!report.correctionOfRunId;
  const linked = [],
    unlinked = [];
  for (const fixture of report.fixtures ?? []) {
    const review = report.review?.candidates?.find((item) => item.fixtureId === fixture.id);
    if (!review || !fixture.reconstruction) {
      unlinked.push(fixture.id);
      continue;
    }
    const actual = fixture.reconstruction;
    const placement = fixture.roomPlacement;
    linked.push({
      id: fixture.id,
      candidateId: review.id,
      kind: canonicalKind(actual.kind),
      bounds: box(review.bounds),
      mounting:
        placement?.face === 'floor'
          ? 'floor'
          : ['left', 'back', 'right'].includes(placement?.face)
            ? 'wall'
            : 'unknown',
      wall:
        placement?.face !== 'floor'
          ? (placement?.face ?? 'unknown')
          : (review.installation?.wall ?? 'unknown'),
      shape: actual.basinShape ?? 'unknown',
      basinVariant: actual.basinVariant ?? (actual.kind === 'vanity' ? 'vanity' : 'unknown'),
      toiletLid: 'unknown',
      reflection: 'physical',
      provenance: actual.provenance ?? { scope: 'rendered template defaults; not observed attributes' },
    });
  }
  const applied = manual
    ? null
    : evaluateObservations(corpusCase.annotation, linked, {
        localizationSource:
          'actually created fixture IDs linked to source review boxes; this is NOT reprojection',
      });
  const reprojections = [];
  if (applied)
    for (const match of applied.matches) {
      const fixture = linked.find((item) => item.id === match.predictionId);
      const check = report.pipeline?.modelChecks?.find(
        (item) => item.candidateId === fixture?.candidateId && item.source === 'source-camera',
      );
      const projected = box(check?.result?.projectedBounds, false);
      const expected = corpusCase.annotation.fixtures.find((item) => item.id === match.truthId);
      if (projected && expected && expected.boundsUncertainty !== 'high')
        reprojections.push({
          truthId: expected.id,
          fixtureId: fixture.id,
          iou: intersectionOverUnion(expected.bounds, projected),
          centerErrorNormalized: centerError(expected.bounds, projected),
          scope:
            'estimated source camera projection against independent approximate photograph box; no measured mm truth',
        });
    }
  return {
    ...identity,
    status: 'completed',
    runId: report.runId,
    engine: report.engineMetadata,
    recognized,
    applied,
    appliedExcludedReason: manual ? 'User-corrected placement is not AI success.' : null,
    heldCandidates: (report.review?.candidates ?? [])
      .filter((item) => item.status !== 'placed')
      .map((item) => ({
        id: item.id,
        status: item.status,
        reason: item.warning ?? item.installation?.reason ?? null,
      })),
    unlinkedFixtureIds: unlinked,
    reprojections,
    timing: {
      totalMs: report.totalMs ?? null,
      creationMs: report.creationMs ?? null,
      renderMs: report.renderMs ?? null,
      model: report.pipeline?.model?.measurement ?? null,
    },
    memory: report.measurement ?? null,
    userCorrectionCount: null,
    userCorrectionReason:
      'No human edit-session measurement; attribute mismatches are not claimed as user interaction counts.',
  };
}

function aggregateStage(evaluations, stage) {
  const values = evaluations.map((entry) => entry[stage]).filter(Boolean);
  if (!values.length) return null;
  const counts = {};
  const attributes = {};
  let correctKind = 0,
    knownKindTruth = 0;
  const centerErrorsNormalized = [];
  for (const result of values) {
    for (const [key, value] of Object.entries(result.counts)) counts[key] = (counts[key] ?? 0) + value;
    correctKind += result.kindRecall.numerator;
    knownKindTruth += result.kindRecall.denominator;
    for (const [field, stats] of Object.entries(result.attributes)) {
      attributes[field] ??= { knownMatched: 0, correct: 0, incorrect: 0, abstained: 0 };
      for (const key of ['knownMatched', 'correct', 'incorrect', 'abstained'])
        attributes[field][key] += stats[key];
    }
    centerErrorsNormalized.push(...result.centerErrorsNormalized);
  }
  return {
    evaluatedCases: values.length,
    counts,
    knownKindRecallSuccessfulReportsOnly: ratio(correctKind, knownKindTruth),
    attributes,
    centerError: centerErrorsNormalized.length
      ? {
          count: centerErrorsNormalized.length,
          meanNormalized: centerErrorsNormalized.reduce((a, b) => a + b, 0) / centerErrorsNormalized.length,
          maximumNormalized: Math.max(...centerErrorsNormalized),
        }
      : null,
  };
}
export function summarizeCorpusMetrics(evaluations) {
  if (new Set(evaluations.map((entry) => entry.caseId)).size !== evaluations.length)
    throw new Error(
      'Choose one predeclared run per case; retries must not silently duplicate the denominator.',
    );
  if (new Set(evaluations.map((entry) => entry.engine?.id).filter(Boolean)).size > 1)
    throw new Error('Summarize baseline and candidate separately.');
  /** @type {Record<string, {attemptedCases: number, completedCases: number, failedCases: Array<{caseId: string, error: string}>, totalTruthPhysicalIncludingFailures: number, recognized: ReturnType<typeof aggregateStage>, applied: ReturnType<typeof aggregateStage>}>} */
  const groups = {};
  for (const split of ['development', 'heldout']) {
    const entries = evaluations.filter((entry) => entry.split === split);
    if (!entries.length) continue;
    groups[split] = {
      attemptedCases: entries.length,
      completedCases: entries.filter((entry) => entry.status === 'completed').length,
      failedCases: entries
        .filter((entry) => entry.status === 'failed')
        .map((entry) => ({ caseId: entry.caseId, error: entry.error })),
      totalTruthPhysicalIncludingFailures: entries.reduce((n, entry) => n + entry.truthPhysical, 0),
      recognized: aggregateStage(entries, 'recognized'),
      applied: aggregateStage(entries, 'applied'),
    };
  }
  return {
    schemaVersion: 1,
    groups,
    limitations: [
      'No composite accuracy or adoption decision is calculated.',
      'Failed cases remain explicit; successful-report-only recalls cannot justify whole-corpus adoption.',
      'Recognized observations and rendered applied templates are distinct.',
      'Image box correspondence is not physical geometry ground truth.',
      'Wall/mount/shape labels are independent Codex source review, not human-adjudicated annotations.',
      'No user edit count, Worker/WASM/GPU peak memory, or measured millimetre placement error is inferred.',
    ],
  };
}
