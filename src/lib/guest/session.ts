import { z } from 'zod';
import { normalizeProjectDocument, projectComparisons, projectScenes } from '../comparison';
import {
  DEFAULT_COLOR,
  EMPTY_MASK,
  type AssetRecord,
  type ImageAssetRecord,
  type Material,
  type ProjectDocument,
} from '../types';
import { createRoomSurfaces } from '../room-geometry';
import type { RoomDefinition } from '../room-types';
import { roomDefinitionSchema } from '../room-validation';
import { renderRoomBackground } from '../room-background';
import { previewDimensions } from '../images';
import { projectV3Schema } from '../storage/validation';
import { projectReferences, StorageNotFoundError } from '../repositories/references';
import type { Repositories, RepositoryOperations } from '../repositories/contracts';
import { getRepositoryUserId } from '../repositories';
import {
  placementToMaterialVersion,
  publicPlacementSchema,
  type PublicPlacement,
} from '../catalog/placement-contract';

export const GUEST_DRAFT_KEY = 'sjn:guest-draft:v1';
/** Leave room for browser bookkeeping; image bytes never enter sessionStorage. */
export const MAX_GUEST_DRAFT_BYTES = 3 * 1024 * 1024;

const uuid = z.string().uuid();
const recipeSchema = z
  .object({
    id: uuid,
    room: roomDefinitionSchema,
    width: z.number().int().positive().max(4096),
    height: z.number().int().positive().max(4096),
    kind: z.enum(['original', 'preview']),
    name: z.string().min(1).max(300),
    sourceAssetId: uuid.optional(),
    createdAt: z.string().datetime(),
  })
  .strict();
export type GuestRoomAssetRecipe = z.infer<typeof recipeSchema>;
const draftSchema = z
  .object({
    schemaVersion: z.literal(1),
    document: projectV3Schema,
    versions: z.record(uuid, publicPlacementSchema),
    roomAssets: z.record(uuid, recipeSchema),
    promotion: z
      .object({ userId: z.string().min(1), startedAt: z.string().datetime() })
      .strict()
      .optional(),
  })
  .strict();
export type GuestDraft = Omit<z.infer<typeof draftSchema>, 'document'> & { document: ProjectDocument };
export type GuestRepositories = RepositoryOperations & {
  mode: 'guest';
  materials: RepositoryOperations['materials'] &
    Required<Pick<RepositoryOperations['materials'], 'createProjectResource'>>;
};
type SessionStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export type GuestSessionDependencies = {
  storage: () => SessionStorage;
  render: (
    room: RoomDefinition,
    size: { width: number; height: number },
  ) => Promise<{ blob: Blob; width: number; height: number }>;
  fetch: typeof fetch;
  currentUserId: () => string;
};

function denied(): Promise<never> {
  return Promise.reject(new Error('이 기능은 로그인한 뒤 사용할 수 있어요.'));
}
function missing(error: unknown) {
  return (
    error instanceof StorageNotFoundError ||
    (error instanceof Error && 'status' in error && error.status === 404)
  );
}
function validateDraft(value: unknown): GuestDraft {
  const draft = draftSchema.parse(value);
  const doc = draft.document;
  if (doc.ownerId !== 'guest' || doc.storageRevision !== 0 || doc.thumbnailAssetId)
    throw new Error('체험 초안의 저장 정보를 확인할 수 없어요.');
  if (projectComparisons(doc).length)
    throw new Error('사진으로 만든 비교 공간은 로그인한 뒤 사용할 수 있어요.');
  for (const scene of projectScenes(doc)) {
    if (!scene.room || scene.backgroundAssetId || scene.fixtures.some((fixture) => fixture.reconstruction))
      throw new Error('체험에서는 직접 만든 빈 공간만 사용할 수 있어요.');
    for (const id of [scene.originalAssetId, scene.previewAssetId]) {
      const recipe = draft.roomAssets[id];
      if (!recipe || recipe.id !== id || JSON.stringify(recipe.room) !== JSON.stringify(scene.room))
        throw new Error('체험 공간의 배경 정보를 찾지 못했어요.');
    }
  }
  const refs = projectReferences(doc);
  for (const id of refs.assets) if (!draft.roomAssets[id]) throw new Error('체험 배경 정보가 누락됐어요.');
  for (const id of refs.versions) {
    if (!draft.versions[id] || draft.versions[id].versionId !== id)
      throw new Error('사용한 자재 버전 정보가 누락됐어요.');
  }
  for (const [id, recipe] of Object.entries(draft.roomAssets)) {
    if (id !== recipe.id || (recipe.sourceAssetId && !draft.roomAssets[recipe.sourceAssetId]))
      throw new Error('체험 배경의 원본 연결이 올바르지 않아요.');
  }
  return draft;
}

