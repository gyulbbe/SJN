'use client';
import { useEffect, useRef, useState } from 'react';
import { prepareFluxImage, requestFluxImage } from '@/lib/ai-export/client';
import { type FluxVariant } from '@/lib/ai-export/contract';
import styles from './ai-export.module.css';

type Result = { url?: string; elapsed?: number; error?: string };
export default function AiExport({
  capture,
  filename,
  userId,
  disabled,
  onBusyChange,
}: {
  capture: () => Promise<Blob>;
  filename: string;
  userId?: string | null;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
}) {
  const live = useRef(true);
  const [sourceUrl, setSourceUrl] = useState('');
  const [results, setResults] = useState<Partial<Record<FluxVariant, Result>>>({});
  const [busy, setBusy] = useState<FluxVariant | null>(null);
  const state = useRef<{ image?: Blob; seed: number; urls: string[]; controller?: AbortController }>({
    seed: 0,
    urls: [],
  });
  useEffect(() => {
    live.current = true;
    const current = state.current;
    return () => {
      live.current = false;
      current.controller?.abort();
      current.urls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);
  async function generate(model: FluxVariant) {
    if (state.current.controller || disabled) return;
    const controller = new AbortController();
    state.current.controller = controller;
    setBusy(model);
    onBusyChange(true);
    setResults((previous) => ({ ...previous, [model]: { ...previous[model], error: undefined } }));
    const started = performance.now();
    const timer = setTimeout(() => controller.abort(), 190_000);
    try {
      if (!state.current.image) {
        const original = await capture();
        const input = await prepareFluxImage(original);
        controller.signal.throwIfAborted();
        state.current.image = input;
        state.current.seed = crypto.getRandomValues(new Uint32Array(1))[0] & 0x7fffffff;
        const url = URL.createObjectURL(input);
        state.current.urls.push(url);
        setSourceUrl(url);
      }
      const blob = await requestFluxImage(
        state.current.image,
        model,
        state.current.seed,
        controller.signal,
        userId,
      );
      controller.signal.throwIfAborted();
      const url = URL.createObjectURL(blob);
      state.current.urls.push(url);
      setResults((previous) => ({
        ...previous,
        [model]: { url, elapsed: (performance.now() - started) / 1000 },
      }));
    } catch (error) {
      if (!live.current) return;
      if (!controller.signal.aborted)
        setResults((previous) => ({
          ...previous,
          [model]: {
            ...previous[model],
            error: error instanceof Error ? error.message : '이미지 변환에 실패했어요.',
          },
        }));
      else
        setResults((previous) => ({
          ...previous,
          [model]: {
            ...previous[model],
            error: '응답 대기 시간이 끝났어요. 서버 처리는 계속될 수 있어요. 자동 재시도하지 않았어요.',
          },
        }));
    } finally {
      clearTimeout(timer);
      state.current.controller = undefined;
      if (live.current) {
        setBusy(null);
        onBusyChange(false);
      }
    }
  }
  return (
    <section className={styles.panel} aria-label="AI 현장 사진 변환 비교">
      <h3>AI로 현장 사진처럼</h3>
      <p className={styles.note}>
        각 버튼을 누를 때 현재 After 이미지를 Cloudflare로 보내 변환해요. 두 모델은 같은 원본과 변환 조건을
        사용해요. 9B는 4B보다 사용량이 커요. AI 결과는 자재나 형태가 달라질 수 있는 참고 이미지예요.
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
        </div>
        {(['4b', '9b'] as const).map((model) => (
          <div className={styles.card} key={model}>
            <h4>FLUX.2 klein {model.toUpperCase()}</h4>
            <div className={styles.preview}>
              {results[model]?.url ? (
                <img src={results[model]!.url} alt={`FLUX ${model.toUpperCase()} 현장 사진 변환 결과`} />
              ) : (
                <span className={styles.placeholder}>
                  {busy === model ? '현장 사진처럼 변환 중…' : '아직 변환하지 않았어요.'}
                </span>
              )}
            </div>
            <div className={styles.actions}>
              <button
                type="button"
                className="btn"
                disabled={!!busy || disabled}
                onClick={() => void generate(model)}
              >
                {busy === model
                  ? `${model.toUpperCase()} 변환 중…`
                  : `AI 변환 · flux-2-klein-${model}${results[model]?.url ? ' 다시 만들기' : ''}`}
              </button>
              {results[model]?.url && (
                <a
                  className="btn"
                  href={results[model]!.url}
                  download={`${filename}-flux-2-klein-${model}.png`}
                >
                  {model.toUpperCase()} PNG 저장
                </a>
              )}
            </div>
            {results[model]?.elapsed !== undefined && (
              <p className={styles.note}>변환 시간 {results[model]!.elapsed!.toFixed(1)}초</p>
            )}
            {results[model]?.error && (
              <p role="alert" className={styles.error}>
                {results[model]!.error}
              </p>
            )}
          </div>
        ))}
      </div>
      <p className={styles.note} role="status">
        {busy
          ? '창을 닫아도 이미 시작된 서버 처리는 사용량에 포함될 수 있어요.'
          : 'AI 비교 입력은 긴 변 최대 496px, 결과는 최대 992px예요. 원본 다운로드 설정과 별개로 After만 변환해요. 창을 닫으면 비교 결과가 지워지니 먼저 저장해 주세요.'}
      </p>
    </section>
  );
}
