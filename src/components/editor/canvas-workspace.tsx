'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Minus, Plus, Scan, MousePointer2, Square, Layers, SlidersHorizontal, Hand } from 'lucide-react';
import { PhotoCompositor } from '@/lib/render/compositor';
import { getRepositories } from '@/lib/repositories';
import { useEditor } from '@/lib/editor-store';
import { getActiveDesign, getEditingScene } from '@/lib/comparison';
import type { MaterialVersion, Point, Scene } from '@/lib/types';
import { useAccess } from '../app-provider';
type Props = {
  materials: Record<string, MaterialVersion>;
  onRenderer: (r: PhotoCompositor | null) => void;
  onError: (error: string) => void;
  showCatalog: () => void;
  showInspector: () => void;
};
export default function CanvasWorkspace({
  materials,
  onRenderer,
  onError,
  showCatalog,
  showInspector,
}: Props) {
  const st = useEditor(),
    { writable } = useAccess();
  const scene = st.draft || (st.project ? getEditingScene(st.project, st.editing) : undefined);
  const beforeScene = st.editing === 'after' ? st.project?.shared.comparison?.before : undefined;
  const activeDesign = st.project ? getActiveDesign(st.project) : undefined;
  const renderRevision = activeDesign?.renderRevision ?? activeDesign?.revision;
  const stage = useRef<HTMLDivElement>(null),
    mount = useRef<HTMLDivElement>(null),
    frame = useRef<HTMLDivElement>(null),
    renderer = useRef<PhotoCompositor | null>(null);
  const [size, setSize] = useState({ width: 700, height: 550 });
  const [loading, setLoading] = useState(true);
  const gesture = useRef<{
    kind: 'fixture' | 'pan';
    id?: string;
    start: Point;
    base: Scene;
    pan?: Point;
  } | null>(null);
  const current = useRef({ scene, beforeScene, materials, mode: st.mode, split: st.split });
  current.current = { scene, beforeScene, materials, mode: st.mode, split: st.split };
  const setView = useCallback(
    (zoom: number, pan: Point) => {
      const state = useEditor.getState();
      if (writable) state.viewport(zoom, pan);
      else if (state.project) useEditor.setState({ project: { ...state.project, viewport: { zoom, pan } } });
    },
    [writable],
  );
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const v = useEditor.getState().project?.viewport;
      if (v) setView(Math.max(0.3, Math.min(5, v.zoom * (e.deltaY < 0 ? 1.1 : 0.9))), v.pan);
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, [setView]);
  useEffect(() => {
    if (!stage.current) return;
    const ob = new ResizeObserver(([e]) =>
      setSize({ width: e.contentRect.width, height: e.contentRect.height }),
    );
    ob.observe(stage.current);
    return () => ob.disconnect();
  }, []);
  const schedule = useRef<() => void>(() => {});
  useEffect(() => {
    let r: PhotoCompositor;
    try {
      r = new PhotoCompositor();
      renderer.current = r;
      mount.current?.appendChild(r.canvas);
      onRenderer(r);
    } catch (e) {
      onError('WebGL을 시작할 수 없어요. Chrome/Edge의 하드웨어 가속을 확인해 주세요. ' + String(e));
      setLoading(false);
      return;
    }
    const life = { disposed: false, running: false, version: 0 };
    const request = () => {
      life.version++;
      if (life.running || life.disposed) return;
      life.running = true;
      void (async () => {
        try {
          let processed = -1;
          while (!life.disposed && processed !== life.version) {
            processed = life.version;
            const c = current.current;
            if (!c.scene) break;
            await r.setSnapshot(
              { scene: c.scene, beforeScene: c.beforeScene, materials: c.materials },
              (id) => getRepositories().assets.get(id),
            );
            if (life.disposed) return;
            if (processed === life.version) {
              const w = Math.min(2048, c.scene.imageWidth);
              r.render(
                Math.round(w),
                Math.round((w * c.scene.imageHeight) / c.scene.imageWidth),
                c.mode,
                c.split,
              );
              setLoading(false);
            }
          }
        } catch (e) {
          if (!life.disposed) {
            onError(e instanceof Error ? e.message : String(e));
            setLoading(false);
          }
        } finally {
          life.running = false;
        }
      })();
    };
    schedule.current = request;
    request();
    return () => {
      life.disposed = true;
      if (schedule.current === request) schedule.current = () => {};
      onRenderer(null);
      r.canvas.remove();
      r.dispose();
      if (renderer.current === r) renderer.current = null;
    };
  }, [onRenderer, onError]);
  useEffect(() => {
    schedule.current();
  }, [
    renderRevision,
    st.project?.shared.revision,
    st.project?.id,
    st.project?.activeDesignId,
    st.editing,
    st.draft,
    materials,
    st.mode,
    st.split,
  ]);
  useEffect(() => {
    if (gesture.current?.kind === 'fixture') useEditor.getState().cancel();
    gesture.current = null;
  }, [st.tool, st.editing, st.project?.id, st.project?.activeDesignId, st.mode]);
  useEffect(() => {
    const cancel = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        gesture.current = null;
        useEditor.getState().cancel();
      }
    };
    window.addEventListener('keydown', cancel);
    return () => window.removeEventListener('keydown', cancel);
  }, []);
  if (!scene || !st.project) return null;
  const ratio = scene.imageWidth / scene.imageHeight;
  const fitW = Math.max(100, Math.min(size.width - 70, (size.height - 100) * ratio));
  const fitH = fitW / ratio;
  const { zoom, pan } = st.project.viewport;
  function point(e: React.PointerEvent): Point {
    const r = frame.current!.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
      y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)),
    };
  }
  function begin(e: React.PointerEvent<SVGSVGElement>) {
    if (!scene) return;
    if (st.tool === 'pan' || e.button === 1) {
      e.currentTarget.setPointerCapture(e.pointerId);
      gesture.current = { kind: 'pan', start: { x: e.clientX, y: e.clientY }, base: scene, pan };
      return;
    }
    if (st.mode !== 'after' || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const entity = (e.target as SVGElement).dataset.entity;
    st.select(entity || null);
    if (!writable || !entity) return;
    const fixture = scene.fixtures.find((item) => item.id === entity);
    if (fixture && !fixture.locked)
      gesture.current = { kind: 'fixture', id: entity, start: point(e), base: structuredClone(scene) };
  }
  function move(e: React.PointerEvent<SVGSVGElement>) {
    const g = gesture.current;
    if (!g) return;
    if (g.kind === 'pan') {
      setView(zoom, { x: g.pan!.x + e.clientX - g.start.x, y: g.pan!.y + e.clientY - g.start.y });
      return;
    }
    if (!writable) {
      gesture.current = null;
      st.cancel();
      return;
    }
    const p = point(e);
    st.preview((s) => {
      const fixture = s.fixtures.find((item) => item.id === g.id),
        base = g.base.fixtures.find((item) => item.id === g.id);
      if (fixture && base && !fixture.locked)
        fixture.position = { x: base.position.x + p.x - g.start.x, y: base.position.y + p.y - g.start.y };
    });
  }
  function end() {
    const g = gesture.current;
    if (!g) return;
    if (g.kind === 'fixture') {
      if (writable) st.commit();
      else st.cancel();
    }
    gesture.current = null;
  }
  const handleSize = (5 / (fitW * zoom)) * 1000;
  const toolButton = (tool: typeof st.tool, label: string, Icon: typeof MousePointer2) => (
    <button
      title={label}
      aria-label={label}
      className={`icon-btn ${st.tool === tool ? 'active' : ''}`}
      onClick={() => st.setTool(tool)}
    >
      <Icon size={17} />
    </button>
  );
  return (
    <section className="workspace">
      <div className="workspace-toolbar">
        <button className="icon-btn side-toggle" title="자재 목록" onClick={showCatalog}>
          <Layers size={18} />
        </button>
        <span className="tool-label">도구</span>
        {toolButton('select', '선택 / 이동', MousePointer2)}
        {toolButton('pan', '화면 이동', Hand)}
        <div style={{ flex: 1 }} />
        <button
          className="icon-btn side-toggle"
          title="자재 수량·금액 및 속성"
          aria-label="자재 수량·금액 및 속성"
          onClick={showInspector}
        >
          <SlidersHorizontal size={18} />
        </button>
      </div>
      <div className="canvas-stage" ref={stage}>
        {scene.surfaces.length === 0 && st.mode !== 'before' && (
          <div className="floating-hint">
            <Square size={14} />
            왼쪽에서 벽 타일 또는 바닥 타일을 고르고 원하는 자재를 눌러 보세요.
          </div>
        )}
        <div
          ref={frame}
          className="canvas-frame"
          data-testid="canvas-frame"
          style={{
            width: fitW,
            height: fitH,
            transform: `translate(calc(-50% + ${pan.x}px), calc(-50% + ${pan.y}px)) scale(${zoom})`,
          }}
        >
          <div ref={mount} />
          <svg
            data-testid="editor-canvas"
            className="canvas-overlay"
            viewBox="0 0 1000 1000"
            preserveAspectRatio="none"
            onPointerDown={begin}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={() => {
              gesture.current = null;
              st.cancel();
            }}
          >
            {st.mode === 'after' && (
              <>
                {[
                  ...scene.surfaces.filter((s) => s.id !== st.selection),
                  ...scene.surfaces.filter((s) => s.id === st.selection),
                ].map((s) => (
                  <g key={s.id}>
                    <path
                      data-entity={s.id}
                      d={[s.mask.polygon, ...(s.mask.polygons || []), ...(s.mask.holes || [])]
                        .filter((polygon) => polygon.length >= 3)
                        .map((polygon) => `M${polygon.map((p) => `${p.x * 1000},${p.y * 1000}`).join('L')}Z`)
                        .join(' ')}
                      fillRule="evenodd"
                      className={st.selection === s.id ? 'selected-region' : 'region'}
                      style={{
                        fill: 'transparent',
                        stroke: st.selection !== s.id ? 'transparent' : undefined,
                      }}
                    />
                  </g>
                ))}
                {scene.fixtures.map((f) =>
                  f.projectedQuad ? (
                    <polygon
                      key={f.id}
                      data-entity={f.id}
                      points={f.projectedQuad.map((p) => p.x * 1000 + ',' + p.y * 1000).join(' ')}
                      fill="transparent"
                      stroke={st.selection === f.id ? '#2b9781' : 'transparent'}
                      strokeWidth="1.5"
                      strokeDasharray="5 3"
                      vectorEffect="non-scaling-stroke"
                    />
                  ) : (
                    <g
                      key={f.id}
                      transform={`translate(${f.position.x * 1000},${f.position.y * 1000}) scale(${1 / ratio},1) rotate(${f.rotation}) scale(${ratio},1)`}
                    >
                      <rect
                        data-entity={f.id}
                        x={-f.anchor.x * f.width * 1000}
                        y={-f.anchor.y * f.height * 1000}
                        width={f.width * 1000}
                        height={f.height * 1000}
                        fill="transparent"
                        stroke={st.selection === f.id ? '#2b9781' : 'transparent'}
                        strokeWidth="1.5"
                        strokeDasharray="5 3"
                        vectorEffect="non-scaling-stroke"
                      />
                      <circle
                        cx="0"
                        cy="0"
                        r={handleSize * 0.75}
                        fill={st.selection === f.id ? '#eeb661' : 'transparent'}
                        pointerEvents="none"
                      />
                    </g>
                  ),
                )}
              </>
            )}
          </svg>
        </div>
        {loading && <div className="canvas-loading">사진과 텍스처를 준비하고 있어요…</div>}
        {st.mode === 'split' && (
          <label className="split-range">
            <input
              aria-label="Before After 비교 위치"
              type="range"
              min="0"
              max="1"
              step=".01"
              value={st.split}
              onChange={(e) => st.setSplit(+e.target.value)}
            />
          </label>
        )}
        <div className="mode-label">
          {st.mode === 'before'
            ? st.project.shared.comparison
              ? 'BEFORE · 기존 공간 재구성'
              : st.project.shared.baseline.room
                ? 'BEFORE · 빈 기본 공간'
                : 'BEFORE · 원본 사진'
            : st.mode === 'split'
              ? 'BEFORE / AFTER'
              : st.editing === 'before'
                ? 'BEFORE · 재구성 편집 중'
                : 'AFTER · 실시간 미리보기'}
        </div>
        <div className="zoom-controls">
          <button
            className="icon-btn"
            aria-label="축소"
            onClick={() => setView(Math.max(0.3, zoom - 0.2), pan)}
          >
            <Minus size={15} />
          </button>
          <span>{Math.round(zoom * 100)}%</span>
          <button
            className="icon-btn"
            aria-label="확대"
            onClick={() => setView(Math.min(5, zoom + 0.2), pan)}
          >
            <Plus size={15} />
          </button>
          <div className="divider" />
          <button className="icon-btn" aria-label="화면 맞춤" onClick={() => setView(1, { x: 0, y: 0 })}>
            <Scan size={16} />
          </button>
        </div>
      </div>
      <div className="workspace-bottom">
        <span>
          {scene.imageWidth} × {scene.imageHeight} px · 면 {scene.surfaces.length}개 · 제품{' '}
          {scene.fixtures.length}개
        </span>
        <span>상품의 형태와 무늬를 유지하는 실시간 합성</span>
      </div>
    </section>
  );
}
