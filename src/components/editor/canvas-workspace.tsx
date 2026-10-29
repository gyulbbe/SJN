'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Minus,
  Plus,
  Scan,
  MousePointer2,
  Square,
  Layers,
  SlidersHorizontal,
  Hand,
  SquareDashed,
  Magnet,
} from 'lucide-react';
import { PhotoCompositor } from '@/lib/render/compositor';
import { useRepositories } from '@/components/repository-context';
import { useEditor } from '@/lib/editor-store';
import { getActiveDesign, getEditingScene } from '@/lib/comparison';
import { projectPhotoLight } from '@/lib/reconstruction/photo-lighting';
import { homography, inverseHomography, transformPoint } from '@/lib/render/math';
import { roomFaceSizeMm } from '@/lib/room-geometry';
import { createRegionSurface, REGION_MIN_MM, type RegionBounds } from '@/lib/room-surface-regions';
import {
  draftRegionUv,
  movedRegion,
  REGION_DRAG_PX,
  regionFromDrag,
  regionPlacementIssue,
  regionToolIssue,
  setSurfaceRegion,
  snappedRegion,
  type FacePoint,
} from '@/lib/region-editing';
import type { RoomFace } from '@/lib/room-types';
import type { MaterialVersion, Point, Quad, Scene, Surface, SurfaceRegion } from '@/lib/types';
import type { WallFeatureFace } from '@/lib/wall-features';
import {
  stageBox,
  useNoTouchGesture,
  useWallFeatureTool,
  WallFeatureCard,
  WallFeaturePolygons,
  WallFeatureToolButton,
  WallFeatureToolOptions,
} from '../rooms/wall-feature-tool';
import { useEditingCapabilities } from './editing-capabilities';
type Props = {
  materials: Record<string, MaterialVersion>;
  onRenderer: (r: PhotoCompositor | null) => void;
  onError: (error: string) => void;
  showCatalog: () => void;
  showInspector: () => void;
  /** A region was just drawn: the editor opens the material drawer on it. */
  onRegionCreated?: (surface: Surface) => void;
};
/**
 * Face UV of a photo point on a room face's quad (outside the face too); null on the face plane's
 * vanishing line (a side wall's runs through the middle of the photo), where it has none.
 */
