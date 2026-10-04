'use client';
import { roomSurfaceAreaM2 } from '@/lib/room-surface-areas';
import type { RoomFace } from '@/lib/room-types';
import { applyFixtureView, prepareFixtureView } from '@/lib/fixture-view';
import { getPlacementViewIndex } from '@/lib/material-images';
import { findFreeSlot, fixtureSlotBox, slotObstacles } from '@/lib/room-slot';
import {
  canShowAsStandardModel,
  isStandardModelOfPhoto,
  readPhotoColor,
  showAsPhoto,
  showAsStandardModel,
} from '@/lib/standard-model-view';
import {
  describeProductFacing,
  directionSuitsFace,
  mismatchMessage,
  readProductDirection,
  suitingDirection,
} from '@/lib/product-direction';
import { useEffect, useRef, useState } from 'react';
import { Copy, CopyCheck, Trash2, Lock, Unlock, ArrowUp, ArrowDown, RotateCcw, X } from 'lucide-react';
import { useEditor } from '@/lib/editor-store';
import { applyTileSettingsToAllSurfaces } from '@/lib/tile-settings';
import { parseRangeInput, stepRangeValue } from '@/lib/range-input';
import { getActiveDesign, getEditingScene } from '@/lib/comparison';
import ReconstructionProperties from '@/components/reconstruction/reconstruction-properties';
import { useRepositories } from '@/components/repository-context';
import { DEFAULT_COLOR, type ColorAdjust, type MaterialVersion, type Scene } from '@/lib/types';
import { useEditingCapabilities } from './editing-capabilities';
import { AssetImage } from '../materials/asset-image';
import styles from './inspector-angles.module.css';
import PhotoLightingControl from './photo-lighting-control';
import StandardModelSwitch from './standard-model-switch';
/**
 * A new installation face for a fixture. A standard model also moves its base: the floor is 0, a wall
 * is where its `v` puts its lower edge (the sync on every change keeps the two together afterwards).
 */
