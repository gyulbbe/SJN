import { createSourceCamera, type SourceCamera } from '../src/lib/reconstruction/source-camera';
import 'fake-indexeddb/auto';
import { IDBObjectStore } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Box3, Quaternion, Vector3 } from 'three';
import {
  createRoomViewCamera,
  sourceRoomView,
  sourceRoomViewAvailable,
  resetRoomView,
  roomViewViewport,
  validRoomSourceCamera,
  defaultRoomView,
  normalizeRoomView,
  roomViewBounds,
  roomViewLabel,
  rotateRoomView,
  type RoomViewDirection,
} from '../src/lib/room-viewer/view-state';
import { createRoomSurfaces, DEFAULT_ROOM } from '../src/lib/room-geometry';
import { captureWorkspace, getActiveDesign, normalizeProjectDocument } from '../src/lib/comparison';
import { duplicateProjectDocument } from '../src/lib/designs';
import { useEditor } from '../src/lib/editor-store';
import { DEFAULT_COLOR, EMPTY_MASK, type LegacyProjectDocument } from '../src/lib/types';
import { projectV3Schema, roomViewSchema } from '../src/lib/storage/validation';
import { createLegacyLocalRepositories } from './helpers/legacy-local-repositories';
import { projectReferences, StorageConflictError } from '../src/lib/repositories/references';
import { createQuote } from '../src/lib/quote';

const directions: RoomViewDirection[] = ['left', 'right', 'up', 'down'];
const opposite: Record<RoomViewDirection, RoomViewDirection> = {
  left: 'right',
  right: 'left',
  up: 'down',
  down: 'up',
};
const basis = (view = defaultRoomView()) =>
  new Vector3(0, 0, 1).applyQuaternion(new Quaternion(...view.quaternion));
function points(box: Box3) {
  return [box.min.x, box.max.x].flatMap((x) =>
    [box.min.y, box.max.y].flatMap((y) => [box.min.z, box.max.z].map((z) => new Vector3(x, y, z))),
  );
}
function project() {
  const asset = crypto.randomUUID();
  const legacy: LegacyProjectDocument = {
    id: crypto.randomUUID(),
    ownerId: 'local',
    name: '보기 상태 검사',
    schemaVersion: 2,
    editRevision: 3,
    storageRevision: 0,
    createdAt: '2026-09-14T00:00:00.000Z',
    updatedAt: '2026-09-14T00:00:00.000Z',
    viewport: { zoom: 1, pan: { x: 0, y: 0 } },
    history: { past: [], future: [] },
    scene: {
      room: { ...DEFAULT_ROOM },
      originalAssetId: asset,
      previewAssetId: asset,
      imageWidth: 1200,
      imageHeight: 800,
      surfaces: createRoomSurfaces(DEFAULT_ROOM),
      fixtures: [],
      protection: EMPTY_MASK(),
      color: { ...DEFAULT_COLOR },
    },
  };
  legacy.comparison = {
    before: structuredClone(legacy.scene),
    room: { ...DEFAULT_ROOM },
    cameraVersion: 1,
    aspect: 1.5,
    referenceOriginalAssetId: asset,
    referencePreviewAssetId: asset,
    status: 'confirmed',
  };
  return normalizeProjectDocument(legacy);
}
const current = () => useEditor.getState().project!;
afterEach(() => vi.restoreAllMocks());

