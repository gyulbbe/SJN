import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import Editor from '../src/components/editor/editor';
import Inspector, { Range } from '../src/components/editor/inspector';
import RoomViewer from '../src/components/rooms/room-viewer';
import { useEditingCapabilities } from '../src/components/editor/editing-capabilities';
import { useEditor } from '../src/lib/editor-store';
import { normalizeProjectDocument, getActiveDesign } from '../src/lib/comparison';
import { createRoomSurfaces, DEFAULT_ROOM } from '../src/lib/room-geometry';
import { DEFAULT_COLOR, EMPTY_MASK, type FixtureInstance } from '../src/lib/types';

// Synthetic handler tests: no browser persistence, network, D1, R2 or renderer is started.
const boundary = vi.hoisted(() => ({
  account: { writable: false, ready: false, mode: 'd1', userId: undefined },
  capability: null as null | { writable: boolean; guest: boolean; requestLogin: (feature: string) => void },
  repo: { mode: 'guest', assets: { get: vi.fn() } },
  requestLogin: vi.fn(),
  onClose: vi.fn(),
}));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: (value: unknown) => [typeof value === 'function' ? value() : value, vi.fn()],
  useRef: (value: unknown) => ({ current: value }),
  useEffect: vi.fn(),
  useMemo: (fn: () => unknown) => fn(),
  useCallback: (fn: unknown) => fn,
  useContext: () => boundary.capability,
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('../src/components/app-provider', () => ({ useAccess: () => boundary.account }));
vi.mock('../src/components/repository-context', () => ({
  useRepositories: () => boundary.repo,
  useAdminProjectScope: () => null,
}));
vi.mock('../src/lib/editor-store', async (original) => {
  const originalStore = await original<typeof import('../src/lib/editor-store')>();
  return { useEditor: Object.assign(() => originalStore.useEditor.getState(), originalStore.useEditor) };
});
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}
function text(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (Array.isArray(node)) return node.map(text).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return text(node.props.children);
  return String(node);
}
function button(tree: ReactNode, label: string) {
  const result = elements(tree).find(
    (node) => node.type === 'button' && text(node.props.children as ReactNode).trim() === label,
  );
  expect(result, label).toBeDefined();
  return result!;
}
function click(tree: ReactNode, label: string) {
  (button(tree, label).props.onClick as () => void)();
}
function fixture(): FixtureInstance {
  return {
    id: crypto.randomUUID(),
    name: '체험 제품',
    materialVersionId: crypto.randomUUID(),
    viewIndex: 0,
    position: { x: 0.5, y: 0.5 },
    width: 0.2,
    height: 0.3,
    rotation: 0,
    anchor: { x: 0.5, y: 1 },
    locked: false,
    shadow: { x: 0, y: 0, opacity: 0.3, blur: 0.015, scale: 0.7 },
    occlusion: EMPTY_MASK(),
    color: { ...DEFAULT_COLOR },
  };
}
function seed() {
  const product = fixture();
  const project = normalizeProjectDocument({
    id: crypto.randomUUID(),
    ownerId: 'guest',
    name: '체험',
    schemaVersion: 2,
    editRevision: 0,
    storageRevision: 0,
    createdAt: '2026-09-17T00:00:00.000Z',
    updatedAt: '2026-09-17T00:00:00.000Z',
    viewport: { zoom: 1, pan: { x: 0, y: 0 } },
    history: { past: [], future: [] },
    scene: {
      originalAssetId: crypto.randomUUID(),
      previewAssetId: crypto.randomUUID(),
      imageWidth: 1200,
      imageHeight: 800,
      room: { ...DEFAULT_ROOM },
      surfaces: createRoomSurfaces(DEFAULT_ROOM),
      fixtures: [product],
      protection: EMPTY_MASK(),
      color: { ...DEFAULT_COLOR },
    },
  });
  project.comparisonDesignIds = [];
  useEditor.getState().load(project);
  useEditor.getState().select(product.id);
  return project;
}
beforeEach(() => {
  vi.clearAllMocks();
  boundary.account.writable = false;
  boundary.repo.mode = 'guest';
  boundary.capability = { writable: true, guest: true, requestLogin: boundary.requestLogin };
  seed();
});

