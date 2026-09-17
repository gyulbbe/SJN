import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import DesignManager from '../src/components/designs/design-manager';
import DesignComparison from '../src/components/designs/design-comparison';
import { useCachedDesignThumbnail, useDesignPreview } from '../src/components/designs/use-design-preview';
import { DEFAULT_COLOR, EMPTY_MASK, type DesignDocument } from '../src/lib/types';

// Synthetic hook/handler boundary tests. Rendering is mocked; no server, OAuth or browser cache is used.
const boundary = vi.hoisted(() => ({
  guest: true,
  adminScope: null as string | null,
  effects: [] as Array<() => void | (() => void)>,
  states: [] as unknown[],
  requestLogin: vi.fn(),
  acquire: vi.fn(),
  request: vi.fn(),
  readThumbnail: vi.fn(),
  deleteCache: vi.fn(),
}));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: (value: unknown) => [
    boundary.states.length ? boundary.states.shift() : typeof value === 'function' ? value() : value,
    vi.fn(),
  ],
  useRef: (value: unknown) => ({ current: value }),
  useEffect: (callback: () => void | (() => void)) => boundary.effects.push(callback),
  useMemo: (callback: () => unknown) => callback(),
  useId: () => 'preview-channel',
}));
vi.mock('../src/components/repository-context', () => ({
  useAdminProjectScope: () => boundary.adminScope,
}));
vi.mock('../src/components/editor/editing-capabilities', () => ({
  useEditingCapabilities: () => ({
    guest: boundary.guest,
    writable: true,
    requestLogin: boundary.requestLogin,
  }),
  LoginRequiredIcon: () => null,
}));
vi.mock('../src/lib/render/design-preview', async (original) => ({
  ...(await original<typeof import('../src/lib/render/design-preview')>()),
  acquireDesignPreviewSession: boundary.acquire,
}));
vi.mock('../src/lib/render/design-preview-cache', async (original) => ({
  ...(await original<typeof import('../src/lib/render/design-preview-cache')>()),
  getCachedDesignThumbnail: boundary.readThumbnail,
  deleteDesignPreviewCache: boundary.deleteCache,
}));
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
function design(id = 'a'): DesignDocument {
  return {
    id,
    name: '시안 ' + id,
    revision: 1,
    history: { past: [], future: [] },
    createdAt: '2026-09-18T00:00:00.000Z',
    updatedAt: '2026-09-18T00:00:00.000Z',
    scene: {
      originalAssetId: 'original',
      previewAssetId: 'preview',
      imageWidth: 1200,
      imageHeight: 800,
      surfaces: [],
      fixtures: [],
      protection: EMPTY_MASK(),
      color: { ...DEFAULT_COLOR },
    },
  };
}
const common = () => ({ projectId: 'project', sharedRevision: 1, materials: {}, assetReader: vi.fn() });
beforeEach(() => {
  vi.clearAllMocks();
  boundary.guest = true;
  boundary.adminScope = null;
  boundary.effects = [];
  boundary.states = [];
  boundary.request.mockResolvedValue({ blob: new Blob(['preview']), width: 360, height: 240 });
  boundary.acquire.mockReturnValue({
    service: { request: boundary.request, cancel: vi.fn() },
    release: vi.fn(),
  });
  boundary.deleteCache.mockResolvedValue(undefined);
});
afterEach(() => vi.useRealTimers());

describe('guest design preview and download boundaries', () => {
  it.each([
    { guest: true, admin: null, session: 'transient:project', transient: true },
    { guest: false, admin: 'admin:owner:', session: 'admin:owner:project', transient: true },
    { guest: false, admin: null, session: 'project', transient: undefined },
  ])(
    'separates preview sessions and persistent-cache policy: $session',
    async ({ guest, admin, session, transient }) => {
      vi.useFakeTimers();
      boundary.guest = guest;
      boundary.adminScope = admin;
      const input = { ...common(), design: design(), purpose: 'thumbnail' as const, edge: 360 };
      useDesignPreview(input);
      const cleanup = boundary.effects.map((run) => run());
      await vi.runAllTimersAsync();
      expect(boundary.acquire).toHaveBeenCalledWith(session, input.assetReader);
      expect(boundary.request).toHaveBeenCalledWith(
        'preview-channel',
        expect.objectContaining({ transient }),
      );
      cleanup.forEach((run) => run?.());
    },
  );

  it.each([
    { guest: true, admin: null },
    { guest: false, admin: 'admin:owner:' },
  ])('never opens the persistent thumbnail cache in a transient editor', ({ guest, admin }) => {
    boundary.guest = guest;
    boundary.adminScope = admin;
    expect(
      useCachedDesignThumbnail({ projectId: 'project', designId: 'a', revision: 1, sharedRevision: 1 }),
    ).toBeUndefined();
    boundary.effects.forEach((run) => run());
    expect(boundary.readThumbnail).not.toHaveBeenCalled();
  });

  it.each([
    { guest: true, admin: null, expectedDeletes: 0 },
    { guest: false, admin: 'admin:owner:', expectedDeletes: 0 },
    { guest: false, admin: null, expectedDeletes: 1 },
  ])(
    'deletes a design without touching persistent cache for transient scopes',
    async ({ guest, admin, expectedDeletes }) => {
      boundary.guest = guest;
      boundary.adminScope = admin;
      const target = design();
      boundary.states = [null, '', target, false, ''];
      const onDelete = vi.fn(async () => {});
      const tree = DesignManager({
        ...common(),
        designs: [target],
        activeDesignId: target.id,
        comparisonDesignIds: [],
        writable: true,
        onCreate: vi.fn(),
        onDuplicate: vi.fn(),
        onRename: vi.fn(),
        onDelete,
        onActivate: vi.fn(),
        onToggleComparison: vi.fn(),
        onCompare: vi.fn(),
        onClose: vi.fn(),
      });
      const button = elements(tree).find(
        (node) => node.type === 'button' && text(node.props.children as ReactNode) === '시안 삭제',
      );
      expect(button).toBeDefined();
      (button!.props.onClick as () => void)();
      await vi.waitFor(() => expect(onDelete).toHaveBeenCalledWith(target.id));
      expect(boundary.deleteCache).toHaveBeenCalledTimes(expectedDeletes);
    },
  );

  it('asks for login before either comparison or individual PNG export acquires a renderer', () => {
    const tree = DesignComparison({
      ...common(),
      designs: [design(), design('b')],
      writable: true,
      onEdit: vi.fn(),
      onExclude: vi.fn(),
      onClose: vi.fn(),
    });
    const button = elements(tree).find(
      (node) => node.type === 'button' && text(node.props.children as ReactNode).includes('비교 PNG'),
    );
    expect(button?.props.title).toBe('로그인 후 이미지 출력');
    (button!.props.onClick as () => void)();
    const cards = elements(tree).filter((node) => typeof node.props.onDownload === 'function');
    expect(cards).toHaveLength(2);
    (cards[0].props.onDownload as () => void)();
    expect(boundary.requestLogin).toHaveBeenCalledTimes(2);
    expect(boundary.requestLogin).toHaveBeenCalledWith('이미지 출력');
    expect(boundary.acquire).not.toHaveBeenCalled();
  });
});