describe('common 90 degree camera rig', () => {
  it.each([
    ['left', [-1, 0, 0], '왼쪽'],
    ['right', [1, 0, 0], '오른쪽'],
    ['up', [0, 1, 0], '위쪽'],
    ['down', [0, -1, 0], '아래쪽'],
  ] as const)('%s moves camera to its named side of the room', (direction, expected, label) => {
    const view = rotateRoomView(defaultRoomView(), direction);
    basis(view)
      .toArray()
      .forEach((value, i) => expect(value).toBeCloseTo(expected[i], 9));
    expect(roomViewLabel(view)).toBe(label);
    const camera = createRoomViewCamera(DEFAULT_ROOM, 1.5, view);
    const targetDirection = new Vector3(0, DEFAULT_ROOM.heightMm / 2, DEFAULT_ROOM.depthMm / 2)
      .sub(camera.position)
      .normalize();
    expect(camera.getWorldDirection(new Vector3()).distanceTo(targetDirection)).toBeLessThan(1e-10);
    expect(Math.abs(camera.up.dot(targetDirection))).toBeLessThan(1e-10);
  });
  it.each(directions)('%s four times and opposite action recover exactly', (direction) => {
    let view = defaultRoomView();
    for (let i = 0; i < 4; i++) view = rotateRoomView(view, direction);
    expect(view).toEqual(defaultRoomView());
    expect(rotateRoomView(rotateRoomView(view, direction), opposite[direction])).toEqual(defaultRoomView());
  });
  it('uses current local axes in mixed rotations and recovers after reverse-order undo', () => {
    const sequence: RoomViewDirection[] = ['up', 'left', 'down', 'right', 'right', 'up', 'left'];
    let view = defaultRoomView();
    for (const direction of sequence) view = rotateRoomView(view, direction);
    expect(view.quaternion).not.toEqual(defaultRoomView().quaternion);
    for (const direction of [...sequence].reverse()) view = rotateRoomView(view, opposite[direction]);
    expect(view).toEqual(defaultRoomView());
    const upThenRight = rotateRoomView(rotateRoomView(defaultRoomView(), 'up'), 'right');
    basis(upThenRight)
      .toArray()
      .forEach((value, i) => expect(value).toBeCloseTo([1, 0, 0][i], 9));
  });
  it('has finite orthogonal cameras at all polar orientations after 100 quarter turns', () => {
    let view = defaultRoomView();
    for (let i = 0; i < 100; i++) {
      view = rotateRoomView(view, directions[(i * 7 + Math.floor(i / 5)) % 4]);
      expect(Math.hypot(...view.quaternion)).toBeCloseTo(1, 10);
      const camera = createRoomViewCamera(DEFAULT_ROOM, 1.5, view);
      expect(camera.matrixWorld.elements.every(Number.isFinite)).toBe(true);
      expect(camera.projectionMatrix.elements.every(Number.isFinite)).toBe(true);
      expect(Math.abs(camera.getWorldDirection(new Vector3()).dot(camera.up))).toBeLessThan(1e-10);
    }
  });
  it.each([
    { widthMm: 20000, depthMm: 20000, heightMm: 6000 },
    { widthMm: 500, depthMm: 20000, heightMm: 1000 },
    { widthMm: 20000, depthMm: 500, heightMm: 1000 },
    { widthMm: 500, depthMm: 500, heightMm: 6000 },
  ])('fits large/narrow/low room corners without clipping %j', (room) => {
    for (const aspect of [0.3, 1.5, 4])
      for (const direction of directions) {
        let view = defaultRoomView();
        for (let i = 0; i < 4; i++) {
          view = rotateRoomView(view, direction);
          const camera = createRoomViewCamera(room, aspect, view);
          for (const point of points(roomViewBounds(room))) {
            const pixel = point.project(camera);
            expect(Math.abs(pixel.x)).toBeLessThan(0.881);
            expect(Math.abs(pixel.y)).toBeLessThan(0.881);
            expect(pixel.z).toBeGreaterThan(-1);
            expect(pixel.z).toBeLessThan(1);
          }
        }
      }
  });
  it('fits common before/after bounds identically and ignores corrupt far-away contents', () => {
    const view = rotateRoomView(defaultRoomView(), 'right');
    const bounds = roomViewBounds(DEFAULT_ROOM).expandByScalar(250);
    const before = createRoomViewCamera(DEFAULT_ROOM, 1.5, view, bounds);
    const after = createRoomViewCamera(DEFAULT_ROOM, 1.5, view, bounds.clone());
    for (const point of points(bounds))
      expect(point.clone().project(before)).toEqual(point.clone().project(after));
    expect(points(bounds).every((point) => Math.abs(point.project(before).x) < 0.881)).toBe(true);
    const broken = new Box3(new Vector3(-1e12, 0, 0), new Vector3(1e12, 1e12, 1e12));
    expect(createRoomViewCamera(DEFAULT_ROOM, 1.5, view, broken).position).toEqual(
      createRoomViewCamera(DEFAULT_ROOM, 1.5, view).position,
    );
  });
  it('keeps orbit center fixed and pan/zoom produce consistent normalized projection', () => {
    const view = rotateRoomView(defaultRoomView(), 'up');
    const zoomed = { ...view, zoom: 2, pan: { x: 0.1, y: -0.2 } };
    const center = new Vector3(0, DEFAULT_ROOM.heightMm / 2, DEFAULT_ROOM.depthMm / 2);
    const projected = center.project(createRoomViewCamera(DEFAULT_ROOM, 1.5, zoomed));
    expect(projected.x).toBeCloseTo(0.2, 9);
    expect(projected.y).toBeCloseTo(0.4, 9);
    expect({ ...zoomed, zoom: 1, pan: { x: 0, y: 0 } }).toEqual(view);
  });
  it('normalizes quaternion signs and replaces unsafe historical state with a fresh default', () => {
    expect(normalizeRoomView({ ...defaultRoomView(), quaternion: [0, 0, 0, -2] })).toEqual(defaultRoomView());
    for (const invalid of [
      undefined,
      null,
      {},
      { ...defaultRoomView(), version: 2 },
      { ...defaultRoomView(), quaternion: [0, 0, 0, 0] },
      { ...defaultRoomView(), quaternion: [NaN, 0, 0, 1] },
      { ...defaultRoomView(), zoom: Infinity },
      { ...defaultRoomView(), zoom: 0 },
      { ...defaultRoomView(), pan: { x: 1e9, y: 0 } },
    ])
      expect(normalizeRoomView(invalid)).toEqual(defaultRoomView());
    const normal = defaultRoomView();
    normalizeRoomView(normal).pan.x = 1;
    expect(normal.pan.x).toBe(0);
  });
});

