/** Renderer selection only; model clients and graphics are mocked, not AI-quality evidence. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectDocument, Scene } from '../src/lib/types';
import { DEFAULT_COLOR } from '../src/lib/types';
import { DEFAULT_ROOM } from '../src/lib/room-geometry';
import { projectDesignPreviewRoomContext } from '../src/lib/render/design-preview-context';
import type { ReconstructionProjectOptions } from '../src/lib/reconstruction/index';
import { runBrowserAnalysisTest } from '../src/lib/reconstruction/browser-analysis-test';

const boundary = vi.hoisted(() => ({
  create: vi.fn(),
  render: vi.fn(),
  get: vi.fn(),
  materials: vi.fn(),
  dispose: vi.fn(),
}));
vi.mock('../src/lib/reconstruction/index', () => ({ createReconstructionProject: boundary.create }));
vi.mock('../src/lib/reconstruction/lab', () => ({
  memoryRepositories: () => ({
    repositories: { assets: { get: boundary.get }, materials: { list: boundary.materials } },
    dispose: boundary.dispose,
  }),
}));
vi.mock('../src/lib/room-viewer/render-snapshot', () => ({ renderRoomSnapshotImage: boundary.render }));
vi.mock('../src/lib/images', () => ({ importImage: vi.fn() }));
vi.mock('../src/lib/reconstruction/analysis-client', () => ({ analyzeExtendedScene: vi.fn() }));
vi.mock('../src/lib/reconstruction/geometry-browser-client', () => ({
  browserGeometryInput: vi.fn(),
  geometryAnalysisFromBrowser: vi.fn(),
}));
vi.mock('../src/lib/reconstruction/moge-browser/client', () => ({ MogeBrowserClient: vi.fn() }));
vi.mock('../src/lib/reconstruction/segmentation-cache', () => ({ segmentReconstructionCached: vi.fn() }));

const beforeBlob = new Blob(['mock graphics output']),
  originalBlob = new Blob(['mock source photo']);
const scene = (id: string, structure = false): Scene => ({
  originalAssetId: id,
  previewAssetId: id + '-preview',
  imageWidth: 4096,
  imageHeight: 2731,
  room: { ...DEFAULT_ROOM },
  surfaces: [],
  fixtures: [],
  protection: { polygon: [], strokes: [] },
  color: { ...DEFAULT_COLOR },
  ...(structure
    ? {
        wallFeatures: [
          {
            version: 1,
            id: '10000000-0000-4000-8000-000000000001',
            kind: 'closed-niche' as const,
            face: 'back' as const,
            source: 'user' as const,
            leftMm: 400,
            topMm: 600,
            widthMm: 500,
            heightMm: 400,
            depthMm: 150,
          },
        ],
      }
    : {}),
});
function project(beforeStructure = false, otherDesignStructure = false): ProjectDocument {
  return {
    schemaVersion: 3,
    activeDesignId: 'active',
    shared: {
      baseline: scene('baseline'),
      comparison: {
        before: scene('before', beforeStructure),
        referencePreviewAssetId: 'original-preview',
        review: {},
      },
    },
    designs: [
      { id: 'active', scene: scene('active-scene') },
      { id: 'other', scene: scene('other-scene', otherDesignStructure) },
    ],
    roomView: { version: 1, quaternion: [0, 0, 0, 1], zoom: 1.4, pan: { x: 0.1, y: 0 } },
  } as unknown as ProjectDocument;
}
beforeEach(() => {
  vi.clearAllMocks();
  boundary.get.mockResolvedValue({ blob: originalBlob });
  boundary.materials.mockResolvedValue([]);
  boundary.render.mockResolvedValue(beforeBlob);
});
async function execute(input: ProjectDocument) {
  boundary.create.mockResolvedValue(input);
  return runBrowserAnalysisTest(
    new File(['photo'], 'fixture.jpg', { type: 'image/jpeg' }),
    'full',
    DEFAULT_ROOM,
    { mode: 'auto', signal: new AbortController().signal, onStage: vi.fn() },
  );
}
describe('performance Before matches the normal editor renderer', () => {
  it.each([false, true])(
    'uses the legacy compositor for ordinary scenes, empty arrays=%s',
    async (emptyArrays) => {
      const input = project();
      if (emptyArrays) {
        input.shared.comparison!.before.wallFeatures = [];
        input.designs.forEach((d) => {
          d.scene.wallFeatures = [];
        });
      }
      expect(projectDesignPreviewRoomContext(input)).toBeUndefined();
      const result = await execute(input);
      const [snapshot, , options] = boundary.render.mock.calls[0];
      expect(snapshot.scene).toBe(input.designs[0].scene);
      expect(snapshot.beforeScene).toBe(input.shared.comparison!.before);
      expect(options).toEqual({ renderer: 'legacy-front', mode: 'before', longEdge: 1024 });
      expect(result).toMatchObject({
        original: originalBlob,
        before: beforeBlob,
        report: {
          rendering: {
            renderer: 'legacy-front',
            selection: 'normal-editor',
            commonDesignFit: false,
            frame: { width: 4096, height: 2731 },
          },
          projectSaved: false,
        },
      });
      expect(boundary.dispose).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    { before: true, other: false },
    { before: false, other: true },
  ])(
    'uses room-view with the same project-wide fit: Before=$before other design=$other',
    async ({ before, other }) => {
      const input = project(before, other),
        original = structuredClone(input);
      const expected = projectDesignPreviewRoomContext(input)!;
      const result = await execute(input);
      const [snapshot, , options] = boundary.render.mock.calls[0];
      expect(snapshot.scene).toBe(input.designs[0].scene);
      expect(options).toEqual({
        renderer: 'room-view',
        mode: 'before',
        longEdge: 1024,
        view: expected.view,
        fitScenes: expected.fitScenes,
      });
      expect(options.fitScenes).toContain(input.designs[1].scene);
      expect(result.report).toMatchObject({ rendering: { renderer: 'room-view', commonDesignFit: true } });
      expect(input).toEqual(original);
      expect(boundary.dispose).toHaveBeenCalledTimes(1);
    },
  );
});


it('keeps an immutable actual pipeline/baseline snapshot in the test report without putting it in the rendered scene', async () => {
  const input = project();
  const observed = { evidence: { version: 1 }, pipeline: { estimatedLayout: { revision: 'test-only', nodes: [{ candidateId: 'actual-candidate', alternatives: [{ score: 0.5 }] }] } } };
  const raw = { version: 2, analysis: 'partial', candidates: [], planes: [], warnings: ['observed baseline'] };
  boundary.create.mockImplementationOnce(async (_file: File, _room: unknown, options: ReconstructionProjectOptions) => {
    options.onRawReview!(raw as Parameters<NonNullable<ReconstructionProjectOptions['onRawReview']>>[0]);
    options.onQuality!(observed as unknown as Parameters<NonNullable<ReconstructionProjectOptions['onQuality']>>[0]);
    raw.warnings.push('later mutation');
    observed.pipeline.estimatedLayout.nodes[0].alternatives[0].score = 9;
    return input;
  });
  const result = await runBrowserAnalysisTest(new File(['photo'], 'fixture.jpg', { type: 'image/jpeg' }), 'full', DEFAULT_ROOM, { mode: 'auto', signal: new AbortController().signal, onStage: vi.fn() });
  expect(result.report.analysisDiagnostics).toEqual({ schemaVersion: 1, baselineReview: { version: 2, analysis: 'partial', candidates: [], planes: [], warnings: ['observed baseline'] }, pipeline: { estimatedLayout: { revision: 'test-only', nodes: [{ candidateId: 'actual-candidate', alternatives: [{ score: 0.5 }] }] } } });
  expect(boundary.render.mock.calls[0][0].scene).toBe(input.designs[0].scene);
  expect(result.report.projectSaved).toBe(false);
});
