'use client';

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { TrackballControls } from 'three/addons/controls/TrackballControls.js';
import type { ProductMesh, ProductPose, ProductShading } from '@/lib/product3d/state-types';
import { ProductRenderer, type ProductCapture } from '@/lib/product3d/renderer';
import { estimateUprightQuaternion } from '@/lib/product3d/upright';
import { levelByOutline, type OutlineLevelResult } from '@/lib/product3d/outline-level';
import { readySurface } from '@/lib/product3d/shading';
import type { ProductGloss } from '@/lib/product3d/glaze';
import { prepareProductSurface } from '@/lib/product3d/surface';
import {
  createDefaultPose,
  MAX_PRODUCT_ZOOM,
  MIN_PRODUCT_ZOOM,
  lineRollAngle,
  ProductPoseHistory,
  rotateInScreen,
  screenDragAngle,
} from '@/lib/product3d/pose';
import styles from './product3d-viewport.module.css';

export interface ProductViewportHandle {
  capture(): Promise<ProductCapture>;
  getPose(): ProductPose;
  /** Turns the view to a pose (one undo step), e.g. to face the direction a name gives. */
  setPose(pose: ProductPose): void;
}
export interface ProductViewportProps {
  mesh: ProductMesh;
  initialPose: ProductPose;
  /**
   * 'mixed': the photographed side keeps the photo's detail, the rest is clean base colour; 'lit':
   * base colours only, under viewer lighting; 'baked': the model's own RGB.
   */
  shading: ProductShading;
  /** The glaze of the lit modes (ceramic products only; see product3d/glaze.ts). */
  gloss?: ProductGloss;
  onShadingChange: (shading: ProductShading) => void;
  onPoseChange: (pose: ProductPose) => void;
  onError: (message: string) => void;
  /**
   * A model just made: stand it level by its outline when the viewer opens (see levelByOutline). A
   * saved product opens as saved.
   */
  levelOnOpen?: boolean;
}
type LevelTool = 'off' | 'level' | 'upright';

/** What the automatic level did, in words. */
export function levelNote(result: OutlineLevelResult, fresh = false): string {
  const where = fresh ? '새 입체 형상: ' : '';
  if (result.status === 'turned') {
    const degrees = Math.abs(result.degrees).toFixed(1);
    return `${where}윤곽의 수평·수직선이 ${degrees}° ${result.degrees > 0 ? '오른쪽' : '왼쪽'}으로 기울어 있어 바로잡았어요.`;
  }
  if (result.status === 'level') return `${where}윤곽의 수평·수직선이 이미 맞아요.`;
  return `${where}윤곽에서 기울기를 확신할 수 없어 형상으로만 맞췄어요. 어긋나 보이면 수평선·수직선 맞추기로 직접 맞춰 주세요.`;
}
type Action = 'fit' | 'view' | 'tilt' | 'upright' | 'undo' | 'redo' | 'in' | 'out';
interface Runtime {
  renderer: ProductRenderer;
  controls: TrackballControls;
  commit: () => void;
  draw: () => void;
  action: (action: Action) => void;
  setPose: (pose: ProductPose) => void;
  beginTilt: (event: PointerEvent, element: HTMLButtonElement) => void;
  keyTilt: (clockwise: number) => void;
  cancelTilt: () => void;
  capture: () => Promise<ProductCapture>;
}

