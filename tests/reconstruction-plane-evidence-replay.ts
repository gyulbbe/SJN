/** Four frozen model observations, replayed with unchanged production placement rules. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildCandidatePipeline } from '../src/lib/reconstruction/candidate-pipeline';
import { fitDepthRoomCamera, type DepthPlaneObservation, type DepthRoomObservation } from '../src/lib/reconstruction/depth-room-geometry';
import { inspectDepthRoomCameraHypotheses } from '../src/lib/reconstruction/depth-room-hypotheses';
import type { SceneUnderstanding } from '../src/lib/reconstruction/pipeline-contract';

const root = resolve(process.env.PLANE_EVIDENCE_ROOT ?? 'test-results/reconstruction-plane-evidence-20260913');
const output = resolve(root, process.env.PLANE_EVIDENCE_OUTPUT ?? 'placement');
const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
const digest = async (path: string) => createHash('sha256').update(await readFile(path)).digest('hex');
const manifestPath = resolve(root, 'inputs-manifest.json');
const manifest = await json(manifestPath);
const manifestHash = await digest(manifestPath);
const modelRoot = resolve('test-results/reconstruction-moge2-20260913');
const modelRun = await json(resolve(modelRoot, 'summary.json'));
const sourceFiles = [
  'src/lib/reconstruction/depth-room-geometry.ts', 'src/lib/reconstruction/depth-room-hypotheses.ts', 'src/lib/reconstruction/source-camera.ts',
  'src/lib/reconstruction/observed-placement.ts', 'src/lib/reconstruction/candidate-pipeline.ts',
  'src/lib/reconstruction/candidate-resolution.ts', 'src/lib/reconstruction/installation.ts',
  'tests/reconstruction-geometry-plane-probe.py', 'tests/reconstruction_plane_evidence.py',
  'tests/reconstruction-plane-evidence-replay.ts',
];
const sourceHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async (p) => [p, await digest(p)])));
const startedAt = new Date().toISOString();
const start = performance.now();
const rows = [];
for (const id of Object.keys(manifest.cases)) {
  const saved = manifest.cases[id];
  if (await digest(resolve(saved.inventory.path)) !== saved.inventory.sha256 ||
      await digest(resolve(saved.semantic.path)) !== saved.semantic.sha256)
    throw new Error('Frozen report changed: ' + id);
  const frozen = await json(resolve(saved.inventory.path));
  const semantic = await json(resolve(saved.semantic.path));
  const model = await json(resolve(modelRoot, id, 'report.json'));
  if (frozen.inputFingerprint !== saved.inputSha256 || semantic.inputSha256 !== saved.inputSha256 || model.input.sha256 !== saved.inputSha256)
    throw new Error('Input identity mismatch: ' + id);
  const understanding: SceneUnderstanding = frozen.pipeline.automaticUnderstanding;
  const originalText = JSON.stringify(understanding);
  const image = { width: model.input.width, height: model.input.height };
  const plain = buildCandidatePipeline(understanding, semantic.review, semantic.room, image);
  const variants: Record<string, unknown> = {};
  const brief: Record<string, unknown> = { id, noGeometryPlaced: Object.values(plain.plans).filter(Boolean).length };
  for (const variant of ['control', 'experiment']) {
    const planePath = resolve(root, variant, id, 'report.json');
    const planes = await json(planePath);
    if (planes.inputSha256 !== saved.inputSha256 || planes.hashes.semanticReport !== saved.semantic.sha256)
      throw new Error('Plane report source differs: ' + id);
    const plane = (p: typeof planes.floors[number]): DepthPlaneObservation => ({
      id: p.id, normalCamera: p.equation.normal, offset: p.equation.d,
      medianPointCamera: p.support.medianPointProjectedOntoPlaneCamera,
      inlierCount: p.support.pixels, inlierFraction: p.support.originalCandidateRatio,
      imageAreaFraction: p.support.imageAreaRatio, rmsResidual: Math.sqrt(p.residual.pcaEigenvaluesAscending[0]),
    });
    const k = model.validation.intrinsicsNormalized;
    const floor = planes.floors.find((p: { id: string }) => p.id === planes.floorGravityCandidate?.basis);
    const observation: DepthRoomObservation = {
      version: 1, inputFingerprint: saved.inputSha256, image,
      model: { id: modelRun.modelRepo, revision: modelRun.modelRevision },
      coordinateSystem: 'opencv-camera', scale: 'model-estimated-metres',
      intrinsics: { fx: k[0][0], fy: k[1][1], cx: k[0][2], cy: k[1][2] },
      floor: floor ? plane(floor) : null, walls: planes.walls.map(plane),
    };
    const camera = fitDepthRoomCamera(semantic.room, observation, saved.inputSha256);
    const cameraHypotheses = inspectDepthRoomCameraHypotheses(semantic.room, observation, saved.inputSha256);
    const result = buildCandidatePipeline(understanding, semantic.review, semantic.room, image, {}, understanding, {},
      { observation, inputFingerprint: saved.inputSha256 });
    const placed = Object.values(result.plans).filter(Boolean).length;
    variants[variant] = { camera, cameraHypotheses, observation, ...result, placed, planeReportSha256: await digest(planePath) };
    brief[variant] = { camera: camera.fit.status, selected: camera.selected, reasons: camera.fit.reasons,
      placed, placedKinds: Object.values(result.plans).filter(Boolean).map((p) => p!.kind),
      holds: result.pipeline.placements.map((p) => ({ id: p.candidateId, status: p.status, reasons: p.reasons })),
      estimatedHypotheses: cameraHypotheses.hypotheses.filter((p) => p.result.fit.status === 'estimated').length,
      poseDifferences: cameraHypotheses.poseDifferences,
      groupedPlanes: planes.walls.filter((p: { groupedFrom?: string[] }) => p.groupedFrom).length };
  }
  if (JSON.stringify(understanding) !== originalText) throw new Error('Raw automatic observations mutated: ' + id);
  const path = resolve(output, id, 'report.json');
  if (await stat(path).then(() => true).catch(() => false)) throw new Error('Refusing to overwrite replay: ' + id);
  await mkdir(resolve(output, id), { recursive: true });
  await writeFile(path, JSON.stringify({ id, inputSha256: saved.inputSha256, sourceRunId: frozen.runId,
    sourceModel: frozen.pipeline.model.modelId, sourceModelRevision: frozen.pipeline.model.modelRevision,
    scope: 'Existing model outputs through current pure placement code; no new AI, user corrections, or rendered-image accuracy claim.',
    sources: { manifestHash, sourceHashes }, noGeometry: plain, ...variants }, null, 2));
  rows.push(brief);
}
for (const [path, hash] of Object.entries(sourceHashes)) {
  if (await digest(path) !== hash) throw new Error('Code changed during replay: ' + path);
}
if (await digest(manifestPath) !== manifestHash) throw new Error('Input manifest changed during replay');
await writeFile(resolve(output, 'summary.json'), JSON.stringify({ startedAt, finishedAt: new Date().toISOString(),
  elapsedSeconds: (performance.now() - start) / 1000, sourceHashes, manifestHash, newModelCalls: 0,
  networkCalls: 0, userCorrections: 0, rows }, null, 2));
console.log(JSON.stringify(rows, null, 2));