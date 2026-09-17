import { describe, expect, it } from 'vitest';
import { projectSchema, reconstructionReviewSchema } from '../src/lib/storage/validation';
import { normalizeProjectDocument } from '../src/lib/comparison';
import { DEFAULT_ROOM, createRoomSurfaces } from '../src/lib/room-geometry';
import { DEFAULT_COLOR, EMPTY_MASK, type LegacyProjectDocument, type Scene } from '../src/lib/types';
import type { ReconstructionReview } from '../src/lib/reconstruction/types';

const review: ReconstructionReview = {
  version: 2,
  analysis: 'partial',
  planes: [],
  candidates: [],
  warnings: [],
  analysisProfile: 'local-quality-v1',
  analysisSummary: {
    profile: 'local-quality-v1',
    revision: 'local-quality-v1-installation-geometry-1',
    runId: crypto.randomUUID(),
    modelId: 'qwen3-vl:4b-instruct-q4_K_M',
    modelRevision: 'a'.repeat(64),
    geometryModelId: 'Ruicheng/moge-2-vits-normal',
    geometryModelRevision: 'b'.repeat(40),
    cameraStatus: 'held',
    estimated: true,
  },
};
function project() {
  const scene: Scene = {
    originalAssetId: crypto.randomUUID(),
    previewAssetId: crypto.randomUUID(),
    imageWidth: 1200,
    imageHeight: 800,
    room: DEFAULT_ROOM,
    surfaces: createRoomSurfaces(DEFAULT_ROOM),
    fixtures: [],
    protection: EMPTY_MASK(),
    color: DEFAULT_COLOR,
  };
  const document: LegacyProjectDocument = {
    id: crypto.randomUUID(),
    ownerId: 'local',
    name: 'Quality round trip',
    schemaVersion: 2,
    editRevision: 0,
    storageRevision: 0,
    scene,
    history: { past: [], future: [] },
    viewport: { zoom: 1, pan: { x: 0, y: 0 } },
    createdAt: '2026-09-14T00:00:00.000Z',
    updatedAt: '2026-09-14T00:00:00.000Z',
    comparison: {
      before: structuredClone(scene),
      room: DEFAULT_ROOM,
      cameraVersion: 1,
      aspect: 1.5,
      referenceOriginalAssetId: scene.originalAssetId,
      referencePreviewAssetId: scene.previewAssetId,
      status: 'draft',
      review,
    },
  };
  return normalizeProjectDocument(document);
}
describe('analysis profile storage boundary', () => {
  it('retains profile, model versions and diagnostic run ID through project JSON validation and reload', () => {
    const written = projectSchema.parse(project());
    const reopened = normalizeProjectDocument(projectSchema.parse(JSON.parse(JSON.stringify(written))));
    expect(reopened.shared.comparison?.review).toEqual(review);
  });
  it('continues to accept historical reviews without profile metadata', () => {
    const historical = { version: 2, analysis: 'partial', planes: [], candidates: [], warnings: [] };
    expect(reconstructionReviewSchema.parse(historical)).toEqual(historical);
  });
  it('rejects unsupported profiles, malformed IDs, measured claims and unbounded revision metadata', () => {
    for (const patch of [
      { profile: 'cloud-ai' },
      { runId: 'broken' },
      { estimated: false },
      { revision: 'x'.repeat(301) },
    ])
      expect(
        reconstructionReviewSchema.safeParse({
          ...review,
          analysisSummary: { ...review.analysisSummary, ...patch },
        }).success,
      ).toBe(false);
    expect(reconstructionReviewSchema.safeParse({ ...review, analysisProfile: 'unsupported' }).success).toBe(
      false,
    );
  });
});
