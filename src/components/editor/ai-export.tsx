'use client';
import { useEffect, useRef, useState } from 'react';
import {
  fluxCheckScene,
  pixelsToPng,
  prepareFluxImage,
  readPixels,
  requestFluxCheck,
  requestFluxImage,
} from '@/lib/ai-export/client';
import { reviewResultColors, type FaceChange, type Pixels, type RegionMask } from '@/lib/ai-export/color';
import { fluxInputLayout, type FluxInputLayout } from '@/lib/ai-export/contract';
import { FLUX_CHECK_WAIT, FLUX_WAIT } from '@/lib/server-wait';
import { ServerWaitProgress, useServerWait } from '@/components/server-wait-progress';
import {
  buildFluxGrounding,
  type FluxCaptureSource,
  type FluxGrounding,
  type FluxPlacedProduct,
} from '@/lib/ai-export/scene';
import styles from './ai-export.module.css';

type Result = { url?: string; correctedUrl?: string; elapsed?: number; error?: string };
/** The walls' and floor's colours of the latest result against the render (no AI call). */
type Colors = { status: 'corrected'; warnings: FaceChange[] } | { status: 'reframed' } | { status: 'failed' };
const SHIFT_WORDS: Record<FaceChange['shift'], string> = {
  warmer: '따뜻하게(노랗게)',
  cooler: '차갑게(푸르게)',
  'more-saturated': '진하게',
  'less-saturated': '옅게',
  hue: '다른 색으로',
};
/** One line per surface kind: the face that changed most. */
function colorChangeLines(warnings: FaceChange[]) {
  return (['wall', 'floor'] as const).flatMap((kind) => {
    const worst = warnings.filter((w) => w.kind === kind).sort((a, b) => b.colorDeltaE - a.colorDeltaE)[0];
    return worst
      ? [{ kind, text: `${kind === 'wall' ? '벽' : '바닥'} 타일 색이 원본보다 ${SHIFT_WORDS[worst.shift]}` }]
      : [];
  });
}
/** Gemma's look at the latest result: which placed products it could not find. */
type Check =
  | { status: 'checking' }
  | { status: 'done'; count: number; missing: FluxPlacedProduct[] }
  | { status: 'failed'; message: string };
