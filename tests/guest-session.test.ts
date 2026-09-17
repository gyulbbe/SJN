import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createGuestSessionManager,
  GUEST_DRAFT_KEY,
  type GuestSessionDependencies,
} from '../src/lib/guest/session';
import { placementToMaterialVersion, type PublicPlacement } from '../src/lib/catalog/placement-contract';
import { DEFAULT_ROOM } from '../src/lib/room-geometry';
import { useEditor } from '../src/lib/editor-store';
import { getActiveDesign, projectScenes } from '../src/lib/comparison';
import { StorageNotFoundError } from '../src/lib/repositories/references';
import type { Repositories } from '../src/lib/repositories/contracts';
import type { AssetRecord, ImageAssetRecord, ProjectDocument } from '../src/lib/types';

class TabStorage {
  values = new Map<string, string>();
  blocked = false;
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    if (this.blocked) throw new Error('QuotaExceededError');
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}
function fixturePlacement(): PublicPlacement {
  const imageId = crypto.randomUUID();
  return {
    materialId: crypto.randomUUID(),
    versionId: crypto.randomUUID(),
    version: 1,
    name: '공용 바닥 타일',
    brand: '공간',
    code: 'A-1',
    category: 'tile',
    description: '',
    color: '흰색',
    finish: '무광',
    widthMm: 600,
    heightMm: 600,
    depthMm: 10,
    usage: 'both',
    installation: 'floor',
    textureAssetIds: [imageId],
    views: [],
    defaultGroutWidth: 2,
    defaultGroutColor: '#eeeeee',
    defaultPattern: 'grid',
    images: [
      {
        id: imageId,
        url: '/api/catalog/images?id=' + imageId,
        width: 64,
        height: 64,
        mime: 'image/png',
        size: 8,
        kind: 'texture',
      },
    ],
  };
}
function setup() {
  const storage = new TabStorage();
  const placement = fixturePlacement();
  const auth = { userId: 'member-a' };
  const render = vi.fn(async (_room, size) => ({
    ...size,
    blob: new Blob(['generated-room'], { type: 'image/png' }),
  }));
  const request = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url === '/api/catalog/placement') return Response.json({ placements: [placement] });
    if (url.startsWith('/api/catalog/images?id='))
      return new Response(new Blob(['texture'], { type: 'image/png' }));
    throw new Error('Unexpected request: ' + url);
  });
  const deps: GuestSessionDependencies = {
    storage: () => storage,
    render,
    fetch: request as typeof fetch,
    currentUserId: () => auth.userId,
  };
  return { storage, placement, auth, render, request, deps, engine: createGuestSessionManager(deps) };
}
function memberRepositories() {
  const documents = new Map<string, ProjectDocument>();
  const assets = new Map<string, AssetRecord>();
  const forbidden = vi.fn(async (): Promise<never> => {
    throw new Error('Unexpected mutation');
  });
  const repo: Repositories = {
    mode: 'd1',
    projects: {
      list: forbidden,
      save: forbidden,
      duplicate: forbidden,
      remove: forbidden,
      load: vi.fn(async (id) => {
        const document = documents.get(id);
        if (!document) throw new StorageNotFoundError();
        return structuredClone(document);
      }),
      create: vi.fn(async (document) => {
        const saved = {
          ...structuredClone(document),
          ownerId: 'member-a',
          storageRevision: 1,
          updatedAt: new Date().toISOString(),
        } as ProjectDocument;
        documents.set(saved.id, saved);
        return saved;
      }),
    },
    assets: {
      get: vi.fn(async (id) => {
        const asset = assets.get(id);
        if (!asset) throw new StorageNotFoundError();
        return structuredClone(asset);
      }),
      put: vi.fn(async (asset) => {
        assets.set(asset.id, { ...structuredClone(asset), ownerId: 'member-a' });
      }),
      removeUnused: forbidden,
    },
    materials: {
      createProjectResource: forbidden,
      list: forbidden,
      create: forbidden,
      update: forbidden,
      setActive: forbidden,
      getVersion: forbidden,
    },
  };
  return { repo, documents, assets };
}
async function applyTile(s: ReturnType<typeof setup>) {
  const session = await s.engine.openGuestSession();
  const list = await session!.repositories.materials.list();
  useEditor.getState().load(session!.draft.document);
  useEditor.getState().change((scene) => {
    scene.surfaces[0].materialVersionId = list[0].version.id;
  });
  const document = useEditor.getState().project!;
  await s.engine.checkpointGuestDraft(document);
  return document;
}
beforeEach(() => {
  useEditor.setState({ project: null, draft: null, selection: null });
});

