import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactNode } from 'react';
import Properties from '../src/components/reconstruction/reconstruction-properties';
import Controls, { fixtureForm } from '../src/components/reconstruction/reconstruction-fixture-controls';
import {
  fixturePropertyFormPatch,
  inspectFixturePropertyChanges,
  updateCandidateFromPropertyEdit,
} from '../src/lib/reconstruction/fixture-property-changes';
import { DEFAULT_ROOM } from '../src/lib/room-geometry';
import {
  DEFAULT_COLOR,
  EMPTY_MASK,
  type FixtureInstance,
  type ProjectDocument,
  type Scene,
} from '../src/lib/types';
import {
  reconstructionDefaults,
  type ReconstructionCandidate,
  type ReconstructionKind,
} from '../src/lib/reconstruction/types';

const boundary = vi.hoisted(() => ({
  state: [] as unknown[],
  cursor: 0,
  project: undefined as unknown as ProjectDocument,
  update: vi.fn(),
  change: vi.fn(),
  materials: vi.fn(async () => {}),
}));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: (initial: unknown) => {
    const index = boundary.cursor++;
    if (!(index in boundary.state))
      boundary.state[index] = typeof initial === 'function' ? initial() : initial;
    return [
      boundary.state[index],
      (value: unknown) => {
        boundary.state[index] = typeof value === 'function' ? value(boundary.state[index]) : value;
      },
    ];
  },
  useRef: (value: unknown) => ({ current: value }),
  useEffect: vi.fn(),
}));
vi.mock('../src/lib/editor-store', () => ({
  useEditor: {
    getState: () => ({
      project: boundary.project,
      draft: null,
      editing: 'before',
      changeProject: boundary.change,
    }),
  },
}));
vi.mock('../src/lib/reconstruction', () => ({
  updateReconstructionFixture: boundary.update,
  createReconstructionTile: vi.fn(() => {
    throw Error('Unexpected tile edit');
  }),
}));