describe('room viewing state is not a scene edit', () => {
  beforeEach(() => useEditor.getState().load(project()));
  it('does not change either scene, revisions, prices, original references, selection or histories', () => {
    const state = useEditor.getState();
    state.change((scene) => {
      scene.color.warmth = 0.2;
    });
    state.undo();
    state.quoteChanged(createQuote(current(), {}));
    state.select(current().designs[0].scene.surfaces[0].id);
    state.setMode('split');
    const source = structuredClone(current()),
      selection = useEditor.getState().selection;
    const view = rotateRoomView(defaultRoomView(), 'right');
    state.setRoomView(view);
    expect(current()).toEqual({ ...source, roomView: view });
    expect(useEditor.getState().selection).toBe(selection);
    expect(useEditor.getState().mode).toBe('split');
    expect(useEditor.getState().saveStatus).toBe('dirty');
    expect(projectReferences(current())).toEqual(projectReferences(source));
  });
  it('retains a save failure and its retry action while preserving the newly selected view', () => {
    const state = useEditor.getState(),
      source = structuredClone(current()),
      view = rotateRoomView(defaultRoomView(), 'right');
    state.failed('서버 저장 실패');
    state.setRoomView(view);
    expect(current()).toEqual({ ...source, roomView: view });
    expect(useEditor.getState().saveStatus).toBe('error');
    expect(useEditor.getState().error).toBe('서버 저장 실패');
    state.saving();
    expect(useEditor.getState().saveStatus).toBe('saving');
    expect(useEditor.getState().error).toBe('');
    state.saved({ ...current(), storageRevision: source.storageRevision + 1 });
    expect(useEditor.getState().saveStatus).toBe('saved');
    expect(current().roomView).toEqual(view);
  });
  it('preserves shared view on design switch, design copy and independent project duplication', () => {
    const state = useEditor.getState(),
      view = rotateRoomView(defaultRoomView(), 'up');
    state.setRoomView(view);
    const first = current().activeDesignId!,
      copy = state.copyDesign()!;
    state.selectDesign(first);
    expect(current().roomView).toEqual(view);
    state.selectDesign(copy);
    const duplicate = duplicateProjectDocument(current());
    expect(duplicate.roomView).toEqual(view);
    duplicate.roomView!.pan.x = 0.1;
    expect(current().roomView).toEqual(view);
    expect(getActiveDesign(duplicate)?.scene.room).toEqual(DEFAULT_ROOM);
  });
  it('preserves view on resize and restores/replays the exact checkpoint view', () => {
    const state = useEditor.getState(),
      first = rotateRoomView(defaultRoomView(), 'left');
    state.setRoomView(first);
    const original = captureWorkspace(current());
    state.resizeAll(
      { ...DEFAULT_ROOM, widthMm: 3000 },
      {
        originalAssetId: crypto.randomUUID(),
        previewAssetId: crypto.randomUUID(),
        imageWidth: 1200,
        imageHeight: 800,
      },
    );
    expect(current().roomView).toEqual(first);
    const second = rotateRoomView(first, 'up');
    state.setRoomView(second);
    state.restoreRoomChange();
    expect(current().roomView).toEqual(first);
    expect(current().shared.baseline.room).toEqual(original.shared.baseline.room);
    state.redoRoomChange();
    expect(current().roomView).toEqual(second);
    expect(current().shared.baseline.room?.widthMm).toBe(3000);
  });
  it('restores an old checkpoint with no viewing field to the default rather than leaking current view', () => {
    const state = useEditor.getState();
    state.resizeAll(
      { ...DEFAULT_ROOM, widthMm: 3000 },
      {
        originalAssetId: crypto.randomUUID(),
        previewAssetId: crypto.randomUUID(),
        imageWidth: 1200,
        imageHeight: 800,
      },
    );
    state.setRoomView(rotateRoomView(defaultRoomView(), 'left'));
    state.restoreRoomChange();
    expect(current().roomView).toBeUndefined();
  });
  it('does not mark a late save complete if only the view changed during storage', () => {
    const state = useEditor.getState(),
      older = structuredClone(current());
    state.saving();
    const latest = rotateRoomView(defaultRoomView(), 'down');
    state.setRoomView(latest);
    state.saved({ ...older, storageRevision: 1 });
    expect(current().roomView).toEqual(latest);
    expect(current().storageRevision).toBe(1);
    expect(useEditor.getState().saveStatus).toBe('dirty');
    state.saved({ ...current(), storageRevision: 2 });
    expect(useEditor.getState().saveStatus).toBe('saved');
  });
  it('normalizes malformed values only in memory without changing stored source or marking dirty', () => {
    const source = project();
    source.roomView = { ...defaultRoomView(), zoom: NaN };
    source.roomHistory.past = captureWorkspace(source);
    const savedSource = structuredClone(source);
    useEditor.getState().load(source);
    expect(source).toEqual(savedSource);
    expect(current().roomView).toEqual(defaultRoomView());
    expect(current().roomHistory.past?.roomView).toEqual(defaultRoomView());
    expect(useEditor.getState().saveStatus).toBe('saved');
    const old = project();
    expect(normalizeProjectDocument(old)).toBe(old);
    expect(old.roomView).toBeUndefined();
  });
  it('server schemas accept view and checkpoints but reject nonfinite/nonunit/out-of-range fields', () => {
    const source = project();
    source.roomView = rotateRoomView(defaultRoomView(), 'right');
    source.roomHistory.past = captureWorkspace(source);
    expect(projectV3Schema.parse(source).roomView).toEqual(source.roomView);
    for (const invalid of [
      { ...source.roomView, quaternion: [0, 0, 0, 3] },
      { ...source.roomView, zoom: NaN },
      { ...source.roomView, zoom: 100 },
      { ...source.roomView, pan: { x: 9, y: 0 } },
    ])
      expect(roomViewSchema.safeParse(invalid).success).toBe(false);
  });
});