describe('guest editor capability boundaries', () => {
  it('enables basic guest editing only with both the guest repository and explicit editor context', () => {
    const guestContext = { requestLogin: boundary.requestLogin };
    const guest = Editor({ id: 'guest', guestContext });
    expect(guest.props.value).toMatchObject({ writable: true, guest: true });
    expect(boundary.account).toMatchObject({ writable: false, ready: false });
    boundary.repo.mode = 'd1';
    expect(Editor({ id: 'member', guestContext }).props.value).toMatchObject({
      writable: false,
      guest: false,
    });
    boundary.repo.mode = 'guest';
    expect(Editor({ id: 'guest' }).props.value).toMatchObject({ writable: false, guest: false });
    expect(
      Editor({
        id: 'admin',
        guestContext,
        adminContext: {
          actorUserId: 'admin',
          owner: { id: 'owner', name: '회원', email: 'owner@example.test' },
        },
      }).props.value,
    ).toMatchObject({ writable: false, guest: false });
  });

  it('keeps member and administrator controls governed by account access outside a guest editor', () => {
    boundary.capability = null;
    expect(useEditingCapabilities()).toMatchObject({ writable: false, guest: false });
    boundary.account.writable = true;
    expect(useEditingCapabilities()).toMatchObject({ writable: true, guest: false });
    expect(boundary.account.ready).toBe(false);
  });

  it('allows guest product duplication, rotation, deletion, undo and redo', () => {
    const props = {
      materials: {},
      open: true,
      onClose: vi.fn(),
      onRoomResize: vi.fn(),
      onMaterialsChanged: vi.fn(async () => {}),
    };
    let tree = Inspector(props);
    expect(elements(tree).find((node) => node.type === 'fieldset')?.props.disabled).toBe(false);
    click(tree, '공간 크기 변경');
    expect(props.onRoomResize).toHaveBeenCalledOnce();
    click(tree, '복제');
    const duplicated = getActiveDesign(useEditor.getState().project!)!.scene.fixtures;
    expect(duplicated).toHaveLength(2);
    expect(duplicated[1].id).not.toBe(duplicated[0].id);
    expect(duplicated[1].materialVersionId).toBe(duplicated[0].materialVersionId);
    const rotate = elements(tree).find(
      (node) => node.type === Range && node.props.label === '이미지 평면 회전',
    )!;
    (rotate.props.onChange as (value: number) => void)(45);
    (rotate.props.onCommit as () => void)();
    expect(getActiveDesign(useEditor.getState().project!)!.scene.fixtures[0].rotation).toBe(45);
    tree = Inspector(props);
    click(tree, '제품 삭제');
    expect(getActiveDesign(useEditor.getState().project!)!.scene.fixtures).toHaveLength(1);
    useEditor.getState().undo();
    expect(getActiveDesign(useEditor.getState().project!)!.scene.fixtures).toHaveLength(2);
    useEditor.getState().redo();
    expect(getActiveDesign(useEditor.getState().project!)!.scene.fixtures).toHaveLength(1);
    expect(boundary.requestLogin).not.toHaveBeenCalled();
  });

  it('allows guest color, shadow, order and lock controls without changing account access', () => {
    const props = {
      materials: {},
      open: true,
      onClose: vi.fn(),
      onRoomResize: vi.fn(),
      onMaterialsChanged: vi.fn(async () => {}),
    };
    let tree = Inspector(props);
    const setRange = (label: string, value: number) => {
      const range = elements(Inspector(props)).find(
        (node) => node.type === Range && node.props.label === label,
      )!;
      expect(range, label).toBeDefined();
      (range.props.onChange as (n: number) => void)(value);
      (range.props.onCommit as () => void)();
    };
    setRange('노출', 0.3);
    setRange('그림자 진하기', 0.6);
    expect(getActiveDesign(useEditor.getState().project!)!.scene.color.exposure).toBe(0.3);
    expect(getActiveDesign(useEditor.getState().project!)!.scene.fixtures[0].shadow.opacity).toBe(0.6);
    click(tree, '복제');
    const selected = getActiveDesign(useEditor.getState().project!)!.scene.fixtures[0].id;
    tree = Inspector(props);
    click(tree, '앞으로');
    expect(getActiveDesign(useEditor.getState().project!)!.scene.fixtures[1].id).toBe(selected);
    tree = Inspector(props);
    click(tree, '배치 잠금');
    tree = Inspector(props);
    expect(button(tree, '제품 삭제').props.disabled).toBe(true);
    expect(getActiveDesign(useEditor.getState().project!)!.scene.fixtures[1].locked).toBe(true);
    click(tree, '잠금 해제');
    expect(getActiveDesign(useEditor.getState().project!)!.scene.fixtures[1].locked).toBe(false);
    expect(boundary.requestLogin).not.toHaveBeenCalled();
    expect(boundary.account.writable).toBe(false);
  });

  it('allows tile pattern, grout and shading controls and removing the applied guest tile', () => {
    const props = {
      materials: {},
      open: true,
      onClose: vi.fn(),
      onRoomResize: vi.fn(),
      onMaterialsChanged: vi.fn(async () => {}),
    };
    const versionId = crypto.randomUUID();
    useEditor.getState().change((scene) => {
      scene.surfaces[0].materialVersionId = versionId;
    });
    useEditor.getState().select(getActiveDesign(useEditor.getState().project!)!.scene.surfaces[0].id);
    const tree = Inspector(props);
    const pattern = elements(tree).find((node) => node.props['aria-label'] === '타일 배열')!;
    expect(pattern).toBeDefined();
    (pattern.props.onChange as (event: { target: { value: string } }) => void)({
      target: { value: 'brick' },
    });
    const grout = elements(Inspector(props)).find((node) => node.props['aria-label'] === '줄눈 색상')!;
    (grout.props.onChange as (event: { target: { value: string } }) => void)({
      target: { value: '#ccddee' },
    });
    const shading = elements(Inspector(props)).find(
      (node) => node.type === Range && node.props.label === '원본 명암 보존',
    )!;
    (shading.props.onChange as (value: number) => void)(0.2);
    (shading.props.onCommit as () => void)();
    expect(getActiveDesign(useEditor.getState().project!)!.scene.surfaces[0].tile).toMatchObject({
      pattern: 'brick',
      groutColor: '#ccddee',
      shading: 0.2,
    });
    click(Inspector(props), '이 면의 타일 초기화');
    expect(
      getActiveDesign(useEditor.getState().project!)!.scene.surfaces[0].materialVersionId,
    ).toBeUndefined();
    expect(boundary.requestLogin).not.toHaveBeenCalled();
  });

  it('opens guest room viewing in After and intercepts all comparison modes and its own download', () => {
    const onView = vi.fn();
    const tree = RoomViewer({
      project: useEditor.getState().project!,
      materials: {},
      assetReader: vi.fn(),
      writable: true,
      onView,
      saveStatus: 'saved',
      saveError: '',
      onSave: vi.fn(),
      onDesign: vi.fn(),
      onClose: boundary.onClose,
    });
    expect(button(tree, 'After').props['aria-pressed']).toBe(true);
    expect(button(tree, '겹쳐 비교').props['aria-pressed']).toBe(false);
    expect(
      elements(tree).some((node) => node.props['aria-label'] === '둘러보기 Before After 비교 위치'),
    ).toBe(false);
    for (const label of ['Before', '겹쳐 비교', '나란히 비교']) click(tree, label);
    expect(boundary.requestLogin).toHaveBeenCalledTimes(3);
    click(tree, '현재 시점 다운로드');
    expect(boundary.requestLogin).toHaveBeenLastCalledWith('이미지 출력');
    expect(boundary.onClose).toHaveBeenCalledTimes(4);
    click(tree, '오른쪽 90°');
    expect(onView).toHaveBeenCalledOnce();
  });

  it('preserves the existing member room-view comparison default', () => {
    boundary.capability = null;
    const tree = RoomViewer({
      project: useEditor.getState().project!,
      materials: {},
      assetReader: vi.fn(),
      writable: false,
      onView: vi.fn(),
      saveStatus: 'saved',
      saveError: '',
      onSave: vi.fn(),
      onDesign: vi.fn(),
      onClose: boundary.onClose,
    });
    expect(button(tree, '겹쳐 비교').props['aria-pressed']).toBe(true);
    expect(
      elements(tree).some((node) => node.props['aria-label'] === '둘러보기 Before After 비교 위치'),
    ).toBe(true);
  });
});