function seed(kind: ReconstructionKind = 'toilet') {
  const defaults = reconstructionDefaults(kind, kind === 'basin' ? 'pedestal' : undefined);
  const fixture = {
    id: 'fixture-1',
    name: 'Authored fixture',
    materialVersionId: 'material-1',
    reconstruction: {
      ...defaults,
      version: 2,
      kind,
      orientation: 'back',
      yawDegrees: 0,
      baseHeightMm: 0,
      ...(kind === 'toilet' ? { toiletLidState: 'open' } : {}),
      provenance: {
        kind: 'model',
        mounting: 'inferred',
        wall: 'model',
        position: 'inferred',
        dimensions: 'default',
        shape: 'inferred',
        toiletLidState: 'inferred',
      },
    },
    roomPlacement: {
      face: defaults.face,
      u: 0.4,
      v: 0.5,
      scale: 1,
      widthMm: defaults.widthMm,
      heightMm: defaults.heightMm,
      imageAspect: 1.5,
    },
    locked: false,
  } as unknown as FixtureInstance;
  const candidate: ReconstructionCandidate = {
    id: 'candidate-1',
    fixtureId: fixture.id,
    kind,
    source: 'qwen',
    proposedKind: kind,
    bounds: { left: 0.2, top: 0.2, right: 0.5, bottom: 0.8 },
    foot: { x: 0.35, y: 0.8 },
    color: defaults.color,
    pixels: 100,
    evidence: { semanticPixels: 100, meanMargin: 2 },
    status: 'placed',
    requiresReview: true,
    warning: '설치 벽과 위치를 확인해 주세요.',
    installation: {
      mode: defaults.face === 'floor' ? 'floor' : 'wall',
      wall: 'left',
      ...(kind === 'basin' ? { basinVariant: 'pedestal' as const } : {}),
      source: 'inferred',
      reason: 'Original observation',
    },
    trace: [{ stage: 'placement', outcome: 'held', reason: 'Original held evidence' }],
  };
  const blank = {
    originalAssetId: 'asset-1',
    previewAssetId: 'asset-1',
    imageWidth: 1200,
    imageHeight: 800,
    room: { ...DEFAULT_ROOM },
    surfaces: [],
    fixtures: [],
    protection: EMPTY_MASK(),
    color: { ...DEFAULT_COLOR },
  } as Scene;
  const scene = { ...blank, fixtures: [fixture] };
  boundary.project = {
    id: 'project-1',
    editRevision: 0,
    shared: {
      baseline: blank,
      comparison: {
        room: { ...DEFAULT_ROOM },
        before: scene,
        review: { version: 2, analysis: 'partial', warnings: [], planes: [], candidates: [candidate] },
      },
    },
  } as unknown as ProjectDocument;
  return { fixture, candidate, scene, before: fixtureForm(scene, fixture) };
}
function inspect(
  f: ReturnType<typeof seed>,
  patch: Partial<ReturnType<typeof fixtureForm>>,
  kind = f.candidate.kind,
) {
  return inspectFixturePropertyChanges({
    before: f.before,
    after: { ...f.before, ...patch },
    oldKind: f.candidate.kind,
    kind,
    oldOrientation: 'back',
    orientation: 'back',
  });
}
function text(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (Array.isArray(node)) return node.map(text).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return text(node.props.children);
  return String(node);
}
function find(
  node: ReactNode,
  predicate: (node: React.ReactElement<Record<string, unknown>>) => boolean,
): React.ReactElement<Record<string, unknown>> | undefined {
  if (Array.isArray(node)) return node.map((item) => find(item, predicate)).find(Boolean);
  if (!isValidElement<Record<string, unknown>>(node)) return;
  if (predicate(node)) return node;
  return find(node.props.children as ReactNode, predicate);
}
function render() {
  boundary.cursor = 0;
  const scene = boundary.project.shared.comparison!.before;
  return Properties({
    scene,
    fixture: scene.fixtures[0],
    materials: {},
    onMaterialsChanged: boundary.materials,
  });
}
async function apply() {
  const button = find(
    render(),
    (node) => node.type === 'button' && text(node.props.children as ReactNode) === '재구성 설정 적용',
  );
  expect(button).toBeDefined();
  (button!.props.onClick as () => void)();
  await vi.waitFor(() => expect(boundary.change).toHaveBeenCalledOnce());
}
beforeEach(() => {
  vi.clearAllMocks();
  boundary.state = [];
  boundary.cursor = 0;
  boundary.change.mockImplementation((change: (p: ProjectDocument) => void) => {
    const copy = structuredClone(boundary.project);
    change(copy);
    copy.editRevision++;
    boundary.project = copy;
  });
  boundary.update.mockImplementation(
    async (fixture: FixtureInstance, _room: unknown, patch: Record<string, unknown>) => ({
      ...structuredClone(fixture),
      materialVersionId: 'material-2',
      reconstruction: { ...structuredClone(fixture.reconstruction), ...patch },
      roomPlacement: {
        ...fixture.roomPlacement,
        ...Object.fromEntries(
          ['face', 'u', 'v'].filter((key) => Object.hasOwn(patch, key)).map((key) => [key, patch[key]]),
        ),
      },
    }),
  );
});

