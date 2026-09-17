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

  it('allows product rotation, deletion, undo and redo while requiring login for duplication', () => {
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
    const before = structuredClone(useEditor.getState().project);
    click(tree, '복제');
    expect(boundary.requestLogin).toHaveBeenCalledWith('제품 복제');
    expect(useEditor.getState().project).toEqual(before);
    const rotate = elements(tree).find(
      (node) => node.type === Range && node.props.label === '이미지 평면 회전',
    )!;
    (rotate.props.onChange as (value: number) => void)(45);
    (rotate.props.onCommit as () => void)();
    expect(getActiveDesign(useEditor.getState().project!)!.scene.fixtures[0].rotation).toBe(45);
    tree = Inspector(props);
    click(tree, '제품 삭제');
    expect(getActiveDesign(useEditor.getState().project!)!.scene.fixtures).toHaveLength(0);
    useEditor.getState().undo();
    expect(getActiveDesign(useEditor.getState().project!)!.scene.fixtures).toHaveLength(1);
    useEditor.getState().redo();
    expect(getActiveDesign(useEditor.getState().project!)!.scene.fixtures).toHaveLength(0);
  });

  it('keeps advanced product controls behind login while allowing an existing guest lock to be released', () => {
    const props = {
      materials: {},
      open: true,
      onClose: vi.fn(),
      onRoomResize: vi.fn(),
      onMaterialsChanged: vi.fn(async () => {}),
    };
    let tree = Inspector(props);
    const rangeLabels = elements(tree)
      .filter((node) => node.type === Range)
      .map((node) => node.props.label);
    expect(rangeLabels).toContain('이미지 평면 회전');
    expect(rangeLabels).not.toContain('노출');
    expect(rangeLabels).not.toContain('그림자 진하기');
    expect(
      elements(tree).some(
        (node) =>
          node.type === 'button' &&
          ['앞으로', '뒤로', '색감 기본값'].includes(text(node.props.children as ReactNode).trim()),
      ),
    ).toBe(false);
    const before = structuredClone(useEditor.getState().project);
    for (const [label, feature] of [
      ['접지 그림자 설정', '접지 그림자'],
      ['겹침 순서 변경', '겹침 순서'],
      ['밝기와 색감 조절', '밝기와 색감'],
      ['배치 잠금', '배치 잠금'],
    ]) {
      expect(button(tree, label).props.title).toBe('로그인 필요');
      click(tree, label);
      expect(boundary.requestLogin).toHaveBeenLastCalledWith(feature);
    }
    expect(useEditor.getState().project).toEqual(before);
    useEditor.getState().change((scene) => {
      scene.fixtures[0].locked = true;
    });
    boundary.requestLogin.mockClear();
    tree = Inspector(props);
    click(tree, '잠금 해제');
    expect(getActiveDesign(useEditor.getState().project!)!.scene.fixtures[0].locked).toBe(false);
    expect(boundary.requestLogin).not.toHaveBeenCalled();
    boundary.capability = { writable: true, guest: false, requestLogin: boundary.requestLogin };
    const memberTree = Inspector(props);
    const memberRanges = elements(memberTree)
      .filter((node) => node.type === Range)
      .map((node) => node.props.label);
    expect(memberRanges).toContain('노출');
    expect(memberRanges).toContain('그림자 진하기');
    expect(button(memberTree, '앞으로')).toBeDefined();
  });

  it('requires login for tile layout details but allows applied tiles to be removed', () => {
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
    const before = structuredClone(useEditor.getState().project);
    const tree = Inspector(props);
    expect(
      elements(tree).some((node) => ['타일 배열', '줄눈 색상'].includes(String(node.props['aria-label']))),
    ).toBe(false);
    expect(elements(tree).filter((node) => node.type === Range)).toHaveLength(0);
    click(tree, '타일 시공 세부 설정');
    expect(boundary.requestLogin).toHaveBeenCalledWith('타일 시공 세부 설정');
    expect(useEditor.getState().project).toEqual(before);
    click(tree, '이 면의 타일 초기화');
    expect(
      getActiveDesign(useEditor.getState().project!)!.scene.surfaces[0].materialVersionId,
    ).toBeUndefined();
    boundary.capability = { writable: true, guest: false, requestLogin: boundary.requestLogin };
    const memberTree = Inspector(props);
    expect(elements(memberTree).some((node) => node.props['aria-label'] === '타일 배열')).toBe(true);
    expect(
      elements(memberTree).some((node) => node.type === Range && node.props.label === '원본 명암 보존'),
    ).toBe(true);
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
