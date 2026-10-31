'use client';
import { useEffect, useRef, useState } from 'react';
import { useEditor } from '@/lib/editor-store';
import { getEditingScene } from '@/lib/comparison';
import type { MaterialVersion, Scene, Surface, SurfaceRegion } from '@/lib/types';
import type { RoomFace } from '@/lib/room-types';
import { roomFaceSizeMm } from '@/lib/room-geometry';
import { createRegionSurface, REGION_MIN_MM, regionUv } from '@/lib/room-surface-regions';
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
import type { AssetReader } from '@/lib/render/compositor';
import { projectDesignPreviewRoomContext } from '@/lib/render/design-preview-context';
import { projectPhotoLight } from '@/lib/reconstruction/photo-lighting';
import { RoomViewerRenderer } from '@/lib/room-viewer/renderer';
import { applyWallContact, WALL_SNAP_MM, wallDistanceMm } from '@/lib/room-wall-contact';
import {
  FOUR_DIRECTION_VIEWS,
  normalizeRoomView,
  resetRoomView,
  rotateRoomView,
  snapRoomView,
} from '@/lib/room-viewer/view-state';
import type { WallFeatureFace, WallFeatureV1 } from '@/lib/wall-features';
import { useEditingCapabilities } from '../editor/editing-capabilities';
import {
  boxCorners,
  stageBox,
  useNoTouchGesture,
  useWallFeatureTool,
  WallFeature3dNotice,
  WallFeatureCard,
  WallFeaturePolygons,
  WallFeatureToolButton,
  WallFeatureToolOptions,
} from './wall-feature-tool';