describe('게스트의 탭 세션', () => {
  it('방 생성에는 API/IndexedDB를 쓰지 않고 새로고침 뒤 같은 배치와 배경 ID를 복원한다', async () => {
    const s = setup();
    const draft = await s.engine.createGuestDraft(DEFAULT_ROOM);
    expect(s.request).not.toHaveBeenCalled();
    const document = await applyTile(s);
    const reopened = createGuestSessionManager(s.deps);
    const session = await reopened.openGuestSession();
    expect(session!.draft.document).toEqual(document);
    expect(session!.repositories.mode).toBe('guest');
    const originalId = draft.document.shared.baseline.originalAssetId;
    const asset = await session!.repositories.assets.get(originalId);
    expect(asset.id).toBe(originalId);
    expect(asset.blob).toBeInstanceOf(Blob);
    const serialized = s.storage.getItem(GUEST_DRAFT_KEY)!;
    expect(serialized).not.toContain('generated-room');
    expect(serialized).not.toContain('base64');
    expect(s.storage.values.size).toBe(1);
    expect(
      await createGuestSessionManager({ ...s.deps, storage: () => new TabStorage() }).openGuestSession(),
    ).toBeNull();
  });

  it('저장소 용량 오류·잘못된 문서·새 공간 생성 실패에도 이전 초안을 덮어쓰지 않는다', async () => {
    const s = setup();
    const draft = await s.engine.createGuestDraft(DEFAULT_ROOM);
    const raw = s.storage.getItem(GUEST_DRAFT_KEY);
    s.storage.blocked = true;
    await expect(s.engine.checkpointGuestDraft({ ...draft.document, name: '변경된 이름' })).rejects.toThrow(
      '보관하지 못했어요',
    );
    expect(s.storage.getItem(GUEST_DRAFT_KEY)).toBe(raw);
    s.storage.blocked = false;
    await expect(s.engine.checkpointGuestDraft({ ...draft.document, ownerId: 'member-a' })).rejects.toThrow(
      '다른 계정',
    );
    s.render.mockRejectedValueOnce(new Error('WebGL failed'));
    await expect(s.engine.createGuestDraft(DEFAULT_ROOM, { replace: true })).rejects.toThrow('WebGL failed');
    expect(s.storage.getItem(GUEST_DRAFT_KEY)).toBe(raw);
    await s.engine.createGuestDraft({ ...DEFAULT_ROOM, widthMm: 3500 }, { replace: true });
    expect(s.engine.readGuestDraft()!.document.id).not.toBe(draft.document.id);
  });

  it('새 공간 렌더 중 교체를 취소하면 이전 초안을 그대로 보존하고 미리 취소한 생성은 렌더하지 않는다', async () => {
    const s = setup();
    const original = await s.engine.createGuestDraft(DEFAULT_ROOM);
    const raw = s.storage.getItem(GUEST_DRAFT_KEY);
    let finishRender!: () => void;
    const gate = new Promise<void>((resolve) => {
      finishRender = resolve;
    });
    s.render.mockImplementationOnce(async (_room, size) => {
      await gate;
      return { ...size, blob: new Blob(['replacement'], { type: 'image/png' }) };
    });
    const controller = new AbortController();
    const replacement = s.engine.createGuestDraft(
      { ...DEFAULT_ROOM, widthMm: 3600 },
      {
        replace: true,
        signal: controller.signal,
      },
    );
    controller.abort();
    finishRender();
    await expect(replacement).rejects.toMatchObject({ name: 'AbortError' });
    expect(s.storage.getItem(GUEST_DRAFT_KEY)).toBe(raw);
    expect(s.engine.readGuestDraft()!.document.id).toBe(original.document.id);
    const renderCount = s.render.mock.calls.length;
    await expect(
      s.engine.createGuestDraft(DEFAULT_ROOM, { replace: true, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(s.render).toHaveBeenCalledTimes(renderCount);
    expect(s.storage.getItem(GUEST_DRAFT_KEY)).toBe(raw);
  });

  it('손상된 세션 원문을 보존하고 출처가 다른 자산 recipe의 복원을 거절한다', async () => {
    const s = setup();
    const draft = await s.engine.createGuestDraft(DEFAULT_ROOM);
    const id = draft.document.shared.baseline.originalAssetId;
    delete draft.roomAssets[id];
    const corrupt = JSON.stringify(draft);
    s.storage.setItem(GUEST_DRAFT_KEY, corrupt);
    expect(() => s.engine.readGuestDraft()).toThrow('삭제하지 않았어요');
    expect(s.storage.getItem(GUEST_DRAFT_KEY)).toBe(corrupt);
  });

  it('공간 크기 변경의 이전 배경과 실행 취소 자재를 세션에서 유지한다', async () => {
    const s = setup();
    const draft = await s.engine.createGuestDraft(DEFAULT_ROOM);
    await applyTile(s);
    const originalId = crypto.randomUUID(),
      previewId = crypto.randomUUID();
    const session = await s.engine.openGuestSession();
    const base: ImageAssetRecord = {
      id: originalId,
      ownerId: 'local',
      name: '기본 공간.png',
      mime: 'image/png',
      size: 4,
      kind: 'original',
      createdAt: new Date().toISOString(),
      width: 1024,
      height: 683,
      blob: new Blob(['room'], { type: 'image/png' }),
    };
    await session!.repositories.assets.put(base);
    await session!.repositories.assets.put({
      ...base,
      id: previewId,
      kind: 'preview',
      sourceAssetId: originalId,
      derivation: 'upload-preview',
    });
    useEditor
      .getState()
      .resizeAll(
        { ...DEFAULT_ROOM, widthMm: 3200 },
        { originalAssetId: originalId, previewAssetId: previewId, imageWidth: 1024, imageHeight: 683 },
      );
    await s.engine.checkpointGuestDraft(useEditor.getState().project!);
    const resumed = createGuestSessionManager(s.deps);
    const after = resumed.readGuestDraft()!;
    expect(after.roomAssets[draft.document.shared.baseline.originalAssetId]).toBeDefined();
    expect(after.roomAssets[originalId].room.widthMm).toBe(3200);
    expect(after.versions[s.placement.versionId]).toBeDefined();
    useEditor.getState().load(after.document);
    useEditor.getState().restoreRoomChange();
    await resumed.checkpointGuestDraft(useEditor.getState().project!);
    expect(resumed.readGuestDraft()!.document.shared.baseline.room?.widthMm).toBe(DEFAULT_ROOM.widthMm);
    expect(
      projectScenes(resumed.readGuestDraft()!.document).some((scene) => scene.originalAssetId === originalId),
    ).toBe(true);
  });

  it('카탈로그 실패나 비활성화에도 초안을 열고 제한 기능은 API 호출 없이 거절한다', async () => {
    const s = setup();
    await s.engine.createGuestDraft(DEFAULT_ROOM);
    await applyTile(s);
    s.request.mockRejectedValueOnce(new Error('offline'));
    const session = await s.engine.openGuestSession();
    expect(session!.warnings[0]).toContain('불러오지 못했어요');
    expect(await session!.repositories.materials.list()).toEqual([]);
    expect((await session!.repositories.materials.getVersion(s.placement.versionId)).id).toBe(
      s.placement.versionId,
    );
    const requestCount = s.request.mock.calls.length;
    await expect(session!.repositories.projects.duplicate('any')).rejects.toThrow('로그인');
    await expect(session!.repositories.assets.removeUnused()).rejects.toThrow('로그인');
    expect(s.request.mock.calls.length).toBe(requestCount);
    s.request.mockResolvedValueOnce(Response.json({ placements: [] }));
    expect((await s.engine.openGuestSession())!.warnings[0]).toContain('변경되거나 내려간');
  });
});

describe('체험을 본인 프로젝트로 이어 저장', () => {
  it('불변 버전을 재검증하고 생성 배경만 먼저 업로드한 뒤 동일 배치를 저장한다', async () => {
    const s = setup();
    await s.engine.createGuestDraft(DEFAULT_ROOM);
    const document = await applyTile(s);
    const member = memberRepositories();
    member.repo.materials.getVersion = vi.fn(async () => placementToMaterialVersion(s.placement));
    const id = await s.engine.promoteGuestDraft(member.repo, s.auth.userId);
    expect(id).toBe(document.id);
    expect(member.repo.materials.getVersion).toHaveBeenCalledWith(s.placement.versionId);
    expect(member.assets.size).toBe(2);
    expect(getActiveDesign(member.documents.get(id)!)!.scene).toEqual(getActiveDesign(document)!.scene);
    expect(s.engine.readGuestDraft()).toBeNull();
  });

  it('서버가 만들었지만 응답을 잃은 경우 새로고침 후 같은 프로젝트를 확인하고 중복 생성하지 않는다', async () => {
    const s = setup();
    const draft = await s.engine.createGuestDraft(DEFAULT_ROOM);
    const member = memberRepositories();
    member.repo.projects.create = vi.fn(async (document) => {
      member.documents.set(document.id, {
        ...document,
        ownerId: s.auth.userId,
        storageRevision: 1,
      } as ProjectDocument);
      throw new Error('response lost');
    });
    await expect(s.engine.promoteGuestDraft(member.repo, s.auth.userId)).rejects.toThrow('response lost');
    expect(s.engine.readGuestDraft()!.promotion!.userId).toBe(s.auth.userId);
    const reopened = createGuestSessionManager(s.deps);
    expect(await reopened.promoteGuestDraft(member.repo, s.auth.userId)).toBe(draft.document.id);
    expect(member.repo.projects.create).toHaveBeenCalledTimes(1);
    expect(reopened.readGuestDraft()).toBeNull();
  });

  it('업로드 후 실패한 자산은 서버에서 확인해 재사용하고 다음 계정으로 초안을 넘기지 않는다', async () => {
    const s = setup();
    await s.engine.createGuestDraft(DEFAULT_ROOM);
    const member = memberRepositories();
    member.repo.assets.put = vi.fn(async (asset) => {
      member.assets.set(asset.id, { ...asset, ownerId: 'member-a' });
      if (asset.kind === 'preview') throw new Error('upload response lost');
    });
    await expect(s.engine.promoteGuestDraft(member.repo, 'member-a')).rejects.toThrow('upload response lost');
    expect(member.repo.projects.create).not.toHaveBeenCalled();
    s.auth.userId = 'member-b';
    await expect(s.engine.promoteGuestDraft(member.repo, 'member-b')).rejects.toThrow('시작한 계정');
    expect(s.engine.readGuestDraft()).not.toBeNull();
    s.auth.userId = 'member-a';
    const reopened = createGuestSessionManager(s.deps);
    await reopened.promoteGuestDraft(member.repo, 'member-a');
    expect(member.repo.assets.put).toHaveBeenCalledTimes(2);
    expect(member.repo.projects.create).toHaveBeenCalledTimes(1);
  });

  it('승격 중 계정이 바뀌면 프로젝트 생성을 중단하고 초안을 남긴다', async () => {
    const s = setup();
    await s.engine.createGuestDraft(DEFAULT_ROOM);
    const member = memberRepositories();
    member.repo.assets.put = vi.fn(async (asset) => {
      member.assets.set(asset.id, { ...asset, ownerId: 'member-a' });
      s.auth.userId = 'member-b';
    });
    await expect(s.engine.promoteGuestDraft(member.repo, 'member-a')).rejects.toThrow('시작한 계정');
    expect(member.repo.projects.create).not.toHaveBeenCalled();
    expect(s.engine.readGuestDraft()).not.toBeNull();
  });

  it('동시에 저장을 눌러도 한 승격만 수행하고 비공용 버전은 업로드 전에 거절한다', async () => {
    const s = setup();
    await s.engine.createGuestDraft(DEFAULT_ROOM);
    await applyTile(s);
    const member = memberRepositories();
    member.repo.materials.getVersion = vi.fn(async () => ({
      ...placementToMaterialVersion(s.placement),
      scope: 'personal' as const,
    }));
    const results = await Promise.allSettled([
      s.engine.promoteGuestDraft(member.repo, 'member-a'),
      s.engine.promoteGuestDraft(member.repo, 'member-a'),
    ]);
    expect(results.every((value) => value.status === 'rejected')).toBe(true);
    expect(member.repo.materials.getVersion).toHaveBeenCalledTimes(1);
    expect(member.repo.assets.put).not.toHaveBeenCalled();
    expect(s.engine.readGuestDraft()).not.toBeNull();
  });
});