export const ProductViewport = forwardRef<ProductViewportHandle, ProductViewportProps>(
  function ProductViewport(
    {
      mesh,
      initialPose,
      shading,
      gloss = 'none',
      onShadingChange,
      onPoseChange,
      onError,
      levelOnOpen = false,
    },
    ref,
  ) {
    const canvasMountRef = useRef<HTMLDivElement>(null);
    const areaRef = useRef<HTMLDivElement>(null);
    const selectionRef = useRef<HTMLDivElement>(null);
    const topRef = useRef<HTMLButtonElement>(null);
    const bottomRef = useRef<HTMLButtonElement>(null);
    const runtime = useRef<Runtime | null>(null);
    const callbacks = useRef({ onPoseChange, onError });
    const initial = useRef(initialPose);
    const shadingRef = useRef(shading);
    const glossRef = useRef(gloss);
    const levelOnOpenRef = useRef(levelOnOpen);
    const toolLayerRef = useRef<HTMLDivElement>(null);
    const [background, setBackground] = useState<'checker' | 'white' | 'black'>('checker');
    const [pose, setPose] = useState(initialPose);
    const [history, setHistory] = useState({ undo: false, redo: false });
    const [ready, setReady] = useState(false);
    const [selected, setSelected] = useState(false);
    const [note, setNote] = useState('');
    // The colours of a lit mode are worked out off the main thread; until they are in, the picture
    // keeps the previous mode and a capture waits for them.
    const preparing = useRef<Promise<void>>(Promise.resolve());
    const [preparingShading, setPreparingShading] = useState(false);
    const [tool, setTool] = useState<LevelTool>('off');
    const [guide, setGuide] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
    const [guideTurn, setGuideTurn] = useState(0);
    useEffect(() => {
      callbacks.current = { onPoseChange, onError };
    }, [onPoseChange, onError]);
    useEffect(() => {
      initial.current = initialPose;
    }, [initialPose]);
    useEffect(() => {
      glossRef.current = gloss;
      const active = runtime.current;
      if (!active) return;
      active.renderer.setGloss(gloss);
      active.draw();
    }, [gloss, ready]);
    useEffect(() => {
      shadingRef.current = shading;
      const active = runtime.current;
      if (!active) return;
      if (shading === 'baked' || readySurface(shading, mesh)) {
        preparing.current = Promise.resolve();
        setPreparingShading(false);
        active.renderer.setShading(shading);
        active.draw();
        return;
      }
      let current = true;
      setPreparingShading(true);
      preparing.current = prepareProductSurface(shading, mesh).then(() => {
        if (!current) return;
        active.renderer.setShading(shading);
        active.draw();
        setPreparingShading(false);
      });
      return () => {
        current = false;
      };
    }, [shading, ready, mesh]);

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
          await preparing.current;
          return active.capture();
        },
        setPose(pose) {
          runtime.current?.setPose(pose);
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
      let openNote = '';
      try {
        initialized = new ProductRenderer(canvas, mesh);
        initialized.setShading(shadingRef.current);
        initialized.setGloss(glossRef.current);
        initialized.setPose(initial.current);
        // A new model comes level by its outline, on top of the shape estimate it was given.
        if (levelOnOpenRef.current) {
          const leveled = levelByOutline(initial.current, (pose) => initialized!.silhouette(pose));
          if (leveled.status === 'turned') {
            initial.current = leveled.pose;
            initialized.setPose(leveled.pose);
          }
          openNote = levelNote(leveled, true);
        }
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
      // Computed on first use; the saved mesh never changes while this viewer is open.
      let upright: ProductPose['objectQuaternion'] | undefined;
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
            if (action === 'tilt') {
              next.objectQuaternion = [0, 0, 0, 1];
              setNote('');
            }
            if (action === 'upright') {
              // The shape first, then the outline: the product's edges seen level are made level.
              next.objectQuaternion = upright ??= estimateUprightQuaternion(mesh.positions);
              try {
                const leveled = levelByOutline(next, (pose) => engine.silhouette(pose));
                next.objectQuaternion = leveled.pose.objectQuaternion;
                setNote(levelNote(leveled));
              } catch {
                setNote('윤곽을 읽지 못해 형상으로만 맞췄어요.');
              }
            }
            if (action === 'in') next.zoom = Math.min(MAX_PRODUCT_ZOOM, current.zoom * 1.25);
            if (action === 'out') next.zoom = Math.max(MIN_PRODUCT_ZOOM, current.zoom / 1.25);
            engine.setPose(next);
            undo.record(next);
          }
          interactionStart = undefined;
          publish();
          draw();
        },
        setPose(next) {
          if (stopped || capturing) return;
          flushWheel();
          controls.update();
          engine.setPose(next);
          undo.record(next);
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
          if (openNote) setNote(openNote);
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
    const endTool = () => {
      setTool('off');
      setGuide(null);
      setGuideTurn(0);
    };
    const applyLine = (degrees: number | undefined, kind: LevelTool) => {
      if (degrees === undefined) {
        setNote(
          `선이 너무 짧거나 ${kind === 'level' ? '수평' : '수직'}에서 너무 벗어났어요. ${
            kind === 'level' ? '수평이어야 할 모서리' : '수직이어야 할 모서리'
          }를 따라 조금 더 길게 끌어 주세요.`,
        );
        return;
      }
      runtime.current?.keyTilt(degrees);
      setNote(
        Math.abs(degrees) < 0.05
          ? `선이 이미 ${kind === 'level' ? '수평' : '수직'}이에요.`
          : `선을 ${kind === 'level' ? '수평' : '수직'}으로 맞췄어요(${Math.abs(degrees).toFixed(1)}° ${degrees > 0 ? '오른쪽' : '왼쪽'}으로 돌림).`,
      );
      endTool();
    };
    const toolPoint = (event: { clientX: number; clientY: number }) => {
      const rect = toolLayerRef.current!.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    // The line tool takes the keyboard when it turns on: arrow keys turn its guide, Enter applies.
    useEffect(() => {
      if (tool !== 'off') toolLayerRef.current?.focus();
    }, [tool]);
    return (
      <section className={styles.root} aria-label="360도 제품 각도 편집">
        <div className={styles.toolbar}>
          <div className={styles.group} aria-label="제품 색 표현">
            {(
              [
                [
                  'mixed',
                  '혼합(권장)',
                  '사진에 찍힌 쪽은 사진의 선·버튼 같은 디테일을 살리고, 안 찍힌 쪽은 깨끗한 제품 색에 음영으로 형태를 보여 줘요',
                ],
                [
                  'lit',
                  '조명 보정',
                  '사진의 그림자를 걷어 낸 제품 색에 현재 시점의 조명을 입혀요(디테일은 사라져요)',
                ],
                ['baked', '원본 색', 'AI가 만든 색을 그대로 보여 줘요(사진의 명암과 추측한 어두운 색 포함)'],
              ] as const
            ).map(([value, label, title]) => (
              <button
                key={value}
                type="button"
                aria-pressed={shading === value}
                title={title}
                onClick={() => onShadingChange(value)}
              >
                {label}
              </button>
            ))}
            {preparingShading && (
              <span role="status" className={styles.preparing} data-testid="product3d-shading-busy">
                색을 계산하고 있어요…
              </span>
            )}
          </div>
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
              hidden={!selected || tool !== 'off'}
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
          {tool !== 'off' && (
            <div
              ref={toolLayerRef}
              className={styles.toolLayer}
              data-testid="product3d-line-layer"
              role="application"
              tabIndex={0}
              aria-label={`${tool === 'level' ? '수평선' : '수직선'} 맞추기. 제품의 ${
                tool === 'level' ? '수평' : '수직'
              }이어야 할 모서리를 따라 끌어 주세요. 키보드는 좌우 방향키로 보조선을 모서리에 맞추고 Enter로 적용, Esc로 취소해요.`}
              onPointerDown={(event) => {
                event.preventDefault();
                try {
                  event.currentTarget.setPointerCapture(event.pointerId);
                } catch {
                  // The drag still works inside the layer, which covers the whole picture.
                }
                const point = toolPoint(event);
                setGuide({ x1: point.x, y1: point.y, x2: point.x, y2: point.y });
              }}
              onPointerMove={(event) => {
                if (!guide) return;
                const point = toolPoint(event);
                setGuide({ ...guide, x2: point.x, y2: point.y });
              }}
              onPointerUp={(event) => {
                if (!guide) return;
                const point = toolPoint(event);
                const done = { ...guide, x2: point.x, y2: point.y };
                setGuide(null);
                applyLine(lineRollAngle({ x: done.x1, y: done.y1 }, { x: done.x2, y: done.y2 }, tool), tool);
              }}
              onPointerCancel={() => setGuide(null)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  event.stopPropagation();
                  endTool();
                } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                  event.preventDefault();
                  const step = (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 5 : 1);
                  setGuideTurn((turn) => Math.max(-45, Math.min(45, turn + step)));
                } else if (event.key === 'Enter') {
                  event.preventDefault();
                  applyLine(guideTurn === 0 ? 0 : -guideTurn, tool);
                }
              }}
            >
              <svg className={styles.toolSvg} aria-hidden="true">
                {guide ? (
                  <line x1={guide.x1} y1={guide.y1} x2={guide.x2} y2={guide.y2} className={styles.toolLine} />
                ) : (
                  <line
                    x1="50%"
                    y1="50%"
                    x2="50%"
                    y2="50%"
                    className={styles.toolLine}
                    style={{ display: 'none' }}
                  />
                )}
              </svg>
              {!guide && (
                <div
                  className={styles.toolKeyGuide}
                  aria-hidden="true"
                  style={{
                    transform: `translate(-50%, -50%) rotate(${(tool === 'level' ? 0 : 90) + guideTurn}deg)`,
                  }}
                />
              )}
              <p className={styles.toolHelp} aria-live="polite">
                {tool === 'level' ? '수평' : '수직'}이어야 할 모서리를 따라 끌어 놓으세요. 방향키로 보조선을
                돌린 뒤 Enter로 적용해도 돼요({guideTurn}°).
              </p>
            </div>
          )}
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
            <button type="button" onClick={() => action('upright')} disabled={!ready}>
              자동 수평 맞춤
            </button>
          </div>
          <div className={styles.group} aria-label="선으로 수평 맞추기">
            {(
              [
                ['level', '수평선 맞추기', '수평이어야 할 모서리(예: 탱크 윗변)를 따라 끌어요'],
                ['upright', '수직선 맞추기', '수직이어야 할 모서리(예: 옆면)를 따라 끌어요'],
              ] as const
            ).map(([kind, label, title]) => (
              <button
                key={kind}
                type="button"
                data-testid={`product3d-line-${kind}`}
                aria-pressed={tool === kind}
                title={title}
                disabled={!ready}
                onClick={() => {
                  setGuide(null);
                  setGuideTurn(0);
                  setTool(tool === kind ? 'off' : kind);
                }}
              >
                {label}
              </button>
            ))}
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
        {note && (
          <p className={styles.note} role="status" data-testid="product3d-level-note">
            {note}
          </p>
        )}
        <p className={styles.hint}>
          드래그로 자유 회전 · 휠/두 손가락으로 확대 · 제품을 클릭한 뒤 위·아래 손잡이를 움직여 기울기를
          바로잡으세요. 손잡이는 좌우 방향키로도 조절할 수 있어요. 자동 수평 맞춤은 제품의 윤곽선까지 읽어요.
          이전에 저장한 각도는 자동 수평 맞춤을 다시 누르고 저장해야 3D 방에 반영돼요. 안 찍힌 면(옆·뒤)의
          모양은 AI의 추측이라 실제와 달라요. 색 표현을 혼합으로 두면 칙칙한 색과 뭉개짐은 줄지만 정확해지지는
          않아요. 더 정확하게 하려면 다른 각도의 사진을 추가로 올려 주세요.
        </p>
        <output hidden data-testid="product3d-pose" data-pose={JSON.stringify(pose)}>
          {JSON.stringify(pose)}
        </output>
      </section>
    );
  },
);

export const Product3dViewport = ProductViewport;
