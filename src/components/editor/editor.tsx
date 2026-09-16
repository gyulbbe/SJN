'use client';
import { getMaterialImageAssetId, getPreferredProductViewIndex } from '@/lib/material-images';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft,
  Ruler,
  Layers,
  Undo2,
  Redo2,
  Sparkles,
  Download,
  Save,
  Plus,
  Search,
  HelpCircle,
  X,
  Columns2,
  Check,
  ExternalLink,
} from 'lucide-react';
import { getRepositories } from '@/lib/repositories';
import type { Repositories } from '@/lib/repositories';
import {
  cloudRecovery,
  inspectRecovery,
  projectContentKey,
  recoveryKey,
  registerStorageTransitionGuard,
  registerAccountChangeCheckpoint,
  type ProjectRecovery,
  type RecoveryScope,
} from '@/lib/storage/recovery';
import { createSaveScheduler } from '@/lib/storage/save-scheduler';
import MaterialUsagePanel, { flushMaterialUsageInputs } from '@/components/materials/material-usage-panel';
import { useEditor } from '@/lib/editor-store';
import {
  getActiveDesign,
  getActiveScene,
  createProjectFromLegacyFrame,
  duplicateProjectDocument,
  MAX_DESIGNS,
  MAX_COMPARISON_DESIGNS,
} from '@/lib/designs';
import { useDesignThumbnail } from '@/components/designs/use-design-preview';
import DesignManager from '@/components/designs/design-manager';
import DesignComparison from '@/components/designs/design-comparison';
import { getEditingScene, projectScenes } from '@/lib/comparison';
import ReconstructionReviewPanel from '@/components/reconstruction/reconstruction-review';
import reconstructionStyles from '@/components/reconstruction/reconstruction.module.css';
import {
  DEFAULT_COLOR,
  EMPTY_MASK,
  type Material,
  type MaterialVersion,
  type Scene,
  type ProjectDocument,
} from '@/lib/types';
import { AssetImage } from '@/components/materials/asset-image';
import { useSharedCatalogAdmin } from '@/components/materials/shared-access';
import { MaterialForm } from '@/components/materials/material-form';
import { useAccess } from '../app-provider';
import CanvasWorkspace from './canvas-workspace';
import Inspector from './inspector';
import AiExport from './ai-export';
import type { PhotoCompositor } from '@/lib/render/compositor';
import { isBuiltInExampleMaterial } from '@/lib/catalog-visibility';
import { importImage } from '@/lib/images';
import RoomDialog from '@/components/rooms/room-dialog';
import RoomViewer from '@/components/rooms/room-viewer';
import WallFeaturesDialog from '@/components/rooms/wall-features-dialog';
import RoomCanvasWorkspace from '@/components/rooms/room-canvas-workspace';
import { projectDesignPreviewRoomContext } from '@/lib/render/design-preview-context';
import type { RoomDefinition } from '@/lib/room-types';
import { renderRoomBackground } from '@/lib/room-background';
import { projectWallFeatureResizeError, roomResetWarnings } from '@/lib/room-editing';
import { createRoomPlacement, projectRoomFixture } from '@/lib/room-fixtures';
import { homography, transformPoint } from '@/lib/render/math';
import { detectSurfaces } from '@/lib/render/auto-surfaces';
import type { RoomSegmentation } from '@/lib/segmentation';
import { analyzeWallGeometry, applyWallGeometry } from '@/lib/render/wall-geometry';
const pendingProjectSaves = new Map<string, Promise<boolean>>();
export default function Editor({ id }: { id: string }) {
  const st = useEditor(),
    router = useRouter(),
    { writable, ready, mode: storageMode, userId } = useAccess();
  const catalogAdmin = useSharedCatalogAdmin();
  const canManageCatalog = storageMode === 'local' || catalogAdmin;
  const [catalog, setCatalog] = useState<{ material: Material; version: MaterialVersion }[]>([]),
    [materials, setMaterials] = useState<Record<string, MaterialVersion>>({}),
    [error, setError] = useState(''),
    [tab, setTab] = useState<'wall' | 'floor' | 'fixtures'>('floor'),
    [search, setSearch] = useState(''),
    [form, setForm] = useState(false),
    [help, setHelp] = useState(false),
    [ai, setAi] = useState(false),
    [exporting, setExporting] = useState(false),
    [aiExporting, setAiExporting] = useState(false),
    [exportModal, setExportModal] = useState(false),
    [roomOpen, setRoomOpen] = useState(false),
    [roomViewerOpen, setRoomViewerOpen] = useState(false),
    [referenceOpen, setReferenceOpen] = useState(false),
    [reviewOpen, setReviewOpen] = useState(true),
    [beforeCatalog, setBeforeCatalog] = useState(false),
    [format, setFormat] = useState<'image/png' | 'image/jpeg'>('image/png'),
    [compare, setCompare] = useState(false),
    [designsOpen, setDesignsOpen] = useState(false),
    [comparisonOpen, setComparisonOpen] = useState(false),
    [hasCompared, setHasCompared] = useState(false),
    [legacyOpen, setLegacyOpen] = useState(false),
    [catalogOpen, setCatalogOpen] = useState(false),
    [inspectorOpen, setInspectorOpen] = useState(false),
    [loaded, setLoaded] = useState(false),
    [savingPreview, setSavingPreview] = useState(false),
    [detectionStatus, setDetectionStatus] = useState(''),
    [detectionNotice, setDetectionNotice] = useState('');
  const [wallEditor, setWallEditor] = useState<{
    projectId: string;
    editRevision: number;
    activeDesignId: string | null;
    editing: 'before' | 'after';
    scene: Scene;
  } | null>(null);
  const [recoveryStatus, setRecoveryStatus] = useState('');
  const [recoveryPrompt, setRecoveryPrompt] = useState<{
    record: ProjectRecovery;
    kind: 'recoverable' | 'conflict' | 'unavailable';
  } | null>(null);
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [recoveryArchives, setRecoveryArchives] = useState<ProjectRecovery[]>([]);
  const scope = useMemo<RecoveryScope | null>(
    () =>
      storageMode !== 'local' && userId && typeof window !== 'undefined'
        ? { origin: window.location.origin, backend: storageMode, userId, projectId: id }
        : null,
    [id, storageMode, userId],
  );
  const scopeKey = scope ? recoveryKey(scope) : JSON.stringify(['local', id]);
  const currentScopeKey = useRef(scopeKey);
  currentScopeKey.current = scopeKey;
  const session = useRef<{ key: string; repo: Repositories; dead: boolean } | null>(null);
  const materialsRef = useRef(materials);
  materialsRef.current = materials;
  const recoveryPromptRef = useRef(recoveryPrompt);
  recoveryPromptRef.current = recoveryPrompt;
  const lastRecoveryContent = useRef('');
  const cloudCommittedContent = useRef('');
  const recoveryCopy = useRef<ProjectDocument | null>(null);
  const activeDesign = st.project ? getActiveDesign(st.project) : undefined;
  const roomContext = st.project ? projectDesignPreviewRoomContext(st.project) : undefined;
  const assetReader = useCallback((assetId: string) => getRepositories().assets.get(assetId), []);
  useDesignThumbnail({
    projectId: id,
    sharedRevision: st.project?.shared.revision ?? 0,
    design: loaded ? (activeDesign ?? null) : null,
    materials,
    assetReader,
    roomContext,
    enabled: loaded && !roomViewerOpen && !comparisonOpen && !designsOpen && !st.draft && !detectionStatus,
    delayMs: 500,
  });
  const renderer = useRef<PhotoCompositor | null>(null);
  const applyRequest = useRef(0);
  const roomRequest = useRef(0);
  const detectedPhotos = useRef(new Map<string, Promise<RoomSegmentation>>());
  const lastSaveError = useRef('');
  useEffect(() => {
    setRoomOpen(false);
    setRoomViewerOpen(false);
    setWallEditor(null);
    const requests = roomRequest;
    return () => {
      requests.current++;
    };
  }, [id, writable]);
  useEffect(() => {
    setExportModal(false);
    setAiExporting(false);
    setCatalogOpen(false);
    setInspectorOpen(false);
    setDetectionStatus('');
    setDetectionNotice('');
    applyRequest.current++;
  }, [id, scopeKey, st.project?.activeDesignId]);
  useEffect(() => {
    if (loaded && Object.keys(materials).length) useEditor.getState().initializeUsage(materials);
  }, [loaded, materials]);
  const onRenderer = useCallback((r: PhotoCompositor | null) => {
    renderer.current = r;
  }, []);
  const onError = useCallback((message: string) => setError(message), []);
  const refresh = useCallback(async () => {
    const list = await getRepositories().materials.list();
    setCatalog(list.filter((row) => !isBuiltInExampleMaterial(row)));
    setMaterials((prev) => ({ ...prev, ...Object.fromEntries(list.map((v) => [v.version.id, v.version])) }));
  }, []);
  useEffect(() => {
    const requests = applyRequest;
    setDetectionStatus('');
    setDetectionNotice('');
    return () => {
      requests.current++;
    };
  }, [id]);
  useEffect(() => {
    const current = useEditor.getState();
    const selected =
      current.project &&
      getEditingScene(current.project, current.editing).surfaces.find((s) => s.id === st.selection);
    if (selected) setTab(selected.kind);
  }, [st.selection, id, st.editing]);
  useEffect(() => {
    if (!ready || (storageMode !== 'local' && !scope)) return;
    const operation = { key: scopeKey, repo: getRepositories(), dead: false };
    session.current = operation;
    setLoaded(false);
    setRecoveryPrompt(null);
    setRecoveryArchives([]);
    setRecoveryStatus('');
    lastRecoveryContent.current = '';
    lastSaveError.current = '';
    cloudCommittedContent.current = '';
    recoveryCopy.current = null;
    void (async () => {
      try {
        const repo = operation.repo;
        await pendingProjectSaves.get(scopeKey);
        let recovery: ProjectRecovery | undefined;
        if (scope) {
          try {
            recovery = await cloudRecovery.read(scope);
            const archives = await cloudRecovery.archives(scope);
            if (!operation.dead) setRecoveryArchives(archives);
          } catch (e) {
            if (!operation.dead) setRecoveryStatus(e instanceof Error ? e.message : String(e));
          }
        }
        let project: ProjectDocument;
        let unavailable = false;
        try {
          project = await repo.projects.load(id);
        } catch (e) {
          // Cached drafts may be opened only for this already authenticated account.
          if (!recovery) throw e;
          project = recovery.document;
          unavailable = true;
        }
        const list = await repo.materials.list().catch((e) => {
          if (!recovery) throw e;
          return [] as { material: Material; version: MaterialVersion }[];
        });
        const versions: Record<string, MaterialVersion> = {
          ...recovery?.versions,
          ...Object.fromEntries(list.map((v) => [v.version.id, v.version])),
        };
        const scenes = [...projectScenes(project), ...(recovery ? projectScenes(recovery.document) : [])];
        const ids = new Set(
          scenes
            .flatMap((scene) => [
              ...scene.surfaces.map((v) => v.materialVersionId),
              ...scene.fixtures.map((v) => v.materialVersionId),
            ])
            .filter(Boolean) as string[],
        );
        for (const v of ids) if (!versions[v]) versions[v] = await repo.materials.getVersion(v);
        if (operation.dead || currentScopeKey.current !== scopeKey) return;
        cloudCommittedContent.current = unavailable ? '' : projectContentKey(project);
        useEditor.getState().load(project);
        useEditor.getState().initializeUsage(versions);
        setCatalog(list.filter((row) => !isBuiltInExampleMaterial(row)));
        setMaterials(versions);
        if (recovery && scope) {
          const kind = unavailable ? 'unavailable' : inspectRecovery(recovery, project);
          if (kind === 'identical') await cloudRecovery.acknowledge(scope, recovery.document, project);
          else setRecoveryPrompt({ record: recovery, kind });
        }
        if (!operation.dead) setLoaded(true);
      } catch (e) {
        if (!operation.dead) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      operation.dead = true;
    };
  }, [id, ready, writable, storageMode, scope, scopeKey]);
  const persistRecovery = useCallback(
    async (document?: ProjectDocument) => {
      if (!scope) return true;
      const project = document ?? useEditor.getState().project;
      const operation = session.current;
      if (!project || project.id !== id || !operation || operation.key !== scopeKey) return false;
      const content = projectContentKey(project);
      if (content === lastRecoveryContent.current) {
        if (!operation.dead && currentScopeKey.current === scopeKey)
          setRecoveryStatus('이 기기에 복구본 저장됨');
        return true;
      }
      try {
        await cloudRecovery.write(scope, project, materialsRef.current);
        if (!operation.dead && currentScopeKey.current === scopeKey) {
          lastRecoveryContent.current = content;
          if (useEditor.getState().project && projectContentKey(useEditor.getState().project!) === content)
            setRecoveryStatus('이 기기에 복구본 저장됨');
        }
        return true;
      } catch (e) {
        if (!operation.dead && currentScopeKey.current === scopeKey)
          setRecoveryStatus(
            `복구본 저장 실패 · ${e instanceof Error ? e.message : String(e)}. 현재 작업은 유지됩니다.`,
          );
        return false;
      }
    },
    [scope, scopeKey, id],
  );
  const saveOnce = useCallback(async () => {
    const operation = session.current;
    if (!writable || !operation || operation.dead || operation.key !== scopeKey || recoveryPromptRef.current)
      return false;
    const pending = pendingProjectSaves.get(scopeKey);
    if (pending) return pending;
    const run = async () => {
      const state = useEditor.getState(),
        project = state.project;
      if (!project || project.id !== id) return false;
      if (state.saveStatus === 'saved') return true;
      if (scope && projectContentKey(project) === cloudCommittedContent.current) {
        await persistRecovery(project);
        try {
          await cloudRecovery.acknowledge(scope, project, project);
        } catch {
          /* Preserve the draft on IDB failure. */
        }
        if (!operation.dead && currentScopeKey.current === scopeKey) {
          state.saved(project);
          lastSaveError.current = '';
          setError('');
          setRecoveryStatus('');
        }
        return true;
      }
      const sent = structuredClone(project);
      const previousSaveError = state.error;
      state.saving();
      if (scope) await persistRecovery(sent);
      if (operation.dead || currentScopeKey.current !== scopeKey || getRepositories() !== operation.repo)
        return false;
      try {
        const result = await operation.repo.projects.save(sent, sent.storageRevision);
        // Persist successful server bookkeeping even if this editor has since closed.
        if (scope) {
          try {
            await cloudRecovery.acknowledge(scope, sent, result);
          } catch {
            /* A retained recovery is safer than dropping a valid server save. */
          }
        }
        if (operation.dead || currentScopeKey.current !== scopeKey || getRepositories() !== operation.repo)
          return true;
        cloudCommittedContent.current = projectContentKey(result);
        useEditor.getState().saved(result);
        if (useEditor.getState().saveStatus === 'saved') {
          lastRecoveryContent.current = '';
          setRecoveryStatus('');
        }
        const clearedSaveError = lastSaveError.current;
        lastSaveError.current = '';
        setError((message) => (message === previousSaveError || message === clearedSaveError ? '' : message));
        return true;
      } catch (e) {
        if (operation.dead || currentScopeKey.current !== scopeKey || getRepositories() !== operation.repo)
          return false;
        const message = e instanceof Error ? e.message : String(e);
        lastSaveError.current = message;
        useEditor.getState().failed(message);
        setError(message);
        // A revision conflict is never resolved by changing expectedStorageRevision.
        if (
          scope &&
          e instanceof Error &&
          (e.name === 'StorageConflictError' || ('status' in e && e.status === 409))
        ) {
          const current = useEditor.getState().project;
          if (current && (await persistRecovery(current))) {
            try {
              const record = await cloudRecovery.read(scope);
              if (record && !operation.dead) setRecoveryPrompt({ record, kind: 'conflict' });
            } catch {
              /* Current editor state remains available if IndexedDB is full. */
            }
          }
        }
        return false;
      }
    };
    const promise = run();
    pendingProjectSaves.set(scopeKey, promise);
    try {
      return await promise;
    } finally {
      if (pendingProjectSaves.get(scopeKey) === promise) pendingProjectSaves.delete(scopeKey);
    }
  }, [writable, id, scopeKey, scope, persistRecovery]);
  const scheduler = useMemo(
    () =>
      createSaveScheduler(saveOnce, {
        delayMs: scope ? 2000 : 500,
        maxWaitMs: scope ? 15000 : 0,
        retryOnChange: !scope,
      }),
    [saveOnce, scope],
  );
  const save = useCallback(() => scheduler.flush(), [scheduler]);
  useEffect(() => {
    scheduler.start();
    return () => scheduler.dispose();
  }, [scheduler]);
  useEffect(() => {
    if (st.saveStatus !== 'dirty' || !loaded || !writable || recoveryPrompt) return;
    scheduler.changed();
  }, [st.project, st.saveStatus, scheduler, loaded, writable, recoveryPrompt]);
  useEffect(() => {
    if (!scope || !loaded || !writable || recoveryPrompt || st.saveStatus === 'saved') return;
    setRecoveryStatus('복구본 저장 대기');
    const timer = setTimeout(() => {
      void persistRecovery();
    }, 500);
    return () => clearTimeout(timer);
  }, [scope, st.project, st.saveStatus, loaded, writable, persistRecovery, recoveryPrompt]);
  useEffect(
    () =>
      registerStorageTransitionGuard(async () => {
        if (!loaded || !writable) return true;
        if (!flushMaterialUsageInputs()) return false;
        useEditor.getState().commit();
        if (recoveryPromptRef.current) {
          // The untouched recovery is already durable; do not replace it while leaving.
          return confirm('복구본은 이 계정의 기기 저장소에 보관됩니다. 지금 작업 공간을 나갈까요?');
        }
        if (await save()) return true;
        if (scope && !(await persistRecovery())) return false;
        return confirm(
          scope
            ? '클라우드 저장에 실패했어요. 이 기기의 복구본은 같은 계정으로 다시 열 수 있어요. 나갈까요?'
            : '저장하지 못한 변경이 있어요. 그래도 나갈까요?',
        );
      }),
    [loaded, writable, save, scope, persistRecovery],
  );
  useEffect(
    () =>
      registerAccountChangeCheckpoint(async () => {
        if (!loaded || !scope) return;
        const operation = session.current;
        scheduler.dispose();
        if (operation) operation.dead = true;
        applyRequest.current++;
        roomRequest.current++;
        if (!flushMaterialUsageInputs())
          throw new Error(
            '입력 중인 값이 유효하지 않아 작업을 정리하지 못했어요. 이전 계정으로 돌아가 확인해 주세요.',
          );
        useEditor.getState().commit();
        const current = useEditor.getState();
        if (!recoveryPromptRef.current && current.project && current.saveStatus !== 'saved') {
          if (!(await persistRecovery(structuredClone(current.project))))
            throw new Error(
              '이전 계정의 복구본을 저장하지 못했어요. 현재 메모리 작업은 보존했으며 추가 저장을 중단합니다.',
            );
        }
        // Clear private pixels through CanvasWorkspace unmount and clear the shared editor store.
        // Durable recovery/asset caches stay in their original account namespace.
        setLoaded(false);
        setMaterials({});
        setCatalog([]);
        setRecoveryPrompt(null);
        setRecoveryArchives([]);
        useEditor.setState({ project: null, draft: null, selection: null, saveStatus: 'saved', error: '' });
      }),
    [loaded, scope, scheduler, persistRecovery],
  );
  useEffect(() => {
    if (!loaded || !writable) return;
    const operation = session.current;
    const onHistoryNavigation = () => {
      if (!flushMaterialUsageInputs()) return;
      useEditor.getState().commit();
      void save();
    };
    window.addEventListener('popstate', onHistoryNavigation);
    return () => {
      window.removeEventListener('popstate', onHistoryNavigation);
      const current = useEditor.getState(),
        project = current.project;
      if (
        !operation ||
        !project ||
        project.id !== id ||
        current.saveStatus === 'saved' ||
        recoveryPromptRef.current
      )
        return;
      const sent = structuredClone(project);
      if (scope) {
        // SPA history navigation cannot await an effect cleanup; start a durable local write immediately.
        // No request is sent using a possibly changed account cookie.
        void cloudRecovery.write(scope, sent, materialsRef.current).catch(() => {});
        return;
      }
      // Preserve the previous local editor's save-on-unmount contract, scoped and serialized.
      const pending = pendingProjectSaves.get(scopeKey);
      const departure = (async () => {
        try {
          if (pending) {
            if (!(await pending)) return false;
            const latest = await operation.repo.projects.load(id);
            if (projectContentKey(latest) === projectContentKey(sent)) return true;
            if (latest.storageRevision === sent.storageRevision + 1)
              sent.storageRevision = latest.storageRevision;
          }
          const saved = await operation.repo.projects.save(sent, sent.storageRevision);
          if (useEditor.getState().project === project) useEditor.getState().saved(saved);
          return true;
        } catch (failure) {
          if (useEditor.getState().project === project)
            useEditor.getState().failed(failure instanceof Error ? failure.message : String(failure));
          return false;
        }
      })();
      pendingProjectSaves.set(scopeKey, departure);
      void departure.finally(() => {
        if (pendingProjectSaves.get(scopeKey) === departure) pendingProjectSaves.delete(scopeKey);
      });
    };
  }, [loaded, writable, id, scope, scopeKey, save]);
  useEffect(() => {
    const before = (e: BeforeUnloadEvent) => {
      if (useEditor.getState().saveStatus !== 'saved') {
        e.preventDefault();
      }
    };
    window.addEventListener('beforeunload', before);
    return () => window.removeEventListener('beforeunload', before);
  }, []);
  useEffect(() => {
    function key(e: KeyboardEvent) {
      if ((e.target as HTMLElement).matches('input,textarea,select,[contenteditable]')) return;
      if (roomViewerOpen || wallEditor || designsOpen || comparisonOpen || legacyOpen) return;
      if (referenceOpen) {
        if (e.key === 'Escape') setReferenceOpen(false);
        return;
      }
      if (roomOpen) {
        if (e.key === 'Escape') {
          roomRequest.current++;
          setRoomOpen(false);
        }
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && writable) {
        e.preventDefault();
        if (e.shiftKey) useEditor.getState().redo();
        else useEditor.getState().undo();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void save();
      }
      if (e.key === 'Escape') {
        applyRequest.current++;
        setDetectionStatus('');
        setCatalogOpen(false);
        setInspectorOpen(false);
        useEditor.getState().setTool('select');
        useEditor.getState().cancel();
      }
    }
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [
    save,
    writable,
    roomOpen,
    roomViewerOpen,
    wallEditor,
    referenceOpen,
    designsOpen,
    comparisonOpen,
    legacyOpen,
  ]);
  const scene = st.draft || (st.project ? getEditingScene(st.project, st.editing) : undefined);
  async function leave(path: string) {
    if (!flushMaterialUsageInputs()) return;
    useEditor.getState().commit();
    if (recoveryPromptRef.current) {
      if (!confirm('복구본을 보관한 채 프로젝트 목록으로 나갈까요?')) return;
    } else if (!(await save())) {
      if (scope && !(await persistRecovery())) return;
      if (
        !confirm(
          scope
            ? '클라우드 저장에 실패했어요. 복구본은 이 기기에 보관돼요. 그래도 나갈까요?'
            : '저장하지 못한 변경이 있어요. 그래도 나갈까요?',
        )
      )
        return;
    }
    router.push(path);
  }
  function downloadRecovery(record: ProjectRecovery) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(record)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${record.document.name}-복구데이터.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function resolveRecovery(action: 'resume' | 'server' | 'copy') {
    const prompt = recoveryPromptRef.current,
      operation = session.current;
    if (!prompt || !scope || !operation || recoveryBusy) return;
    setRecoveryBusy(true);
    try {
      if (action === 'resume') {
        if (prompt.kind === 'conflict') return;
        const document = structuredClone(prompt.record.document);
        useEditor.getState().load(document);
        useEditor.setState({ saveStatus: 'dirty' });
        setMaterials((previous) => ({ ...previous, ...prompt.record.versions }));
        lastRecoveryContent.current = projectContentKey(document);
        setRecoveryStatus('이 기기에 복구본 저장됨');
        scheduler.start();
        setRecoveryPrompt(null);
      } else if (action === 'server') {
        const server = await operation.repo.projects.load(id);
        const versions = { ...materialsRef.current };
        for (const scene of projectScenes(server)) {
          for (const versionId of [
            ...scene.surfaces.map((surface) => surface.materialVersionId),
            ...scene.fixtures.map((fixture) => fixture.materialVersionId),
          ].filter((value): value is string => !!value)) {
            if (!versions[versionId])
              versions[versionId] = await operation.repo.materials.getVersion(versionId);
          }
        }
        if (operation.dead || currentScopeKey.current !== scopeKey) return;
        await cloudRecovery.archive(scope, prompt.kind === 'conflict' ? 'conflict' : 'dismissed');
        setRecoveryArchives(await cloudRecovery.archives(scope));
        cloudCommittedContent.current = projectContentKey(server);
        useEditor.getState().load(server);
        setMaterials(versions);
        scheduler.start();
        lastSaveError.current = '';
        setRecoveryPrompt(null);
        setRecoveryStatus('이전 복구본은 이 기기에 별도 보관됨');
        setError('');
      } else {
        // Keep a stable creation ID when retrying a lost response.
        recoveryCopy.current ??= duplicateProjectDocument(prompt.record.document);
        recoveryCopy.current.name = (prompt.record.document.name + ' · 복구본').slice(0, 200);
        const copy = await operation.repo.projects.create(recoveryCopy.current);
        if (operation.dead || currentScopeKey.current !== scopeKey) return;
        await cloudRecovery.archive(scope, 'conflict');
        useEditor.setState({ saveStatus: 'saved' });
        setRecoveryPrompt(null);
        router.push('/projects/' + copy.id);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!operation.dead) setRecoveryBusy(false);
    }
  }
  async function analyzePhoto(source: Scene, request: number) {
    const photoId = source.backgroundAssetId || source.previewAssetId;
    const asset = await getRepositories().assets.get(photoId);
    if (asset.kind === 'product-mesh') throw new Error('제품 사진에는 이미지 자산이 필요해요.');
    let pending = detectedPhotos.current.get(photoId);
    if (!pending) {
      pending = (async () => {
        const { segmentRoom } = await import('@/lib/segmentation');
        return segmentRoom(asset.blob, (message: string) => {
          if (applyRequest.current === request) setDetectionStatus(message);
        });
      })();
      detectedPhotos.current.set(photoId, pending);
      void pending.catch(() => detectedPhotos.current.delete(photoId));
    }
    const masks = await pending;
    const geometry = await analyzeWallGeometry(
      asset.blob,
      masks,
      source.surfaces.find((s) => s.kind === 'floor')?.quad,
    );
    const detected = detectSurfaces({
      width: masks.width,
      height: masks.height,
      wallMask: masks.wall,
      floorMask: masks.floor,
      wallSeams: geometry.wallSeams,
    });
    return { ...detected, geometry, warnings: [...detected.warnings, ...geometry.warnings] };
  }
  async function applyMaterial(m: MaterialVersion) {
    if (!writable || !scene || !activeDesign) return;
    const request = ++applyRequest.current;
    setError('');
    setDetectionStatus('');
    if (m.category === 'tile') {
      const captured = useEditor.getState();
      const project = captured.project;
      if (!project || captured.draft) return;
      const source = getEditingScene(project, captured.editing);
      const selected = source.surfaces.find((surface) => surface.id === captured.selection);
      const kind = tab === 'fixtures' ? selected?.kind || (m.usage === 'wall' ? 'wall' : 'floor') : tab;
      if (m.usage !== 'both' && m.usage !== kind) {
        setError('선택한 면에 사용할 수 없는 타일이에요. 벽·바닥 용도를 확인하세요.');
        return;
      }
      if (!m.textureAssetIds.length) {
        setError('이 자재에는 타일 한 장의 텍스처를 먼저 등록해 주세요.');
        return;
      }
      const targets = selected?.kind === kind ? [selected] : source.surfaces.filter((s) => s.kind === kind);
      const additions: typeof targets = [];
      const currentRequest = () => {
        const current = useEditor.getState();
        return (
          applyRequest.current === request &&
          current.project?.id === project.id &&
          current.project.editRevision === project.editRevision &&
          current.project.activeDesignId === project.activeDesignId &&
          current.selection === captured.selection &&
          current.editing === captured.editing &&
          !current.draft
        );
      };
      try {
        if (!targets.length) {
          st.setTool('select');
          setDetectionNotice('');
          setDetectionStatus('사진에서 벽과 바닥을 찾을 준비를 하고 있어요…');
          const detected = await analyzePhoto(source, request);
          if (!currentRequest()) return;
          additions.push(
            ...applyWallGeometry(detected.surfaces, detected.geometry)
              .filter((candidate) => !source.surfaces.some((s) => s.kind === candidate.kind))
              .sort((a, b) => Number(b.kind === kind) - Number(a.kind === kind))
              .slice(0, Math.max(0, 100 - source.surfaces.length)),
          );
          targets.push(...additions.filter((surface) => surface.kind === kind));
          if (!targets.length) {
            setError(
              `${kind === 'wall' ? '벽' : '바닥'} 영역을 찾지 못했어요. 사진으로 비교 공간을 만들거나 기본 공간에서 작업해 주세요.`,
            );
            return;
          }
          setDetectionNotice(
            `${kind === 'wall' ? '벽' : '바닥'} 영역을 자동으로 찾아 적용했어요. 선택한 자재를 바꾸며 비교할 수 있어요.${detected.warnings.length ? ' ' + detected.warnings.join(' ') : ''}`,
          );
        }
        if (!currentRequest()) return;
        const targetIds = new Set(targets.map((surface) => surface.id));
        st.change((s) => {
          s.surfaces.push(...additions);
          for (const sf of s.surfaces)
            if (targetIds.has(sf.id)) {
              sf.materialVersionId = m.id;
              sf.tile.groutWidth = m.defaultGroutWidth;
              sf.tile.groutColor = m.defaultGroutColor;
              sf.tile.pattern = m.defaultPattern;
            }
        });
      } catch (e) {
        if (currentRequest())
          setError(`영역을 자동으로 찾지 못했어요. ${e instanceof Error ? e.message : String(e)}`);
        return;
      } finally {
        if (applyRequest.current === request) setDetectionStatus('');
      }
    } else {
      if (!m.views.length) {
        setError('배치용 제품 이미지를 등록해 주세요.');
        return;
      }
      const captured = useEditor.getState();
      const previous =
        captured.editing === 'before' ? scene.fixtures.find((f) => f.id === captured.selection) : undefined;
      if (previous?.locked) {
        setError('잠긴 모형은 잠금을 해제한 뒤 교체해 주세요.');
        return;
      }
      const fixtureId = previous?.id || crypto.randomUUID();
      const viewIndex = getPreferredProductViewIndex(m);
      const view = m.views[viewIndex];
      const asset = await getRepositories().assets.get(view.assetId);
      if (asset.kind === 'product-mesh') throw new Error('제품 사진에는 이미지 자산이 필요해요.');
      if (
        useEditor.getState().project?.id !== id ||
        useEditor.getState().project?.editRevision !== captured.project?.editRevision ||
        useEditor.getState().project?.activeDesignId !== captured.project?.activeDesignId ||
        useEditor.getState().editing !== captured.editing ||
        useEditor.getState().selection !== captured.selection ||
        !!useEditor.getState().draft ||
        applyRequest.current !== request
      )
        return;
      let width = 0.24;
      let position = { x: 0.5, y: 0.77 };
      const sf =
        scene.surfaces.find((s) => s.id === st.selection) ||
        scene.surfaces.find((s) => s.kind === (m.installation === 'wall' ? 'wall' : 'floor'));
      if (sf) {
        position = {
          x: sf.quad.reduce((a, p) => a + p.x, 0) / 4,
          y: sf.quad.reduce((a, p) => a + p.y, 0) / 4,
        };
        if (sf.calibrated) {
          const h = homography(
            [
              { x: 0, y: 0 },
              { x: 1, y: 0 },
              { x: 1, y: 1 },
              { x: 0, y: 1 },
            ],
            sf.quad,
          );
          const a = transformPoint(h, { x: 0.5, y: 0.5 }),
            b = transformPoint(h, { x: 0.5 + m.widthMm / sf.widthMm, y: 0.5 });
          width = Math.max(
            0.03,
            Math.min(0.8, Math.hypot(b.x - a.x, ((b.y - a.y) * scene.imageHeight) / scene.imageWidth)),
          );
        }
      }
      const roomPlacement = scene.room
        ? await createRoomPlacement(
            m,
            asset,
            m.installation === 'floor'
              ? 'floor'
              : sf?.roomFace && sf.roomFace !== 'floor'
                ? sf.roomFace
                : 'back',
          )
        : undefined;
      if (
        useEditor.getState().project?.id !== id ||
        useEditor.getState().project?.editRevision !== captured.project?.editRevision ||
        useEditor.getState().project?.activeDesignId !== captured.project?.activeDesignId ||
        useEditor.getState().editing !== captured.editing ||
        useEditor.getState().selection !== captured.selection ||
        !!useEditor.getState().draft ||
        applyRequest.current !== request
      )
        return;
      st.change((s) => {
        const fixture = {
          id: fixtureId,
          name: m.name,
          materialVersionId: m.id,
          viewIndex,
          position,
          width,
          height: (((width * scene.imageWidth) / scene.imageHeight) * asset.height) / asset.width,
          rotation: 0,
          anchor: { ...view.anchor },
          locked: false,
          shadow: { x: 0, y: 0.005, opacity: 0.3, blur: 0.015, scale: 0.7 },
          occlusion: EMPTY_MASK(),
          color: { ...DEFAULT_COLOR },
          roomPlacement,
        };
        if (previous?.roomPlacement && fixture.roomPlacement)
          Object.assign(fixture.roomPlacement, {
            face: previous.roomPlacement.face,
            u: previous.roomPlacement.u,
            v: previous.roomPlacement.v,
            scale: previous.roomPlacement.scale,
          });
        if (s.room) projectRoomFixture(s.room, fixture, s.imageWidth / s.imageHeight);
        if (previous) s.fixtures = s.fixtures.map((item) => (item.id === previous.id ? fixture : item));
        else s.fixtures.push(fixture);
      });
      st.select(fixtureId);
      st.setTool('select');
    }
    st.setMode('after');
    setCatalogOpen(false);
  }
  async function resizeRoom(room: RoomDefinition) {
    const captured = useEditor.getState();
    const project = captured.project;
    if (!writable || !project?.shared.baseline.room || captured.draft) return;
    const request = ++roomRequest.current;
    const current = () =>
      roomRequest.current === request &&
      useEditor.getState().project?.id === project.id &&
      useEditor.getState().project?.editRevision === project.editRevision;
    const structureError = projectWallFeatureResizeError(project, room);
    if (structureError) throw new Error(structureError);
    const image = await renderRoomBackground(room);
    if (!current()) return;
    const { original, preview } = await importImage(
      new File([image.blob], '기본 공간.png', { type: 'image/png' }),
      'original',
      getRepositories().assets,
    );
    if (!current()) return;
    const background = {
      originalAssetId: original.id,
      previewAssetId: preview.id,
      imageWidth: original.width,
      imageHeight: original.height,
    };
    useEditor.getState().resizeAll(room, background);
    setRoomOpen(false);
    setDetectionNotice(
      'Before와 모든 시안의 공간 크기·자재 수량·금액을 함께 맞췄어요. 공간 크기 설정에서 변경 직전 전체 복원을 할 수 있어요.',
    );
  }
  async function captureExport(
    outputFormat: 'image/png' | 'image/jpeg',
    comparison: boolean,
    maxEdge = 4096,
  ): Promise<Blob> {
    if (!scene || !st.project || (!renderer.current && !roomContext))
      throw new Error('내보낼 공간이 아직 준비되지 않았어요.');
    try {
      const edge = Math.min(maxEdge, Math.max(scene.imageWidth, scene.imageHeight));
      const w = edge,
        h = edge;
      const snapshot = {
        scene: structuredClone(getActiveScene(st.project)),
        beforeScene: structuredClone(st.project.shared.comparison?.before ?? st.project.shared.baseline),
        materials: structuredClone(materials),
      };
      let blob: Blob;
      if (roomContext) {
        const { RoomViewerRenderer } = await import('@/lib/room-viewer/renderer');
        const roomRenderer = new RoomViewerRenderer();
        try {
          await roomRenderer.setSnapshot(snapshot, assetReader, {
            fitScenes: structuredClone(roomContext.fitScenes),
          });
          blob = await roomRenderer.export(roomContext.view, {
            format: outputFormat === 'image/png' ? 'png' : 'jpeg',
            mode: comparison ? 'compare' : 'after',
            longEdge: edge,
          });
        } finally {
          roomRenderer.dispose();
        }
      } else {
        blob = await renderer.current!.exportImage(snapshot, w, h, outputFormat, comparison);
      }
      return blob;
    } finally {
      const pw = Math.min(2048, scene.imageWidth);
      renderer.current?.render(
        pw,
        Math.round((pw * scene.imageHeight) / scene.imageWidth),
        st.mode,
        st.split,
      );
    }
  }
  async function exportImage() {
    if (exporting || aiExporting) return;
    setExporting(true);
    setError('');
    try {
      const blob = await captureExport(format, compare);
      const url = URL.createObjectURL(blob),
        link = document.createElement('a');
      link.href = url;
      link.download = `${st.project!.name}-${activeDesign?.name ?? '시안'}-${compare ? '비교' : 'After'}.${format === 'image/png' ? 'png' : 'jpg'}`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      setExportModal(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(false);
    }
  }
  async function saveWithThumbnail() {
    if (savingPreview || !writable || !flushMaterialUsageInputs()) return;
    setSavingPreview(true);
    try {
      useEditor.getState().commit();
      await save();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingPreview(false);
    }
  }
  function viewComparison(mode: 'before' | 'after' | 'split') {
    if (!flushMaterialUsageInputs()) return;
    if (st.editing === 'before') {
      st.setEditing('after');
      setBeforeCatalog(false);
      setReviewOpen(false);
    }
    st.setMode(mode);
  }
  function prepareDesignAction() {
    if (!flushMaterialUsageInputs()) return false;
    useEditor.getState().commit();
    applyRequest.current++;
    setDetectionStatus('');
    setError('');
    return true;
  }
  function activateDesign(designId: string) {
    if (!prepareDesignAction()) return;
    useEditor.getState().selectDesign(designId);
    if (!writable) useEditor.setState({ saveStatus: 'saved' });
    setDesignsOpen(false);
    setComparisonOpen(false);
  }
  function toggleComparison(designId: string) {
    useEditor.getState().toggleDesignComparison(designId);
    if (!writable) useEditor.setState({ saveStatus: 'saved' });
    const message = useEditor.getState().error;
    if (message) throw new Error(message);
  }
  function openDesignComparison() {
    if (!prepareDesignAction()) return;
    if ((useEditor.getState().project?.comparisonDesignIds.length ?? 0) < 2) {
      setDesignsOpen(true);
      return;
    }
    setDesignsOpen(false);
    setComparisonOpen(true);
    setHasCompared(true);
  }
  function restoreRoom(redo: boolean) {
    if (
      !writable ||
      !window.confirm(
        redo
          ? '전체 복원 직전의 작업으로 다시 돌아갈까요? Before와 모든 시안·자재 수량·금액을 함께 바꿉니다.'
          : '크기 변경 직전으로 전체 복원할까요? 이후의 Before 수정, 시안 편집·생성·삭제, 자재 수량·금액 변경도 모두 되돌립니다. 전체 다시 실행으로 회수할 수 있어요.',
      )
    )
      return;
    if (!prepareDesignAction()) return;
    if (redo) useEditor.getState().redoRoomChange();
    else useEditor.getState().restoreRoomChange();
    setRoomOpen(false);
  }
  if (!loaded || !st.project || !scene)
    return (
      <main className="auth-page">
        <div className="stack" style={{ alignItems: 'center' }}>
          <Layers size={30} />
          <p>{error || '작업 공간을 불러오고 있어요…'}</p>
          {error && (
            <button className="btn" onClick={() => router.push('/')}>
              프로젝트 목록
            </button>
          )}
        </div>
      </main>
    );
  const items = catalog.filter(
    ({ material, version: v }) =>
      material.active &&
      (tab === 'fixtures'
        ? v.category !== 'tile'
        : v.category === 'tile' && (v.usage === 'both' || v.usage === tab)) &&
      `${v.name} ${v.brand} ${v.code}`.toLowerCase().includes(search.toLowerCase()),
  );
  const hasSaveError = st.saveStatus === 'error' || (!!scope && !!lastSaveError.current);
  const status =
    st.saveStatus === 'saved'
      ? storageMode === 'local'
        ? '이 브라우저에 저장됨'
        : '클라우드에 저장됨'
      : st.saveStatus === 'saving'
        ? '저장 중…'
        : hasSaveError
          ? '저장 실패 · 다시 시도'
          : '변경사항 저장 대기';
  const chosenSurface = scene.surfaces.find((s) => s.id === st.selection && s.kind === tab);
  const applicableSurfaces = chosenSurface ? [chosenSurface] : scene.surfaces.filter((s) => s.kind === tab);
  return (
    <div className="editor-shell" data-comparison={!!st.project.shared.comparison}>
      <header className="editor-top">
        <button className="icon-btn" aria-label="프로젝트 목록으로" onClick={() => leave('/')}>
          <ArrowLeft size={18} />
        </button>
        <button
          className="editor-brand"
          style={{ background: 'none', borderTop: 0, borderLeft: 0, borderBottom: 0 }}
          onClick={() => leave('/')}
        >
          <span className="brand-mark">
            <Layers size={19} />
          </span>
          <span>공간미리</span>
        </button>
        <div className="top-project">
          <input
            className="editor-title"
            aria-label="프로젝트명"
            value={st.project.name}
            disabled={!writable}
            onChange={(e) => st.renamed(e.target.value)}
          />
          <span className="save-state" data-testid="save-status">
            {status}
          </span>
          {scope && recoveryStatus && (
            <span className="save-state" data-testid="recovery-status">
              {recoveryStatus}
            </span>
          )}
          {hasSaveError && !error && !st.error && (
            <button className="text-button" onClick={() => void saveWithThumbnail()}>
              저장 다시 시도
            </button>
          )}
        </div>
        <div className="top-actions">
          <div className="row undo-redo">
            <button
              className="icon-btn"
              title="실행 취소 (Ctrl+Z)"
              aria-label="실행 취소"
              disabled={
                !writable ||
                !(st.editing === 'before'
                  ? st.project.shared.beforeHistory.past.length
                  : activeDesign?.history.past.length)
              }
              onClick={st.undo}
            >
              <Undo2 size={17} />
            </button>
            <button
              className="icon-btn"
              title="다시 실행 (Ctrl+Shift+Z)"
              aria-label="다시 실행"
              disabled={
                !writable ||
                !(st.editing === 'before'
                  ? st.project.shared.beforeHistory.future.length
                  : activeDesign?.history.future.length)
              }
              onClick={st.redo}
            >
              <Redo2 size={17} />
            </button>
          </div>
          <div className="divider" />
          <div className="segmented">
            <button
              disabled={!!st.draft || !!detectionStatus}
              className={st.mode === 'before' ? 'active' : ''}
              onClick={() => viewComparison('before')}
            >
              Before
            </button>
            <button
              disabled={!!st.draft || !!detectionStatus}
              className={st.mode === 'after' && st.editing === 'after' ? 'active' : ''}
              onClick={() => viewComparison('after')}
            >
              After
            </button>
          </div>
          <button
            className={`icon-btn ${st.mode === 'split' ? 'active' : ''}`}
            disabled={!!st.draft || !!detectionStatus}
            title="드래그 비교"
            aria-label="드래그 비교"
            onClick={() => viewComparison(st.mode === 'split' ? 'after' : 'split')}
          >
            <Columns2 size={17} />
          </button>
          <div className="divider" />
          <button
            className="btn room-open-button"
            aria-label="공간 둘러보기"
            disabled={!!detectionStatus || !activeDesign}
            onClick={() => {
              if (!prepareDesignAction()) return;
              setRoomViewerOpen(true);
            }}
          >
            <Layers size={16} />
            공간 둘러보기
          </button>
          <button className="btn ai-button" onClick={() => setAi(true)}>
            <Sparkles size={15} />
            AI 고화질 보정<span className="badge">연결 필요</span>
          </button>
          <button
            className="icon-btn"
            title="지금 저장"
            aria-label="지금 저장"
            disabled={!writable || savingPreview}
            onClick={() => void saveWithThumbnail()}
          >
            <Save size={17} />
          </button>
          {scene.room && (
            <button
              className="btn room-open-button"
              aria-label="공간 크기"
              title="공간 크기"
              disabled={!writable || !!st.draft || !!detectionStatus}
              onClick={() => setRoomOpen(true)}
            >
              <Ruler size={16} />
              <span>공간 크기</span>
            </button>
          )}
          <button
            className="btn primary"
            aria-label="내보내기"
            disabled={comparisonOpen || !activeDesign || exporting || st.editing === 'before' || !!st.draft}
            onClick={() => setExportModal(true)}
          >
            <Download size={15} />
            <span className="export-label">내보내기</span>
          </button>
          <button className="icon-btn" title="사용 도움말" onClick={() => setHelp(true)}>
            <HelpCircle size={17} />
          </button>
        </div>
      </header>
      <div className="design-toolbar">
        <div className="row">
          <strong data-testid="active-design-name">{activeDesign?.name ?? '시안이 없어요'}</strong>
          <span className="muted">
            시안 {st.project.designs.length}/{MAX_DESIGNS}
          </span>
          <button
            className="btn small"
            onClick={() => {
              if (!prepareDesignAction()) return;
              setDesignsOpen(true);
            }}
          >
            시안 관리
          </button>
        </div>
        <div className="row">
          <span className="muted">
            비교 선택 {st.project.comparisonDesignIds.length}/{MAX_COMPARISON_DESIGNS}
          </span>
          <button className="btn small" onClick={openDesignComparison}>
            <Columns2 size={15} />
            {hasCompared && !comparisonOpen ? '시안 비교로 돌아가기' : '시안 비교'}
          </button>
          {st.project.shared.legacyHistory && (
            <button className="text-button" onClick={() => setLegacyOpen(true)}>
              이전 편집 기록
            </button>
          )}
        </div>
      </div>
      {scope && recoveryArchives.length > 0 && (
        <details style={{ padding: '4px 16px' }}>
          <summary>보관된 복구본 {recoveryArchives.length}개</summary>
          {recoveryArchives.map((record, index) => (
            <div className="row" key={record.savedAt + index}>
              <span>
                {new Date(record.savedAt).toLocaleString()} · {record.document.name}
              </span>
              <button className="btn small" onClick={() => downloadRecovery(record)}>
                복구 데이터 다운로드
              </button>
              <button
                className="btn small"
                disabled={!writable}
                onClick={async () => {
                  if (!flushMaterialUsageInputs()) return;
                  useEditor.getState().commit();
                  if (!(await save())) return;
                  recoveryCopy.current = null;
                  setRecoveryPrompt({ record, kind: 'conflict' });
                }}
              >
                새 프로젝트로 복원
              </button>
            </div>
          ))}
        </details>
      )}
      {st.project.shared.comparison && (
        <div className={reconstructionStyles.bar}>
          <div>
            <strong>
              {st.editing === 'before'
                ? 'BEFORE · 기존 공간 재구성 중'
                : st.mode === 'before'
                  ? 'BEFORE · 사진에서 재구성한 기존 공간'
                  : st.mode === 'split'
                    ? 'BEFORE / AFTER · 같은 방, 같은 각도'
                    : 'AFTER · 새 공간 꾸미기'}
            </strong>
            <p>
              {st.editing === 'before'
                ? '사진과 초안을 비교하며 색감·기구 배치를 확인하세요.'
                : st.mode === 'before'
                  ? '기존 공간을 보고 있어요. 새 디자인을 계속 꾸미려면 상단 After를 누르세요.'
                  : '사진에서 만든 Before는 보관돼요. 새 타일과 제품은 After에 배치하고 자재 수량·금액에 반영해요.'}
            </p>
          </div>
          <div className={reconstructionStyles.barActions}>
            <button className="btn small" onClick={() => setReferenceOpen(true)}>
              참고 사진 보기
            </button>
            {st.editing === 'before' ? (
              <>
                <button
                  className="btn small"
                  onClick={() => {
                    setReviewOpen((v) => !v);
                    setBeforeCatalog(false);
                  }}
                >
                  초안 보정
                </button>
                <button
                  className="btn small"
                  onClick={() => {
                    setBeforeCatalog((v) => !v);
                    setCatalogOpen(true);
                    setReviewOpen(false);
                  }}
                >
                  등록 자재 보기
                </button>
                <button
                  className="btn primary small"
                  disabled={!writable || !!st.draft || !!detectionStatus}
                  onClick={() => {
                    viewComparison('after');
                  }}
                >
                  After 꾸미기로 돌아가기
                </button>
              </>
            ) : (
              <button
                className="btn small"
                disabled={!writable || !!st.draft || !!detectionStatus}
                onClick={() => {
                  st.setEditing('before');
                  setReviewOpen(true);
                  setBeforeCatalog(false);
                }}
              >
                기존 공간 수정
              </button>
            )}
          </div>
        </div>
      )}
      <button
        className={`drawer-scrim ${catalogOpen || inspectorOpen ? 'visible' : ''}`}
        aria-label="패널 닫기"
        onClick={() => {
          setCatalogOpen(false);
          setInspectorOpen(false);
        }}
      />
      {roomViewerOpen && (
        <RoomViewer
          project={st.project}
          materials={materials}
          assetReader={assetReader}
          writable={writable}
          onView={st.setRoomView}
          saveStatus={st.saveStatus}
          saveError={st.error}
          onSave={() => void save()}
          onDesign={activateDesign}
          onClose={() => setRoomViewerOpen(false)}
        />
      )}
      {comparisonOpen ? (
        <DesignComparison
          projectId={st.project.id}
          roomContext={roomContext}
          sharedRevision={st.project.shared.revision}
          designs={st.project.comparisonDesignIds
            .map((designId) => st.project!.designs.find((d) => d.id === designId)!)
            .filter(Boolean)}
          materials={materials}
          assetReader={assetReader}
          writable={writable}
          onEdit={activateDesign}
          onExclude={toggleComparison}
          onAddDesigns={() => setDesignsOpen(true)}
          onClose={() => setComparisonOpen(false)}
        />
      ) : !activeDesign ? (
        <main className="empty-design-state">
          <Layers size={32} />
          <h2>새 시안으로 시작하세요</h2>
          <p>기준 공간과 Before는 보관돼 있어요. 새 시안에서 타일과 제품을 배치할 수 있어요.</p>
          <button className="btn primary" disabled={!writable} onClick={() => st.createDesign()}>
            새 시안 만들기
          </button>
        </main>
      ) : (
        <div className="editor-body">
          {st.editing === 'before' && st.project.shared.comparison && (
            <ReconstructionReviewPanel
              open={reviewOpen}
              onClose={() => setReviewOpen(false)}
              onMaterialsChanged={refresh}
              onError={onError}
              onShowProperties={() => {
                setInspectorOpen(true);
                if (window.innerWidth <= 900) setReviewOpen(false);
              }}
            />
          )}
          {(st.editing !== 'before' || beforeCatalog) && (
            <aside className={`catalog-panel ${catalogOpen ? 'open' : ''}`}>
              <div className="panel-title">
                자재 라이브러리
                <div className="row">
                  <button
                    className="icon-btn mobile-close"
                    aria-label="자재 패널 닫기"
                    onClick={() => setCatalogOpen(false)}
                  >
                    <X size={17} />
                  </button>
                  {canManageCatalog && (
                    <button
                      className="icon-btn"
                      title="자재 등록"
                      aria-label="신규 자재 등록"
                      disabled={!writable}
                      onClick={() => setForm(true)}
                    >
                      <Plus size={17} />
                    </button>
                  )}
                </div>
              </div>
              <div className="catalog-tabs">
                <button
                  className={tab === 'wall' ? 'active' : ''}
                  onClick={() => {
                    setTab('wall');
                    st.select(null);
                    st.setTool('select');
                    applyRequest.current++;
                    setDetectionStatus('');
                  }}
                >
                  벽 타일
                </button>
                <button
                  className={tab === 'floor' ? 'active' : ''}
                  onClick={() => {
                    setTab('floor');
                    st.select(null);
                    st.setTool('select');
                    applyRequest.current++;
                    setDetectionStatus('');
                  }}
                >
                  바닥 타일
                </button>
                <button
                  className={tab === 'fixtures' ? 'active' : ''}
                  onClick={() => {
                    setTab('fixtures');
                    applyRequest.current++;
                    setDetectionStatus('');
                  }}
                >
                  위생도기
                </button>
              </div>
              {tab === 'fixtures' && (
                <div style={{ margin: '0 16px 12px', display: 'grid', gap: 8 }}>
                  <p className="muted" style={{ fontSize: 11, lineHeight: 1.6 }}>
                    등록한 도기를 눌러 배치하고, 화면에서 선택해 이동·삭제할 수 있어요. 기본 벽과 바닥은
                    유지돼요.
                  </p>
                </div>
              )}
              {tab !== 'fixtures' && (
                <label className="catalog-target">
                  적용 위치
                  <select
                    aria-label="타일 적용 위치"
                    value={
                      scene.surfaces.some((s) => s.id === st.selection && s.kind === tab)
                        ? st.selection!
                        : 'all'
                    }
                    onChange={(e) => {
                      st.select(e.target.value === 'all' ? null : e.target.value);
                      st.setTool('select');
                      applyRequest.current++;
                      setDetectionStatus('');
                    }}
                  >
                    <option value="all">전체 {tab === 'wall' ? '벽' : '바닥'}</option>
                    {scene.surfaces
                      .filter((s) => s.kind === tab)
                      .map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                  </select>
                </label>
              )}
              <label className="search-box catalog-search">
                <Search size={14} />
                <input
                  aria-label="편집기 자재 검색"
                  placeholder="자재명, 브랜드 검색"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </label>
              <div className="catalog-grid">
                {items.length === 0 && (
                  <div className="empty-catalog">
                    등록된 자재가 없어요.
                    <br />내 상품 이미지를 등록해 주세요.
                  </div>
                )}
                {items.map(({ version: v }) => (
                  <button
                    key={v.id}
                    className={`material-tile ${applicableSurfaces.length > 0 && applicableSurfaces.every((s) => s.materialVersionId === v.id) ? 'selected' : ''}`}
                    disabled={!writable}
                    onClick={() =>
                      void applyMaterial(v).catch((e) => setError(e instanceof Error ? e.message : String(e)))
                    }
                    title={`${v.name} 적용`}
                  >
                    <div className="swatch">
                      <AssetImage
                        assetId={getMaterialImageAssetId(v)}
                        alt={v.name}
                        className={v.category === 'tile' ? '' : 'product-image'}
                      />
                    </div>
                    <strong>{v.name}</strong>
                    <small>
                      {v.widthMm} × {v.heightMm} mm{v.scope === 'shared' ? ' · 공용' : ''}
                    </small>
                  </button>
                ))}
              </div>
              <div className="catalog-footer">
                {canManageCatalog && (
                  <button className="btn" disabled={!writable} onClick={() => setForm(true)}>
                    <Plus size={14} />내 자재 등록하기
                  </button>
                )}
                <button className="text-button" style={{ fontSize: 11 }} onClick={() => leave('/materials')}>
                  자재 관리 열기
                  <ExternalLink size={12} />
                </button>
              </div>
            </aside>
          )}
          {roomContext ? (
            <RoomCanvasWorkspace
              materials={materials}
              assetReader={assetReader}
              onError={onError}
              showCatalog={() => {
                if (st.editing === 'before') {
                  setReviewOpen((value) => !value);
                  setBeforeCatalog(false);
                } else setCatalogOpen((value) => !value);
                setInspectorOpen(false);
              }}
              showInspector={() => {
                setInspectorOpen((value) => !value);
                setCatalogOpen(false);
              }}
            />
          ) : (
            <CanvasWorkspace
              materials={materials}
              onRenderer={onRenderer}
              onError={onError}
              showCatalog={() => {
                if (st.editing === 'before') {
                  setReviewOpen((v) => !v);
                  setBeforeCatalog(false);
                } else setCatalogOpen((v) => !v);
                setInspectorOpen(false);
              }}
              showInspector={() => {
                setInspectorOpen((v) => !v);
                setCatalogOpen(false);
              }}
            />
          )}
          <div className={`usage-drawer ${inspectorOpen ? 'open' : ''}`}>
            <MaterialUsagePanel
              key={activeDesign.id}
              design={activeDesign}
              materials={materials}
              currentCatalog={catalog}
              assetReader={assetReader}
              writable={writable && st.editing === 'after' && !st.draft && !detectionStatus}
              beforeViewing={st.mode !== 'after' || st.editing === 'before'}
              onChange={st.changeMaterialUsage}
              onClose={() => setInspectorOpen(false)}
            >
              <details className="usage-properties" open>
                <summary>편집 속성</summary>
                <Inspector
                  embedded
                  materials={materials}
                  open={inspectorOpen}
                  onClose={() => setInspectorOpen(false)}
                  onRoomResize={() => setRoomOpen(true)}
                  onWallFeatures={() => {
                    if (!writable || !flushMaterialUsageInputs()) return;
                    useEditor.getState().commit();
                    const current = useEditor.getState();
                    if (!current.project) return;
                    setWallEditor({
                      projectId: current.project.id,
                      editRevision: current.project.editRevision,
                      activeDesignId: current.project.activeDesignId,
                      editing: current.editing,
                      scene: structuredClone(getEditingScene(current.project, current.editing)),
                    });
                  }}
                  onMaterialsChanged={refresh}
                />
              </details>
            </MaterialUsagePanel>
          </div>
        </div>
      )}
      {designsOpen && (
        <DesignManager
          projectId={st.project.id}
          roomContext={roomContext}
          sharedRevision={st.project.shared.revision}
          designs={st.project.designs}
          activeDesignId={st.project.activeDesignId}
          comparisonDesignIds={st.project.comparisonDesignIds}
          materials={materials}
          assetReader={assetReader}
          writable={writable}
          onCreate={(name) => {
            if (writable) {
              if (!prepareDesignAction()) return;
              st.createDesign(name);
            }
          }}
          onDuplicate={(designId) => {
            if (writable) {
              if (!prepareDesignAction()) return;
              st.copyDesign(designId);
            }
          }}
          onRename={(designId, name) => {
            if (writable) st.renameDesign(designId, name);
          }}
          onDelete={(designId) => {
            if (writable) {
              if (!prepareDesignAction()) return;
              st.deleteDesign(designId);
            }
          }}
          onActivate={activateDesign}
          onToggleComparison={toggleComparison}
          onCompare={openDesignComparison}
          onClose={() => setDesignsOpen(false)}
        />
      )}
      {!error && (detectionStatus || detectionNotice) && (
        <div
          className="detection-toast"
          role="status"
          aria-live="polite"
          data-testid={detectionStatus ? 'auto-detection-status' : 'auto-detection-notice'}
        >
          <span>{detectionStatus || detectionNotice}</span>
          <button
            className="icon-btn"
            aria-label={detectionStatus ? '영역 찾기 취소' : '자동 적용 안내 닫기'}
            onClick={() => {
              applyRequest.current++;
              setDetectionStatus('');
              setDetectionNotice('');
            }}
          >
            <X size={16} />
          </button>
        </div>
      )}
      {(error || st.error) && (
        <div role="alert" className="editor-error row between">
          <span>{error || st.error}</span>
          {hasSaveError && !recoveryPrompt && (
            <button className="btn small" disabled={savingPreview} onClick={() => void saveWithThumbnail()}>
              저장 다시 시도
            </button>
          )}
          <button
            className="icon-btn"
            aria-label="오류 닫기"
            onClick={() => {
              setError('');
              useEditor.setState({ error: '' });
            }}
          >
            <X size={15} />
          </button>
        </div>
      )}
      {form && canManageCatalog && (
        <div className="modal" role="dialog" aria-modal="true" aria-label="신규 자재 등록">
          <div className="modal-card">
            <MaterialForm
              onCancel={() => setForm(false)}
              onSaved={(v) => {
                setMaterials((prev) => ({ ...prev, [v.id]: v }));
                void refresh();
                setForm(false);
              }}
            />
          </div>
        </div>
      )}
      {recoveryPrompt && (
        <div className="modal" role="dialog" aria-modal="true" aria-label="클라우드 작업 복구">
          <div className="modal-card" style={{ maxWidth: 680 }}>
            <h2>
              {recoveryPrompt.kind === 'conflict'
                ? '서버 저장본과 다른 복구본이 있어요'
                : '이 기기에 저장한 작업이 있어요'}
            </h2>
            <p>
              {new Date(recoveryPrompt.record.savedAt).toLocaleString()} ·{' '}
              {recoveryPrompt.record.document.name}
            </p>
            <p>
              {recoveryPrompt.kind === 'conflict'
                ? '서버본과 복구본을 모두 보존해요. 복구본은 새 프로젝트로 만들 수 있고, 기존 서버본을 덮어쓰지 않아요.'
                : recoveryPrompt.kind === 'unavailable'
                  ? '서버 저장본을 확인하지 못했어요. 같은 계정의 기기 복구본으로 작업할 수 있어요. 연결 후 서버본과 다르면 별도 프로젝트로 복원합니다.'
                  : '마지막 클라우드 저장 이후의 변경이 있어요. 복구본을 이어서 편집하거나 서버 저장본을 사용할 수 있어요.'}
            </p>
            <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
              {recoveryPrompt.kind !== 'conflict' && (
                <button
                  className="btn primary"
                  disabled={recoveryBusy || !writable}
                  onClick={() => void resolveRecovery('resume')}
                >
                  복구본 이어서 편집
                </button>
              )}
              <button
                className="btn"
                disabled={recoveryBusy || !writable}
                onClick={() => void resolveRecovery('copy')}
              >
                새 프로젝트로 복원
              </button>
              <button className="btn" disabled={recoveryBusy} onClick={() => void resolveRecovery('server')}>
                서버 저장본 사용 · 복구본 보관
              </button>
              <button className="btn" onClick={() => downloadRecovery(recoveryPrompt.record)}>
                복구 데이터 다운로드
              </button>
              <button className="btn" disabled={recoveryBusy} onClick={() => void leave('/')}>
                목록으로
              </button>
            </div>
            <p className="muted">
              복구 데이터에는 장면과 자산 참조가 포함돼요. 이미지·3D 파일 자체는 별도 클라우드 자산입니다.
            </p>
          </div>
        </div>
      )}
      {legacyOpen && st.project.shared.legacyHistory && (
        <div className="modal" role="dialog" aria-modal="true" aria-label="이전 버전 편집 기록">
          <div className="modal-card">
            <div className="modal-header">
              <h2>이전 편집 기록</h2>
              <button className="btn" onClick={() => setLegacyOpen(false)}>
                닫기
              </button>
            </div>
            <p>이전 버전의 기록을 별도 프로젝트로 복원해요. 현재 시안은 유지돼요.</p>
            {[
              ...st.project.shared.legacyHistory.past.map((frame, i) => ({
                frame,
                label: `이전 기록 ${i + 1}`,
              })),
              ...st.project.shared.legacyHistory.future.map((frame, i) => ({
                frame,
                label: `다시 실행 기록 ${i + 1}`,
              })),
            ].map(({ frame, label }) => (
              <div className="row between" key={label} style={{ marginTop: 10 }}>
                <span>
                  {label} · 제품 {frame.fixtures.length}개
                </span>
                <button
                  className="btn small"
                  disabled={!writable}
                  onClick={async () => {
                    try {
                      if (!prepareDesignAction()) return;
                      const restored = createProjectFromLegacyFrame(useEditor.getState().project!, frame);
                      await getRepositories().projects.create(restored);
                      await leave('/projects/' + restored.id);
                    } catch (failure) {
                      setError(failure instanceof Error ? failure.message : String(failure));
                    }
                  }}
                >
                  별도 프로젝트로 복원
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
      {referenceOpen && st.project.shared.comparison && (
        <div
          className={reconstructionStyles.backdrop}
          role="dialog"
          aria-modal="true"
          aria-label="기존 공간 참고 사진"
          onClick={() => setReferenceOpen(false)}
        >
          <div className={reconstructionStyles.referenceModal} onClick={(e) => e.stopPropagation()}>
            <div className="row between">
              <h3>기존 공간 참고 사진</h3>
              <button className="btn" autoFocus onClick={() => setReferenceOpen(false)}>
                닫기
              </button>
            </div>
            <AssetImage
              assetId={st.project.shared.comparison.referenceOriginalAssetId}
              alt="기존 공간 원본 사진"
            />
          </div>
        </div>
      )}
      {wallEditor?.scene.room && (
        <WallFeaturesDialog
          room={wallEditor.scene.room}
          initial={wallEditor.scene.wallFeatures ?? []}
          targetName={wallEditor.editing === 'before' ? '공통 Before' : (activeDesign?.name ?? 'After')}
          onClose={() => setWallEditor(null)}
          onApply={(features) => {
            const current = useEditor.getState();
            if (
              !writable ||
              !current.project ||
              current.project.id !== wallEditor.projectId ||
              current.project.editRevision !== wallEditor.editRevision ||
              current.editing !== wallEditor.editing ||
              current.project.activeDesignId !== wallEditor.activeDesignId ||
              current.draft
            )
              throw new Error('편집 중 공간이 바뀌었어요. 창을 닫고 현재 공간에서 다시 열어 주세요.');
            if (JSON.stringify(wallEditor.scene.wallFeatures ?? []) !== JSON.stringify(features))
              current.change((target) => {
                if (features.length) target.wallFeatures = structuredClone(features);
                else delete target.wallFeatures;
              });
            setWallEditor(null);
            setRoomViewerOpen(true);
          }}
        />
      )}
      {roomOpen && st.project.shared.baseline.room && (
        <RoomDialog
          mode="resize"
          initial={st.project.shared.baseline.room}
          affectedDesignCount={st.project.designs.length}
          onRestore={st.project.roomHistory?.past ? () => restoreRoom(false) : undefined}
          onRedoRestore={st.project.roomHistory?.future ? () => restoreRoom(true) : undefined}
          resetWarnings={[
            ...st.project.designs.flatMap((design) =>
              roomResetWarnings(design.scene).map((w) => design.name + ': ' + w),
            ),
            ...(st.project.shared.comparison
              ? roomResetWarnings(st.project.shared.comparison.before).map((w) => 'Before: ' + w)
              : []),
          ]}
          onApply={resizeRoom}
          onClose={() => {
            roomRequest.current++;
            setRoomOpen(false);
          }}
        />
      )}
      {exportModal && (
        <div className="modal" role="dialog" aria-modal="true" aria-label="이미지 내보내기">
          <div className="modal-card" style={{ maxWidth: 1000 }}>
            <div className="modal-header">
              <h2>결과 이미지 저장</h2>
              <button
                className="icon-btn"
                onClick={() => {
                  setExportModal(false);
                  setAiExporting(false);
                }}
              >
                <X size={18} />
              </button>
            </div>
            <div className="field-grid">
              <label className="field">
                이미지 구성
                <select
                  className="input"
                  value={compare ? 'compare' : 'after'}
                  onChange={(e) => setCompare(e.target.value === 'compare')}
                >
                  <option value="after">현재 After</option>
                  <option value="compare">Before / After 좌우 비교</option>
                </select>
              </label>
              <label className="field">
                파일 형식
                <select
                  className="input"
                  value={format}
                  onChange={(e) => setFormat(e.target.value as typeof format)}
                >
                  <option value="image/png">PNG</option>
                  <option value="image/jpeg">JPG</option>
                </select>
              </label>
            </div>
            <div className="export-preview">
              <Check size={17} style={{ display: 'inline', marginRight: 8 }} />
              자재·배치·색감 반영 · 편집 도구 제외
              <br />
              <small>원본 크기 이내, 전체 긴 변 최대 4096px</small>
            </div>
            <p className="muted" style={{ fontSize: 12 }}>
              가상 시공 이미지이며 실제 색상, 치수, 설치 가능 여부는 실측 및 현장 확인이 필요합니다.
            </p>
            <AiExport
              key={`${scopeKey}-${activeDesign?.id}`}
              capture={() => captureExport('image/png', false, 1024)}
              filename={`${st.project?.name ?? '공간'}-${activeDesign?.name ?? '시안'}`}
              userId={userId}
              disabled={exporting}
              onBusyChange={setAiExporting}
            />
            <div className="modal-footer">
              <button
                className="btn"
                onClick={() => {
                  setExportModal(false);
                  setAiExporting(false);
                }}
              >
                닫기
              </button>
              <button
                className="btn primary"
                disabled={exporting || aiExporting}
                onClick={() => void exportImage()}
              >
                <Download size={15} />
                {exporting ? '이미지 만드는 중…' : '이미지 다운로드'}
              </button>
            </div>
          </div>
        </div>
      )}
      {(help || ai) && (
        <div className="modal" role="dialog" aria-modal="true">
          <div className="modal-card" style={{ maxWidth: 580 }}>
            <div className="modal-header">
              <h2>{ai ? 'AI 고화질 보정 · 연결 필요' : '공간미리 사용 안내'}</h2>
              <button
                className="icon-btn"
                onClick={() => {
                  setHelp(false);
                  setAi(false);
                }}
              >
                <X size={18} />
              </button>
            </div>
            {ai ? (
              <p className="muted">
                벽·바닥 찾기는 브라우저 안에서 자동으로 처리합니다. AI 고화질 보정·자동 배경 제거와 3D 배치는
                아직 연결되지 않았습니다. 이 버튼은 사진을 전송하거나 비용을 발생시키지 않습니다.
              </p>
            ) : (
              <ol className="help-list">
                <li>‘벽 타일’이나 ‘바닥 타일’을 선택한 뒤 원하는 자재를 누르면 해당 영역에 바로 적용돼요.</li>
                <li>
                  처음에는 사진에서 영역을 자동으로 찾아요. 적용 위치에서 전체 또는 개별 면을 선택할 수
                  있어요.
                </li>
                <li>기본 벽과 바닥은 삭제되지 않아요. 타일은 변경하거나 적용을 해제할 수 있어요.</li>
                <li>제품은 화면에서 선택해 이동·크기 조절·삭제하고, 잠금으로 고정할 수 있어요.</li>
                <li>공간 크기에서 가로·깊이·높이를 바꾸면 타일과 제품 크기가 함께 맞춰져요.</li>
                <li>
                  Before / After 비교 후 이미지를 내려받으세요. Ctrl+S 저장, Ctrl+Z 실행 취소를 지원해요.
                </li>
              </ol>
            )}
            <p className="notice" style={{ fontSize: 12, marginTop: 20 }}>
              로컬 프로젝트는 이 브라우저에만 저장됩니다. 브라우저 데이터를 삭제하면 프로젝트도 사라질 수
              있어요. 이미지 내보내기는 편집 가능한 프로젝트 백업이 아닙니다.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
