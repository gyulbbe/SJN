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
import { standardModelKind } from '../standard-model-view';
import {
  placementToMaterialVersion,
  publicPlacementSchema,
  type PublicPlacement,
} from '../catalog/placement-contract';
import { facetSelectionSchema, PAGE_SIZE, pageSearchParams } from '../catalog/paging';
import { materialCard } from '../catalog/cards';
import { listImageRecord } from '../list-images';

export const GUEST_DRAFT_KEY = 'sjn:guest-draft:v1';
const pageSchema = z.object({
  placements: z.array(publicPlacementSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().nonnegative().optional(),
  facets: facetSelectionSchema.optional(),
});
/** A public material as the editor's lists hold it. */
const placementMaterial = (placement: PublicPlacement): Material => ({
  id: placement.materialId,
  ownerId: 'guest-public',
  currentVersionId: placement.versionId,
  active: true,
  scope: 'shared',
  updatedAt: '',
});
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
    // A model made by a photo reconstruction is not allowed here; a catalog product the person
    // switched to its standard model ("표준 모형으로 보기") is: its material is a public one.
    const reconstructed = scene.fixtures.some(
      (fixture) =>
        fixture.reconstruction &&
        !(
          fixture.reconstruction.version === 2 &&
          standardModelKind(draft.versions[fixture.materialVersionId]) === fixture.reconstruction.kind
        ),
    );
    if (!scene.room || scene.backgroundAssetId || reconstructed)
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
  const listAssets = new Map<string, ImageAssetRecord>();
  const placements = new Map<string, PublicPlacement>();
  const pendingAssets = new Map<string, Promise<ImageAssetRecord>>();
  let pendingPromotion: Promise<string> | undefined;
  /** The current public placement of each material this draft uses (checked when the draft opens). */
  let currentPlacements: Map<string, PublicPlacement> | undefined;
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
      listAssets.clear();
      placements.clear();
      pendingAssets.clear();
      currentPlacements = undefined;
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
  /** A card's list image of a public image (the image itself once it was read whole). */
  async function getListImage(id: string): Promise<ImageAssetRecord> {
    current();
    const known = memoryAssets.get(id) ?? listAssets.get(id);
    if (known) return known;
    const image = [...placements.values()]
      .flatMap((placement) => placement.images)
      .find((item) => item.id === id);
    if (!image) throw new StorageNotFoundError('체험 이미지');
    const response = await deps.fetch(image.url + '&size=list', {
      credentials: 'same-origin',
      cache: 'no-store',
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok)
      throw new Error('현재 공개된 자재 이미지를 불러오지 못했어요. 자재가 변경되었을 수 있어요.');
    const blob = await response.blob();
    if (
      !/^image\/(png|jpeg|webp)$/.test(blob.type.split(';')[0]) ||
      !blob.size ||
      blob.size > 25 * 1024 * 1024
    )
      throw new Error('자재 이미지 응답을 확인할 수 없어요.');
    const asset = listImageRecord(id, blob);
    listAssets.set(id, asset);
    return asset;
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
  async function placementRequest(search: string): Promise<unknown> {
    const response = await deps.fetch('/api/catalog/placement' + (search ? '?' + search : ''), {
      credentials: 'same-origin',
      cache: 'no-store',
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error('공용 자재를 불러오지 못했어요. 다시 시도해 주세요.');
    return response.json();
  }
  /** The current public placements of these materials (asked once per draft opening, a page at a time). */
  async function currentOf(materialIds: string[]): Promise<Map<string, PublicPlacement>> {
    currentPlacements ??= new Map();
    const missingIds = [...new Set(materialIds)].filter((id) => !currentPlacements!.has(id));
    for (let start = 0; start < missingIds.length; start += PAGE_SIZE) {
      const chunk = missingIds.slice(start, start + PAGE_SIZE);
      const data = z
        .object({ placements: z.array(publicPlacementSchema) })
        .parse(await placementRequest('ids=' + chunk.join(',')));
      for (const placement of data.placements) {
        placements.set(placement.versionId, placement);
        currentPlacements.set(placement.materialId, placement);
      }
    }
    return new Map(
      materialIds.flatMap((id) => {
        const placement = currentPlacements!.get(id);
        return placement ? [[id, placement] as const] : [];
      }),
    );
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
      getListImage,
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
      async page(query) {
        const draft = current();
        const data = pageSchema.parse(await placementRequest(pageSearchParams(query).toString()));
        if (read()?.document.id !== draft.document.id) throw new Error('체험 공간이 바뀌었어요.');
        for (const placement of data.placements) placements.set(placement.versionId, placement);
        return {
          items: data.placements.map((placement) =>
            materialCard(placementMaterial(placement), placementToMaterialVersion(placement)),
          ),
          nextCursor: data.nextCursor,
          ...(data.total === undefined ? {} : { total: data.total }),
          ...(data.facets ? { facets: data.facets } : {}),
        };
      },
      async getVersions(ids, options = {}) {
        const draft = current();
        const versions = [...new Set(ids)]
          .map((id) => placements.get(id))
          .filter((placement): placement is PublicPlacement => !!placement)
          .map(placementToMaterialVersion);
        if (!options.withCurrent) return { versions, current: [] };
        // The current versions only inform (latest prices); an unreachable public list leaves them out.
        const latest = await currentOf(versions.map((version) => version.materialId)).catch(
          () => new Map<string, PublicPlacement>(),
        );
        if (read()?.document.id !== draft.document.id) throw new Error('체험 공간이 바뀌었어요.');
        return {
          versions,
          current: [...latest.values()].map((placement) => ({
            material: placementMaterial(placement),
            version: placementToMaterialVersion(placement),
          })),
        };
      },
      find: denied,
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
    currentPlacements = undefined;
    try {
      // Only the materials this draft uses are checked against the public list.
      const used = projectReferences(draft.document).versions;
      const latest = await currentOf(used.map((id) => draft.versions[id].materialId));
      if (used.some((id) => latest.get(draft.versions[id].materialId)?.versionId !== id))
        warnings.push(
          '사용한 자재 중 현재 공개 목록에서 변경되거나 내려간 자재가 있어요. 배치는 보존했으며, 표시되지 않는 자재는 바꾸거나 삭제할 수 있어요.',
        );
    } catch {
      currentPlacements = new Map();
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
    listAssets.clear();
    placements.clear();
    pendingAssets.clear();
    currentPlacements = undefined;
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
      // One request for every version the draft uses (the member API's visibility).
      const checked = refs.versions.length ? (await repo.materials.getVersions(refs.versions)).versions : [];
      assertAccount();
      for (const id of refs.versions) {
        const verified = checked.find((version) => version.id === id);
        const original = draft.versions[id];
        if (
          !verified ||
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
