/** Replays frozen real observations through today's pipeline. No new AI; no manual placements. */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import {
  fitDepthRoomCamera,
  type DepthPlaneObservation,
  type DepthRoomObservation,
} from '../src/lib/reconstruction/depth-room-geometry';
import { buildCandidatePipeline } from '../src/lib/reconstruction/candidate-pipeline';

const output = resolve('test-results/reconstruction-floor-geometry-20260913/placement');
const root = resolve('test-results/reconstruction-floor-geometry-20260913');
const modelRoot = resolve('test-results/reconstruction-moge2-20260913');
const frozenRoot = resolve(
  'test-results/user-reconstruction-improvement-20260913/after-installation-shape-final',
);
const readJson = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
const modelRun = await readJson(resolve(modelRoot, 'summary.json'));
const sourceFiles = ['src/lib/reconstruction/depth-room-geometry.ts', 'src/lib/reconstruction/source-camera.ts', 'src/lib/reconstruction/observed-placement.ts', 'src/lib/reconstruction/candidate-pipeline.ts', 'src/lib/reconstruction/lab-engine.ts'];
const sourceHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async (path) => [path, createHash('sha256').update(await readFile(path)).digest('hex')])));
const rows = [];
for (const id of ['user-01', 'user-02', 'user-03', 'user-04', 'bath-20', 'bath-22', 'bath-27', 'bath-31']) {
  const planeReport = await readJson(resolve(root, 'planes', id, 'report.json'));
  const semantic = await readJson(resolve(root, 'semantic', id, 'report.json'));
  const modelReport = await readJson(resolve(modelRoot, id, 'report.json'));
  if (
    planeReport.inputSha256 !== modelReport.input.sha256 ||
    planeReport.inputSha256 !== semantic.inputSha256
  )
    throw new Error('Input identity mismatch: ' + id);
  // Exact adapter for the versioned local plane probe. It does not select successful IDs,
  // edit points, merge conflicting planes or provide photo-specific scale/room parameters.
  const plane = (p: (typeof planeReport.floors)[number]): DepthPlaneObservation => ({
    id: p.id,
    normalCamera: p.equation.normal,
    offset: p.equation.d,
    medianPointCamera: p.support.medianPointProjectedOntoPlaneCamera,
    inlierCount: p.support.pixels,
    inlierFraction: p.support.originalCandidateRatio,
    imageAreaFraction: p.support.imageAreaRatio,
    rmsResidual: Math.sqrt(p.residual.pcaEigenvaluesAscending[0]),
  });
  const k = modelReport.validation.intrinsicsNormalized;
  const floor = planeReport.floors.find(
    (p: { id: string }) => p.id === planeReport.floorGravityCandidate?.basis,
  );
  const observation: DepthRoomObservation = {
    version: 1,
    inputFingerprint: planeReport.inputSha256,
    image: { width: modelReport.input.width, height: modelReport.input.height },
    model: { id: modelRun.modelRepo, revision: modelRun.modelRevision },
    coordinateSystem: 'opencv-camera',
    scale: 'model-estimated-metres',
    intrinsics: { fx: k[0][0], fy: k[1][1], cx: k[0][2], cy: k[1][2] },
    floor: floor ? plane(floor) : null,
    walls: planeReport.walls.map(plane),
  };
  const camera = fitDepthRoomCamera(semantic.room, observation, planeReport.inputSha256);
  let comparison = undefined;
  if (id.startsWith('user-')) {
    const frozen = await readJson(resolve(frozenRoot, id, 'candidate.json'));
    if (frozen.inputFingerprint !== observation.inputFingerprint)
      throw new Error('Candidate mismatch: ' + id);
    const understanding = frozen.pipeline.automaticUnderstanding;
    const baseline = buildCandidatePipeline(understanding, semantic.review, semantic.room, observation.image);
    const experiment = buildCandidatePipeline(
      understanding,
      semantic.review,
      semantic.room,
      observation.image,
      {},
      understanding,
      {},
      { observation, inputFingerprint: observation.inputFingerprint },
    );
    const count = (value: typeof experiment) => Object.values(value.plans).filter(Boolean).length;
    comparison = {
      sourceRunId: frozen.runId,
      sourceModel: frozen.pipeline.model.modelId,
      sourceModelRevision: frozen.pipeline.model.modelRevision,
      scope:
        'Frozen real Qwen observations + fresh real DeepLab/MoGe outputs replayed through current pure placement pipeline. No new Qwen or user correction.',
      baseline: {
        review: baseline.review,
        plans: baseline.plans,
        pipeline: baseline.pipeline,
        placed: count(baseline),
      },
      experiment: {
        review: experiment.review,
        plans: experiment.plans,
        pipeline: experiment.pipeline,
        placed: count(experiment),
      },
    };
  }
  const report = {
    id,
    observation,
    camera,
    comparison,
    sources: {
      sourceHashes,
      planeReport: createHash('sha256')
        .update(await readFile(resolve(root, 'planes', id, 'report.json')))
        .digest('hex'),
      semanticReport: createHash('sha256')
        .update(await readFile(resolve(root, 'semantic', id, 'report.json')))
        .digest('hex'),
      fixtureDetectionAccuracyEvaluated: false,
      modelGeometryAccuracyEvaluated: false,
    },
  };
  await mkdir(resolve(output, id), { recursive: true });
  await writeFile(resolve(output, id, 'report.json'), JSON.stringify(report, null, 2));
  rows.push({
    id,
    camera: camera.fit.status,
    selected: camera.selected,
    reasons: camera.fit.reasons,
    before: comparison?.baseline.placed,
    after: comparison?.experiment.placed,
  });
}
await writeFile(resolve(output, 'summary.json'), JSON.stringify(rows, null, 2));
console.log(JSON.stringify(rows, null, 2));
