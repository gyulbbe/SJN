'use client';

import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
import { getRepositories } from '@/lib/repositories';
import { canvasBlob, makeAsset, previewDimensions } from '@/lib/images';
import { rectifyImage } from '@/lib/render/crop';
import type { Point, Quad } from '@/lib/types';
import styles from './materials.module.css';

type BrushStroke = { points: Point[]; radius: number; restore: boolean };
const INITIAL_QUAD: Quad = [
  { x: 0.05, y: 0.05 },
  { x: 0.95, y: 0.05 },
  { x: 0.95, y: 0.95 },
  { x: 0.05, y: 0.95 },
];

export function ImagePreparer({
  assetId,
  mode,
  widthMm = 600,
  heightMm = 600,
  onSaved,
  onCancel,
}: {
  assetId: string;
  mode: 'crop' | 'alpha';
  widthMm?: number;
  heightMm?: number;
  onSaved: (assetId: string) => void;
  onCancel: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sourceRef = useRef<HTMLCanvasElement | null>(null);
  const assetSourceRef = useRef<string>('');
  const strokesRef = useRef<BrushStroke[]>([]);
  const activeRef = useRef(false);
  const cornerRef = useRef<number | null>(null);
  const [quad, setQuad] = useState<Quad>(INITIAL_QUAD.map((point) => ({ ...point })) as Quad);
  const quadRef = useRef(quad);
  const [size, setSize] = useState({ width: 1, height: 1 });
  const [brush, setBrush] = useState(30);
  const [restore, setRestore] = useState(false);
  const [strokeCount, setStrokeCount] = useState(0);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const draw = useCallback(() => {
    const canvas = canvasRef.current,
      source = sourceRef.current;
    if (!canvas || !source) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(source, 0, 0);
    if (mode === 'alpha') {
      const mask = document.createElement('canvas');
      mask.width = canvas.width;
      mask.height = canvas.height;
      const maskCtx = mask.getContext('2d')!;
      maskCtx.fillStyle = '#fff';
      maskCtx.fillRect(0, 0, mask.width, mask.height);
      for (const stroke of strokesRef.current) {
        maskCtx.globalCompositeOperation = stroke.restore ? 'source-over' : 'destination-out';
        maskCtx.strokeStyle = '#fff';
        maskCtx.fillStyle = '#fff';
        maskCtx.lineWidth = stroke.radius * 2;
        maskCtx.lineCap = 'round';
        maskCtx.lineJoin = 'round';
        maskCtx.beginPath();
        stroke.points.forEach((point, i) =>
          i ? maskCtx.lineTo(point.x, point.y) : maskCtx.moveTo(point.x, point.y),
        );
        maskCtx.stroke();
        const first = stroke.points[0];
        if (first) {
          maskCtx.beginPath();
          maskCtx.arc(first.x, first.y, stroke.radius, 0, Math.PI * 2);
          maskCtx.fill();
        }
      }
      ctx.globalCompositeOperation = 'destination-in';
      ctx.drawImage(mask, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      return;
    }
    const points = quadRef.current.map((point) => ({
      x: point.x * canvas.width,
      y: point.y * canvas.height,
    }));
    ctx.fillStyle = '#172b2660';
    ctx.beginPath();
    ctx.rect(0, 0, canvas.width, canvas.height);
    points.forEach((point, i) => (i ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y)));
    ctx.closePath();
    ctx.fill('evenodd');
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = Math.max(2, canvas.width / 500);
    ctx.stroke();
    const radius = Math.max(10, canvas.width / 65);
    points.forEach((point, i) => {
      ctx.beginPath();
      ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = '#245e51';
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.font = `600 ${radius}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), point.x, point.y + 1);
    });
  }, [mode]);

  useEffect(() => {
    let alive = true;
    (async () => {
      const assets = getRepositories().assets;
      const selected = await assets.get(assetId);
      const original = selected.sourceAssetId ? await assets.get(selected.sourceAssetId) : selected;
      const bitmap = await createImageBitmap(original.blob);
      if (!alive) {
        bitmap.close();
        return;
      }
      const dimensions = previewDimensions(bitmap.width, bitmap.height);
      const source = document.createElement('canvas');
      source.width = dimensions.width;
      source.height = dimensions.height;
      source.getContext('2d')!.drawImage(bitmap, 0, 0, source.width, source.height);
      bitmap.close();
      sourceRef.current = source;
      assetSourceRef.current = original.id;
      setSize(dimensions);
      setReady(true);
    })().catch((reason) => {
      if (alive) setError(reason instanceof Error ? reason.message : '이미지를 열지 못했어요.');
    });
    return () => {
      alive = false;
      sourceRef.current = null;
    };
  }, [assetId]);

  useEffect(() => {
    quadRef.current = quad;
    draw();
  }, [draw, quad, ready, size]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onCancel();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [busy, onCancel]);

  const pointAt = (event: PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(size.width, ((event.clientX - rect.left) / rect.width) * size.width)),
      y: Math.max(0, Math.min(size.height, ((event.clientY - rect.top) / rect.height) * size.height)),
    };
  };
  const down = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!ready || busy) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = pointAt(event);
    activeRef.current = true;
    if (mode === 'crop') {
      let nearest = 0,
        distance = Infinity;
      quadRef.current.forEach((corner, i) => {
        const d = Math.hypot(corner.x * size.width - point.x, corner.y * size.height - point.y);
        if (d < distance) {
          nearest = i;
          distance = d;
        }
      });
      cornerRef.current = nearest;
      setQuad(
        (current) =>
          current.map((corner, i) =>
            i === nearest ? { x: point.x / size.width, y: point.y / size.height } : corner,
          ) as Quad,
      );
    } else {
      const ratio = size.width / event.currentTarget.getBoundingClientRect().width;
      strokesRef.current.push({ points: [point], radius: (brush * ratio) / 2, restore });
      setStrokeCount(strokesRef.current.length);
      draw();
    }
  };
  const move = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!activeRef.current || busy) return;
    const point = pointAt(event);
    if (mode === 'crop')
      setQuad(
        (current) =>
          current.map((corner, i) =>
            i === cornerRef.current ? { x: point.x / size.width, y: point.y / size.height } : corner,
          ) as Quad,
      );
    else {
      strokesRef.current.at(-1)?.points.push(point);
      draw();
    }
  };
  const finish = () => {
    activeRef.current = false;
    cornerRef.current = null;
  };
  const save = async () => {
    if (!sourceRef.current || !canvasRef.current) return;
    setBusy(true);
    setError('');
    try {
      let blob: Blob;
      if (mode === 'crop') {
        if (!(widthMm > 0 && heightMm > 0)) throw new Error('먼저 타일의 가로·세로 규격을 입력해 주세요.');
        const ratio = widthMm / heightMm;
        const width = ratio >= 1 ? 1600 : Math.round(1600 * ratio);
        const height = ratio >= 1 ? Math.round(1600 / ratio) : 1600;
        blob = await rectifyImage(
          await canvasBlob(sourceRef.current),
          quadRef.current,
          Math.max(16, width),
          Math.max(16, height),
        );
      } else blob = await canvasBlob(canvasRef.current);
      const result = await makeAsset(
        blob,
        mode === 'crop' ? '정면 보정 타일 텍스처' : '수동 배경 제거 제품',
        mode === 'crop' ? 'texture' : 'product',
        assetSourceRef.current,
      );
      result.derivation = mode === 'crop' ? 'rectified' : 'manual-alpha';
      await getRepositories().assets.put(result);
      onSaved(result.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '이미지를 저장하지 못했어요.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="modal"
      style={{ zIndex: 80 }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="prepare-title"
    >
      <div className={`modal-card ${styles.preparer}`}>
        <div className={styles.formHeader}>
          <div>
            <span className={styles.eyebrow}>IMAGE STUDIO</span>
            <h2 id="prepare-title">
              {mode === 'crop' ? '타일 한 장 선택·정면 보정' : '제품 배경 수동 지우기'}
            </h2>
            <p className="muted">
              {mode === 'crop'
                ? '1 좌상 → 2 우상 → 3 우하 → 4 좌하 순서로 타일 한 장의 모서리를 맞춰 주세요.'
                : '지울 배경 위를 드래그하세요. 체크무늬가 보이면 투명한 부분이에요.'}
            </p>
          </div>
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={onCancel}
            aria-label="이미지 준비 닫기"
          >
            닫기
          </button>
        </div>
        <p className={styles.note}>
          원본에서 새로 편집해요. 기존 결과와 원본 파일은 보존되며, 적용을 눌러야 새 결과로 바뀌어요.
        </p>
        {mode === 'alpha' && (
          <div className={styles.toolbar}>
            <button
              type="button"
              className={`btn ${!restore ? 'primary' : ''}`}
              onClick={() => setRestore(false)}
            >
              지우기
            </button>
            <button
              type="button"
              className={`btn ${restore ? 'primary' : ''}`}
              onClick={() => setRestore(true)}
            >
              복원
            </button>
            <label>
              브러시 크기{' '}
              <input
                aria-label="배경 제거 브러시 크기"
                type="range"
                min="5"
                max="150"
                value={brush}
                onChange={(event) => setBrush(Number(event.target.value))}
              />{' '}
              {brush}px
            </label>
            <button
              type="button"
              className="btn"
              disabled={!strokeCount || busy}
              onClick={() => {
                strokesRef.current.pop();
                setStrokeCount(strokesRef.current.length);
                draw();
              }}
            >
              한 획 취소
            </button>
            <button
              type="button"
              className="btn"
              disabled={!strokeCount || busy}
              onClick={() => {
                strokesRef.current = [];
                setStrokeCount(0);
                draw();
              }}
            >
              초기화
            </button>
          </div>
        )}
        <div className={`${styles.preparationCanvas} ${mode === 'alpha' ? styles.checkerboard : ''}`}>
          {!ready && !error && <p>원본을 준비하고 있어요…</p>}
          <canvas
            ref={canvasRef}
            width={size.width}
            height={size.height}
            onPointerDown={down}
            onPointerMove={move}
            onPointerUp={finish}
            onPointerCancel={finish}
            aria-label={mode === 'crop' ? '타일 모서리 네 점 편집 화면' : '배경 제거 브러시 편집 화면'}
            style={{ display: ready ? 'block' : 'none', cursor: mode === 'crop' ? 'crosshair' : 'cell' }}
          />
        </div>
        {mode === 'crop' && (
          <div className={styles.cornerInputs}>
            {quad.map((corner, i) => (
              <label key={i}>
                모서리 {i + 1}
                <span>
                  <input
                    aria-label={`모서리 ${i + 1} 가로 위치`}
                    type="number"
                    min="0"
                    max="100"
                    step=".1"
                    value={Number((corner.x * 100).toFixed(1))}
                    onChange={(event) =>
                      setQuad(
                        (current) =>
                          current.map((p, n) =>
                            n === i
                              ? { ...p, x: Math.max(0, Math.min(1, Number(event.target.value) / 100)) }
                              : p,
                          ) as Quad,
                      )
                    }
                  />
                  % ·{' '}
                  <input
                    aria-label={`모서리 ${i + 1} 세로 위치`}
                    type="number"
                    min="0"
                    max="100"
                    step=".1"
                    value={Number((corner.y * 100).toFixed(1))}
                    onChange={(event) =>
                      setQuad(
                        (current) =>
                          current.map((p, n) =>
                            n === i
                              ? { ...p, y: Math.max(0, Math.min(1, Number(event.target.value) / 100)) }
                              : p,
                          ) as Quad,
                      )
                    }
                  />
                  %
                </span>
              </label>
            ))}
          </div>
        )}
        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
        <footer className={styles.formFooter}>
          <span className="muted">
            {mode === 'crop' ? `${widthMm} × ${heightMm} mm 비율로 PNG 생성` : '투명도를 보존하는 PNG로 저장'}
          </span>
          <button type="button" className="btn primary" disabled={!ready || busy} onClick={save}>
            {busy ? '이미지 처리 중…' : '편집 결과 적용'}
          </button>
        </footer>
      </div>
    </div>
  );
}