const faceUv = (quad: Quad, p: Point): FacePoint | null => {
  try {
    const uv = transformPoint(homography(quad), p);
    return { u: uv.x, v: uv.y };
  } catch {
    return null;
  }
};
/** A face rectangle's corners in photo coordinates. */
const photoCorners = (quad: Quad, box: RegionBounds): Point[] => {
  const back = inverseHomography(homography(quad));
  return [
    { x: box.left, y: box.top },
    { x: box.right, y: box.top },
    { x: box.right, y: box.bottom },
    { x: box.left, y: box.bottom },
  ].map((p) => transformPoint(back, p));
};
export default function CanvasWorkspace({
  materials,
  onRenderer,
  onError,
  showCatalog,
  showInspector,
  onRegionCreated,
}: Props) {
  const repositories = useRepositories();
  const st = useEditor(),
    { writable } = useEditingCapabilities();
  const scene = st.draft || (st.project ? getEditingScene(st.project, st.editing) : undefined);
  const beforeScene = st.editing === 'after' ? st.project?.shared.comparison?.before : undefined;
  const lighting = st.project ? projectPhotoLight(st.project) : undefined;
  const lightingKey = lighting?.join();
  const activeDesign = st.project ? getActiveDesign(st.project) : undefined;
  const renderRevision = activeDesign?.renderRevision ?? activeDesign?.revision;
  const stage = useRef<HTMLDivElement>(null),
    mount = useRef<HTMLDivElement>(null),
    frame = useRef<HTMLDivElement>(null),
    renderer = useRef<PhotoCompositor | null>(null);
  const [size, setSize] = useState({ width: 700, height: 550 });
  const [loading, setLoading] = useState(true);
  const gesture = useRef<{
    kind: 'fixture' | 'pan' | 'region-draw' | 'region-move' | 'wall-draw';
    id?: string;
    start: Point;
    base: Scene;
    pan?: Point;
    /** A region drag: its face, the face's photo quad, where it started and the region moved. */
    face?: RoomFace;
    quad?: Quad;
    from?: FacePoint;
    region?: SurfaceRegion;
    client?: Point;
  } | null>(null);
  // The rectangle being drawn with the region tool (not part of the scene until it is let go).
  const [regionDraft, setRegionDraft] = useState<{
    face: RoomFace;
    quad: Quad;
    from: FacePoint;
    to: FacePoint;
  } | null>(null);
  const [regionNote, setRegionNote] = useState('');
  const [regionSnap, setRegionSnap] = useState(true);
  const current = useRef({ scene, beforeScene, materials, lighting, mode: st.mode, split: st.split });
  current.current = { scene, beforeScene, materials, lighting, mode: st.mode, split: st.split };
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
              {
                scene: c.scene,
                beforeScene: c.beforeScene,
                materials: c.materials,
                ...(c.lighting ? { lighting: c.lighting } : {}),
              },
              (id) => repositories.assets.get(id),
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
  }, [onRenderer, onError, repositories]);
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
    lightingKey,
    st.mode,
    st.split,
  ]);
  useEffect(() => {
    if (gesture.current?.kind === 'fixture' || gesture.current?.kind === 'region-move')
      useEditor.getState().cancel();
    gesture.current = null;
    setRegionDraft(null);
    setRegionNote('');
  }, [st.tool, st.editing, st.project?.id, st.project?.activeDesignId, st.mode]);
  const regionIssue = regionToolIssue({ scene, editing: st.editing, writable });
  // No feature is on this canvas (any feature turns the editor to 3D): the tool draws the first one.
  const wallTool = useWallFeatureTool({ scene, materials, writable });
  useNoTouchGesture(frame, st.tool === 'wall-feature' || st.tool === 'region');
  useEffect(() => {
    if (st.tool === 'region' && regionIssue) useEditor.getState().setTool('select');
  }, [st.tool, regionIssue]);
  useEffect(() => {
    const cancel = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        gesture.current = null;
        setRegionDraft(null);
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
  /** The room face under a photo point (a region drag starts on it), with its face UV. */
  function faceAt(p: Point) {
    if (!scene?.room) return null;
    for (const surface of scene.surfaces) {
      if (!surface.roomFace || surface.geometryMode !== 'room' || surface.region) continue;
      const uv = faceUv(surface.quad, p);
      if (uv && uv.u >= 0 && uv.u <= 1 && uv.v >= 0 && uv.v <= 1)
        return { face: surface.roomFace, quad: surface.quad, uv };
    }
    return null;
  }
  /** One history step for a drawn rectangle, snapped when asked; the drawer opens on it. */
  function createRegion(face: RoomFace, region: SurfaceRegion | null) {
    const state = useEditor.getState();
    const latest = state.project ? getEditingScene(state.project, state.editing) : undefined;
    if (!latest?.room) return;
    if (!region) return setRegionNote(`가로·세로 ${REGION_MIN_MM}mm보다 크게 끌어 주세요.`);
    const placed = regionSnap ? snappedRegion(latest, face, region, materials) : region;
    const issue = regionPlacementIssue(latest, face, placed);
    if (issue) return setRegionNote(issue);
    const surface = createRegionSurface(latest, face, placed);
    state.change((draft) => {
      draft.surfaces.push(structuredClone(surface));
    });
    useEditor.getState().select(surface.id);
    setRegionNote('');
    onRegionCreated?.(surface);
  }
  function begin(e: React.PointerEvent<SVGSVGElement>) {
    if (!scene) return;
    if (st.tool === 'pan' || e.button === 1) {
      e.currentTarget.setPointerCapture(e.pointerId);
      gesture.current = { kind: 'pan', start: { x: e.clientX, y: e.clientY }, base: scene, pan };
      return;
    }
    if (st.mode !== 'after' || e.button !== 0) return;
    if (st.tool === 'wall-feature') {
      const p = point(e),
        hit = faceAt(p);
      if (!wallTool.start(hit?.face, hit?.uv)) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      gesture.current = {
        kind: 'wall-draw',
        start: p,
        client: { x: e.clientX, y: e.clientY },
        base: scene,
        face: hit!.face,
        quad: hit!.quad,
        from: hit!.uv,
      };
      return;
    }
    if (st.tool === 'region') {
      if (regionIssue) return setRegionNote(regionIssue);
      const p = point(e),
        hit = faceAt(p);
      if (!hit) return setRegionNote('벽이나 바닥 위에서 끌어 주세요.');
      e.currentTarget.setPointerCapture(e.pointerId);
      setRegionNote('');
      gesture.current = {
        kind: 'region-draw',
        start: p,
        client: { x: e.clientX, y: e.clientY },
        base: scene,
        face: hit.face,
        quad: hit.quad,
        from: hit.uv,
      };
      setRegionDraft({ face: hit.face, quad: hit.quad, from: hit.uv, to: hit.uv });
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    const entity = (e.target as SVGElement).dataset.entity;
    st.select(entity || null);
    if (!writable || !entity) return;
    const region = scene.surfaces.find((item) => item.id === entity && item.region && item.roomFace);
    const from = region && faceUv(region.quad, point(e));
    if (region && from && st.editing === 'after') {
      const p = point(e);
      gesture.current = {
        kind: 'region-move',
        id: entity,
        start: p,
        base: structuredClone(scene),
        face: region.roomFace,
        quad: region.quad,
        from,
        region: region.region,
      };
      return;
    }
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
    if (g.kind === 'region-draw') {
      const to = faceUv(g.quad!, point(e));
      if (to) setRegionDraft({ face: g.face!, quad: g.quad!, from: g.from!, to });
      return;
    }
    if (g.kind === 'wall-draw') {
      const to = faceUv(g.quad!, point(e));
      if (to) wallTool.drag(to);
      return;
    }
    if (!writable) {
      gesture.current = null;
      st.cancel();
      return;
    }
    const p = point(e);
    if (g.kind === 'region-move') {
      const uv = faceUv(g.quad!, p);
      if (!uv) return;
      const next = movedRegion(
        g.region!,
        roomFaceSizeMm(g.base.room!, g.face!),
        uv.u - g.from!.u,
        uv.v - g.from!.v,
      );
      // Over another region the move stops at its last free place.
      if (regionPlacementIssue(g.base, g.face!, next, g.id)) return;
      st.preview((s) => {
        const target = s.surfaces.find((item) => item.id === g.id);
        if (target) setSurfaceRegion(target, next);
      });
      return;
    }
    st.preview((s) => {
      const fixture = s.fixtures.find((item) => item.id === g.id),
        base = g.base.fixtures.find((item) => item.id === g.id);
      if (fixture && base && !fixture.locked)
        fixture.position = { x: base.position.x + p.x - g.start.x, y: base.position.y + p.y - g.start.y };
    });
  }
  function end(e?: React.PointerEvent) {
    const g = gesture.current;
    if (!g) return;
    if (g.kind === 'wall-draw') {
      gesture.current = null;
      if (!e) return wallTool.cancelDraw();
      // A click places the default size; a drag the drawn rectangle.
      const click = Math.hypot(e.clientX - g.client!.x, e.clientY - g.client!.y) < REGION_DRAG_PX;
      const to = click ? null : faceUv(g.quad!, point(e));
      if (!click && !to) return wallTool.cancelDraw();
      wallTool.place(g.face as WallFeatureFace, g.from!, to);
      return;
    }
    if (g.kind === 'region-draw') {
      gesture.current = null;
      setRegionDraft(null);
      // A click is not a drag: nothing is made.
      if (!e || Math.hypot(e.clientX - g.client!.x, e.clientY - g.client!.y) < REGION_DRAG_PX) return;
      const to = faceUv(g.quad!, point(e));
      if (to) createRegion(g.face!, regionFromDrag(roomFaceSizeMm(g.base.room!, g.face!), g.from!, to));
      return;
    }
    if (g.kind === 'fixture' || g.kind === 'region-move') {
      if (writable) st.commit();
      else st.cancel();
    }
    gesture.current = null;
  }
  const handleSize = (5 / (fitW * zoom)) * 1000;
  // Wall-feature outlines on their face's photo quad, and the card's place beside the edited one.
  const wallOutlines = wallTool.shapes.flatMap((shape) => {
    const face = scene.surfaces.find(
      (s) => s.roomFace === shape.face && s.geometryMode === 'room' && !s.region,
    );
    if (!face) return [];
    // Cut to the face, whose own vanishing line lies outside it.
    const clamp = (value: number) => Math.max(0, Math.min(1, value));
    const { left, top, right, bottom } = shape.box;
    const box = { left: clamp(left), top: clamp(top), right: clamp(right), bottom: clamp(bottom) };
    try {
      return [{ ...shape, points: photoCorners(face.quad, box) }];
    } catch {
      return [];
    }
  });
  const edited = wallOutlines.find((shape) => shape.source === 'edit');
  const cardAnchor =
    edited &&
    stageBox(
      edited.points.map((p) => ({
        x: size.width / 2 + pan.x + (p.x - 0.5) * fitW * zoom,
        y: size.height / 2 + pan.y + (p.y - 0.5) * fitH * zoom,
      })),
    );
  const toolButton = (tool: typeof st.tool, label: string, Icon: typeof MousePointer2) => (
    <button
      title={label}
      aria-label={label}
      aria-pressed={st.tool === tool}
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
        <span className="tool-label shrink-0">도구</span>
        {toolButton('select', '선택 / 이동', MousePointer2)}
        {toolButton('pan', '화면 이동', Hand)}
        <button
          title={regionIssue ?? '부분 타일: 벽이나 바닥을 끌어 네모 영역을 만들어요'}
          aria-label="부분 타일"
          aria-pressed={st.tool === 'region'}
          data-testid="region-tool"
          disabled={!!regionIssue}
          className={`icon-btn ${st.tool === 'region' ? 'active' : ''}`}
          onClick={() => st.setTool('region')}
        >
          <SquareDashed size={17} />
        </button>
        <WallFeatureToolButton tool={wallTool} compact />
        <WallFeatureToolOptions tool={wallTool} compact />
        {st.tool === 'region' && (
          <button
            title="경계를 바탕 타일 줄눈에 맞춤"
            aria-label="경계를 바탕 타일 줄눈에 맞춤"
            aria-pressed={regionSnap}
            data-testid="region-snap"
            className={`icon-btn ${regionSnap ? 'active' : ''}`}
            onClick={() => setRegionSnap((value) => !value)}
          >
            <Magnet size={17} />
          </button>
        )}
        {(st.tool === 'region' || regionNote) && (
          <span className="tool-label" role="status" data-testid="region-note">
            {regionNote || '벽이나 바닥을 끌어 네모 영역을 만드세요.'}
          </span>
        )}
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
              setRegionDraft(null);
              wallTool.cancelDraw();
              st.cancel();
            }}
          >
            {st.mode === 'after' && (
              <>
                {/* Regions lie on their faces, so they come later and take the click; the selection last. */}
                {[...scene.surfaces]
                  .sort(
                    (a, b) =>
                      Number(!!a.region) - Number(!!b.region) ||
                      Number(a.id === st.selection) - Number(b.id === st.selection),
                  )
                  .map((s) => (
                    <g key={s.id}>
                      <path
                        data-entity={s.id}
                        d={[s.mask.polygon, ...(s.mask.polygons || []), ...(s.mask.holes || [])]
                          .filter((polygon) => polygon.length >= 3)
                          .map(
                            (polygon) => `M${polygon.map((p) => `${p.x * 1000},${p.y * 1000}`).join('L')}Z`,
                          )
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
                {regionDraft && (
                  <polygon
                    data-testid="region-preview"
                    points={photoCorners(
                      regionDraft.quad,
                      draftRegionUv(
                        scene,
                        regionDraft.face,
                        regionDraft.from,
                        regionDraft.to,
                        regionSnap,
                        materials,
                      ),
                    )
                      .map((p) => p.x * 1000 + ',' + p.y * 1000)
                      .join(' ')}
                    fill="rgba(43, 151, 129, 0.16)"
                    stroke="#2b9781"
                    strokeWidth="1.5"
                    strokeDasharray="5 3"
                    vectorEffect="non-scaling-stroke"
                    pointerEvents="none"
                  />
                )}
                <WallFeaturePolygons items={wallOutlines} scale={1000} />
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
        {scene.room && <WallFeatureCard tool={wallTool} room={scene.room} anchor={cardAnchor} stage={size} />}
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