describe('property edit boundaries', () => {
  it('does not turn a lid-only edit into placement, kind or review confirmation', () => {
    const f = seed(),
      changes = inspect(f, { toiletLidState: 'closed' }),
      snapshot = structuredClone(f.candidate);
    expect(changes).toEqual({
      kind: false,
      mounting: false,
      wall: false,
      position: false,
      shape: false,
      toiletLidState: true,
    });
    const next = structuredClone(f.fixture);
    next.reconstruction!.toiletLidState = 'closed';
    expect(updateCandidateFromPropertyEdit(f.candidate, next, changes)).toEqual(snapshot);
    expect(f.candidate).toEqual(snapshot);
    expect(fixturePropertyFormPatch(f.before, { ...f.before, toiletLidState: 'closed' }, 'toilet')).toEqual({
      toiletLidState: 'closed',
    });
  });
  it.each(['toilet', 'shower', 'mirror', 'showerCurtain'] as const)(
    'does not inject basin defaults into unchanged %s',
    (kind) => {
      const f = seed(kind);
      expect(fixturePropertyFormPatch(f.before, f.before, kind)).toEqual({});
      const converted = fixturePropertyFormPatch(f.before, f.before, kind, { convert: true });
      expect(converted).not.toHaveProperty('basinVariant');
      expect(converted).not.toHaveProperty('basinShape');
    },
  );
  it('preserves a previously stored irrelevant field rather than silently migrating it', () => {
    const f = seed();
    f.fixture.reconstruction!.basinVariant = 'pedestal';
    const initial = fixtureForm(f.scene, f.fixture);
    const patch = fixturePropertyFormPatch(initial, { ...initial, toiletLidState: 'closed' }, 'toilet');
    expect(patch).not.toHaveProperty('basinVariant');
    expect({ ...f.fixture.reconstruction, ...patch }.basinVariant).toBe('pedestal');
  });
  it('updates an actual wall edit but retains kind, review status and original evidence', () => {
    const f = seed('mirror'),
      changes = inspect(f, { face: 'right' }),
      next = structuredClone(f.fixture);
    next.roomPlacement!.face = 'right';
    const result = updateCandidateFromPropertyEdit(f.candidate, next, changes);
    expect(changes.wall).toBe(true);
    expect(changes.mounting).toBe(false);
    expect(result.installation).toMatchObject({ mode: 'wall', wall: 'right', source: 'user' });
    expect(result.source).toBe('qwen');
    expect(result.requiresReview).toBe(true);
    expect(result.warning).toBe(f.candidate.warning);
    expect(result.evidence).toEqual(f.candidate.evidence);
    expect(result.trace?.slice(0, 1)).toEqual(f.candidate.trace);
  });
  it('does not lose the observed installation wall when a floor model is moved or rotated', () => {
    const f = seed(),
      changes = inspect(f, { u: 0.6, yawDegrees: 90 }),
      next = structuredClone(f.fixture);
    next.roomPlacement!.u = 0.6;
    next.reconstruction!.yawDegrees = 90;
    const result = updateCandidateFromPropertyEdit(f.candidate, next, changes);
    expect(changes).toMatchObject({ position: true, wall: false, mounting: false });
    expect(result.installation).toEqual(f.candidate.installation);
    expect(result.requiresReview).toBe(true);
  });
  it('clears basin-only installation metadata on a floor basin to toilet kind edit', () => {
    const f = seed('basin'),
      changes = inspect(f, {}, 'toilet'),
      next = structuredClone(f.fixture);
    next.reconstruction!.kind = 'toilet';
    const result = updateCandidateFromPropertyEdit(f.candidate, next, changes);
    expect(changes).toMatchObject({ kind: true, mounting: false, wall: false });
    expect(result.installation).not.toHaveProperty('basinVariant');
    expect(result.installation).toMatchObject({ mode: 'floor', wall: 'left', source: 'inferred' });
    expect(result).toMatchObject({
      kind: 'toilet',
      proposedKind: 'toilet',
      source: 'user',
      requiresReview: true,
    });
  });
  it('marks an actual basin mounting transition without erasing unrelated review warnings', () => {
    const f = seed('basin'),
      changes = inspect(f, { basinVariant: 'wall', face: 'left' }),
      next = structuredClone(f.fixture);
    next.reconstruction!.basinVariant = 'wall';
    next.roomPlacement!.face = 'left';
    const result = updateCandidateFromPropertyEdit(f.candidate, next, changes);
    expect(changes.mounting).toBe(true);
    expect(result.installation).toMatchObject({
      mode: 'wall',
      wall: 'left',
      basinVariant: 'wall',
      source: 'user',
    });
    expect(result.warning).toBe(f.candidate.warning);
    expect(result.source).toBe('qwen');
  });
  it('keeps suspended curtain support distinct from floor coordinates', () => {
    const f = seed('showerCurtain');
    f.candidate.installation!.mode = 'suspended';
    expect(inspect(f, { baseHeightMm: 200 })).toMatchObject({ mounting: false, position: true });
    expect(
      updateCandidateFromPropertyEdit(f.candidate, f.fixture, inspect(f, { baseHeightMm: 200 })).installation,
    ).toEqual(f.candidate.installation);
  });
  it('does not treat shape controls or reverted controls as whole-candidate confirmation', () => {
    const f = seed('mirror'),
      changes = inspect(f, { mirrorShape: 'oval' });
    expect(changes).toMatchObject({ shape: true, kind: false, position: false, mounting: false });
    expect(updateCandidateFromPropertyEdit(f.candidate, f.fixture, changes)).toEqual(f.candidate);
    expect(inspect(f, {})).toEqual({
      kind: false,
      mounting: false,
      wall: false,
      position: false,
      shape: false,
      toiletLidState: false,
    });
  });
});