/** A tab-scoped engine. It never opens IndexedDB or changes the authenticated repository singleton. */
export function createGuestSessionManager(deps: GuestSessionDependencies) {
  let activeId = '';
  const memoryAssets = new Map<string, ImageAssetRecord>();
  const placements = new Map<string, PublicPlacement>();
  const pendingAssets = new Map<string, Promise<ImageAssetRecord>>();
  let pendingPromotion: Promise<string> | undefined;
  let catalogRows:
    { material: Material; version: ReturnType<typeof placementToMaterialVersion> }[] | undefined;
  const warnings: string[] = [];

  function read(): GuestDraft | null {
    let raw: string | null;
    try {
      raw = deps.storage().getItem(GUEST_DRAFT_KEY);
    } catch {
      throw new Error('이 탭의 임시 보관함을 열지 못했어요. 브라우저의 사이트 저장 설정을 확인해 주세요.');
    }
    if (!raw) return null;
    try {
      if (raw.length * 2 > MAX_GUEST_DRAFT_BYTES) throw new Error('too large');
      return validateDraft(JSON.parse(raw));
    } catch {
      throw new Error(
        '이 탭의 체험 초안을 읽지 못했어요. 초안은 삭제하지 않았어요. 새로 시작하려면 체험 초기화를 선택해 주세요.',
      );
    }
  }
  function write(draft: GuestDraft) {
    const validated = validateDraft(draft);
    const raw = JSON.stringify(validated);
    if (raw.length * 2 > MAX_GUEST_DRAFT_BYTES)
      throw new Error(
        '체험 초안이 이 탭의 보관 용량을 넘었어요. 현재 화면은 유지되며 이전 임시 보관본은 바뀌지 않았어요.',
      );
    try {
      deps.storage().setItem(GUEST_DRAFT_KEY, raw);
    } catch {
      throw new Error(
        '이 탭에 체험 내용을 보관하지 못했어요. 현재 화면을 유지하고 브라우저 저장 설정을 확인해 주세요.',
      );
    }
    return validated;
  }
  function attach(draft: GuestDraft) {
    if (activeId !== draft.document.id) {
      memoryAssets.clear();
      placements.clear();
      pendingAssets.clear();
      catalogRows = undefined;
      warnings.length = 0;
      activeId = draft.document.id;
    }
    for (const placement of Object.values(draft.versions)) placements.set(placement.versionId, placement);
  }
  function current() {
    const draft = read();
    if (!draft) throw new Error('이 탭에 체험 공간이 없어요. 빈 공간부터 만들어 주세요.');
    attach(draft);
    return draft;
  }
  async function generatedAsset(recipe: GuestRoomAssetRecipe): Promise<ImageAssetRecord> {
    const rendered = await deps.render(recipe.room, { width: recipe.width, height: recipe.height });
    if (rendered.width !== recipe.width || rendered.height !== recipe.height)
      throw new Error('이 기기에서 이전 체험 공간의 배경 크기를 복원하지 못했어요. 초안은 보존했어요.');
    return {
      id: recipe.id,
      ownerId: 'guest',
      name: recipe.name,
      mime: 'image/png',
      size: rendered.blob.size,
      width: rendered.width,
      height: rendered.height,
      kind: recipe.kind,
      createdAt: recipe.createdAt,
      blob: rendered.blob,
      ...(recipe.sourceAssetId
        ? { sourceAssetId: recipe.sourceAssetId, derivation: 'upload-preview' as const }
        : {}),
    };
  }
  async function getAsset(id: string): Promise<ImageAssetRecord> {
    const draft = current();
    const existing = memoryAssets.get(id);
    if (existing) return existing;
    let pending = pendingAssets.get(id);
    if (!pending) {
      pending = (async () => {
        const recipe = draft.roomAssets[id];
        if (recipe) return generatedAsset(recipe);
        const image = [...placements.values()]
          .flatMap((placement) => placement.images)
          .find((item) => item.id === id);
        if (!image) throw new StorageNotFoundError('체험 이미지');
        const response = await deps.fetch(image.url, {
          credentials: 'same-origin',
          cache: 'no-store',
          signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok)
          throw new Error('현재 공개된 자재 이미지를 불러오지 못했어요. 자재가 변경되었을 수 있어요.');
        const blob = await response.blob();
        if (blob.type.split(';')[0] !== image.mime || !blob.size || blob.size > 25 * 1024 * 1024)
          throw new Error('자재 이미지 응답을 확인할 수 없어요.');
        return {
          id,
          ownerId: 'guest-public',
          name: '공용 자재 이미지',
          mime: image.mime,
          width: image.width,
          height: image.height,
          size: blob.size,
          kind: image.kind,
          createdAt: '',
          blob,
        };
      })();
      pendingAssets.set(id, pending);
    }
    try {
      const asset = await pending;
      if (activeId !== draft.document.id || read()?.document.id !== draft.document.id)
        throw new Error('체험 공간이 바뀌었어요. 현재 공간을 다시 열어 주세요.');
      memoryAssets.set(id, asset);
      return asset;
    } finally {
      if (pendingAssets.get(id) === pending) pendingAssets.delete(id);
    }
  }
  async function checkpoint(document?: ProjectDocument): Promise<void> {
    const draft = current();
    if (!document) return;
    if (document.id !== draft.document.id || document.ownerId !== 'guest')
      throw new Error('다른 계정의 작업을 체험 초안에 보관할 수 없어요.');
    if (draft.promotion && JSON.stringify(document) !== JSON.stringify(draft.document))
      throw new Error('로그인한 계정에 저장 중인 초안이에요. 저장을 마친 뒤 계속 편집해 주세요.');
    const refs = projectReferences(document);
    const roomAssets: GuestDraft['roomAssets'] = {};
    for (const scene of projectScenes(document)) {
      if (!scene.room) throw new Error('체험에서는 빈 공간만 보관할 수 있어요.');
      for (const id of [scene.originalAssetId, scene.previewAssetId]) {
        const existing = draft.roomAssets[id];
        if (existing) {
          roomAssets[id] = existing;
          continue;
        }
        const asset = memoryAssets.get(id);
        if (!asset || !['original', 'preview'].includes(asset.kind))
          throw new Error('새 공간의 배경이 준비되지 않았어요. 다시 시도해 주세요.');
        roomAssets[id] = {
          id,
          room: structuredClone(scene.room),
          width: asset.width,
          height: asset.height,
          kind: asset.kind as 'original' | 'preview',
          name: asset.name,
          createdAt: asset.createdAt,
          ...(asset.sourceAssetId ? { sourceAssetId: asset.sourceAssetId } : {}),
        };
      }
    }
    const versions: GuestDraft['versions'] = {};
    for (const id of refs.versions) {
      const value = placements.get(id) ?? draft.versions[id];
      if (!value) throw new Error('사용한 공용 자재 정보를 찾지 못했어요. 자재 목록을 다시 열어 주세요.');
      versions[id] = value;
    }
    write({ ...draft, document: structuredClone(document), versions, roomAssets });
  }
  const repositories: GuestRepositories = {
    mode: 'guest',
    projects: {
      list: denied,
      create: denied,
      duplicate: denied,
      remove: denied,
      async load(id) {
        const draft = current();
        if (draft.document.id !== id) throw new StorageNotFoundError('체험 공간');
        return structuredClone(draft.document);
      },
      async save(input) {
        await checkpoint(normalizeProjectDocument(input));
        return structuredClone(current().document);
      },
    },
    assets: {
      get: getAsset,
      async put(asset: AssetRecord) {
        current();
        if (asset.kind !== 'original' && asset.kind !== 'preview')
          throw new Error('체험에서는 빈 공간의 배경만 임시로 사용할 수 있어요.');
        memoryAssets.set(asset.id, structuredClone(asset));
      },
      removeUnused: denied,
    },
    materials: {
      createProjectResource: denied,
      create: denied,
      update: denied,
      setActive: denied,
      async list() {
        const draft = current();
        if (catalogRows) return structuredClone(catalogRows);
        const response = await deps.fetch('/api/catalog/placement', {
          credentials: 'same-origin',
          cache: 'no-store',
          signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) throw new Error('공용 자재를 불러오지 못했어요. 다시 시도해 주세요.');
        const data = z.object({ placements: z.array(publicPlacementSchema) }).parse(await response.json());
        if (read()?.document.id !== draft.document.id) throw new Error('체험 공간이 바뀌었어요.');
        catalogRows = data.placements.map((placement) => {
          placements.set(placement.versionId, placement);
          const version = placementToMaterialVersion(placement);
          const material: Material = {
            id: placement.materialId,
            ownerId: 'guest-public',
            currentVersionId: version.id,
            active: true,
            scope: 'shared',
            updatedAt: '',
          };
          return { material, version };
        });
        return structuredClone(catalogRows);
      },
      async getVersion(id) {
        current();
        const placement = placements.get(id);
        if (!placement) throw new StorageNotFoundError('체험 자재 버전');
        return placementToMaterialVersion(placement);
      },
    },
  };
  async function create(
    room: RoomDefinition,
    options: { replace?: boolean; signal?: AbortSignal } = {},
  ): Promise<GuestDraft> {
    options.signal?.throwIfAborted();
    roomDefinitionSchema.parse(room);
    const previous = read();
    if (previous && !options.replace)
      throw new Error('이 탭에 진행 중인 체험 공간이 있어요. 이어서 편집하거나 먼저 체험을 초기화해 주세요.');
    const createdAt = new Date().toISOString();
    const originalId = crypto.randomUUID(),
      previewId = crypto.randomUUID();
    const rendered = await deps.render(room, { width: 4096, height: 2731 });
    options.signal?.throwIfAborted();
    if (read()?.document.id !== previous?.document.id)
      throw new Error('이미 체험 공간을 만들었어요. 진행 중인 공간을 열어 주세요.');
    const original: GuestRoomAssetRecipe = {
      id: originalId,
      room: structuredClone(room),
      width: rendered.width,
      height: rendered.height,
      kind: 'original',
      name: '기본 공간.png',
      createdAt,
    };
    const preview: GuestRoomAssetRecipe = {
      ...original,
      id: previewId,
      ...previewDimensions(rendered.width, rendered.height),
      kind: 'preview',
      name: '기본 공간.png · 편집용',
      sourceAssetId: originalId,
    };
    const document = normalizeProjectDocument({
      id: crypto.randomUUID(),
      ownerId: 'guest',
      name: '체험 공간',
      schemaVersion: 1,
      editRevision: 0,
      storageRevision: 0,
      createdAt,
      updatedAt: createdAt,
      scene: {
        originalAssetId: originalId,
        previewAssetId: previewId,
        imageWidth: rendered.width,
        imageHeight: rendered.height,
        room: structuredClone(room),
        surfaces: createRoomSurfaces(room, rendered.width / rendered.height),
        fixtures: [],
        protection: EMPTY_MASK(),
        color: { ...DEFAULT_COLOR },
      },
      history: { past: [], future: [] },
      viewport: { zoom: 1, pan: { x: 0, y: 0 } },
    });
    document.comparisonDesignIds = [];
    const draft = write({
      schemaVersion: 1,
      document,
      versions: {},
      roomAssets: { [originalId]: original, [previewId]: preview },
    });
    attach(draft);
    memoryAssets.set(originalId, {
      id: originalId,
      ownerId: 'guest',
      name: original.name,
      kind: 'original',
      mime: 'image/png',
      width: rendered.width,
      height: rendered.height,
      size: rendered.blob.size,
      blob: rendered.blob,
      createdAt,
    });
    return structuredClone(draft);
  }
  async function open() {
    if (!read()) return null;
    const draft = current();
    warnings.length = 0;
    catalogRows = undefined;
    try {
      const rows = await repositories.materials.list();
      const currentVersions = new Set(rows.map((row) => row.version.id));
      if (projectReferences(draft.document).versions.some((id) => !currentVersions.has(id)))
        warnings.push(
          '사용한 자재 중 현재 공개 목록에서 변경되거나 내려간 자재가 있어요. 배치는 보존했으며, 표시되지 않는 자재는 바꾸거나 삭제할 수 있어요.',
        );
    } catch {
      catalogRows = [];
      warnings.push(
        '공용 자재 목록을 불러오지 못했어요. 체험 배치는 보존했어요. 새로고침하면 다시 확인해요.',
      );
    }
    return { draft: structuredClone(draft), repositories, warnings: [...new Set(warnings)] };
  }
  function clear() {
    try {
      deps.storage().removeItem(GUEST_DRAFT_KEY);
    } catch {
      throw new Error('체험 초안을 지우지 못했어요. 브라우저 저장 설정을 확인해 주세요.');
    }
    activeId = '';
    memoryAssets.clear();
    placements.clear();
    pendingAssets.clear();
    catalogRows = undefined;
    warnings.length = 0;
  }
  async function promote(repo: Repositories, userId: string): Promise<string> {
    if (pendingPromotion) return pendingPromotion;
    const run = async () => {
      let draft = current();
      const assertAccount = () => {
        if (
          repo.mode !== 'd1' ||
          !userId ||
          deps.currentUserId() !== userId ||
          (draft.promotion && draft.promotion.userId !== userId)
        )
          throw new Error('체험 저장을 시작한 계정으로 다시 로그인해 주세요. 초안은 이 탭에 보관돼요.');
        if (read()?.document.id !== draft.document.id) throw new Error('저장 중 체험 공간이 바뀌었어요.');
      };
      assertAccount();
      if (!draft.promotion) {
        draft = write({ ...draft, promotion: { userId, startedAt: new Date().toISOString() } });
      }
      const document: ProjectDocument = { ...structuredClone(draft.document), ownerId: userId };
      const finish = (saved: ProjectDocument) => {
        assertAccount();
        if (saved.id !== document.id || saved.ownerId !== userId)
          throw new Error('저장한 프로젝트의 소유자를 확인하지 못했어요. 초안은 보존했어요.');
        // Parse both documents to give object properties the same canonical order.
        const content = (value: ProjectDocument) => {
          const parsed = projectV3Schema.parse(value);
          const {
            ownerId: _owner,
            storageRevision: _revision,
            createdAt: _created,
            updatedAt: _updated,
            ...rest
          } = parsed;
          void _owner;
          void _revision;
          void _created;
          void _updated;
          return JSON.stringify(rest);
        };
        if (content(saved) !== content(document))
          throw new Error('같은 ID의 프로젝트 내용이 달라요. 초안을 보존했으니 내 프로젝트를 확인해 주세요.');
        clear();
        return saved.id;
      };
      try {
        const saved = await repo.projects.load(document.id);
        return finish(saved);
      } catch (error) {
        if (!missing(error)) throw error;
      }
      assertAccount();
      const refs = projectReferences(document);
      for (const id of refs.versions) {
        const verified = await repo.materials.getVersion(id);
        assertAccount();
        const original = draft.versions[id];
        if (
          !original ||
          verified.id !== id ||
          verified.scope !== 'shared' ||
          verified.reconstruction ||
          verified.materialId !== original.materialId
        )
          throw new Error('체험에 사용한 공용 자재 버전을 확인하지 못했어요. 초안은 보존했어요.');
        for (const scene of projectScenes(document))
          for (const fixture of scene.fixtures) {
            if (
              fixture.materialVersionId === id &&
              verified.views[fixture.viewIndex]?.assetId !== original.views[fixture.viewIndex]?.assetId
            )
              throw new Error('체험에 사용한 제품 사진이 변경됐어요. 초안은 보존했어요.');
          }
      }
      const recipes = Object.values(draft.roomAssets).sort(
        (a, b) => Number(!!a.sourceAssetId) - Number(!!b.sourceAssetId),
      );
      for (const recipe of recipes) {
        assertAccount();
        try {
          const uploaded = await repo.assets.get(recipe.id);
          assertAccount();
          if (
            uploaded.ownerId !== userId ||
            uploaded.kind !== recipe.kind ||
            uploaded.sourceAssetId !== recipe.sourceAssetId ||
            !('width' in uploaded) ||
            uploaded.width !== recipe.width ||
            uploaded.height !== recipe.height
          )
            throw new Error('이미 올린 체험 배경 정보를 확인하지 못했어요. 초안은 보존했어요.');
        } catch (error) {
          if (!missing(error)) throw error;
          const asset = await getAsset(recipe.id);
          assertAccount();
          await repo.assets.put(asset);
          assertAccount();
        }
      }
      assertAccount();
      const saved = await repo.projects.create(document);
      return finish(saved);
    };
    pendingPromotion = run();
    try {
      return await pendingPromotion;
    } finally {
      pendingPromotion = undefined;
    }
  }
  return {
    createGuestDraft: create,
    openGuestSession: open,
    readGuestDraft: read,
    checkpointGuestDraft: checkpoint,
    promoteGuestDraft: promote,
    clearGuestDraft: clear,
  };
}

const manager = createGuestSessionManager({
  storage: () => window.sessionStorage,
  render: renderRoomBackground,
  fetch: (...args) => fetch(...args),
  currentUserId: getRepositoryUserId,
});
export const {
  createGuestDraft,
  openGuestSession,
  readGuestDraft,
  checkpointGuestDraft,
  promoteGuestDraft,
  clearGuestDraft,
} = manager;
