'use client';

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { TrackballControls } from 'three/addons/controls/TrackballControls.js';
import type { ProductMesh, ProductPose } from '@/lib/product3d/state-types';
import { ProductRenderer, type ProductCapture } from '@/lib/product3d/renderer';
import {
  createDefaultPose,
  MAX_PRODUCT_ZOOM,
  MIN_PRODUCT_ZOOM,
  ProductPoseHistory,
  rotateInScreen,
  screenDragAngle,
} from '@/lib/product3d/pose';
import styles from './product3d-viewport.module.css';

export interface ProductViewportHandle {
  capture(): Promise<ProductCapture>;
  getPose(): ProductPose;
}
export interface ProductViewportProps {
  mesh: ProductMesh;
  initialPose: ProductPose;
  onPoseChange: (pose: ProductPose) => void;
  onError: (message: string) => void;
}
type Action = 'fit' | 'view' | 'tilt' | 'undo' | 'redo' | 'in' | 'out';
interface Runtime {
  renderer: ProductRenderer;
  controls: TrackballControls;
  commit: () => void;
  draw: () => void;
  action: (action: Action) => void;
  beginTilt: (event: PointerEvent, element: HTMLButtonElement) => void;
  keyTilt: (clockwise: number) => void;
  cancelTilt: () => void;
  capture: () => Promise<ProductCapture>;
}

