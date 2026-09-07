'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
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
import MaterialUsagePanel, { flushMaterialUsageInputs } from '@/components/materials/material-usage-panel';
import { useEditor } from '@/lib/editor-store';
import {
  getActiveDesign,
  getActiveScene,
  createProjectFromLegacyFrame,
  MAX_DESIGNS,
  MAX_COMPARISON_DESIGNS,
} from '@/lib/designs';
import { useDesignThumbnail } from '@/components/designs/use-design-preview';
import DesignManager from '@/components/designs/design-manager';
import DesignComparison from '@/components/designs/design-comparison';
import { getEditingScene, projectScenes } from '@/lib/comparison';
import ReconstructionReviewPanel from '@/components/reconstruction/reconstruction-review';
import reconstructionStyles from '@/components/reconstruction/reconstruction.module.css';
import { DEFAULT_COLOR, EMPTY_MASK, type Material, type MaterialVersion, type Scene } from '@/lib/types';
import { AssetImage } from '@/components/materials/asset-image';
import { MaterialForm } from '@/components/materials/material-form';
import { useAccess } from '../app-provider';
import CanvasWorkspace from './canvas-workspace';
import Inspector from './inspector';
import type { PhotoCompositor } from '@/lib/render/compositor';
import { isBuiltInExampleMaterial } from '@/lib/catalog-visibility';
import { importImage } from '@/lib/images';
import RoomDialog from '@/components/rooms/room-dialog';
import type { RoomDefinition } from '@/lib/room-types';
import { renderRoomBackground } from '@/lib/room-background';
import { roomResetWarnings } from '@/lib/room-editing';
import { createRoomPlacement, projectRoomFixture } from '@/lib/room-fixtures';
import { homography, transformPoint } from '@/lib/render/math';
import { detectSurfaces } from '@/lib/render/auto-surfaces';
import type { RoomSegmentation } from '@/lib/segmentation';
import { analyzeWallGeometry, applyWallGeometry } from '@/lib/render/wall-geometry';
const pendingProjectSaves = new Map<string, Promise<void>>();
export default function Editor({ id }: { id: string }) {
  const st = useEditor(),
    router = useRouter(),
    { writable, ready, mode: storageMode } = useAccess();
  const [catalog, setCatalog] = useState<{ material: Material; version: MaterialVersion }[]>([]),
    [materials, setMaterials] = useState<Record<string, MaterialVersion>>({}),
    [error, setError] = useState(''),
    [tab, setTab] = useState<'wall' | 'floor' | 'fixtures'>('floor'),
    [search, setSearch] = useState(''),
    [form, setForm] = useState(false),
    [help, setHelp] = useState(false),
    [ai, setAi] = useState(false),
    [exporting, setExporting] = useState(false),
    [exportModal, setExportModal] = useState(false),
    [roomOpen, setRoomOpen] = useState(false),
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
  const activeDesign = st.project ? getActiveDesign(st.project) : undefined;
  const assetReader = useCallback((assetId: string) => getRepositories().assets.get(assetId), []);
  useDesignThumbnail({
    projectId: id,
    sharedRevision: st.project?.shared.revision ?? 0,
    design: loaded ? (activeDesign ?? null) : null,
    materials,
    assetReader,
    enabled: loaded && !comparisonOpen && !designsOpen && !st.draft && !detectionStatus,
    delayMs: 500,
  });
  const renderer = useRef<PhotoCompositor | null>(null);
  const applyRequest = useRef(0);
  const roomRequest = useRef(0);
  const detectedPhotos = useRef(new Map<string, Promise<RoomSegmentation>>());
  const readerId = useRef(id);
  useEffect(() => {
    setRoomOpen(false);
    const requests = roomRequest;
    return () => {
      requests.current++;
    };
  }, [id, writable]);
  useEffect(() => {
    setExportModal(false);
    setCatalogOpen(false);
    setInspectorOpen(false);
    setDetectionStatus('');
    setDetectionNotice('');
    applyRequest.current++;
  }, [id, st.project?.activeDesignId]);
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
    if (!ready) return;
    let dead = false;
    readerId.current = id;
    setLoaded(false);
    void (async () => {
      try {
        const repo = getRepositories();
        await pendingProjectSaves.get(id);
        const project = await repo.projects.load(id);
        const list = await repo.materials.list();
        const versions: Record<string, MaterialVersion> = Object.fromEntries(
          list.map((v) => [v.version.id, v.version]),
        );
        const scenes = projectScenes(project);
        const ids = new Set(
          scenes
            .flatMap((s) => [
              ...s.surfaces.map((v) => v.materialVersionId),
              ...s.fixtures.map((v) => v.materialVersionId),
            ])
            .filter(Boolean) as string[],
        );
        for (const v of ids) if (!versions[v]) versions[v] = await repo.materials.getVersion(v);
        if (dead) return;
        useEditor.getState().load(project);
        useEditor.getState().initializeUsage(versions);
        setCatalog(list.filter((row) => !isBuiltInExampleMaterial(row)));
        setMaterials(versions);
        setLoaded(true);
      } catch (e) {
        if (!dead) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      dead = true;
    };
  }, [id, ready, writable]);
  const save = useCallback(async () => {
    if (!writable) return;
    const pending = pendingProjectSaves.get(id);
    if (pending) {
      await pending;
      return;
    }
    const run = async () => {
      for (;;) {
        const state = useEditor.getState(),
          p = state.project;
        if (!p || p.id !== id || state.saveStatus === 'saved') return;
        const previousSaveError = state.error;
        state.saving();
        try {
          const result = await getRepositories().projects.save(structuredClone(p), p.storageRevision);
          useEditor.getState().saved(result);
          setError((message) => (message === previousSaveError ? '' : message));
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          if (useEditor.getState().project?.id === id) useEditor.getState().failed(message);
          setError(message);
          return;
        }
        if (useEditor.getState().saveStatus !== 'dirty') return;
      }
    };
    const promise = run();
    pendingProjectSaves.set(id, promise);
    try {
      await promise;
    } finally {
      if (pendingProjectSaves.get(id) === promise) pendingProjectSaves.delete(id);
    }
  }, [writable, id]);
  useEffect(
    () => () => {
      if (useEditor.getState().project?.id === id && useEditor.getState().saveStatus !== 'saved') void save();
    },
    [id, save],
  );
  useEffect(() => {
    if (st.saveStatus !== 'dirty' || !loaded || !writable) return;
    const t = setTimeout(() => void save(), 500);
    return () => clearTimeout(t);
  }, [st.project, st.saveStatus, save, loaded, writable]);
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
      if (designsOpen || comparisonOpen || legacyOpen) return;
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
  }, [save, writable, roomOpen, referenceOpen, designsOpen, comparisonOpen, legacyOpen]);
  const scene = st.draft || (st.project ? getEditingScene(st.project, st.editing) : undefined);
  async function leave(path: string) {
    if (!flushMaterialUsageInputs()) return;
    await save();
    if (useEditor.getState().saveStatus === 'dirty') await save();
    if (
      useEditor.getState().saveStatus === 'error' &&
      !confirm('저장하지 못한 변경이 있어요. 그래도 나갈까요?')
    )
      return;
    router.push(path);
  }
  async function analyzePhoto(source: Scene, request: number) {
    const photoId = source.backgroundAssetId || source.previewAssetId;
    const asset = await getRepositories().assets.get(photoId);
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
      const view = m.views[0];
      const asset = await getRepositories().assets.get(view.assetId);
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
          viewIndex: 0,
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
  async function exportImage() {
    if (!scene || !renderer.current) return;
    setExporting(true);
    setError('');
    try {
      const edge = Math.min(4096, Math.max(scene.imageWidth, scene.imageHeight));
      const w = edge,
        h = edge;
      const blob = await renderer.current.exportImage(
        {
          scene: structuredClone(getActiveScene(st.project!)),
          beforeScene: st.project!.shared.comparison?.before,
          materials,
        },
        w,
        h,
        format,
        compare,
      );
      const url = URL.createObjectURL(blob),
        link = document.createElement('a');
      link.href = url;
      link.download = `${st.project!.name}-${activeDesign?.name ?? '시안'}-${compare ? '비교' : 'After'}.${format === 'image/png' ? 'png' : 'jpg'}`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      setExportModal(false);
      const pw = Math.min(2048, scene.imageWidth);
      renderer.current.render(pw, Math.round((pw * scene.imageHeight) / scene.imageWidth), st.mode, st.split);
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
  const status =
    st.saveStatus === 'saved'
      ? storageMode === 'local'
        ? '이 브라우저에 저장됨'
        : '서버에 저장됨'
      : st.saveStatus === 'saving'
        ? '저장 중…'
        : st.saveStatus === 'error'
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
      {comparisonOpen ? (
        <DesignComparison
          projectId={st.project.id}
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
                  <button
                    className="icon-btn"
                    title="자재 등록"
                    aria-label="신규 자재 등록"
                    disabled={!writable}
                    onClick={() => setForm(true)}
                  >
                    <Plus size={17} />
                  </button>
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
                        assetId={
                          v.category === 'tile'
                            ? v.textureAssetIds[0] || v.coverAssetId
                            : v.views[0]?.assetId || v.coverAssetId
                        }
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
                <button className="btn" disabled={!writable} onClick={() => setForm(true)}>
                  <Plus size={14} />내 자재 등록하기
                </button>
                <button className="text-button" style={{ fontSize: 11 }} onClick={() => leave('/materials')}>
                  자재 관리 열기
                  <ExternalLink size={12} />
                </button>
              </div>
            </aside>
          )}
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
      {form && (
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
          <div className="modal-card" style={{ maxWidth: 470 }}>
            <div className="modal-header">
              <h2>결과 이미지 저장</h2>
              <button className="icon-btn" onClick={() => setExportModal(false)}>
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
            <div className="modal-footer">
              <button className="btn" onClick={() => setExportModal(false)}>
                취소
              </button>
              <button className="btn primary" disabled={exporting} onClick={() => void exportImage()}>
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