/** 이/가 after a Korean word, by its last syllable. */
const subject = (word: string) => {
  const code = word.charCodeAt(word.length - 1) - 0xac00;
  return word + (code >= 0 && code < 11172 && code % 28 ? '이' : '가');
};
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
  const [check, setCheck] = useState<Check>();
  const [colors, setColors] = useState<Colors>();
  const [showOriginal, setShowOriginal] = useState(false);
  const { wait, start: startWait, finish: finishWait } = useServerWait();
  const state = useRef<{
    image?: Blob;
    grounding?: FluxGrounding;
    /** The render, its regions and the model input's padding, for the colour check. */
    color?: { capture: Pixels; mask: RegionMask; layout: FluxInputLayout };
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
    setCheck(undefined);
    setColors(undefined);
    setShowOriginal(false);
    const started = performance.now();
    let timer = setTimeout(() => controller.abort(), 190_000);
    try {
      if (!state.current.image) {
        startWait({ message: '변환할 After 이미지와 제품 정보를 준비하는 중이에요.' });
        const source = await capture();
        const input = await prepareFluxImage(source.blob);
        if (source.regions) {
          const pixels = await readPixels(source.blob);
          state.current.color = {
            capture: pixels,
            mask: source.regions,
            layout: fluxInputLayout(pixels.width, pixels.height),
          };
        }
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
      startWait({ spec: FLUX_WAIT, message: '서버에서 현장 사진처럼 변환하는 중이에요.' });
      const blob = await requestFluxImage(
        state.current.image,
        seed,
        controller.signal,
        userId,
        state.current.grounding?.scene,
      );
      controller.signal.throwIfAborted();
      // Only a finished server conversion counts toward this browser's usual time.
      finishWait(true);
      const url = URL.createObjectURL(blob);
      state.current.urls.push(url);
      setResult({ url, elapsed: (performance.now() - started) / 1000 });
      // Walls and floor back to the render's colours where the model kept the framing (no AI call).
      const color = state.current.color;
      if (color) {
        try {
          const review = reviewResultColors({ ...color, result: await readPixels(blob) });
          if (!live.current) return;
          if (!review.framing.aligned) setColors({ status: 'reframed' });
          else if (review.corrected) {
            const correctedUrl = URL.createObjectURL(await pixelsToPng(review.corrected));
            state.current.urls.push(correctedUrl);
            if (!live.current) return;
            setResult((previous) => (previous.url === url ? { ...previous, correctedUrl } : previous));
            setColors({ status: 'corrected', warnings: review.warnings });
          }
        } catch {
          if (live.current) setColors({ status: 'failed' });
        }
      }
      // Every result is checked once for the placed products; a missing one is only reported.
      const scene = fluxCheckScene(state.current.grounding?.scene);
      if (!scene) return;
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(), 130_000);
      setCheck({ status: 'checking' });
      startWait({ spec: FLUX_CHECK_WAIT, message: '결과에 배치한 제품이 그대로 있는지 확인하는 중이에요.' });
      try {
        const checked = await requestFluxCheck(blob, scene, controller.signal, userId);
        finishWait(true);
        if (!live.current) return;
        const products = state.current.grounding?.placed ?? [];
        setCheck({
          status: 'done',
          count: scene.fixtures.length,
          missing: checked.fixtures.flatMap((entry, i) =>
            entry.present === 'no' && products[i] ? [products[i]] : [],
          ),
        });
      } catch (error) {
        if (!live.current) return;
        setCheck({
          status: 'failed',
          message: controller.signal.aborted
            ? '확인 응답이 늦어 더 기다리지 않았어요.'
            : error instanceof Error
              ? error.message
              : '확인하지 못했어요.',
        });
      }
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
      finishWait(false);
      if (live.current) {
        setBusy(false);
        onBusyChange(false);
      }
    }
  }
  const shown = showOriginal || !result.correctedUrl ? result.url : result.correctedUrl;
  return (
    <section className={styles.panel} aria-label="AI 현장 사진 변환">
      <h3>AI로 현장 사진처럼</h3>
      <p className={styles.note}>
        버튼을 누를 때 현재 After 이미지와 배치한 제품의 종류·위치·크기·색 정보를 Cloudflare로 보내 변환해요.
        결과가 나오면 배치한 제품이 그대로 있는지 AI(Gemma)로 한 번 더 확인하고, 벽·바닥 색은 원래 자재 색에
        맞춰 보여 줘요(추가 요청 없음). 다시 만들 때마다 다른 결과가 나오고 두 요청의 사용량이 새로 발생해요.
        그래도 AI가 자재나 제품을 바꿀 수 있으니 원본과 비교해 주세요.
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
            {shown ? (
              <img src={shown} alt="FLUX 4B 현장 사진 변환 결과" />
            ) : wait ? (
              // The first conversion waits where its result will appear.
              <div className="w-full max-w-xs px-3">
                <ServerWaitProgress title="AI 현장 사진 변환" wait={wait} compact />
              </div>
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
            {shown && (
              <a
                className="btn"
                href={shown}
                download={`${filename}-flux-2-klein-4b${shown === result.url && result.correctedUrl ? '-AI원본색' : ''}.png`}
              >
                4B PNG 저장
              </a>
            )}
            {result.correctedUrl && (
              <button
                type="button"
                className="btn"
                aria-pressed={showOriginal}
                onClick={() => setShowOriginal((value) => !value)}
              >
                {showOriginal ? '보정한 색 보기' : 'AI 원본 색 보기'}
              </button>
            )}
          </div>
          {wait && result.url && (
            <div className="mt-2">
              <ServerWaitProgress
                title={check?.status === 'checking' ? 'AI 제품 확인' : 'AI 현장 사진 변환'}
                wait={wait}
                compact
              />
            </div>
          )}
          {result.elapsed !== undefined && (
            <p className={styles.note}>변환 시간 {result.elapsed.toFixed(1)}초</p>
          )}
          {colors?.status === 'corrected' &&
            result.correctedUrl &&
            (showOriginal && colors.warnings.length ? (
              <div
                role="alert"
                className="mt-2 rounded-[var(--radius-sm,8px)] border border-[color:var(--danger)] bg-[color:var(--paper)] px-3 py-2 text-xs leading-relaxed text-[color:var(--ink)]"
              >
                {colorChangeLines(colors.warnings).map((line) => (
                  <div key={line.kind}>{line.text} 바뀌었을 수 있어요.</div>
                ))}
              </div>
            ) : (
              <div
                className="mt-2 text-xs leading-relaxed text-[color:var(--muted)]"
                data-testid="flux-color-note"
              >
                {showOriginal
                  ? 'AI 원본 색이에요. 벽·바닥 색이 원본과 크게 다르지 않아요.'
                  : colors.warnings.length
                    ? `${colorChangeLines(colors.warnings)
                        .map((line) => line.text)
                        .join(
                          ', ',
                        )} 바뀌어 원래 자재 색으로 맞췄어요. 명암·질감과 제품·유리는 AI 결과 그대로예요.`
                    : '벽·바닥 색을 원래 자재 색에 맞췄어요. 명암·질감과 제품·유리는 AI 결과 그대로예요.'}
              </div>
            ))}
          {colors?.status === 'reframed' && (
            <div
              className="mt-2 text-xs leading-relaxed text-[color:var(--muted)]"
              data-testid="flux-color-note"
            >
              AI가 구도를 바꿔 벽·바닥 색을 원본과 비교하지 못했어요. 자재 색은 원본과 직접 비교해 주세요.
            </div>
          )}
          {check?.status === 'done' &&
            (check.missing.length ? (
              <div
                role="alert"
                className="mt-2 rounded-[var(--radius-sm,8px)] border border-[color:var(--danger)] bg-[color:var(--paper)] px-3 py-2 text-xs leading-relaxed text-[color:var(--ink)]"
              >
                <div className="font-semibold text-[color:var(--danger)]">
                  배치한 제품이 바뀌었을 수 있어요
                </div>
                <ul className="mt-1 space-y-0.5">
                  {check.missing.map((product) => (
                    <li key={product.id}>
                      {subject(product.label)} {product.where}에서 보이지 않거나 다른 물건으로 바뀌었을 수
                      있어요.
                    </li>
                  ))}
                </ul>
                <div className="mt-1">다시 만들어 보세요. 자동으로 다시 만들지는 않아요.</div>
              </div>
            ) : (
              <div className="mt-2 text-xs text-[color:var(--muted)]">
                AI 제품 확인: 배치한 제품 {check.count}개가 모두 보여요.
              </div>
            ))}
          {check?.status === 'failed' && (
            <div className="mt-2 text-xs text-[color:var(--muted)]">
              AI 제품 확인을 하지 못했어요. {check.message}
            </div>
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
