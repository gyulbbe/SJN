/** Frozen real observations only; no new AI, UI integration, or user acceptance. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { proposeObservedProductProposal } from '../src/lib/reconstruction/observed-product-proposal';
import type { ObservedProductPoseInput } from '../src/lib/reconstruction/observed-product-pose';
import type { RoomDefinition } from '../src/lib/room-types';
import { reconstructionDefaults } from '../src/lib/reconstruction/types';

type Saved = {
  id: string;
  inputFingerprint: string;
  cameraStatus: string;
  camera: unknown;
  room: RoomDefinition;
  walls: ObservedProductPoseInput['walls'];
  candidates: {
    candidateId: string;
    kind: string;
    sourceCoordinates: string;
    samples: ObservedProductPoseInput['samples'];
    evidence: ObservedProductPoseInput['evidence'];
  }[];
  provenance: {
    pointsSha256: string;
    placementReportSha256: string;
    sources: { inputSha256: string; labelsSha256: string };
    [key: string]: unknown;
  };
};
const sourceFiles = [
  'src/lib/reconstruction/observed-product-proposal.ts',
  'src/lib/reconstruction/observed-product-pose.ts',
  'src/lib/reconstruction/source-camera.ts',
  'src/lib/reconstruction/types.ts',
  'tests/reconstruction-product-proposal-replay.ts',
];
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const digest = async (path: string) => hash(await readFile(resolve(path)));
const sourceHashes = Object.fromEntries(
  await Promise.all(sourceFiles.map(async (path) => [path, await digest(path)])),
);
const out = resolve('test-results/reconstruction-product-proposal-20260913');
await mkdir(out, { recursive: true });
const summary = [];
for (const id of ['user-01', 'user-02', 'user-03', 'user-04']) {
  const bytes = await readFile(
    resolve('test-results/reconstruction-product-pose-20260913/inputs', id + '.json'),
  );
  const source: Saved = JSON.parse(bytes.toString('utf8'));
  if (source.inputFingerprint !== source.provenance.sources.inputSha256)
    throw new Error(id + ': input fingerprint mismatch');
  const resources = [
    {
      path: 'test-results/reconstruction-object-surfaces-20260913/surfaces/' + id + '/surface-points.npz',
      sha256: source.provenance.pointsSha256,
    },
    {
      path: 'test-results/reconstruction-object-surfaces-20260913/labels/' + id + '/semantic-labels.u8',
      sha256: source.provenance.sources.labelsSha256,
    },
    {
      path: 'test-results/reconstruction-floor-geometry-20260913/placement/' + id + '/report.json',
      sha256: source.provenance.placementReportSha256,
    },
  ];
  for (const resource of resources)
    if ((await digest(resource.path)) !== resource.sha256)
      throw new Error(id + ': frozen source hash changed: ' + resource.path);
  const candidates = source.candidates.map((c) => {
    if (source.cameraStatus !== 'estimated' || c.sourceCoordinates !== 'model-world-mm')
      return {
        candidateId: c.candidateId,
        kind: c.kind,
        status: 'held-frozen-camera',
        reason:
          'This saved input has no established room coordinate frame; current camera algorithm is not rerun here.',
      };
    if (c.kind !== 'vanity')
      return { candidateId: c.candidateId, kind: c.kind, status: 'outside-experiment' };
    const defaults = reconstructionDefaults('vanity');
    const input: ObservedProductPoseInput = {
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
    const result = proposeObservedProductProposal(input, {
      room: source.room,
      expectedFingerprint: source.inputFingerprint,
      baseHeightMm: 0,
      sources: {
        inputFingerprint: source.inputFingerprint,
        pointsSha256: source.provenance.pointsSha256,
        labelsSha256: source.provenance.sources.labelsSha256,
        cameraSha256: source.provenance.placementReportSha256,
      },
    });
    return {
      candidateId: c.candidateId,
      kind: c.kind,
      status: result.status,
      samples: c.samples.length,
      calculationMs: performance.now() - started,
      result,
    };
  });
  const report = {
    version: 1,
    id,
    sourceHashes,
    inputExportSha256: hash(bytes),
    inputFingerprint: source.inputFingerprint,
    scope:
      'Saved actual semantic/MoGe surface observations, independent default-only visible proxy experiment. No inference, automatic application, UI selection or measured size accuracy validation.',
    sourceVerification: {
      resources,
      sha256Matched: true,
      cameraHashMeaning: 'Full frozen placement report containing the camera, not only its JSON subobject',
    },
    observationProvenance: source.provenance,
    installationAssumption: { face: 'floor', baseHeightMm: 0, provenance: 'existing-default-not-observed' },
    candidates,
    newInference: false,
    automaticallyApplied: 0,
    userAccepted: 0,
    measured: false,
  };
  await writeFile(resolve(out, id + '.json'), JSON.stringify(report, null, 2));
  summary.push({
    id,
    candidates: candidates.map((c) => ({
      candidateId: c.candidateId,
      kind: c.kind,
      status: c.status,
      ...('result' in c
        ? {
            alternatives: c.result?.alternatives.length,
            fixedStatus: c.result?.fixedCheck.status,
            reasons: c.result?.reasons.map((r) => r.code),
          }
        : {}),
    })),
  });
}
for (const path of sourceFiles)
  if ((await digest(path)) !== sourceHashes[path]) throw new Error('Source changed during replay: ' + path);
await writeFile(
  resolve(out, 'summary.json'),
  JSON.stringify({ sourceHashes, sourceUnchangedDuringReplay: true, cases: summary }, null, 2),
);
console.log(JSON.stringify(summary, null, 2));