function setFace(scene: Scene, id: string, face: RoomFace) {
  const product = scene.fixtures.find((item) => item.id === id);
  if (!product?.roomPlacement) return;
  product.roomPlacement.face = face;
  if (product.reconstruction?.version === 2 && scene.room)
    product.reconstruction.baseHeightMm =
      face === 'floor' ? 0 : (1 - product.roomPlacement.v) * scene.room.heightMm;
}
export function Range({
  label,
  value,
  min,
  max,
  step = 0.01,
  onChange,
  onCommit,
  unit = '',
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  onCommit: () => void;
  unit?: string;
}) {
  // Typing only edits this draft; Enter or leaving the field applies it like one slider drag.
  const [draft, setDraft] = useState<string | null>(null);
  const bounds = { min, max, step };
  const apply = (next: number | null) => {
    setDraft(null);
    if (next === null) return;
    if (next !== value) onChange(next);
    onCommit();
  };
  return (
    <div className="range-field">
      <span className="range-label">
        {label}
        <span className="flex items-center gap-1">
          <input
            aria-label={`${label} 숫자 입력`}
            type="number"
            inputMode="decimal"
            min={min}
            max={max}
            step={step}
            value={draft ?? String(Number(value.toFixed(2)))}
            onChange={(e) => setDraft(e.target.value)}
            onFocus={(e) => e.target.select()}
            onBlur={() => {
              if (draft !== null) apply(parseRangeInput(draft, bounds));
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (draft !== null) apply(parseRangeInput(draft, bounds));
              } else if (e.key === 'Escape') {
                setDraft(null);
              } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                e.preventDefault();
                const base = draft === null ? value : (parseRangeInput(draft, bounds) ?? value);
                apply(stepRangeValue(base, e.key === 'ArrowUp' ? 1 : -1, bounds, e.shiftKey ? 10 : 1));
              }
            }}
            className="h-7 w-16 rounded-md border border-[color:var(--line)] bg-[color:var(--paper)] px-1.5 text-right text-xs text-[color:var(--ink)] tabular-nums [appearance:textfield] max-[620px]:h-9 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          />
          {unit.trim() && <span className="text-xs text-[color:var(--muted)]">{unit.trim()}</span>}
        </span>
      </span>
      <input
        aria-label={label}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(+e.target.value)}
        onPointerUp={onCommit}
        onKeyUp={onCommit}
        onBlur={onCommit}
      />
    </div>
  );
}
export default function Inspector({
  embedded = false,
  materials,
  open,
  onClose,
  onRoomResize,
  onWallFeatures,
  onMaterialsChanged,
}: {
  embedded?: boolean;
  materials: Record<string, MaterialVersion>;
  open: boolean;
  onClose: () => void;
  onRoomResize: () => void;
  onWallFeatures?: () => void;
  onMaterialsChanged: () => Promise<void>;
}) {
  const repositories = useRepositories();
  const st = useEditor(),
    { writable } = useEditingCapabilities();
  const [colorTarget, setColorTarget] = useState<'global' | 'selection'>('global');
  const [pendingView, setPendingView] = useState<number | null>(null);
  const [viewError, setViewError] = useState('');
  // What the editor did on its own for the selected product: switched its photo with a new face, or
  // put a copy on top of another product because the face was full.
  const [viewNotice, setViewNotice] = useState('');
  // The standard-model switch: reading the photo's colour, what the switch did, why it could not.
  const [modelBusy, setModelBusy] = useState(false);
  const [modelNotice, setModelNotice] = useState('');
  const [modelError, setModelError] = useState('');
  // Which surface's settings were last copied to every surface; the notice hides once another is selected.
  const [tileShared, setTileShared] = useState<{ surfaceId: string; count: number } | null>(null);
  const viewRequest = useRef(0);
  const projectId = st.project?.id;
  useEffect(() => {
    const requests = viewRequest;
    requests.current++;
    setPendingView(null);
    setViewError('');
    setViewNotice('');
    setModelBusy(false);
    setModelNotice('');
    setModelError('');
    const cancel = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      requests.current++;
      setPendingView(null);
      setViewError('');
    };
    window.addEventListener('keydown', cancel);
    return () => {
      requests.current++;
      window.removeEventListener('keydown', cancel);
    };
  }, [projectId, st.selection, st.editing, writable]);
  const s = st.draft || (st.project ? getEditingScene(st.project, st.editing) : undefined);
  if (!s) return null;
  const surface = s.surfaces.find((x) => x.id === st.selection);
  const fixture = s.fixtures.find((x) => x.id === st.selection);
  const material = materials[surface?.materialVersionId || fixture?.materialVersionId || ''];
  // A photo product shown as its standard model, and whether the switch is offered for the fixture.
  const modelOn = !!fixture && isStandardModelOfPhoto(fixture, material);
  // (Not in the Before of a photo comparison: there the models are reconstructions, edited below.)
  const modelSwitch =
    st.editing !== 'before' &&
    !!s.room &&
    !!fixture &&
    (modelOn || canShowAsStandardModel(fixture, material));
  // The photo's angle name is the direction the product faces; say where that is on this face, and
  // warn (never block) when the name does not suit the face.
  const facing = (() => {
    const placement = fixture?.roomPlacement;
    const view = fixture && !fixture.reconstruction ? material?.views[fixture.viewIndex] : undefined;
    if (!placement || !view) return undefined;
    const name = readProductDirection(view.direction).name;
    const warning = mismatchMessage(placement.face, name);
    const fitName = suitingDirection(placement.face);
    const fitIndex =
      warning && fitName
        ? material.views.findIndex((other) => readProductDirection(other.direction).name === fitName)
        : -1;
    return { name, text: describeProductFacing(placement.face, name), warning, fitName, fitIndex };
  })();
  async function changeFixtureView(index: number) {
    const request = ++viewRequest.current;
    setViewError('');
    const captured = useEditor.getState();
    const project = captured.project;
    const selected =
      project &&
      getEditingScene(project, captured.editing).fixtures.find((item) => item.id === captured.selection);
    const view = selected && materials[selected.materialVersionId]?.views[index];
    if (!writable || !project || !selected || selected.locked || !view || captured.draft) {
      setPendingView(null);
      return;
    }
    if (selected.viewIndex === index) {
      setPendingView(null);
      return;
    }
    setPendingView(index);
    const currentFixture = () => {
      const current = useEditor.getState();
      if (
        viewRequest.current !== request ||
        current.project?.id !== project.id ||
        current.project.editRevision !== project.editRevision ||
        current.project.activeDesignId !== project.activeDesignId ||
        current.selection !== selected.id ||
        current.editing !== captured.editing ||
        current.draft
      )
        return undefined;
      const product = getEditingScene(current.project, current.editing).fixtures.find(
        (item) => item.id === selected.id,
      );
      return product && !product.locked && product.materialVersionId === selected.materialVersionId
        ? product
        : undefined;
    };
    try {
      const prepared = await prepareFixtureView(view, index, repositories.assets, !!selected.roomPlacement);
      if (!currentFixture()) return;
      useEditor.getState().change((scene) => {
        applyFixtureView(scene, selected.id, prepared);
      });
    } catch (error) {
      if (currentFixture())
        setViewError(error instanceof Error ? error.message : '제품 방향 이미지를 불러오지 못했어요.');
    } finally {
      if (viewRequest.current === request) setPendingView(null);
    }
  }
  /**
   * A new installation face. When the photo shown does not suit the new wall and the product has
   * the photo that does (왼쪽 벽 → 오른쪽 …), the photo changes with the face in one scene change, so
   * one undo puts both back. Only the moment of the face change does this; a photo picked by hand
   * stays as long as the face stays. A locked product, a draft and the floor (it takes any) keep
   * the photo.
   */
  async function changeFixtureFace(face: RoomFace) {
    const request = ++viewRequest.current;
    setViewError('');
    setViewNotice('');
    const captured = useEditor.getState();
    const project = captured.project;
    const selected =
      project &&
      getEditingScene(project, captured.editing).fixtures.find((item) => item.id === captured.selection);
    if (!selected?.roomPlacement || selected.roomPlacement.face === face) return;
    const material = materials[selected.materialVersionId];
    const showing = material?.views[selected.viewIndex];
    const pick =
      writable &&
      project &&
      material &&
      showing &&
      !selected.locked &&
      !captured.draft &&
      !selected.reconstruction &&
      face !== 'floor' &&
      !directionSuitsFace(face, readProductDirection(showing.direction).name)
        ? getPlacementViewIndex(material, face)
        : undefined;
    const view =
      pick && !pick.missing && pick.index !== selected.viewIndex ? material.views[pick.index] : undefined;
    if (!pick || !view || !project) {
      useEditor.getState().change((scene) => setFace(scene, selected.id, face));
      return;
    }
    setPendingView(pick.index);
    const stillThere = () => {
      const current = useEditor.getState();
      if (
        viewRequest.current !== request ||
        current.project?.id !== project.id ||
        current.project.editRevision !== project.editRevision ||
        current.project.activeDesignId !== project.activeDesignId ||
        current.selection !== selected.id ||
        current.editing !== captured.editing ||
        current.draft
      )
        return false;
      const product = getEditingScene(current.project, current.editing).fixtures.find(
        (item) => item.id === selected.id,
      );
      return !!product && !product.locked && product.materialVersionId === selected.materialVersionId;
    };
    try {
      const prepared = await prepareFixtureView(view, pick.index, repositories.assets, true);
      if (!stillThere()) return;
      useEditor.getState().change((scene) => {
        const product = scene.fixtures.find((item) => item.id === selected.id);
        if (!product?.roomPlacement) return;
        product.roomPlacement.face = face;
        applyFixtureView(scene, selected.id, prepared);
      });
      setViewNotice(`각도를 ‘${readProductDirection(view.direction).name}’으로 바꿨어요.`);
    } catch (error) {
      // The face still changes; only the photo could not be read.
      if (stillThere()) {
        useEditor.getState().change((scene) => setFace(scene, selected.id, face));
        setViewError(error instanceof Error ? error.message : '제품 방향 이미지를 불러오지 못했어요.');
      }
    } finally {
      if (viewRequest.current === request) setPendingView(null);
    }
  }
  /**
   * The standard-model switch. On: the photo's colour is read first (the model takes it), then the
   * fixture gets its model in one scene change. Off: only the model goes, the photo is still there.
   * Either way one undo puts it back. A locked product and a draft keep their look.
   */
  async function toggleStandardModel(on: boolean) {
    const request = ++viewRequest.current;
    setModelNotice('');
    setModelError('');
    const captured = useEditor.getState();
    const project = captured.project;
    const selected =
      project &&
      getEditingScene(project, captured.editing).fixtures.find((item) => item.id === captured.selection);
    const product = selected && materials[selected.materialVersionId];
    if (!writable || !project || !selected || !product || selected.locked || captured.draft) return;
    if (!on) {
      useEditor.getState().change((scene) => void showAsPhoto(scene, selected.id, product));
      setModelNotice('사진으로 돌아왔어요.');
      return;
    }
    if (!canShowAsStandardModel(selected, product)) return;
    setModelBusy(true);
    const stillThere = () => {
      const current = useEditor.getState();
      if (
        viewRequest.current !== request ||
        current.project?.id !== project.id ||
        current.project.editRevision !== project.editRevision ||
        current.project.activeDesignId !== project.activeDesignId ||
        current.selection !== selected.id ||
        current.editing !== captured.editing ||
        current.draft
      )
        return false;
      const found = getEditingScene(current.project, current.editing).fixtures.find(
        (item) => item.id === selected.id,
      );
      return !!found && !found.locked && found.materialVersionId === selected.materialVersionId;
    };
    try {
      // The model's colour is the photo's; a photo that cannot be read leaves the material's colour.
      let color: string | undefined;
      try {
        const view = product.views[selected.viewIndex];
        const asset = view ? await repositories.assets.get(view.assetId) : undefined;
        if (asset && asset.kind !== 'product-mesh') color = await readPhotoColor(asset.blob);
      } catch {
        color = undefined;
      }
      if (!stillThere()) return;
      useEditor.getState().change((scene) => void showAsStandardModel(scene, selected.id, product, color));
      setModelNotice('표준 모형은 일반 모양이라 제품 생김새는 사라져요. 끄면 사진으로 돌아와요.');
    } catch (error) {
      if (stillThere())
        setModelError(error instanceof Error ? error.message : '표준 모형으로 바꾸지 못했어요.');
    } finally {
      if (viewRequest.current === request) setModelBusy(false);
    }
  }
  const changeSurface = (fn: (v: NonNullable<typeof surface>) => void, preview = false) => {
    (preview ? st.preview : st.change)((scene) => {
      const v = scene.surfaces.find((v) => v.id === surface?.id);
      if (v) fn(v);
    });
  };
  const changeFixture = (fn: (v: NonNullable<typeof fixture>) => void, preview = false) => {
    (preview ? st.preview : st.change)((scene) => {
      const v = scene.fixtures.find((v) => v.id === fixture?.id);
      if (v) fn(v);
    });
  };
  const color = colorTarget === 'selection' ? surface?.color || fixture?.color || s.color : s.color;
  const editColor = (key: keyof ColorAdjust, v: number) =>
    st.preview((scene) => {
      const target =
        colorTarget === 'selection'
          ? scene.surfaces.find((x) => x.id === st.selection) ||
            scene.fixtures.find((x) => x.id === st.selection)
          : null;
      (target?.color || scene.color)[key] = v;
    });
  const resetColor = () =>
    st.change((scene) => {
      const target =
        colorTarget === 'selection'
          ? scene.surfaces.find((x) => x.id === st.selection) ||
            scene.fixtures.find((x) => x.id === st.selection)
          : null;
      if (target) target.color = { ...DEFAULT_COLOR };
      else scene.color = { ...DEFAULT_COLOR };
    });
  function moveFixture(direction: number) {
    if (!writable || !fixture) return;
    st.change((scene) => {
      const i = scene.fixtures.findIndex((f) => f.id === fixture.id);
      const next = i + direction;
      if (next < 0 || next >= scene.fixtures.length) return;
      [scene.fixtures[i], scene.fixtures[next]] = [scene.fixtures[next], scene.fixtures[i]];
    });
  }
  const inputNumber = (label: string, value: number, fn: (v: number) => void, min = 0) => (
    <label className="field">
      {label}
      <input
        className="input"
        type="number"
        min={min}
        value={value}
        onChange={(e) => {
          const n = +e.target.value;
          if (Number.isFinite(n) && n >= min) fn(n);
        }}
      />
    </label>
  );
  return (
    <div className={`inspector ${embedded ? 'inspector-embedded' : open ? 'open' : ''}`}>
      <div className="inspector-heading">
        <div className="row between">
          <h3>{surface ? '타일 속성' : fixture ? '제품 속성' : '공간 속성'}</h3>
          <button className="icon-btn mobile-close" hidden={embedded} onClick={onClose}>
            <X size={17} />
          </button>
        </div>
        <span className={`badge ${surface?.calibrated ? 'green' : 'amber'}`}>
          {surface
            ? surface.roomFace && surface.geometryMode === 'room'
              ? '공간 설정 치수 적용'
              : surface.calibrated
                ? '실측 치수 적용'
                : '크기 추정 상태'
            : fixture
              ? '2D 이미지 · 추정 배치'
              : s.room
                ? '공간 설정 치수 기반'
                : '사진 기반 시뮬레이션'}
        </span>
      </div>
      <fieldset
        disabled={!writable || st.mode !== 'after'}
        style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}
      >
        {s.room && (
          <section className="property-section">
            <h4>공간 크기</h4>
            <p className="muted" style={{ fontSize: 12 }}>
              가로 {s.room.widthMm / 1000} × 깊이 {s.room.depthMm / 1000} × 높이 {s.room.heightMm / 1000}m
              <br />
              기본 바닥 {((s.room.widthMm * s.room.depthMm) / 1e6).toLocaleString('ko-KR')}㎡ · 설정값 기준
            </p>
            <button className="btn small" onClick={onRoomResize} disabled={!!st.draft}>
              공간 크기 변경
            </button>
            {onWallFeatures && (
              <button
                className="btn small"
                onClick={onWallFeatures}
                disabled={!!st.draft}
                style={{ marginLeft: 8 }}
              >
                벽 구조 편집{s.wallFeatures?.length ? ' · ' + s.wallFeatures.length : ''}
              </button>
            )}
          </section>
        )}
        {st.editing === 'before' && st.project?.shared.comparison && (
          <ReconstructionProperties
            key={(fixture?.id || surface?.id || 'none') + st.project.editRevision}
            scene={s}
            fixture={fixture}
            surface={surface}
            materials={materials}
            onMaterialsChanged={onMaterialsChanged}
          />
        )}
        {surface && (
          <>
            <section className="property-section">
              <h4>{surface.name}</h4>
              <p className="muted" style={{ fontSize: 12 }}>
                {surface.widthMm.toLocaleString('ko-KR')} × {surface.heightMm.toLocaleString('ko-KR')}mm
                {s.room && surface.roomFace && surface.geometryMode === 'room' && (
                  <>
                    <br />
                    시공 면적 {roomSurfaceAreaM2(s, surface.id)?.toLocaleString('ko-KR') ?? '확인 필요'}㎡
                  </>
                )}
              </p>
            </section>
            <section className="property-section">
              <div className="row between" style={{ marginBottom: 13 }}>
                <h4 style={{ margin: 0 }}>타일 시공</h4>
                <span className="badge">
                  {material ? `${material.widthMm}×${material.heightMm}` : '자재 미선택'}
                </span>
              </div>
              <>
                <label className="field" style={{ marginBottom: 13 }}>
                  배열
                  <select
                    className="input"
                    aria-label="타일 배열"
                    value={surface.tile.pattern}
                    onChange={(e) =>
                      changeSurface((v) => (v.tile.pattern = e.target.value as 'grid' | 'brick'))
                    }
                  >
                    <option value="grid">기본 격자</option>
                    <option value="brick">반장 엇갈림</option>
                  </select>
                </label>
                <Range
                  label="타일 방향"
                  value={surface.tile.rotation}
                  min={-180}
                  max={180}
                  step={1}
                  unit="°"
                  onChange={(n) => changeSurface((v) => (v.tile.rotation = n), true)}
                  onCommit={st.commit}
                />
                <Range
                  label="가로 시작점"
                  value={surface.tile.offsetX}
                  min={-1000}
                  max={1000}
                  step={1}
                  unit=" mm"
                  onChange={(n) => changeSurface((v) => (v.tile.offsetX = n), true)}
                  onCommit={st.commit}
                />
                <Range
                  label="세로 시작점"
                  value={surface.tile.offsetY}
                  min={-1000}
                  max={1000}
                  step={1}
                  unit=" mm"
                  onChange={(n) => changeSurface((v) => (v.tile.offsetY = n), true)}
                  onCommit={st.commit}
                />
                <label className="color-field">
                  줄눈 색상
                  <input
                    aria-label="줄눈 색상"
                    type="color"
                    value={surface.tile.groutColor}
                    onChange={(e) => changeSurface((v) => (v.tile.groutColor = e.target.value))}
                  />
                </label>
                <Range
                  label="줄눈 폭"
                  value={surface.tile.groutWidth}
                  min={0}
                  max={15}
                  step={0.5}
                  unit=" mm"
                  onChange={(n) => changeSurface((v) => (v.tile.groutWidth = n), true)}
                  onCommit={st.commit}
                />
                <Range
                  label="원본 명암 보존"
                  value={surface.tile.shading}
                  min={0}
                  max={1}
                  onChange={(n) => changeSurface((v) => (v.tile.shading = n), true)}
                  onCommit={st.commit}
                />
                <p className="muted" style={{ fontSize: 10 }}>
                  기존 무늬가 남으면 명암 보존을 0으로 낮춰주세요.
                </p>
              </>
              <button
                className="btn small"
                style={{ marginTop: 12 }}
                title="배열·방향·시작점·줄눈·명암 보존을 모든 벽·바닥에 적용"
                disabled={!writable || !!st.draft || s.surfaces.length < 2}
                onClick={() => {
                  let count = 0;
                  st.change((scene) => {
                    count = applyTileSettingsToAllSurfaces(scene, surface.id);
                  });
                  if (count) setTileShared({ surfaceId: surface.id, count });
                }}
              >
                <CopyCheck size={13} />
                시공 설정 전체 적용
              </button>
              {tileShared?.surfaceId === surface.id && (
                <p role="status" className="muted" style={{ fontSize: 11, marginTop: 8 }}>
                  모든 면({tileShared.count}개)에 같은 시공 설정을 적용했어요. Ctrl+Z로 되돌릴 수 있어요.
                </p>
              )}
              <button
                className="btn small"
                style={{ marginTop: 12 }}
                title="이 면의 타일 초기화 (Delete)"
                aria-keyshortcuts="Delete Backspace"
                onClick={() =>
                  changeSurface((v) => {
                    delete v.materialVersionId;
                  })
                }
              >
                <RotateCcw size={13} />이 면의 타일 초기화
              </button>
            </section>
          </>
        )}
        {fixture && (
          <>
            <section className="property-section">
              <h4>{fixture.name}</h4>
              {modelSwitch && (
                <StandardModelSwitch
                  model={modelOn ? fixture.reconstruction : undefined}
                  disabled={!writable || fixture.locked || !!st.draft}
                  busy={modelBusy}
                  notice={modelNotice}
                  error={modelError}
                  onToggle={(on) => void toggleStandardModel(on)}
                  onModel={(edit, preview) =>
                    changeFixture((v) => {
                      if (v.reconstruction) edit(v.reconstruction);
                    }, preview)
                  }
                  onModelCommit={st.commit}
                />
              )}
              <div className={styles.heading}>
                <span>제품 각도</span>
                <span className={styles.count}>{material?.views.length ?? 0}개 사진</span>
              </div>
              {modelOn ? (
                <p className={styles.hint} data-testid="standard-model-angle-hint">
                  표준 모형으로 보는 동안에는 각도 사진을 고를 수 없어요. 끄면 ‘
                  {readProductDirection(material?.views[fixture.viewIndex]?.direction).name}’ 사진으로
                  돌아와요.
                </p>
              ) : (
                <>
                  <p className={styles.hint}>사진을 누르면 현재 배치의 각도만 바뀌어요.</p>
                  <div
                    role="group"
                    aria-label="제품 촬영 방향"
                    aria-busy={pendingView !== null}
                    className={styles.grid}
                  >
                    {material?.views.map((view, index) => {
                      const selected = fixture.viewIndex === index;
                      const pending = pendingView === index;
                      const name = view.direction || `각도 ${index + 1}`;
                      return (
                        <button
                          key={`${index}:${view.assetId}`}
                          type="button"
                          className={`${styles.angle} ${selected ? styles.selected : ''}`}
                          data-testid={`fixture-view-${index}`}
                          aria-label={`${name} 각도 선택`}
                          aria-pressed={selected}
                          aria-busy={pending}
                          disabled={fixture.locked || !!st.draft}
                          onClick={() => void changeFixtureView(index)}
                        >
                          <span className={styles.image}>
                            <AssetImage
                              assetId={view.assetId}
                              alt={`${name} 제품 사진`}
                              className={styles.photo}
                            />
                          </span>
                          <span className={styles.caption}>
                            <span className={styles.name}>{name}</span>
                            <span className={`${styles.state} ${pending ? styles.pending : ''}`}>
                              {pending ? '불러오는 중…' : selected ? '사용 중' : '선택'}
                            </span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </>
              )}
              {!modelOn && !material?.views.length && (
                <p className={styles.hint}>등록된 각도 사진이 없어요.</p>
              )}
              {pendingView !== null && (
                <p role="status" className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                  선택한 각도 사진을 준비하고 있어요…
                </p>
              )}
              {viewError && (
                <p role="alert" className="error" style={{ fontSize: 12, marginTop: 8 }}>
                  {viewError}
                </p>
              )}
              <div className="row" style={{ marginTop: 12 }}>
                <button
                  className="btn small"
                  onClick={() => {
                    changeFixture((v) => (v.locked = !v.locked));
                  }}
                >
                  {fixture.locked ? <Lock size={13} /> : <Unlock size={13} />}{' '}
                  {fixture.locked ? '잠금 해제' : '배치 잠금'}
                </button>
                <button
                  className="btn small"
                  onClick={() => {
                    if (!writable) return;
                    // A copy goes to the free place nearest the original on the same face, not on top of it.
                    const ownBox = fixtureSlotBox(fixture, materials);
                    const slot =
                      fixture.roomPlacement && s.room && ownBox
                        ? findFreeSlot(
                            s.room,
                            fixture.roomPlacement.face,
                            ownBox,
                            slotObstacles(s, fixture.roomPlacement.face, materials),
                            { defaultSlot: { u: fixture.roomPlacement.u, v: fixture.roomPlacement.v } },
                          )
                        : undefined;
                    setViewError('');
                    setViewNotice(
                      slot?.status === 'crowded' ? '놓을 자리가 없어 겹쳐 놓았어요. 위치를 옮겨 주세요.' : '',
                    );
                    const clone = {
                      ...structuredClone(fixture),
                      id: crypto.randomUUID(),
                      ...(fixture.roomPlacement && slot
                        ? {
                            roomPlacement: {
                              ...structuredClone(fixture.roomPlacement),
                              u: slot.u,
                              v: slot.v,
                            },
                          }
                        : {
                            position: { x: fixture.position.x + 0.035, y: fixture.position.y + 0.035 },
                            ...(fixture.roomPlacement
                              ? {
                                  roomPlacement: {
                                    ...structuredClone(fixture.roomPlacement),
                                    u: Math.min(1, fixture.roomPlacement.u + 0.04),
                                    v: Math.min(1, fixture.roomPlacement.v + 0.04),
                                  },
                                }
                              : {}),
                          }),
                    };
                    if (
                      clone.reconstruction?.version === 2 &&
                      clone.roomPlacement &&
                      clone.roomPlacement.face !== 'floor' &&
                      s.room
                    ) {
                      clone.reconstruction.baseHeightMm = (1 - clone.roomPlacement.v) * s.room.heightMm;
                    }
                    st.changeProject((project) => {
                      getEditingScene(project, st.editing).fixtures.push(clone);
                      const usage =
                        st.editing === 'after' ? getActiveDesign(project)?.materialUsage : undefined;
                      if (usage?.assignments[fixture.id]) {
                        usage.assignments[clone.id] = structuredClone(usage.assignments[fixture.id]);
                      }
                    });
                  }}
                >
                  <Copy size={13} />
                  복제
                </button>
              </div>
              <button
                className="btn danger small"
                style={{ marginTop: 12 }}
                title="제품 삭제 (Delete)"
                aria-keyshortcuts="Delete Backspace"
                disabled={!writable || fixture.locked || !!st.draft}
                onClick={() => {
                  if (!writable || fixture.locked || st.draft) return;
                  useEditor.getState().removeFixture(fixture.id);
                }}
              >
                <Trash2 size={13} />
                제품 삭제
              </button>
              <div
                style={{
                  opacity: fixture.locked ? 0.5 : 1,
                  pointerEvents: fixture.locked ? 'none' : undefined,
                  marginTop: 16,
                }}
              >
                {(fixture.reconstruction?.version !== 2 || modelOn) && (
                  <>
                    {fixture.roomPlacement ? (
                      <>
                        <label className="field">
                          설치 면
                          <select
                            className="input"
                            aria-label="제품 설치 면"
                            value={fixture.roomPlacement.face}
                            disabled={fixture.locked}
                            onChange={(e) => void changeFixtureFace(e.target.value as RoomFace)}
                          >
                            <option value="floor">바닥</option>
                            <option value="back">정면 벽</option>
                            <option value="left">왼쪽 벽</option>
                            <option value="right">오른쪽 벽</option>
                          </select>
                        </label>
                        {viewNotice && (
                          <p
                            role="status"
                            data-testid="facing-notice"
                            className="muted"
                            style={{ fontSize: 12, marginBottom: 8 }}
                          >
                            {viewNotice}
                          </p>
                        )}
                        {facing && (
                          <div data-testid="facing-info" style={{ marginBottom: 12 }}>
                            <p className="muted" style={{ fontSize: 11 }}>
                              각도 ‘{facing.name}’ · {facing.text}
                            </p>
                            {facing.warning && (
                              <div
                                role="status"
                                data-testid="facing-warning"
                                style={{ fontSize: 12, color: '#8a5a00', marginTop: 6 }}
                              >
                                <p>{facing.warning}</p>
                                {facing.fitIndex >= 0 ? (
                                  <button
                                    type="button"
                                    className="btn"
                                    style={{ marginTop: 6 }}
                                    disabled={fixture.locked || !!st.draft || pendingView !== null}
                                    onClick={() => void changeFixtureView(facing.fitIndex)}
                                  >
                                    맞는 각도로 바꾸기
                                  </button>
                                ) : (
                                  facing.fitName && (
                                    <p style={{ marginTop: 4 }}>
                                      이 제품에는 ‘{facing.fitName}’ 각도 사진이 없어요. 자재 편집에서 방향별
                                      사진을 추가하면 바꿀 수 있어요.
                                    </p>
                                  )
                                )}
                              </div>
                            )}
                          </div>
                        )}
                        <Range
                          label="제품 배율"
                          value={fixture.roomPlacement.scale * 100}
                          min={10}
                          max={500}
                          step={1}
                          unit="%"
                          onChange={(n) =>
                            changeFixture((v) => {
                              if (v.roomPlacement) v.roomPlacement.scale = n / 100;
                            }, true)
                          }
                          onCommit={st.commit}
                        />
                        {modelOn && fixture.reconstruction ? (
                          <p className="muted" style={{ fontSize: 11 }}>
                            등록 규격 {fixture.reconstruction.widthMm} × {fixture.reconstruction.heightMm} ×{' '}
                            {fixture.reconstruction.depthMm}mm로 세워요.{' '}
                            {fixture.roomPlacement.face === 'floor'
                              ? '위치는 모형의 가운데 기준이에요.'
                              : '세로 위치는 모형의 아래쪽 가장자리 기준이에요.'}
                          </p>
                        ) : (
                          <p className="muted" style={{ fontSize: 11 }}>
                            등록 규격 {fixture.roomPlacement.widthMm} × {fixture.roomPlacement.heightMm}mm에
                            이미지 비율을 맞춘 2D 배치예요. 위치에 따라 원근 크기가 바뀌어요.
                          </p>
                        )}
                      </>
                    ) : (
                      <>
                        <Range
                          label="제품 크기"
                          value={fixture.width}
                          min={0.03}
                          max={1}
                          step={0.005}
                          onChange={(n) =>
                            changeFixture((v) => {
                              v.height = n * (v.height / v.width);
                              v.width = n;
                            }, true)
                          }
                          onCommit={st.commit}
                        />
                      </>
                    )}
                    {!modelOn && (
                      <Range
                        label="이미지 평면 회전"
                        value={fixture.rotation}
                        min={-180}
                        max={180}
                        step={1}
                        unit="°"
                        onChange={(n) => changeFixture((v) => (v.rotation = n), true)}
                        onCommit={st.commit}
                      />
                    )}
                    <div className="field-grid">
                      {inputNumber(
                        fixture.roomPlacement ? '면 가로 위치 (%)' : '기준점 가로 (%)',
                        Math.round((fixture.roomPlacement?.u ?? fixture.position.x) * 100),
                        (n) =>
                          changeFixture((v) => {
                            if (v.roomPlacement) v.roomPlacement.u = Math.max(0, Math.min(1, n / 100));
                            else v.position.x = n / 100;
                          }),
                        -100,
                      )}
                      {inputNumber(
                        fixture.roomPlacement
                          ? fixture.roomPlacement.face === 'floor'
                            ? '면 깊이 위치 (%)'
                            : '면 세로 위치 (%)'
                          : '기준점 세로 (%)',
                        Math.round((fixture.roomPlacement?.v ?? fixture.position.y) * 100),
                        (n) =>
                          changeFixture((v) => {
                            if (v.roomPlacement) v.roomPlacement.v = Math.max(0, Math.min(1, n / 100));
                            else v.position.y = n / 100;
                          }),
                        -100,
                      )}
                    </div>
                  </>
                )}
              </div>
              {fixture.reconstruction?.version !== 2 && (
                <p className="muted" style={{ fontSize: 10, marginTop: 10 }}>
                  제품의 실제 3D 회전이 아닙니다. 다른 각도는 위의 제품 사진을 선택해 주세요.
                </p>
              )}
            </section>
            <section className="property-section">
              <h4>접지 그림자</h4>
              <Range
                label="그림자 진하기"
                value={fixture.shadow.opacity}
                min={0}
                max={1}
                onChange={(n) => changeFixture((v) => (v.shadow.opacity = n), true)}
                onCommit={st.commit}
              />
              <Range
                label="그림자 부드러움"
                value={fixture.shadow.blur}
                min={0.001}
                max={0.12}
                step={0.001}
                onChange={(n) => changeFixture((v) => (v.shadow.blur = n), true)}
                onCommit={st.commit}
              />
              <Range
                label="그림자 가로 위치"
                value={fixture.shadow.x}
                min={-0.2}
                max={0.2}
                step={0.002}
                onChange={(n) => changeFixture((v) => (v.shadow.x = n), true)}
                onCommit={st.commit}
              />
              <Range
                label="그림자 세로 위치"
                value={fixture.shadow.y}
                min={-0.2}
                max={0.2}
                step={0.002}
                onChange={(n) => changeFixture((v) => (v.shadow.y = n), true)}
                onCommit={st.commit}
              />
              <Range
                label="그림자 너비"
                value={fixture.shadow.scale}
                min={0.1}
                max={2}
                onChange={(n) => changeFixture((v) => (v.shadow.scale = n), true)}
                onCommit={st.commit}
              />
              <div className="row">
                <button className="btn small" onClick={() => moveFixture(1)}>
                  <ArrowUp size={13} />
                  앞으로
                </button>
                <button className="btn small" onClick={() => moveFixture(-1)}>
                  <ArrowDown size={13} />
                  뒤로
                </button>
              </div>
            </section>
          </>
        )}
        {!surface && !fixture && (
          <div className="empty-inspector">
            면이나 제품을 선택하면
            <br />
            타일 설정과 제품 배치를 바꿀 수 있어요.
          </div>
        )}
        <section className="property-section">
          <div className="row between" style={{ marginBottom: 14 }}>
            <h4 style={{ margin: 0 }}>밝기와 색감</h4>
            <button className="icon-btn" title="색감 기본값" onClick={resetColor}>
              <RotateCcw size={13} />
            </button>
          </div>
          <PhotoLightingControl />
          <div className="segmented" style={{ width: '100%', marginBottom: 17 }}>
            <button
              style={{ flex: 1 }}
              className={colorTarget === 'global' ? 'active' : ''}
              onClick={() => setColorTarget('global')}
            >
              전체 공간
            </button>
            <button
              style={{ flex: 1 }}
              disabled={!surface && !fixture}
              className={colorTarget === 'selection' ? 'active' : ''}
              onClick={() => setColorTarget('selection')}
            >
              선택 자재
            </button>
          </div>
          <Range
            label="노출"
            value={color.exposure}
            min={-2}
            max={2}
            onChange={(n) => editColor('exposure', n)}
            onCommit={st.commit}
          />
          <Range
            label="대비"
            value={color.contrast}
            min={0}
            max={2}
            onChange={(n) => editColor('contrast', n)}
            onCommit={st.commit}
          />
          <Range
            label="채도"
            value={color.saturation}
            min={0}
            max={2}
            onChange={(n) => editColor('saturation', n)}
            onCommit={st.commit}
          />
          <Range
            label="따뜻함"
            value={color.warmth}
            min={-1}
            max={1}
            onChange={(n) => editColor('warmth', n)}
            onCommit={st.commit}
          />
        </section>
      </fieldset>
    </div>
  );
}
