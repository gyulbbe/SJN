/** Frozen actual semantic/depth observations; no new model, inferred front, or manual pose. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { cpus } from 'node:os';
import { proposeObservedProductPose } from '../src/lib/reconstruction/observed-product-pose';
import { reconstructionDefaults } from '../src/lib/reconstruction/types';
import { buildCandidatePipeline } from '../src/lib/reconstruction/candidate-pipeline';
import type { CandidatePipeline } from '../src/lib/reconstruction/candidate-pipeline';
import type { DepthRoomObservation } from '../src/lib/reconstruction/depth-room-geometry';

import type { RoomDefinition } from '../src/lib/room-types';

type Input = Parameters<typeof proposeObservedProductPose>[0];
type Exported = {
  id: string;
  inputFingerprint: string;
  cameraStatus: 'estimated' | 'held';
  room: RoomDefinition;
  observation: DepthRoomObservation;
  walls: Input['walls'];
  candidates: {
    candidateId: string;
    kind: string;
    sourceCoordinates: string;
    samples: Input['samples'];
    evidence: Input['evidence'];
  }[];
  frozenComparison: { experiment: { pipeline: CandidatePipeline } };
  provenance: unknown;
};
const root = resolve('test-results/reconstruction-product-pose-20260913');
const sourceFiles = [
  'src/lib/reconstruction/observed-product-pose.ts',
  'src/lib/reconstruction/candidate-pipeline.ts',
  'src/lib/reconstruction/depth-room-geometry.ts',
  'src/lib/reconstruction/source-camera.ts',
  'src/lib/reconstruction/types.ts',
  'tests/reconstruction-product-pose-replay.ts',
];
const sourceHashes = Object.fromEntries(
  await Promise.all(
    sourceFiles.map(async (path) => [
      path,
      createHash('sha256')
        .update(await readFile(path))
        .digest('hex'),
    ]),
  ),
);
const summary = [];
await mkdir(resolve(root, 'results'), { recursive: true });
for (const id of ['user-01', 'user-02', 'user-03', 'user-04']) {
  const bytes = await readFile(resolve(root, 'inputs', id + '.json'));
  const source: Exported = JSON.parse(bytes.toString('utf8'));
  const frozen = source.frozenComparison.experiment.pipeline;
  const room = source.room;
  const current = buildCandidatePipeline(
    frozen.automaticUnderstanding,
    frozen.baselineReview,
    room,
    source.observation.image,
    {},
    frozen.automaticUnderstanding,
    {},
    { observation: source.observation, inputFingerprint: source.inputFingerprint },
  );
  const candidates = source.candidates.map((c) => {
    if (source.cameraStatus !== 'estimated' || c.sourceCoordinates !== 'model-world-mm')
      return {
        candidateId: c.candidateId,
        kind: c.kind,
        status: 'held-camera',
        reasons: [
          'A room coordinate frame was not established. Camera-space surfaces are not converted to a product pose.',
        ],
      };
    if (c.kind !== 'vanity')
      return {
        candidateId: c.candidateId,
        kind: c.kind,
        status: 'outside-experiment',
        reasons: [
          'This bounded experiment only fits cabinet body surfaces; other shapes are not treated as cuboids.',
        ],
      };
    const defaults = reconstructionDefaults('vanity');
    const input: Input = {
      version: 1,
      inputFingerprint: source.inputFingerprint,
      coordinateSystem: 'model-world-mm',
      candidateId: c.candidateId,
      kind: 'vanity',
      samples: c.samples,
      walls: source.walls,
      evidence: c.evidence,
      knownDimensions: {
        widthMm: defaults.widthMm,
        depthMm: defaults.depthMm,
        heightMm: defaults.heightMm,
        provenance: 'default',
      },
    };
    const started = performance.now();
    const result = proposeObservedProductPose(input, source.inputFingerprint);
    return {
      candidateId: c.candidateId,
      kind: c.kind,
      status: result.status,
      dimensions: input.knownDimensions,
      samples: c.samples.length,
      evidence: input.evidence,
      result,
      calculationMs: performance.now() - started,
      currentSourcePlacement: current.pipeline.placements.find((p) => p.candidateId === c.candidateId),
      currentModelCheck: current.pipeline.modelChecks.find((p) => p.candidateId === c.candidateId),
    };
  });
  const report = {
    id,
    inputFingerprint: source.inputFingerprint,
    scope:
      'Frozen actual observations + current pure horizontal-pose diagnostic. No new AI, manual front direction, adjusted dimensions, or automatic application.',
    sourceHashes,
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpu: cpus()[0]?.model,
      timingScope: 'Pure pose calculation with decoded samples, excludes AI/model loading/export/render',
    },
    inputExportSha256: createHash('sha256').update(bytes).digest('hex'),
    observationProvenance: source.provenance,
    candidates,
    currentPlacementCount: Object.values(current.plans).filter(Boolean).length,
    proposedPosesApplied: 0,
    measuredGeometry: false,
  };
  await writeFile(resolve(root, 'results', id + '.json'), JSON.stringify(report, null, 2));
  summary.push({
    id,
    currentPlacementCount: report.currentPlacementCount,
    candidates: candidates.map(({ candidateId, kind, status }) => ({ candidateId, kind, status })),
  });
}
await writeFile(resolve(root, 'results', 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