describe('real IndexedDB view-only writes', () => {
  async function setup() {
    const repo = createLegacyLocalRepositories('room-view-' + crypto.randomUUID()),
      source = project();
    const id = source.shared.baseline.originalAssetId;
    await repo.assets.put({
      id,
      ownerId: 'local',
      name: 'room.png',
      mime: 'image/png',
      kind: 'original',
      width: 1200,
      height: 800,
      size: 3,
      blob: new Blob(['png'], { type: 'image/png' }),
      createdAt: source.createdAt,
    });
    return { repo, source, saved: await repo.projects.create(source) };
  }
  it('saves and reopens camera, advances only storage revision and rejects competing stale save', async () => {
    const { repo, saved } = await setup();
    const first = structuredClone(saved),
      stale = structuredClone(saved);
    first.roomView = rotateRoomView(defaultRoomView(), 'right');
    const written = await repo.projects.save(first, saved.storageRevision);
    expect(written.editRevision).toBe(saved.editRevision);
    expect(written.storageRevision).toBe(saved.storageRevision + 1);
    expect((await repo.projects.load(saved.id))?.roomView).toEqual(first.roomView);
    stale.roomView = rotateRoomView(defaultRoomView(), 'left');
    await expect(repo.projects.save(stale, saved.storageRevision)).rejects.toBeInstanceOf(
      StorageConflictError,
    );
    expect((await repo.projects.load(saved.id))?.roomView).toEqual(first.roomView);
  });
  it('keeps saved version and current viewing state when storage fails', async () => {
    const { repo, saved } = await setup();
    useEditor.getState().load(saved);
    const view = rotateRoomView(defaultRoomView(), 'up');
    useEditor.getState().setRoomView(view);
    const put = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
      this: IDBObjectStore,
      ...args: Parameters<typeof put>
    ) {
      if (this.name === 'projects') throw new DOMException('disk full', 'QuotaExceededError');
      return put.apply(this, args);
    });
    await expect(repo.projects.save(current(), saved.storageRevision)).rejects.toMatchObject({
      name: 'QuotaExceededError',
    });
    useEditor.getState().failed('저장 공간 부족');
    expect(current().roomView).toEqual(view);
    expect(useEditor.getState().saveStatus).toBe('error');
    expect(await repo.projects.load(saved.id)).toEqual(saved);
  });
});

