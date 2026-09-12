'use client';
import { roomFaceAreaM2 } from '@/lib/room-geometry';
import { productContentBounds } from '@/lib/room-fixtures';
import type { RoomFace } from '@/lib/room-types';
import { useEffect, useRef, useState } from 'react';
import { Copy, Trash2, Lock, Unlock, ArrowUp, ArrowDown, RotateCcw, X } from 'lucide-react';
import { useEditor } from '@/lib/editor-store';
import { getActiveDesign, getEditingScene } from '@/lib/comparison';
import ReconstructionProperties from '@/components/reconstruction/reconstruction-properties';
import { getRepositories } from '@/lib/repositories';
import { DEFAULT_COLOR, type ColorAdjust, type MaterialVersion } from '@/lib/types';
import { useAccess } from '../app-provider';
import { AssetImage } from '../materials/asset-image';
import styles from './inspector-angles.module.css';
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
  return (
    <label className="range-field">
      <span className="range-label">
        {label}
        <output>
          {Number(value.toFixed(2))}
          {unit}
        </output>
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
    </label>
  );
}
export default function Inspector({
  embedded = false,
  materials,
  open,
  onClose,
  onRoomResize,
  onMaterialsChanged,
}: {
  embedded?: boolean;
  materials: Record<string, MaterialVersion>;
  open: boolean;
  onClose: () => void;
  onRoomResize: () => void;
  onMaterialsChanged: () => Promise<void>;
}) {
  const st = useEditor(),
    { writable } = useAccess();
  const [colorTarget, setColorTarget] = useState<'global' | 'selection'>('global');
  const [pendingView, setPendingView] = useState<number | null>(null);
  const [viewError, setViewError] = useState('');
  const viewRequest = useRef(0);
  const projectId = st.project?.id;
  useEffect(() => {
    const requests = viewRequest;
    requests.current++;
    setPendingView(null);
    setViewError('');
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
      const asset = await getRepositories().assets.get(view.assetId);
      if (asset.kind === 'product-mesh') throw new Error('제품 사진에는 이미지 자산이 필요해요.');
      if (!currentFixture()) return;
      if (
        !Number.isFinite(asset.width) ||
        !Number.isFinite(asset.height) ||
        asset.width <= 0 ||
        asset.height <= 0
      ) {
        throw new Error('선택한 제품 이미지의 가로·세로 크기를 확인할 수 없어요.');
      }
      const contentBounds = selected.roomPlacement ? await productContentBounds(asset) : undefined;
      if (!currentFixture()) return;
      useEditor.getState().change((scene) => {
        const product = scene.fixtures.find((item) => item.id === selected.id)!;
        product.viewIndex = index;
        product.anchor = { ...view.anchor };
        if (product.roomPlacement && contentBounds) {
          product.roomPlacement.contentBounds = contentBounds;
          product.roomPlacement.imageAspect = asset.width / asset.height;
        }
        product.height =
          (((product.width * scene.imageWidth) / scene.imageHeight) * asset.height) / asset.width;
      });
    } catch (error) {
      if (currentFixture())
        setViewError(error instanceof Error ? error.message : '제품 방향 이미지를 불러오지 못했어요.');
    } finally {
      if (viewRequest.current === request) setPendingView(null);
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
    if (!fixture) return;
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
              바닥 {((s.room.widthMm * s.room.depthMm) / 1e6).toLocaleString('ko-KR')}㎡ · 설정값 기준
            </p>
            <button className="btn small" onClick={onRoomResize} disabled={!!st.draft}>
              공간 크기 변경
            </button>
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
                    시공 면적{' '}
                    {(
                      roomFaceAreaM2(s.room, surface.roomFace) *
                      (surface.reconstructionBand
                        ? surface.reconstructionBand.to - surface.reconstructionBand.from
                        : 1)
                    ).toLocaleString('ko-KR')}
                    ㎡
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
              <button
                className="btn small"
                style={{ marginTop: 12 }}
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
              <div className={styles.heading}>
                <span>제품 각도</span>
                <span className={styles.count}>{material?.views.length ?? 0}개 사진</span>
              </div>
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
              {!material?.views.length && <p className={styles.hint}>등록된 각도 사진이 없어요.</p>}
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
                <button className="btn small" onClick={() => changeFixture((v) => (v.locked = !v.locked))}>
                  {fixture.locked ? <Lock size={13} /> : <Unlock size={13} />}{' '}
                  {fixture.locked ? '잠금 해제' : '배치 잠금'}
                </button>
                <button
                  className="btn small"
                  onClick={() => {
                    const clone = {
                      ...structuredClone(fixture),
                      id: crypto.randomUUID(),
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
                    };
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
                {fixture.roomPlacement ? (
                  <>
                    <label className="field">
                      설치 면
                      <select
                        className="input"
                        aria-label="제품 설치 면"
                        value={fixture.roomPlacement.face}
                        disabled={fixture.locked}
                        onChange={(e) =>
                          changeFixture((v) => {
                            if (v.roomPlacement) v.roomPlacement.face = e.target.value as RoomFace;
                          })
                        }
                      >
                        <option value="floor">바닥</option>
                        <option value="back">정면 벽</option>
                        <option value="left">왼쪽 벽</option>
                        <option value="right">오른쪽 벽</option>
                      </select>
                    </label>
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
                    <p className="muted" style={{ fontSize: 11 }}>
                      등록 규격 {fixture.roomPlacement.widthMm} × {fixture.roomPlacement.heightMm}mm에 이미지
                      비율을 맞춘 2D 배치예요. 위치에 따라 원근 크기가 바뀌어요.
                    </p>
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
              </div>
              <p className="muted" style={{ fontSize: 10, marginTop: 10 }}>
                제품의 실제 3D 회전이 아닙니다. 다른 각도는 위의 제품 사진을 선택해 주세요.
              </p>
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
