import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactNode } from 'react';
import Properties from '../src/components/reconstruction/reconstruction-properties';
import Review from '../src/components/reconstruction/reconstruction-review';
import { reconstructionReviewSchema } from '../src/lib/supabase/validation';
import { reconstructionDefaults, type ReconstructionKind } from '../src/lib/reconstruction/types';
import { inspectStrictPlacement } from '../src/lib/reconstruction/strict-placement';
import { DEFAULT_ROOM } from '../src/lib/room-geometry';
import { DEFAULT_COLOR, EMPTY_MASK, type FixtureInstance, type ProjectDocument } from '../src/lib/types';

// Synthetic handler-boundary test only. The real browser/IndexedDB/PNG regression is
// preserved under curtain-properties-2026-09-15T05-41-55.021Z; neither is an AI metric.
const boundary = vi.hoisted(() => ({
  project: undefined as unknown as ProjectDocument,
  fixture: undefined as unknown as FixtureInstance,
  changeProject: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  onError: vi.fn(),
  onMaterialsChanged: vi.fn(async () => {}),
}));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: (value: unknown) => [typeof value === 'function' ? value() : value, vi.fn()],
  useRef: (value: unknown) => ({ current: value }),
  useEffect: vi.fn(),
}));
vi.mock('../src/components/app-provider', () => ({ useAccess: () => ({ writable: true }) }));
vi.mock('../src/lib/editor-store', () => {
  const state = () => ({
    project: boundary.project,
    draft: null,
    editing: 'before',
    changeProject: boundary.changeProject,
    select: vi.fn(),
    setTool: vi.fn(),
  });
  return { useEditor: Object.assign(state, { getState: state }) };
});
vi.mock('../src/lib/reconstruction', () => ({
  createReconstructionFixture: boundary.create,
  updateReconstructionFixture: boundary.update,
  createReconstructionTile: vi.fn(() => {
    throw Error('Unexpected tile edit');
  }),
  mapReconstructionCandidate: vi.fn(() => undefined),
  inferToiletLidState: vi.fn(() => undefined),
  estimateCandidateFixture: vi.fn(() => {
    throw Error('Use authored explicit placement');
  }),
}));
function text(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (Array.isArray(node)) return node.map(text).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return text(node.props.children);
  return String(node);
}
function button(node: ReactNode, label: string): (() => void) | undefined {
  if (Array.isArray(node)) return node.map((item) => button(item, label)).find(Boolean);
  if (!isValidElement<{ children?: ReactNode; onClick?: () => void }>(node)) return;
  if (node.type === 'button' && text(node.props.children) === label) return node.props.onClick;
  return button(node.props.children, label);
}
function seed(kind: ReconstructionKind, placed: boolean) {
  const defaults = reconstructionDefaults(kind);
  const baseHeightMm = kind === 'mirror' ? 1000 : kind === 'showerCurtain' ? 200 : 0;
  const face = defaults.face;
  const fixture: FixtureInstance = {
    id: 'ec263aea-b1ba-4da3-a8e9-457d276d45c1',
    name: 'Synthetic boundary fixture',
    materialVersionId: 'old-version',
    viewIndex: 0,
    position: { x: 0.5, y: 0.5 },
    width: 0.2,
    height: 0.5,
    rotation: 0,
    anchor: { x: 0.5, y: 1 },
    locked: false,
    roomPlacement: {
      face,
      u: 0.5,
      v: face === 'floor' ? 0.5 : 1 - baseHeightMm / DEFAULT_ROOM.heightMm,
      scale: 1,
      widthMm: defaults.widthMm,
      heightMm: defaults.heightMm,
      imageAspect: 1,
      contentBounds: { left: 0, top: 0, right: 1, bottom: 1 },
    },
    shadow: { x: 0, y: 0, opacity: 0, blur: 0, scale: 1 },
    occlusion: EMPTY_MASK(),
    color: { ...DEFAULT_COLOR },
    reconstruction: {
      ...defaults,
      version: 2,
      kind,
      orientation: 'back',
      baseHeightMm,
      provenance: { dimensions: 'user', width: 'user', height: 'user', depth: 'user' },
    },
  };
  boundary.fixture = fixture;
  const requested = { ...fixture.reconstruction!, ...fixture.roomPlacement!, kind };
  const blank = {
    room: { ...DEFAULT_ROOM },
    originalAssetId: 'original',
    previewAssetId: 'preview',
    imageWidth: 1200,
    imageHeight: 800,
    surfaces: [],
    fixtures: [],
    protection: EMPTY_MASK(),
    color: { ...DEFAULT_COLOR },
  };
  const before = { ...blank, fixtures: placed ? [structuredClone(fixture)] : [] };
  const installation = {
    mode: kind === 'showerCurtain' ? 'suspended' : face === 'floor' ? 'floor' : 'wall',
    ...(face === 'floor' ? {} : { wall: face }),
    source: 'inferred',
    reason: 'Authored boundary input',
  };
  boundary.project = {
    id: 'boundary-project',
    activeDesignId: 'design',
    editRevision: 0,
    shared: {
      baseline: blank,
      comparison: {
        before,
        room: { ...DEFAULT_ROOM },
        aspect: 1.5,
        cameraVersion: 1,
        status: 'draft',
        referenceOriginalAssetId: 'original',
        referencePreviewAssetId: 'preview',
        review: {
          version: 2,
          analysis: 'partial',
          planes: [],
          warnings: [],
          candidates: [
            {
              id: 'authored-candidate',
              kind,
              proposedKind: kind,
              source: 'deeplab',
              bounds: { left: 0.2, top: 0.1, right: 0.6, bottom: 0.9 },
              foot: { x: 0.4, y: 0.9 },
              color: defaults.color,
              pixels: 1000,
              evidence: { semanticPixels: 1000, meanMargin: 3 },
              status: placed ? 'placed' : 'unplaced',
              ...(placed ? { fixtureId: fixture.id } : {}),
              installation,
              placementReview: inspectStrictPlacement(DEFAULT_ROOM, requested),
            },
          ],
        },
      },
    },
  } as unknown as ProjectDocument;
  expect(reconstructionReviewSchema.safeParse(boundary.project.shared.comparison!.review).success).toBe(true);
}
beforeEach(() => {
  vi.clearAllMocks();
  boundary.changeProject.mockImplementation((mutate: (project: ProjectDocument) => void) => {
    const next = structuredClone(boundary.project);
    mutate(next);
    next.editRevision += 1;
    boundary.project = next;
  });
  boundary.create.mockImplementation(async () => structuredClone(boundary.fixture));
  boundary.update.mockImplementation(async (fixture: FixtureInstance) => ({
    ...structuredClone(fixture),
    materialVersionId: 'new-version',
  }));
});
describe('curtain mounting at production UI handler boundaries (synthetic model dependencies)', () => {
  for (const [kind, mode] of [
    ['showerCurtain', 'suspended'],
    ['toilet', 'floor'],
    ['mirror', 'wall'],
  ] as const) {
    it(`Properties keeps ${kind} review installation ${mode} after apply`, async () => {
      seed(kind, true);
      const before = structuredClone(boundary.project.shared.baseline);
      const priorCandidate = structuredClone(boundary.project.shared.comparison!.review!.candidates[0]);
      const run = button(
        Properties({
          scene: boundary.project.shared.comparison!.before,
          fixture: boundary.fixture,
          materials: {},
          onMaterialsChanged: boundary.onMaterialsChanged,
        }),
        '재구성 설정 적용',
      );
      expect(run).toBeTypeOf('function');
      run!();
      await vi.waitFor(() => expect(boundary.changeProject).toHaveBeenCalledOnce());
      const candidate = boundary.project.shared.comparison!.review!.candidates[0];
      expect(candidate.installation).toEqual(priorCandidate.installation);
      expect(candidate).toEqual(priorCandidate);
      expect(candidate.fixtureId).toBe(boundary.fixture.id);
      expect(boundary.project.shared.comparison!.before.fixtures[0].materialVersionId).toBe('new-version');
      expect(
        reconstructionReviewSchema.parse(boundary.project.shared.comparison!.review).candidates[0]
          .installation?.mode,
      ).toBe(mode);
      expect(boundary.project.shared.baseline).toEqual(before);
      expect(boundary.update).toHaveBeenCalledOnce();
      expect(boundary.create).not.toHaveBeenCalled();
    });
    it(`Review candidate addition keeps ${kind} installation ${mode}`, async () => {
      seed(kind, false);
      const before = structuredClone(boundary.project.shared.baseline);
      const run = button(
        Review({
          open: true,
          onClose: vi.fn(),
          onMaterialsChanged: boundary.onMaterialsChanged,
          onError: boundary.onError,
          onShowProperties: vi.fn(),
        }),
        '모형 추가',
      );
      expect(run).toBeTypeOf('function');
      run!();
      await vi.waitFor(() => expect(boundary.changeProject).toHaveBeenCalledOnce());
      expect(boundary.onError).not.toHaveBeenCalled();
      const review = reconstructionReviewSchema.parse(boundary.project.shared.comparison!.review);
      expect(review.candidates[0]).toMatchObject({
        kind,
        status: 'placed',
        fixtureId: boundary.fixture.id,
        installation: { mode, source: 'user' },
      });
      expect(boundary.project.shared.comparison!.before.fixtures).toHaveLength(1);
      expect(boundary.project.shared.baseline).toEqual(before);
      expect(boundary.create).toHaveBeenCalledOnce();
      expect(boundary.update).not.toHaveBeenCalled();
    });
  }
});