describe('real Properties handler with isolated authored state', () => {
  it('writes only the lid provenance and preserves all candidate review fields', async () => {
    const f = seed(),
      candidate = structuredClone(f.candidate),
      meta = structuredClone(f.fixture.reconstruction);
    const control = find(render(), (node) => node.type === Controls)!;
    (control.props.onChange as (form: unknown) => void)({ ...f.before, toiletLidState: 'closed' });
    await apply();
    const patch = boundary.update.mock.calls[0][2];
    expect(patch.provenance).toEqual({ ...meta!.provenance, toiletLidState: 'user' });
    expect(patch).not.toHaveProperty('basinVariant');
    expect(patch).not.toHaveProperty('hasFrame');
    expect(boundary.project.shared.comparison!.review!.candidates[0]).toEqual(candidate);
    expect(boundary.project.shared.baseline.fixtures).toEqual([]);
  });
  it('marks only position when the actual floor yaw changes', async () => {
    const f = seed(),
      control = find(render(), (node) => node.type === Controls)!;
    (control.props.onChange as (form: unknown) => void)({ ...f.before, yawDegrees: 90 });
    await apply();
    expect(boundary.update.mock.calls[0][2].provenance).toEqual({
      ...f.fixture.reconstruction!.provenance,
      position: 'user',
    });
    const candidate = boundary.project.shared.comparison!.review!.candidates[0];
    expect(candidate.installation).toEqual(f.candidate.installation);
    expect(candidate.source).toBe('qwen');
    expect(candidate.requiresReview).toBe(true);
  });
  it('marks actual wall changes without claiming the kind was chosen', async () => {
    const f = seed('mirror'),
      control = find(render(), (node) => node.type === Controls)!;
    (control.props.onChange as (form: unknown) => void)({ ...f.before, face: 'right' });
    await apply();
    expect(boundary.update.mock.calls[0][2].provenance).toEqual({
      ...f.fixture.reconstruction!.provenance,
      position: 'user',
      wall: 'user',
    });
    expect(boundary.project.shared.comparison!.review!.candidates[0].installation).toMatchObject({
      wall: 'right',
      mode: 'wall',
      source: 'user',
    });
  });
  it('does not mark a changed-then-restored lid as newly user confirmed', async () => {
    const f = seed(),
      first = find(render(), (node) => node.type === Controls)!;
    (first.props.onChange as (form: unknown) => void)({ ...f.before, toiletLidState: 'closed' });
    const second = find(render(), (node) => node.type === Controls)!;
    (second.props.onChange as (form: unknown) => void)({ ...f.before, toiletLidState: 'open' });
    await apply();
    expect(boundary.update.mock.calls[0][2].provenance).toEqual(f.fixture.reconstruction!.provenance);
  });
  it.each(['wall-only', 'u-only', 'floor-to-wall'] as const)(
    'preserves bottom anchor semantics for %s edits',
    async (mode) => {
      const f = seed('mirror');
      f.fixture.reconstruction!.baseHeightMm = 600;
      f.fixture.roomPlacement!.face = mode === 'floor-to-wall' ? 'floor' : 'back';
      f.fixture.roomPlacement!.v = mode === 'floor-to-wall' ? 0.4 : 0.75;
      const initial = fixtureForm(f.scene, f.fixture);
      const control = find(render(), (node) => node.type === Controls)!;
      (control.props.onChange as (value: unknown) => void)({
        ...initial,
        ...(mode === 'u-only' ? { u: 0.6 } : { face: 'right' }),
      });
      await apply();
      const patch = boundary.update.mock.calls[0][2];
      expect(patch.baseHeightMm).toBe(600);
      expect(patch.v).toBe(0.75);
      expect(patch.provenance.kind).toBe('model');
      expect(patch.provenance.position).toBe('user');
      expect(patch.provenance.wall).toBe(mode === 'u-only' ? 'model' : 'user');
    },
  );
  it('preserves existing conversion dimensions and wall bottom anchor', async () => {
    const f = seed('mirror');
    f.fixture.reconstruction!.version = 1;
    f.fixture.reconstruction!.baseHeightMm = 600;
    f.fixture.roomPlacement!.v = 0.6;
    f.fixture.roomPlacement!.scale = 0.75;
    const run = find(
      render(),
      (node) => node.type === 'button' && text(node.props.children as ReactNode) === '표준 모형으로 변환',
    )!;
    (run.props.onClick as () => void)();
    await vi.waitFor(() => expect(boundary.change).toHaveBeenCalledOnce());
    const patch = boundary.update.mock.calls[0][2],
      options = boundary.update.mock.calls[0][3];
    expect(patch.v).toBe(0.75);
    expect(patch.baseHeightMm).toBe(600);
    expect(patch.widthMm).toBe(f.fixture.reconstruction!.widthMm * 0.75);
    expect(options.convertToStandard).toBe(true);
    expect(options.placementPolicy).toBe('preserve');
    expect(boundary.project.shared.comparison!.review!.candidates[0]).toEqual(f.candidate);
  });
  it('updates an explicitly changed kind while retaining remaining review issues', async () => {
    const f = seed('basin');
    const chooser = find(render(), (node) => node.props['aria-label'] === '재구성 모형 종류')!;
    (chooser.props.onChange as (event: unknown) => void)({ target: { value: 'toilet' } });
    await apply();
    const candidate = boundary.project.shared.comparison!.review!.candidates[0];
    expect(candidate.kind).toBe('toilet');
    expect(candidate.source).toBe('user');
    expect(candidate.requiresReview).toBe(true);
    expect(candidate.installation).not.toHaveProperty('basinVariant');
    expect(candidate.warning).toBe(f.candidate.warning);
  });
  it('does not rewrite differing original candidate color during a lid-only edit', async () => {
    const f = seed();
    f.candidate.color = '#aabbcc';
    const candidate = structuredClone(f.candidate);
    const control = find(render(), (node) => node.type === Controls)!;
    (control.props.onChange as (value: unknown) => void)({ ...f.before, toiletLidState: 'closed' });
    await apply();
    expect(boundary.project.shared.comparison!.review!.candidates[0]).toEqual(candidate);
  });
  it('updates an explicitly edited color while retaining source, review and installation', () => {
    const f = seed(),
      next = structuredClone(f.fixture);
    next.reconstruction!.color = '#aabbcc';
    const changed = updateCandidateFromPropertyEdit(f.candidate, next, inspect(f, {}), {
      colorChanged: true,
    });
    expect(changed.color).toBe('#aabbcc');
    expect(changed.installation).toEqual(f.candidate.installation);
    expect(changed.source).toBe(f.candidate.source);
    expect(changed.requiresReview).toBe(true);
    expect(changed.warning).toBe(f.candidate.warning);
  });
});
