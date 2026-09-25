'use client';
import { useEffect, useRef, useState } from 'react';
import { prepareFluxImage, requestFluxImage } from '@/lib/ai-export/client';
import { fluxInputLayout } from '@/lib/ai-export/contract';
import {
  buildFluxGrounding,
  type FluxCaptureSource,
  type FluxGrounding,
  type FluxPlacedProduct,
} from '@/lib/ai-export/scene';
import styles from './ai-export.module.css';

type Result = { url?: string; elapsed?: number; error?: string };
export default function AiExport({
  capture,
  filename,
  userId,
  disabled,
  onBusyChange,
}: {
  capture: () => Promise<FluxCaptureSource>;
  filename: string;
  userId?: string | null;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
}) {
  const live = useRef(true);
  const [sourceUrl, setSourceUrl] = useState('');
  const [result, setResult] = useState<Result>({});
  const [busy, setBusy] = useState(false);
  const [placed, setPlaced] = useState<FluxPlacedProduct[]>();
  const state = useRef<{
    image?: Blob;
    grounding?: FluxGrounding;
    urls: string[];
    controller?: AbortController;
  }>({ urls: [] });
  useEffect(() => {
    live.current = true;
    const current = state.current;
    return () => {
      live.current = false;
      current.controller?.abort();
      current.urls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);
  async function generate() {
    if (state.current.controller || disabled) return;
    const controller = new AbortController();
    state.current.controller = controller;
    setBusy(true);
    onBusyChange(true);
    setResult((previous) => ({ ...previous, error: undefined }));
    const started = performance.now();
    const timer = setTimeout(() => controller.abort(), 190_000);
    try {
      if (!state.current.image) {
        const source = await capture();
        const input = await prepareFluxImage(source.blob);
        const bitmap = await createImageBitmap(source.blob);
        let grounding: FluxGrounding | undefined;
        try {
          // What was actually placed goes with the image, so a 25px toilet is not left to guesswork.
          grounding = await buildFluxGrounding({
            snapshot: source.snapshot,
            reader: source.reader,
            capture: bitmap,
            layout: fluxInputLayout(bitmap.width, bitmap.height),
            boxes: source.boxes,
          });
        } catch {
          grounding = undefined;
        } finally {
          bitmap.close();
        }
        controller.signal.throwIfAborted();
        state.current.image = input;
        state.current.grounding = grounding;
        setPlaced(grounding?.placed ?? []);
        const url = URL.createObjectURL(input);
        state.current.urls.push(url);
        setSourceUrl(url);
      }
      // Same source image, fresh seed: re-generating gives a different variation.
      const seed = crypto.getRandomValues(new Uint32Array(1))[0] & 0x7fffffff;
      const blob = await requestFluxImage(
        state.current.image,
        seed,
        controller.signal,
        userId,
        state.current.grounding?.scene,
      );
      controller.signal.throwIfAborted();
      const url = URL.createObjectURL(blob);
      state.current.urls.push(url);
      setResult({ url, elapsed: (performance.now() - started) / 1000 });
    } catch (error) {
      if (!live.current) return;
      const message = controller.signal.aborted
        ? '응답 대기 시간이 끝났어요. 서버 처리는 계속될 수 있어요. 자동 재시도하지 않았어요.'
        : error instanceof Error
          ? error.message
          : '이미지 변환에 실패했어요.';
      // A failed re-generate keeps the previous successful result.
      setResult((previous) => ({ ...previous, error: message }));
    } finally {
      clearTimeout(timer);
      state.current.controller = undefined;
      if (live.current) {
        setBusy(false);
        onBusyChange(false);
      }
    }
  }
  return (
    <section className={styles.panel} aria-label="AI 현장 사진 변환">
      <h3>AI로 현장 사진처럼</h3>
      <p className={styles.note}>
        버튼을 누를 때 현재 After 이미지와 배치한 제품의 종류·위치·크기·색 정보를 Cloudflare로 보내 변환해요.
        다시 만들 때마다 다른 결과가 나오고 사용량이 새로 발생해요. 그래도 AI가 자재나 제품을 바꿀 수 있으니
        원본과 비교해 주세요.
      </p>
      <div className={styles.grid}>
        <div className={styles.card}>
          <h4>비교 기준 · 현재 After</h4>
          <div className={styles.preview}>
            {sourceUrl ? (
              // User-created blob URLs are ephemeral and cannot use the image optimizer.
              <img src={sourceUrl} alt="AI 변환 기준 원본" />
            ) : (
              <span className={styles.placeholder}>
                변환 버튼을 누르면
                <br />
                비교 원본이 고정돼요.
              </span>
            )}
          </div>
          {sourceUrl && (
            <a className="btn" href={sourceUrl} download={`${filename}-AI비교원본.png`}>
              비교 원본 저장
            </a>
          )}
          {placed && (
            <div
              className="mt-3 text-xs leading-relaxed text-[color:var(--muted)]"
              aria-label="변환에 전달한 제품"
            >
              {placed.length ? (
                <>
                  <div className="font-semibold text-[color:var(--ink)]">변환에 전달한 제품</div>
                  <ul className="mt-1 space-y-0.5">
                    {placed.map((product) => (
                      <li key={product.id}>
                        {product.label} · {product.where}
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <div>전달할 제품 정보가 없어 이미지로만 변환해요.</div>
              )}
            </div>
          )}
        </div>
        <div className={styles.card}>
          <h4>FLUX.2 klein 4B</h4>
          <div className={styles.preview}>
            {result.url ? (
              <img src={result.url} alt="FLUX 4B 현장 사진 변환 결과" />
            ) : (
              <span className={styles.placeholder}>
                {busy ? '현장 사진처럼 변환 중…' : '아직 변환하지 않았어요.'}
              </span>
            )}
          </div>
          <div className={styles.actions}>
            <button type="button" className="btn" disabled={busy || disabled} onClick={() => void generate()}>
              {busy ? '4B 변환 중…' : `AI 변환 · flux-2-klein-4b${result.url ? ' 다시 만들기' : ''}`}
            </button>
            {result.url && (
              <a className="btn" href={result.url} download={`${filename}-flux-2-klein-4b.png`}>
                4B PNG 저장
              </a>
            )}
          </div>
          {result.elapsed !== undefined && (
            <p className={styles.note}>변환 시간 {result.elapsed.toFixed(1)}초</p>
          )}
          {result.error && (
            <p role="alert" className={styles.error}>
              {result.error}
            </p>
          )}
        </div>
      </div>
      <p className={styles.note} role="status">
        {busy
          ? '창을 닫아도 이미 시작된 서버 처리는 사용량에 포함될 수 있어요.'
          : 'AI 입력은 긴 변 최대 496px, 결과는 최대 992px예요. 원본 다운로드 설정과 별개로 After만 변환해요. 창을 닫으면 결과가 지워지니 먼저 저장해 주세요.'}
      </p>
    </section>
  );
}