const photoCamera: SourceCamera = {
  version: 1,
  positionMm: [250, 1550, 3050],
  quaternion: [0, 0, 0, 1],
  verticalFovDegrees: 64,
  image: { width: 960, height: 1280 },
};
describe('explicit common photo camera', () => {
  it('matches the exact source projection on every room corner and preserves its original aspect', () => {
    for (const image of [
      { width: 960, height: 1280 },
      { width: 1400, height: 600 },
    ]) {
      const quaternion = new Quaternion()
        .setFromAxisAngle(new Vector3(1, 2, 3).normalize(), 0.17)
        .toArray() as SourceCamera['quaternion'];
      const source = { ...photoCamera, quaternion, image };
      const expected = createSourceCamera(source),
        view = sourceRoomView(source, DEFAULT_ROOM);
      for (const displayAspect of [0.4, 1.5, 4]) {
        const actual = createRoomViewCamera(DEFAULT_ROOM, displayAspect, view);
        expect(actual.position).toEqual(expected.position);
        actual.projectionMatrix.elements.forEach((value, i) =>
          expect(value).toBeCloseTo(expected.projectionMatrix.elements[i], 12),
        );
        for (const point of points(roomViewBounds(DEFAULT_ROOM))) {
          expect(point.clone().project(actual).distanceTo(point.clone().project(expected))).toBeLessThan(
            1e-12,
          );
        }
        expect(actual.aspect).toBe(image.width / image.height);
      }
    }
  });
  it('turns around the room center, four quarter turns return to source, and zoom does not move the camera', () => {
    const view = sourceRoomView(photoCamera, DEFAULT_ROOM),
      pivot = new Vector3(0, 1200, 1200);
    const base = createRoomViewCamera(DEFAULT_ROOM, 1.5, view);
    let rotated = view;
    for (let i = 0; i < 4; i++) {
      rotated = rotateRoomView(rotated, 'up');
      const camera = createRoomViewCamera(DEFAULT_ROOM, 1.5, rotated);
      expect(camera.position.distanceTo(pivot)).toBeCloseTo(base.position.distanceTo(pivot), 8);
      expect(camera.matrixWorld.elements.every(Number.isFinite)).toBe(true);
    }
    expect(rotated).toEqual(view);
    expect(createRoomViewCamera(DEFAULT_ROOM, 1.5, { ...view, zoom: 3 }).position).toEqual(base.position);
    expect(resetRoomView({ ...rotated, zoom: 3, pan: { x: 1, y: 2 } })).toEqual(view);
  });
  it('pans by the same photo fraction at all depths and preserves letterbox on narrow displays', () => {
    const view = sourceRoomView(photoCamera, DEFAULT_ROOM),
      normal = createRoomViewCamera(DEFAULT_ROOM, 1.5, view);
    const panned = createRoomViewCamera(DEFAULT_ROOM, 1.5, { ...view, pan: { x: 0.12, y: 0.08 } });
    for (const z of [0, 1000, 2000]) {
      const p = new Vector3(200, 1300, z),
        a = p.clone().project(normal),
        b = p.clone().project(panned);
      expect(b.x - a.x).toBeCloseTo(0.24, 10);
      expect(b.y - a.y).toBeCloseTo(-0.16, 10);
    }
    expect(roomViewViewport(1200, 800, view)).toEqual({ x: 300, y: 0, width: 600, height: 800 });
    expect(roomViewViewport(300, 800, view)).toEqual({ x: 0, y: 200, width: 300, height: 400 });
    expect(roomViewViewport(1200, 800, resetRoomView(view, 'room-fit'))).toEqual({
      x: 0,
      y: 0,
      width: 1200,
      height: 800,
    });
  });
  it('makes mode changes explicit while keeping old view shape and old fit camera identical', () => {
    const source = sourceRoomView(photoCamera, DEFAULT_ROOM),
      fitted = resetRoomView(source, 'room-fit');
    expect(fitted.sourceCamera).toEqual(source.sourceCamera);
    expect(createRoomViewCamera(DEFAULT_ROOM, 1.5, fitted).matrixWorld).toEqual(
      createRoomViewCamera(DEFAULT_ROOM, 1.5, defaultRoomView()).matrixWorld,
    );
    expect(normalizeRoomView(undefined)).toEqual({
      version: 1,
      quaternion: [0, 0, 0, 1],
      zoom: 1,
      pan: { x: 0, y: 0 },
    });
    expect(resetRoomView(fitted, 'source-photo')).toEqual(source);
    const original = structuredClone(source);
    normalizeRoomView(source).sourceCamera!.positionMm[0] = 900;
    expect(source).toEqual(original);
  });
  it('validates strict storage, rejects bad optics, and does not rewrite malformed read data', () => {
    const view = sourceRoomView(photoCamera, DEFAULT_ROOM),
      input = project();
    input.roomView = view;
    input.roomHistory.past = captureWorkspace(input);
    expect(projectV3Schema.parse(input).roomView).toEqual(view);
    for (const patch of [
      { quaternion: [0, 0, 0, 4] },
      { positionMm: [NaN, 0, 1] },
      { verticalFovDegrees: 0 },
      { image: { width: 0, height: 1280 } },
      { image: { width: 100000, height: 1 } },
      { source: 'recognized' },
      { referenceRoom: { widthMm: 1, depthMm: 2400, heightMm: 2400 } },
    ]) {
      const invalid = { ...view, sourceCamera: { ...view.sourceCamera, ...patch } };
      const original = structuredClone(invalid);
      expect(validRoomSourceCamera(invalid.sourceCamera)).toBe(false);
      expect(roomViewSchema.safeParse(invalid).success).toBe(false);
      expect(normalizeRoomView(invalid).sourceCamera).toBeUndefined();
      expect(invalid).toEqual(original);
    }
    expect(roomViewSchema.safeParse({ ...defaultRoomView(), projection: 'source-photo' }).success).toBe(
      false,
    );
    expect(
      roomViewSchema.safeParse({ ...view, sourceCamera: { ...view.sourceCamera, unknown: 1 } }).success,
    ).toBe(false);
  });
  it('keeps a photo view across scene undo/design copy and restores exact pose at the room-size boundary', () => {
    const input = project();
    input.roomView = { ...sourceRoomView(photoCamera, DEFAULT_ROOM), zoom: 1.2, pan: { x: 0.1, y: 0.2 } };
    useEditor.getState().load(input);
    const state = useEditor.getState(),
      view = structuredClone(current().roomView!);
    const initial = structuredClone(current());
    state.setRoomView(rotateRoomView(view, 'right'));
    expect(current()).toEqual({ ...initial, roomView: rotateRoomView(view, 'right') });
    state.change((scene) => {
      scene.color.warmth = 0.3;
    });
    state.undo();
    expect(current().roomView).toEqual(rotateRoomView(view, 'right'));
    state.setRoomView(view);
    state.copyDesign();
    const duplicate = duplicateProjectDocument(current());
    duplicate.roomView!.sourceCamera!.positionMm[0] = 99;
    expect(current().roomView).toEqual(view);
    state.resizeAll(
      { ...DEFAULT_ROOM, widthMm: 3000 },
      {
        originalAssetId: crypto.randomUUID(),
        previewAssetId: crypto.randomUUID(),
        imageWidth: 1200,
        imageHeight: 800,
      },
    );
    expect(current().roomView).toEqual(resetRoomView(view, 'room-fit'));
    expect(sourceRoomViewAvailable(current().shared.baseline.room!, current().roomView!)).toBe(false);
    expect(() => createRoomViewCamera(current().shared.baseline.room!, 1.5, view)).toThrow('이전 공간 크기');
    expect(() =>
      createRoomViewCamera(current().shared.baseline.room!, 1.5, current().roomView!),
    ).not.toThrow();
    state.restoreRoomChange();
    expect(current().roomView).toEqual(view);
    state.redoRoomChange();
    expect(current().roomView).toEqual(resetRoomView(view, 'room-fit'));
  });
});