export const ProductViewport = forwardRef<ProductViewportHandle, ProductViewportProps>(
  function ProductViewport({ mesh, initialPose, onPoseChange, onError }, ref) {
    const canvasMountRef = useRef<HTMLDivElement>(null);
    const areaRef = useRef<HTMLDivElement>(null);
    const selectionRef = useRef<HTMLDivElement>(null);
    const topRef = useRef<HTMLButtonElement>(null);
    const bottomRef = useRef<HTMLButtonElement>(null);
    const runtime = useRef<Runtime | null>(null);
    const callbacks = useRef({ onPoseChange, onError });
    const initial = useRef(initialPose);
    const [background, setBackground] = useState<'checker' | 'white' | 'black'>('checker');
    const [pose, setPose] = useState(initialPose);
    const [history, setHistory] = useState({ undo: false, redo: false });
    const [ready, setReady] = useState(false);
    const [selected, setSelected] = useState(false);
    useEffect(() => {
      callbacks.current = { onPoseChange, onError };
    }, [onPoseChange, onError]);
    useEffect(() => {
      initial.current = initialPose;
    }, [initialPose]);

    useImperativeHandle(
      ref,
      () => ({
        getPose() {
          const active = runtime.current;
          if (!active) throw new Error('입체 미리보기가 준비되지 않았습니다.');
          active.controls.update();
          return active.renderer.getPose();
        },
        async capture() {
          const active = runtime.current;
          if (!active) throw new Error('입체 미리보기가 준비되지 않았습니다.');
          return active.capture();
        },
      }),
      [],
    );

    useEffect(() => {
      const mount = canvasMountRef.current,
        area = areaRef.current;
      if (!mount || !area) return;
      // Each effect owns a fresh canvas. A disposed WebGL context cannot safely
      // be reused when React StrictMode immediately mounts the effect again.
      const canvas = document.createElement('canvas');
      canvas.className = styles.canvas;
      canvas.dataset.testid = 'product3d-canvas';
      canvas.setAttribute('aria-label', '드래그하면 제품 시점을 자유롭게 회전합니다');
      canvas.tabIndex = 0;
      mount.append(canvas);
      let initialized: ProductRenderer | undefined;
      try {
        initialized = new ProductRenderer(canvas, mesh);
        initialized.setPose(initial.current);
      } catch (error) {
        initialized?.dispose();
        canvas.remove();
        callbacks.current.onError(error instanceof Error ? error.message : String(error));
        return;
      }
      const engine = initialized;
      const createControls = () => {
        const next = new TrackballControls(engine.camera, canvas);
        next.target.set(0, 0, 0);
        next.noPan = true;
        next.staticMoving = true;
        next.rotateSpeed = 1.25;
        next.zoomSpeed = 1.1;
        next.minZoom = MIN_PRODUCT_ZOOM;
        next.maxZoom = MAX_PRODUCT_ZOOM;
        next.keys = ['', '', ''];
        return next;
      };
      let controls = createControls();
      const undo = new ProductPoseHistory(initial.current);
      let stopped = false,
        capturing = false,
        frame = 0,
        interactionStart: ProductPose | undefined;
      let wheelTimer: ReturnType<typeof setTimeout> | undefined;
      let wheelActive = false,
        wasClick = false;
      const pointers = new Set<number>();
      let click: { id: number; x: number; y: number; maxDistance: number; multiple: boolean } | undefined;
      let tilt:
        | {
            pointer: number;
            element: HTMLButtonElement;
            pose: ProductPose;
            start: { x: number; y: number };
            center: { x: number; y: number };
          }
        | undefined;

      const publish = () => {
        const current = engine.getPose();
        setPose(current);
        setHistory({ undo: undo.canUndo, redo: undo.canRedo });
        callbacks.current.onPoseChange(current);
      };
      const commit = () => {
        undo.record(engine.getPose());
        interactionStart = undefined;
        publish();
      };
      const overlay = () => {
        const bounds = engine.projectedBounds();
        const box = selectionRef.current;
        if (box) {
          box.style.left = `${bounds.left}px`;
          box.style.top = `${bounds.top}px`;
          box.style.width = `${bounds.right - bounds.left}px`;
          box.style.height = `${bounds.bottom - bounds.top}px`;
        }
        for (const [element, y] of [
          [topRef.current, bounds.top - 13],
          [bottomRef.current, bounds.bottom + 13],
        ] as const) {
          if (element) {
            element.style.left = `${Math.max(24, Math.min(area.clientWidth - 24, bounds.centerX))}px`;
            element.style.top = `${Math.max(24, Math.min(area.clientHeight - 24, y))}px`;
          }
        }
      };
      const fail = (error: unknown) => {
        if (stopped) return;
        stopped = true;
        controls.enabled = false;
        setReady(false);
        callbacks.current.onError(error instanceof Error ? error.message : String(error));
      };
      const draw = () => {
        if (stopped || capturing || frame) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          try {
            controls.update();
            engine.render();
            overlay();
          } catch (error) {
            fail(error);
          }
        });
      };
      const flushWheel = () => {
        if (wheelTimer) clearTimeout(wheelTimer);
        wheelTimer = undefined;
        if (wheelActive) {
          controls.update();
          wheelActive = false;
          commit();
        }
      };
      const start = () => {
        if (!interactionStart) interactionStart = engine.getPose();
      };
      const end = () => {
        controls.update();
        if (pointers.size > 0) {
          draw();
          return;
        }
        if (wasClick && interactionStart) {
          engine.setPose(interactionStart);
          wasClick = false;
        }
        if (wheelActive) {
          if (wheelTimer) clearTimeout(wheelTimer);
          wheelTimer = setTimeout(() => {
            wheelActive = false;
            wheelTimer = undefined;
            if (!stopped) commit();
          }, 150);
        } else commit();
        draw();
      };
      const pointerDown = (event: PointerEvent) => {
        if (stopped || capturing) return;
        flushWheel();
        pointers.add(event.pointerId);
        wasClick = false;
        if (!click)
          click = {
            id: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            maxDistance: 0,
            multiple: false,
          };
        if (pointers.size > 1 && click) click.multiple = true;
        controls.handleResize();
      };
      const pointerMove = (event: PointerEvent) => {
        if (click && click.id === event.pointerId)
          click.maxDistance = Math.max(
            click.maxDistance,
            Math.hypot(event.clientX - click.x, event.clientY - click.y),
          );
        if (tilt && tilt.pointer === event.pointerId) {
          const angle = screenDragAngle(tilt.center, tilt.start, { x: event.clientX, y: event.clientY });
          engine.setPose(rotateInScreen(tilt.pose, angle));
        }
        if (pointers.has(event.pointerId) || tilt) draw();
      };
      const endTilt = (cancel: boolean) => {
        if (!tilt) return;
        const old = tilt;
        tilt = undefined;
        if (cancel) engine.setPose(old.pose);
        controls.enabled = !stopped;
        if (old.element.hasPointerCapture(old.pointer)) old.element.releasePointerCapture(old.pointer);
        if (!cancel) commit();
        else publish();
        draw();
      };
      const pointerUp = (event: PointerEvent) => {
        if (tilt?.pointer === event.pointerId) {
          endTilt(false);
          return;
        }
        pointers.delete(event.pointerId);
        if (click?.id === event.pointerId) {
          if (
            !click.multiple &&
            Math.max(click.maxDistance, Math.hypot(event.clientX - click.x, event.clientY - click.y)) <= 5 &&
            event.button === 0
          ) {
            wasClick = true;
            const rect = canvas.getBoundingClientRect();
            setSelected(engine.hitTest(event.clientX - rect.left, event.clientY - rect.top));
          }
          click = undefined;
        }
      };
      const cancel = () => {
        const hadInteraction = Boolean(tilt || interactionStart || pointers.size);
        if (tilt) endTilt(true);
        if (interactionStart) {
          controls.update();
          engine.setPose(interactionStart);
          interactionStart = undefined;
          publish();
        }
        for (const pointer of pointers)
          if (canvas.hasPointerCapture(pointer)) canvas.releasePointerCapture(pointer);
        pointers.clear();
        click = undefined;
        wasClick = false;
        if (wheelTimer) clearTimeout(wheelTimer);
        wheelTimer = undefined;
        wheelActive = false;
        // TrackballControls does not clear its private pointer state on window blur.
        // Reconnect a clean controls instance rather than accessing private fields.
        if (hadInteraction) {
          controls.removeEventListener('start', start);
          controls.removeEventListener('end', end);
          controls.removeEventListener('change', draw);
          controls.dispose();
          controls = createControls();
          controls.enabled = !stopped && !capturing;
          controls.addEventListener('start', start);
          controls.addEventListener('end', end);
          controls.addEventListener('change', draw);
          if (runtime.current) runtime.current.controls = controls;
        }
        draw();
      };
      const wheel = () => {
        wheelActive = true;
        draw();
      };
      const contextLost = (event: Event) => {
        event.preventDefault();
        fail(new Error('GPU 연결이 끊겼습니다. 창을 닫고 다시 열어 주세요.'));
      };
      const resize = () => {
        if (stopped) return;
        const box = area.getBoundingClientRect();
        engine.resize(box.width, box.height, window.devicePixelRatio);
        controls.handleResize();
        draw();
      };
      runtime.current = {
        renderer: engine,
        controls,
        commit,
        draw,
        action(action) {
          if (stopped || capturing) return;
          flushWheel();
          const current = engine.getPose();
          if (action === 'undo') engine.setPose(undo.undo());
          else if (action === 'redo') engine.setPose(undo.redo());
          else {
            const next = { ...current };
            if (action === 'fit') next.zoom = 1;
            if (action === 'view') next.cameraQuaternion = createDefaultPose().cameraQuaternion;
            if (action === 'tilt') next.objectQuaternion = [0, 0, 0, 1];
            if (action === 'in') next.zoom = Math.min(MAX_PRODUCT_ZOOM, current.zoom * 1.25);
            if (action === 'out') next.zoom = Math.max(MIN_PRODUCT_ZOOM, current.zoom / 1.25);
            engine.setPose(next);
            undo.record(next);
          }
          interactionStart = undefined;
          publish();
          draw();
        },
        beginTilt(event, element) {
          if (stopped || capturing || tilt) return;
          event.preventDefault();
          event.stopPropagation();
          flushWheel();
          controls.update();
          controls.enabled = false;
          const rect = canvas.getBoundingClientRect(),
            bounds = engine.projectedBounds();
          tilt = {
            pointer: event.pointerId,
            element,
            pose: engine.getPose(),
            start: { x: event.clientX, y: event.clientY },
            center: { x: rect.left + bounds.centerX, y: rect.top + bounds.centerY },
          };
          element.setPointerCapture(event.pointerId);
        },
        cancelTilt() {
          endTilt(true);
        },
        async capture() {
          if (stopped || capturing) throw new Error('입체 미리보기가 준비되지 않았거나 이미 저장 중입니다.');
          controls.update();
          endTilt(false);
          flushWheel();
          commit();
          capturing = true;
          controls.enabled = false;
          try {
            return await engine.capture();
          } finally {
            capturing = false;
            controls.enabled = !stopped;
            draw();
          }
        },
        keyTilt(clockwise) {
          if (stopped || capturing) return;
          engine.setPose(rotateInScreen(engine.getPose(), (clockwise * Math.PI) / 180));
          commit();
          draw();
        },
      };
      controls.addEventListener('start', start);
      controls.addEventListener('end', end);
      controls.addEventListener('change', draw);
      canvas.addEventListener('pointerdown', pointerDown, true);
      canvas.addEventListener('wheel', wheel, { capture: true, passive: true });
      canvas.addEventListener('webglcontextlost', contextLost);
      document.addEventListener('pointermove', pointerMove);
      document.addEventListener('pointerup', pointerUp, true);
      document.addEventListener('pointercancel', cancel, true);
      window.addEventListener('blur', cancel);
      const observer = new ResizeObserver(resize);
      observer.observe(area);
      resize();
      publish();
      // Initial notification is deferred to keep state changes outside the effect body.
      const readyFrame = requestAnimationFrame(() => {
        if (!stopped) {
          setReady(true);
          setSelected(false);
        }
      });
      return () => {
        stopped = true;
        runtime.current = null;
        if (frame) cancelAnimationFrame(frame);
        cancelAnimationFrame(readyFrame);
        if (wheelTimer) clearTimeout(wheelTimer);
        observer.disconnect();
        canvas.removeEventListener('pointerdown', pointerDown, true);
        canvas.removeEventListener('wheel', wheel, true);
        canvas.removeEventListener('webglcontextlost', contextLost);
        document.removeEventListener('pointermove', pointerMove);
        document.removeEventListener('pointerup', pointerUp, true);
        document.removeEventListener('pointercancel', cancel, true);
        window.removeEventListener('blur', cancel);
        controls.removeEventListener('start', start);
        controls.removeEventListener('end', end);
        controls.removeEventListener('change', draw);
        controls.dispose();
        engine.dispose();
        canvas.remove();
      };
    }, [mesh]);

    const action = (name: Action) => runtime.current?.action(name);
    return (
      <section className={styles.root} aria-label="360도 제품 각도 편집">
        <div className={styles.toolbar}>
          <div className={styles.group} aria-label="미리보기 배경">
            {(['checker', 'white', 'black'] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={background === value}
                onClick={() => setBackground(value)}
              >
                {{ checker: '체크무늬', white: '흰색', black: '검은색' }[value]}
              </button>
            ))}
          </div>
          <div className={styles.group}>
            <button
              type="button"
              onClick={() => action('out')}
              disabled={!ready || pose.zoom <= MIN_PRODUCT_ZOOM}
              aria-label="축소"
            >
              −
            </button>
            <output aria-label="확대 배율">{Math.round(pose.zoom * 100)}%</output>
            <button
              type="button"
              onClick={() => action('in')}
              disabled={!ready || pose.zoom >= MAX_PRODUCT_ZOOM}
              aria-label="확대"
            >
              +
            </button>
            <button type="button" onClick={() => action('fit')} disabled={!ready}>
              화면 맞춤
            </button>
          </div>
        </div>
        <div ref={areaRef} className={`${styles.area} ${styles[background]}`}>
          <div ref={canvasMountRef} className={styles.canvasHost} />
          <div
            ref={selectionRef}
            data-testid="product3d-selection"
            className={styles.selection}
            hidden={!selected}
          />
          {(['top', 'bottom'] as const).map((position) => (
            <button
              key={position}
              ref={position === 'top' ? topRef : bottomRef}
              type="button"
              hidden={!selected}
              data-testid={`product3d-handle-${position}`}
              className={styles.handle}
              aria-label={position === 'top' ? '위쪽 기울기 손잡이' : '아래쪽 기울기 손잡이'}
              title="드래그 또는 좌우 방향키로 기울기 보정"
              onPointerDown={(event) => runtime.current?.beginTilt(event.nativeEvent, event.currentTarget)}
              onLostPointerCapture={() => runtime.current?.cancelTilt()}
              onKeyDown={(event) => {
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                event.preventDefault();
                event.stopPropagation();
                runtime.current?.keyTilt(
                  (event.key === 'ArrowRight' ? 1 : -1) * (position === 'top' ? 1 : -1),
                );
              }}
            >
              ↔
            </button>
          ))}
          {!ready && <span className={styles.loading}>입체 미리보기 준비 중</span>}
        </div>
        <div className={styles.toolbar}>
          <div className={styles.group}>
            <button type="button" onClick={() => action('view')} disabled={!ready}>
              시점 초기화
            </button>
            <button type="button" onClick={() => action('tilt')} disabled={!ready}>
              기울기 초기화
            </button>
          </div>
          <div className={styles.group}>
            <button type="button" onClick={() => action('undo')} disabled={!ready || !history.undo}>
              실행 취소
            </button>
            <button type="button" onClick={() => action('redo')} disabled={!ready || !history.redo}>
              다시 실행
            </button>
          </div>
        </div>
        <p className={styles.hint}>
          드래그로 자유 회전 · 휠/두 손가락으로 확대 · 제품을 클릭한 뒤 위·아래 손잡이를 움직여 기울기를
          바로잡으세요. 손잡이는 좌우 방향키로도 조절할 수 있어요.
        </p>
        <output hidden data-testid="product3d-pose" data-pose={JSON.stringify(pose)}>
          {JSON.stringify(pose)}
        </output>
      </section>
    );
  },
);

export const Product3dViewport = ProductViewport;
