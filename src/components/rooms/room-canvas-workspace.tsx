'use client';
import { useEffect, useRef, useState } from 'react';
import { useEditor } from '@/lib/editor-store';
import { getEditingScene } from '@/lib/comparison';
import type { MaterialVersion, Scene } from '@/lib/types';
import type { AssetReader } from '@/lib/render/compositor';
import { projectDesignPreviewRoomContext } from '@/lib/render/design-preview-context';
import { RoomViewerRenderer } from '@/lib/room-viewer/renderer';
import { normalizeRoomView, resetRoomView, rotateRoomView } from '@/lib/room-viewer/view-state';
import { useEditingCapabilities } from '../editor/editing-capabilities';

/** The same world renderer used for comparison/export, with installation-plane editing. */
export default function RoomCanvasWorkspace({
  materials,
  assetReader,
  onError,
  showCatalog,
  showInspector,
}: {
  materials: Record<string, MaterialVersion>;
  assetReader: AssetReader;
  onError: (message: string) => void;
  showCatalog: () => void;
  showInspector: () => void;
}) {
  const st = useEditor(),
    { writable } = useEditingCapabilities();
  const scene = st.draft ?? (st.project ? getEditingScene(st.project, st.editing) : undefined);
  const context = st.project ? projectDesignPreviewRoomContext(st.project) : undefined;
  const before = st.editing === 'before' ? scene : context?.beforeScene;
  const view = normalizeRoomView(st.project?.roomView);
  const stage = useRef<HTMLDivElement>(null),
    mount = useRef<HTMLDivElement>(null);
  const renderer = useRef<RoomViewerRenderer | null>(null);
  const [size, setSize] = useState({ width: 800, height: 600 });
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState('');
  const canPick = useRef(false),
    preparedKey = useRef<string | null>(null);
  const [retry, setRetry] = useState(0);
  const sceneKey = JSON.stringify([scene, before, materials, context?.fitScenes]);
  const current = useRef({
    scene,
    before,
    materials,
    context,
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
    view,
    mode: st.mode,
    split: st.split,
    size,
    sceneKey,
  };
  const schedule = useRef(() => {}),
    paint = useRef(() => {});
  const gesture = useRef<{
    kind: 'fixture' | 'pan';
    id?: string;
    start: { x: number; y: number };
    base: Scene;
    uv?: { u: number; v: number };
    view: typeof view;
    moved: boolean;
  } | null>(null);

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
                { scene: c.scene, beforeScene: c.before, materials: c.materials },
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
    if (gesture.current?.kind === 'fixture') useEditor.getState().cancel();
    gesture.current = null;
  }, [st.project?.id, st.project?.activeDesignId, st.editing, st.tool, st.mode, writable]);
  useEffect(() => {
    const cancel = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      gesture.current = null;
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
    const normalized = normalizeRoomView(next);
    if (writable) st.setRoomView(normalized);
    else if (st.project) useEditor.setState({ project: { ...st.project, roomView: normalized } });
  }
  function point(event: React.PointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height };
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
    const picked = renderer.current.pick(start.x, start.y);
    st.select(picked?.id ?? null);
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
    if (!g.moved && Math.hypot((p.x - g.start.x) * rect.width, (p.y - g.start.y) * rect.height) < 5) return;
    g.moved = true;
    if (g.kind === 'pan') {
      updateView({
        ...g.view,
        pan: { x: g.view.pan.x + p.x - g.start.x, y: g.view.pan.y + p.y - g.start.y },
      });
      return;
    }
    if (!writable) {
      gesture.current = null;
      st.cancel();
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
    });
  }
  function end(cancel = false) {
    const g = gesture.current;
    gesture.current = null;
    if (g?.kind === 'fixture' && g.moved) {
      if (cancel || !writable) st.cancel();
      else st.commit();
    }
  }
  if (!scene || !st.project) return null;
  const aspect = scene.imageWidth / scene.imageHeight;
  const width = Math.max(1, Math.min(size.width, size.height * aspect));
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
          onClick={() => st.setTool('select')}
        >
          선택 / 이동
        </button>
        <button
          className={'btn small ' + (st.tool === 'pan' ? 'active' : '')}
          onClick={() => st.setTool('pan')}
        >
          화면 이동
        </button>
        <button className="btn small" onClick={showInspector}>
          {name ? name + ' 속성' : '자재·공간 속성'}
        </button>
      </div>
      <div className="canvas-stage" ref={stage}>
        <div
          className="canvas-frame"
          style={{ width, height: width / aspect, transform: 'translate(-50%, -50%)', touchAction: 'none' }}
          data-testid="room-editor-canvas"
          aria-busy={loading}
          data-render-state={loading ? 'preparing' : failure ? 'error' : 'ready'}
          onPointerDown={begin}
          onPointerMove={move}
          onPointerUp={() => end()}
          onPointerCancel={() => end(true)}
        >
          <div ref={mount} style={{ width: '100%', height: '100%' }} />
        </div>
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
        {(['left', 'right', 'up', 'down'] as const).map((direction, index) => (
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