/** The same world renderer used for comparison/export, with installation-plane editing. */
export default function RoomCanvasWorkspace({
  materials,
  assetReader,
  onError,
  showCatalog,
  showInspector,
  onRegionCreated,
}: {
  materials: Record<string, MaterialVersion>;
  assetReader: AssetReader;
  onError: (message: string) => void;
  showCatalog: () => void;
  showInspector: () => void;
  /** A region was just drawn: the editor opens the material drawer on it. */
  onRegionCreated?: (surface: Surface) => void;
}) {
  const st = useEditor(),
    { writable } = useEditingCapabilities();
  const scene = st.draft ?? (st.project ? getEditingScene(st.project, st.editing) : undefined);
  const context = st.project ? projectDesignPreviewRoomContext(st.project) : undefined;
  const before = st.editing === 'before' ? scene : context?.beforeScene;
  // Drawn from the front, right, back or left only; the saved view is left as it is until the person turns it.
  const view = snapRoomView(st.project?.roomView);
  const lighting = st.project ? projectPhotoLight(st.project) : undefined;
  const stage = useRef<HTMLDivElement>(null),
    mount = useRef<HTMLDivElement>(null);
  const renderer = useRef<RoomViewerRenderer | null>(null);
  const [size, setSize] = useState({ width: 800, height: 600 });
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState('');
  const canPick = useRef(false),
    preparedKey = useRef<string | null>(null);
  const [retry, setRetry] = useState(0);
  const sceneKey = JSON.stringify([scene, before, materials, context?.fitScenes, lighting]);
  const current = useRef({
    scene,
    before,
    materials,
    context,
    lighting,
    view,
    mode: st.mode,
    split: st.split,
    size,
    sceneKey,
  });
  current.current = {
    scene,
    before,
    materials,
    context,
    lighting,
    view,
    mode: st.mode,
    split: st.split,
    size,
    sceneKey,
  };
  const schedule = useRef(() => {}),
    paint = useRef(() => {});
  const gesture = useRef<{
    kind: 'fixture' | 'pan' | 'region-draw' | 'region-move' | 'wall-draw' | 'feature-move';
    id?: string;
    start: { x: number; y: number };
    base: Scene;
    uv?: { u: number; v: number };
    view: typeof view;
    moved: boolean;
    /** A region drag: the face it is on and the region before the move. */
    face?: RoomFace;
    region?: SurfaceRegion;
    /** A wall feature being moved, as it was. */
    feature?: WallFeatureV1;
  } | null>(null);
  // The rectangle being drawn with the region tool (not part of the scene until it is let go).
  const [regionDraft, setRegionDraft] = useState<{ face: RoomFace; from: FacePoint; to: FacePoint } | null>(
    null,
  );
  const [regionNote, setRegionNote] = useState('');
  const [regionSnap, setRegionSnap] = useState(true);
  // Advances after every drawn frame, so outlines are projected with the camera just used.
  const [, setDrawn] = useState(0);
  const regionIssue = regionToolIssue({ scene, editing: st.editing, writable });
  const wallTool = useWallFeatureTool({ scene, materials, writable });
  const frame = useRef<HTMLDivElement>(null);
  useNoTouchGesture(frame, st.tool === 'wall-feature' || st.tool === 'region');

  const frameKey = JSON.stringify([view, st.mode, st.split, size]);
  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) =>
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height }),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    canPick.current = false;
    preparedKey.current = null;
    let instance: RoomViewerRenderer;
    try {
      instance = new RoomViewerRenderer();
    } catch (error) {
      setLoading(false);
      setFailure(error instanceof Error ? error.message : String(error));
      onError(String(error));
      return;
    }
    renderer.current = instance;
    instance.canvas.setAttribute('aria-label', '벽 구조를 포함한 현재 공간');
    instance.canvas.style.width = '100%';
    instance.canvas.style.height = '100%';
    mount.current?.appendChild(instance.canvas);
    const life = { disposed: false, running: false, version: 0, ready: false };
    const draw = () => {
      if (life.disposed || !life.ready) return;
      const c = current.current;
      if (!c.scene) return;
      const aspect = c.scene.imageWidth / c.scene.imageHeight;
      const w = Math.max(1, Math.min(c.size.width, c.size.height * aspect));
      const edge = Math.min(2048, Math.max(c.scene.imageWidth, c.scene.imageHeight));
      const dpr = Math.min(2, window.devicePixelRatio || 1, edge / Math.max(w, w / aspect));
      try {
        instance.render(
          Math.max(1, Math.round(w * dpr)),
          Math.max(1, Math.round((w / aspect) * dpr)),
          c.view,
          c.mode,
          c.split,
        );
        setDrawn((value) => value + 1);
      } catch (error) {
        life.ready = false;
        canPick.current = false;
        preparedKey.current = null;
        const message = error instanceof Error ? error.message : String(error);
        setFailure(message);
        onError(message);
      }
    };
    const request = () => {
      life.version++;
      if (life.disposed) return;
      life.ready = false;
      canPick.current = false;
      preparedKey.current = null;
      setLoading(true);
      setFailure('');
      if (life.running) return;
      life.running = true;
      void (async () => {
        try {
          let processed = -1;
          while (!life.disposed && processed !== life.version) {
            processed = life.version;
            const c = current.current;
            if (!c.scene || !c.before) break;
            try {
              await instance.setSnapshot(
                {
                  scene: c.scene,
                  beforeScene: c.before,
                  materials: c.materials,
                  ...(c.lighting ? { lighting: c.lighting } : {}),
                },
                assetReader,
                { fitScenes: c.context?.fitScenes },
              );
            } catch (error) {
              if (life.disposed) return;
              // A failed obsolete request must not discard a newer queued scene.
              if (processed !== life.version) continue;
              life.ready = false;
              canPick.current = false;
              preparedKey.current = null;
              const message = error instanceof Error ? error.message : String(error);
              setLoading(false);
              setFailure(message);
              onError(message);
              return;
            }
            if (life.disposed) return;
            if (processed === life.version && c.sceneKey === current.current.sceneKey) {
              life.ready = true;
              canPick.current = true;
              preparedKey.current = c.sceneKey;
              setLoading(false);
              setFailure('');
              draw();
            }
          }
        } finally {
          life.running = false;
        }
      })();
    };
    schedule.current = request;
    paint.current = draw;
    request();
    return () => {
      life.disposed = true;
      canPick.current = false;
      preparedKey.current = null;
      renderer.current = null;
      schedule.current = () => {};
      paint.current = () => {};
      instance.dispose();
      instance.canvas.remove();
    };
  }, [assetReader, onError, retry]);
  useEffect(() => {
    schedule.current();
  }, [sceneKey]);
  useEffect(() => {
    paint.current();
  }, [frameKey]);
  useEffect(() => {
    if (gesture.current?.kind === 'fixture' || gesture.current?.kind === 'region-move')
      useEditor.getState().cancel();
    gesture.current = null;
    setRegionDraft(null);
    setRegionNote('');
  }, [st.project?.id, st.project?.activeDesignId, st.editing, st.tool, st.mode, writable]);
  useEffect(() => {
    if (st.tool === 'region' && regionIssue) useEditor.getState().setTool('select');
  }, [st.tool, regionIssue]);
  useEffect(() => {
    const cancel = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      gesture.current = null;
      setRegionDraft(null);
      useEditor.getState().cancel();
    };
    window.addEventListener('keydown', cancel);
    return () => {
      window.removeEventListener('keydown', cancel);
      if (gesture.current) useEditor.getState().cancel();
      gesture.current = null;
    };
  }, []);
  function updateView(next: typeof view) {
    const normalized = snapRoomView(next);
    if (writable) st.setRoomView(normalized);
    else if (st.project) useEditor.setState({ project: { ...st.project, roomView: normalized } });
  }
  function point(event: React.PointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height };
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
  function begin(event: React.PointerEvent<HTMLDivElement>) {
    if (
      !scene ||
      !renderer.current ||
      !canPick.current ||
      preparedKey.current !== sceneKey ||
      loading ||
      (event.button !== 0 && event.button !== 1)
    )
      return;
    const start = point(event);
    if (st.tool === 'pan' || event.button === 1) {
      gesture.current = { kind: 'pan', start, base: structuredClone(scene), view, moved: false };
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    if (st.mode !== 'after') return;
    if (st.tool === 'wall-feature') {
      if (event.button !== 0) return;
      // On a feature: pick it (a click opens its card) or move it; anywhere else draws a new one.
      const hit = renderer.current.pickWallFeature(start.x, start.y);
      const uv = hit && renderer.current.facePosition(start.x, start.y, hit.face);
      const feature = hit && uv && !wallTool.issue ? wallTool.startMove(hit.featureId) : undefined;
      if (hit && uv && feature) {
        gesture.current = {
          kind: 'feature-move',
          start,
          base: scene,
          uv,
          view,
          moved: false,
          face: hit.face,
          feature,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
        return;
      }
      const face = renderer.current.pickFace(start.x, start.y);
      const at = face && renderer.current.facePosition(start.x, start.y, face);
      if (!wallTool.start(face, at)) return;
      gesture.current = { kind: 'wall-draw', start, base: scene, uv: at!, view, moved: false, face: face! };
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    if (st.tool === 'region') {
      if (event.button !== 0) return;
      if (regionIssue) return setRegionNote(regionIssue);
      const face = renderer.current.pickFace(start.x, start.y);
      const uv = face && renderer.current.facePosition(start.x, start.y, face);
      if (!face || !uv) return setRegionNote('벽이나 바닥 위에서 끌어 주세요.');
      setRegionNote('');
      gesture.current = { kind: 'region-draw', start, base: scene, uv, view, moved: false, face };
      setRegionDraft({ face, from: uv, to: uv });
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    const picked = renderer.current.pick(start.x, start.y);
    st.select(picked?.id ?? null);
    const region =
      picked?.kind === 'surface'
        ? scene.surfaces.find((item) => item.id === picked.id && item.region && item.roomFace)
        : undefined;
    if (region && writable && st.editing === 'after') {
      const uv = renderer.current.facePosition(start.x, start.y, region.roomFace!);
      if (!uv) return;
      gesture.current = {
        kind: 'region-move',
        id: region.id,
        start,
        uv,
        base: structuredClone(scene),
        view,
        moved: false,
        face: region.roomFace,
        region: region.region,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    const fixture =
      picked?.kind === 'fixture' ? scene.fixtures.find((item) => item.id === picked.id) : undefined;
    if (!writable || !fixture?.roomPlacement || fixture.locked) return;
    const uv = renderer.current.facePosition(start.x, start.y, fixture.roomPlacement.face);
    if (!uv) return;
    gesture.current = {
      kind: 'fixture',
      id: fixture.id,
      start,
      uv,
      base: structuredClone(scene),
      view,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function move(event: React.PointerEvent<HTMLDivElement>) {
    const g = gesture.current;
    if (!g || !renderer.current || !canPick.current || preparedKey.current !== sceneKey) return;
    const p = point(event),
      rect = event.currentTarget.getBoundingClientRect();
    if (
      !g.moved &&
      Math.hypot((p.x - g.start.x) * rect.width, (p.y - g.start.y) * rect.height) < REGION_DRAG_PX
    )
      return;
    g.moved = true;
    if (g.kind === 'pan') {
      updateView({
        ...g.view,
        pan: { x: g.view.pan.x + p.x - g.start.x, y: g.view.pan.y + p.y - g.start.y },
      });
      return;
    }
    if (g.kind === 'region-draw') {
      const uv = renderer.current.facePosition(p.x, p.y, g.face!);
      if (uv) setRegionDraft({ face: g.face!, from: g.uv!, to: uv });
      return;
    }
    if (g.kind === 'wall-draw' || g.kind === 'feature-move') {
      const uv = renderer.current.facePosition(p.x, p.y, g.face!);
      if (!uv) return;
      if (g.kind === 'wall-draw') wallTool.drag(uv);
      else wallTool.moveTo(g.feature!, uv.u - g.uv!.u, uv.v - g.uv!.v);
      return;
    }
    if (!writable) {
      gesture.current = null;
      st.cancel();
      return;
    }
    if (g.kind === 'region-move') {
      const uv = renderer.current.facePosition(p.x, p.y, g.face!);
      if (!uv) return;
      const next = movedRegion(
        g.region!,
        roomFaceSizeMm(g.base.room!, g.face!),
        uv.u - g.uv!.u,
        uv.v - g.uv!.v,
      );
      // Over another region the move stops at its last free place.
      if (regionPlacementIssue(g.base, g.face!, next, g.id)) return;
      st.preview((draft) => {
        const target = draft.surfaces.find((item) => item.id === g.id);
        if (target) setSurfaceRegion(target, next);
      });
      return;
    }
    const original = g.base.fixtures.find((fixture) => fixture.id === g.id);
    if (!original?.roomPlacement || !g.uv) return;
    const uv = renderer.current.facePosition(p.x, p.y, original.roomPlacement.face);
    if (!uv) return;
    st.preview((draft) => {
      const fixture = draft.fixtures.find((item) => item.id === g.id);
      if (!fixture?.roomPlacement || fixture.locked) return;
      fixture.roomPlacement.u = Math.max(0, Math.min(1, original.roomPlacement!.u + uv.u - g.uv!.u));
      fixture.roomPlacement.v = Math.max(0, Math.min(1, original.roomPlacement!.v + uv.v - g.uv!.v));
      if (fixture.reconstruction && fixture.roomPlacement.face !== 'floor' && draft.room)
        fixture.reconstruction.baseHeightMm = (1 - fixture.roomPlacement.v) * draft.room.heightMm;
      // A floor product brought near the wall behind it goes against it; pulled away, it lets go.
      const distance = draft.room && wallDistanceMm(draft.room, fixture, materials);
      if (distance !== undefined && distance <= WALL_SNAP_MM) {
        fixture.roomPlacement.againstWall = true;
        applyWallContact(draft.room!, fixture, materials);
      } else delete fixture.roomPlacement.againstWall;
    });
  }
  function end(cancel = false, event?: React.PointerEvent<HTMLDivElement>) {
    const g = gesture.current;
    gesture.current = null;
    if (g?.kind === 'wall-draw') {
      const uv =
        !cancel && g.moved && event && renderer.current
          ? renderer.current.facePosition(point(event).x, point(event).y, g.face!)
          : null;
      // A click places the default size; a drag the drawn rectangle.
      if (cancel || (g.moved && !uv)) wallTool.cancelDraw();
      else wallTool.place(g.face as WallFeatureFace, g.uv!, g.moved ? uv : null);
      return;
    }
    if (g?.kind === 'feature-move') {
      wallTool.endMove(!cancel && g.moved && writable);
      if (!cancel && !g.moved) wallTool.open(g.feature!.id);
      return;
    }
    if (g?.kind === 'region-draw') {
      setRegionDraft(null);
      // A click is not a drag: nothing is made.
      if (cancel || !g.moved || !event || !renderer.current) return;
      const p = point(event);
      const uv = renderer.current.facePosition(p.x, p.y, g.face!);
      if (uv) createRegion(g.face!, regionFromDrag(roomFaceSizeMm(g.base.room!, g.face!), g.uv!, uv));
      return;
    }
    if ((g?.kind === 'fixture' || g?.kind === 'region-move') && g.moved) {
      if (cancel || !writable) st.cancel();
      else st.commit();
    }
  }
  if (!scene || !st.project) return null;
  // The rectangle being drawn, or else the selected region, projected with the last frame's camera.
  const outline = (() => {
    const engine = renderer.current;
    if (!engine || loading || failure || st.mode !== 'after' || !scene.room) return null;
    const selected = scene.surfaces.find((item) => item.id === st.selection && item.region && item.roomFace);
    const box = regionDraft
      ? {
          face: regionDraft.face,
          ...draftRegionUv(scene, regionDraft.face, regionDraft.from, regionDraft.to, regionSnap, materials),
        }
      : selected
        ? {
            face: selected.roomFace!,
            ...regionUv(selected.region!, roomFaceSizeMm(scene.room, selected.roomFace!)),
          }
        : null;
    if (!box) return null;
    const clamp = (value: number) => Math.max(0, Math.min(1, value));
    const points = [
      [box.left, box.top],
      [box.right, box.top],
      [box.right, box.bottom],
      [box.left, box.bottom],
    ].map(([u, v]) => engine.faceToFrame(box.face, clamp(u), clamp(v)));
    if (points.some((point) => !point)) return null;
    return {
      points: points as { x: number; y: number }[],
      testId: regionDraft ? 'region-preview' : 'region-outline',
    };
  })();
  const aspect = scene.imageWidth / scene.imageHeight;
  const width = Math.max(1, Math.min(size.width, size.height * aspect));
  // Wall-feature outlines with the same camera, and the card's place beside the edited one.
  const wallOutlines = (() => {
    const engine = renderer.current;
    if (!engine || loading || failure) return [];
    return wallTool.shapes.flatMap((shape) => {
      const points = boxCorners(shape.box).map(({ u, v }) => engine.faceToFrame(shape.face, u, v));
      return points.every((point) => point)
        ? [{ ...shape, points: points as { x: number; y: number }[] }]
        : [];
    });
  })();
  const edited = wallOutlines.find((shape) => shape.source === 'edit');
  const cardAnchor =
    edited &&
    stageBox(
      edited.points.map((point) => ({
        x: size.width / 2 + (point.x - 0.5) * width,
        y: size.height / 2 + (point.y - 0.5) * (width / aspect),
      })),
    );
  const name =
    scene.fixtures.find((item) => item.id === st.selection)?.name ??
    scene.surfaces.find((item) => item.id === st.selection)?.name;
  return (
    <section className="workspace">
      <div className="workspace-toolbar" style={{ flexWrap: 'wrap' }}>
        <button className="btn small" onClick={showCatalog}>
          자재 목록
        </button>
        <button
          className={'btn small ' + (st.tool === 'select' ? 'active' : '')}
          aria-pressed={st.tool === 'select'}
          onClick={() => st.setTool('select')}
        >
          선택 / 이동
        </button>
        <button
          className={'btn small ' + (st.tool === 'pan' ? 'active' : '')}
          aria-pressed={st.tool === 'pan'}
          onClick={() => st.setTool('pan')}
        >
          화면 이동
        </button>
        <button
          className={'btn small ' + (st.tool === 'region' ? 'active' : '')}
          aria-pressed={st.tool === 'region'}
          data-testid="region-tool"
          title={regionIssue ?? '벽이나 바닥을 끌어 네모 영역을 만들어요'}
          disabled={!!regionIssue}
          onClick={() => st.setTool('region')}
        >
          부분 타일
        </button>
        <WallFeatureToolButton tool={wallTool} compact={false} />
        <WallFeatureToolOptions tool={wallTool} compact={false} />
        {st.tool === 'region' && (
          <button
            className={'btn small ' + (regionSnap ? 'active' : '')}
            aria-pressed={regionSnap}
            data-testid="region-snap"
            title="경계를 바탕 타일 줄눈에 맞춤"
            onClick={() => setRegionSnap((value) => !value)}
          >
            줄눈 맞춤
          </button>
        )}
        {(st.tool === 'region' || regionNote) && (
          <span className="tool-label" role="status" data-testid="region-note">
            {regionNote || '벽이나 바닥을 끌어 네모 영역을 만드세요.'}
          </span>
        )}
        <button className="btn small" onClick={showInspector}>
          {name ? name + ' 속성' : '자재·공간 속성'}
        </button>
      </div>
      <div className="canvas-stage" ref={stage}>
        <WallFeature3dNotice tool={wallTool} />
        <div
          ref={frame}
          className="canvas-frame"
          style={{ width, height: width / aspect, transform: 'translate(-50%, -50%)', touchAction: 'none' }}
          data-testid="room-editor-canvas"
          aria-busy={loading}
          data-render-state={loading ? 'preparing' : failure ? 'error' : 'ready'}
          onPointerDown={begin}
          onPointerMove={move}
          onPointerUp={(event) => end(false, event)}
          onPointerCancel={() => end(true)}
        >
          <div ref={mount} style={{ width: '100%', height: '100%' }} />
          {outline && (
            <svg
              viewBox="0 0 1 1"
              preserveAspectRatio="none"
              data-testid={outline.testId}
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
            >
              <polygon
                points={outline.points.map((point) => point.x + ',' + point.y).join(' ')}
                fill={outline.testId === 'region-preview' ? 'rgba(43, 151, 129, 0.16)' : 'none'}
                stroke="#2b9781"
                strokeWidth="2"
                strokeDasharray="5 3"
                vectorEffect="non-scaling-stroke"
              />
            </svg>
          )}
          {!!wallOutlines.length && (
            <svg
              viewBox="0 0 1 1"
              preserveAspectRatio="none"
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
            >
              <WallFeaturePolygons items={wallOutlines} scale={1} />
            </svg>
          )}
        </div>
        {scene.room && <WallFeatureCard tool={wallTool} room={scene.room} anchor={cardAnchor} stage={size} />}
        {loading && <div className="canvas-loading">입체 공간을 준비하고 있어요…</div>}
        {failure && (
          <div className="canvas-loading" role="alert">
            공간을 표시하지 못했어요. {failure}
          </div>
        )}
        {st.mode === 'split' && (
          <label className="split-range">
            <input
              aria-label="Before After 비교 위치"
              type="range"
              min="0"
              max="1"
              step=".01"
              value={st.split}
              onChange={(event) => st.setSplit(+event.target.value)}
            />
          </label>
        )}
      </div>
      <div className="workspace-toolbar" style={{ flexWrap: 'wrap' }}>
        {(FOUR_DIRECTION_VIEWS
          ? (['left', 'right'] as const)
          : (['left', 'right', 'up', 'down'] as const)
        ).map((direction, index) => (
          <button
            className="btn small"
            key={direction}
            onClick={() => updateView(rotateRoomView(view, direction))}
          >
            {['왼쪽', '오른쪽', '위로', '아래로'][index]} 90°
          </button>
        ))}
        <button
          className="btn small"
          aria-label="축소"
          onClick={() => updateView(normalizeRoomView({ ...view, zoom: view.zoom / 1.2 }))}
        >
          −
        </button>
        <button
          className="btn small"
          aria-label="확대"
          onClick={() => updateView(normalizeRoomView({ ...view, zoom: view.zoom * 1.2 }))}
        >
          ＋
        </button>
        <button className="btn small" onClick={() => updateView({ ...view, zoom: 1, pan: { x: 0, y: 0 } })}>
          화면 맞춤
        </button>
        <button className="btn small" onClick={() => updateView(resetRoomView(view))}>
          시점 초기화
        </button>
        <button
          className="btn small"
          onClick={() => {
            setLoading(true);
            setRetry((value) => value + 1);
          }}
        >
          보기 새로고침
        </button>
      </div>
    </section>
  );
}
