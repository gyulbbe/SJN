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
import { reviewResultColors, type Pixels, type RegionMask } from '@/lib/ai-export/color';
import { fluxInputLayout, type FluxInputLayout } from '@/lib/ai-export/contract';
import type { FluxCheckWall } from '@/lib/ai-export/check-contract';
import { fluxResultNotices, readFluxCheck, type FluxNoticeInput } from '@/lib/ai-export/notices';
import { FLUX_VIEW_LABELS, type FluxViewChoice } from '@/lib/ai-export/view';
import { FLUX_CHECK_WAIT, FLUX_WAIT } from '@/lib/server-wait';
import { ServerWaitProgress, useServerWait } from '@/components/server-wait-progress';
import {
  buildFluxGrounding,
  visibleWalls,
  type FluxCaptureSource,
  type FluxGrounding,
  type FluxPlacedProduct,
} from '@/lib/ai-export/scene';
import { composeFluxResult, placeholderRoom, type RoomLayers } from '@/lib/ai-export/composite';
import type { FluxRoomMode } from '@/lib/ai-export/scene-contract';
import styles from './ai-export.module.css';

type Result = { url?: string; correctedUrl?: string; elapsed?: number; error?: string };
/**
 * The conversion method, chosen in the dialog while the composite export is being tested: the
 * current one (the model repaints the whole render), or experiment A/B (the model repaints the room
 * without fixtures, bare or with grey stand-ins, and ours go back on top). The current one is the
 * default; this browser remembers the choice (a convenience only: unreadable storage means default).
 */
type FluxMethod = 'current' | FluxRoomMode;
const FLUX_METHODS: { value: FluxMethod; label: string }[] = [
  { value: 'current', label: '지금 방식' },
  { value: 'empty-room', label: '실험 A · 빈 방 합성' },
  { value: 'placeholders', label: '실험 B · 회색 자리 합성' },
];
export const FLUX_COMPOSITE_FLAG = 'sjn:flux-composite';
function savedMethod(): FluxMethod {
  try {
    const value = window.localStorage.getItem(FLUX_COMPOSITE_FLAG);
    return value === 'empty-room' || value === 'placeholders' ? value : 'current';
  } catch {
    return 'current';
  }
}
function saveMethod(method: FluxMethod) {
  try {
    if (method === 'current') window.localStorage.removeItem(FLUX_COMPOSITE_FLAG);
    else window.localStorage.setItem(FLUX_COMPOSITE_FLAG, method);
  } catch {
    // Not remembered; the choice still applies in this dialog.
  }
}
/**
 * Whether the check's tile-layout answer is shown. Off: in the 2026-09-27 comparison it missed the
 * one real layout change and said "no" only where old front-composite walls were partly replaced.
 * The answer is still requested and kept in the check response for later evaluation.
 */
const FLUX_SHOW_TILE_NOTICE = false;
/** A radio shown as a pill (view and method choices). */
const chipClass = (checked: boolean) =>
  `cursor-pointer rounded-full border px-3 py-1 text-xs has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60 has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 ${
    checked
      ? 'border-[color:var(--ink)] bg-[color:var(--ink)] font-semibold text-[color:var(--paper)]'
      : 'border-[color:var(--line)] bg-[color:var(--paper)] text-[color:var(--ink)]'
  }`;
export default function AiExport({
  capture,
  views,
  filename,
  userId,
  disabled,
  onBusyChange,
}: {
  /**
   * Renders the After for the AI input from the chosen view (none: the legacy front composite);
   * `composite` also returns the room and fixture layers of the same frame.
   */
  capture: (view?: FluxViewChoice, composite?: boolean) => Promise<FluxCaptureSource>;
  /** In-room views to choose from; absent for a scene without room dimensions. */
  views?: { choices: FluxViewChoice[]; initial: FluxViewChoice };
  filename: string;
  userId?: string | null;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
}) {
  const live = useRef(true);
  const [view, setView] = useState<FluxViewChoice | undefined>(views?.initial);
  const [sourceUrl, setSourceUrl] = useState('');
  const [result, setResult] = useState<Result>({});
  const [busy, setBusy] = useState(false);
  const [placed, setPlaced] = useState<FluxPlacedProduct[]>();
  const [check, setCheck] = useState<FluxNoticeInput['check']>();
  const [colors, setColors] = useState<FluxNoticeInput['colors']>();
  const [showOriginal, setShowOriginal] = useState(false);
  const [shifted, setShifted] = useState(false);
  // Only scenes drawn in the room (views) can be composited.
  const [method, setMethod] = useState<FluxMethod>(() => (views ? savedMethod() : 'current'));
  const mode = views && method !== 'current' ? method : undefined;
  const { wait, start: startWait, finish: finishWait } = useServerWait();
  const state = useRef<{
    image?: Blob;
    grounding?: FluxGrounding;
    /** The render, its regions and the model input's padding, for the colour check. */
    color?: { capture: Pixels; mask: RegionMask; layout: FluxInputLayout };
    /** Walls in the captured view, asked about in the result check. */
    walls?: FluxCheckWall[];
    /** The composite export: the frame's layers and the fixtures' capture boxes. */
    composite?: { layers: RoomLayers; boxes: [number, number, number, number][] };
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
  /** A new view or method is a new comparison: the source and everything made from it start over. */
  function chooseView(next: FluxViewChoice) {
    if (busy || next === view) return;
    setView(next);
    restart();
  }
  function chooseMethod(next: FluxMethod) {
    if (busy || next === method) return;
    setMethod(next);
    saveMethod(next);
    restart();
  }
  function restart() {
    state.current.image = undefined;
    state.current.grounding = undefined;
    state.current.color = undefined;
    state.current.walls = undefined;
    state.current.composite = undefined;
    setShifted(false);
    setSourceUrl('');
    setPlaced(undefined);
    setResult({});
    setCheck(undefined);
    setColors(undefined);
    setShowOriginal(false);
  }
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
    setShifted(false);
    const started = performance.now();
    let timer = setTimeout(() => controller.abort(), 190_000);
    try {
      if (!state.current.image) {
        startWait({ message: '변환할 After 이미지와 제품 정보를 준비하는 중이에요.' });
        const source = await capture(view, !!mode);
        const layers = mode ? source.layers : undefined;
        if (mode && (!layers || !source.regions || !source.boxes))
          throw new Error('제품을 따로 합성할 이미지 층을 만들지 못했어요.');
        // The composite export sends the room without fixtures (with grey stand-ins for placeholders).
        const sent: Pixels | undefined = layers
          ? mode === 'placeholders'
            ? placeholderRoom(layers)
            : { width: layers.width, height: layers.height, data: layers.empty }
          : undefined;
        const input = await prepareFluxImage(sent ? await pixelsToPng(sent) : source.blob);
        if (source.regions) {
          const pixels = sent ?? (await readPixels(source.blob));
          state.current.color = {
            capture: pixels,
            mask: source.regions,
            layout: fluxInputLayout(pixels.width, pixels.height),
          };
          state.current.walls = visibleWalls(source.regions, source.snapshot.scene);
        }
        state.current.composite = layers ? { layers, boxes: Object.values(source.boxes ?? {}) } : undefined;
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
            ceiling: source.ceiling,
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
        // The composite's reference is the full render: that is what the result should look like.
        const url = URL.createObjectURL(mode ? source.blob : input);
        state.current.urls.push(url);
        setSourceUrl(url);
      }
      // Same source image, fresh seed: re-generating gives a different variation.
      const seed = crypto.getRandomValues(new Uint32Array(1))[0] & 0x7fffffff;
      startWait({ spec: FLUX_WAIT, message: '서버에서 현장 사진처럼 변환하는 중이에요.' });
      const grounded = state.current.grounding?.scene;
      // An empty room is described without fixtures: a described fixture gets drawn.
      const sentScene = mode && grounded ? { ...grounded, fixtures: [], mode } : mode ? undefined : grounded;
      const blob = await requestFluxImage(state.current.image, seed, controller.signal, userId, sentScene);
      controller.signal.throwIfAborted();
      // Only a finished server conversion counts toward this browser's usual time.
      finishWait(true);
      const color = state.current.color;
      const composite = state.current.composite;
      if (composite && color) {
        // Our fixtures back on the model's room, where the render put them (no AI call).
        const composed = composeFluxResult({
          result: await readPixels(blob),
          input: color.capture,
          layers: composite.layers,
          mask: color.mask,
          layout: color.layout,
          boxes: composite.boxes,
        });
        if (!live.current) return;
        const rawUrl = URL.createObjectURL(await pixelsToPng(composed.raw));
        const correctedUrl = composed.corrected
          ? URL.createObjectURL(await pixelsToPng(composed.corrected))
          : undefined;
        state.current.urls.push(rawUrl, ...(correctedUrl ? [correctedUrl] : []));
        if (!live.current) return;
        setResult({ url: rawUrl, correctedUrl, elapsed: (performance.now() - started) / 1000 });
        setShifted(composed.shifted);
        setColors(
          !composed.review.framing.aligned
            ? { status: 'reframed' }
            : correctedUrl
              ? { status: 'corrected', warnings: composed.review.warnings }
              : undefined,
        );
      } else {
        const url = URL.createObjectURL(blob);
        state.current.urls.push(url);
        setResult({ url, elapsed: (performance.now() - started) / 1000 });
      }
      // Walls and floor back to the render's colours where the model kept the framing (no AI call).
      if (color && !composite) {
        const url = state.current.urls.at(-1);
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
      // Every result is checked once: placed products, added objects and the walls' tile layout.
      // Anything off is only reported.
      // The composite asks only about added objects, in the model's room before our fixtures go on.
      const scene = fluxCheckScene(
        state.current.grounding?.scene,
        state.current.walls,
        mode ? (mode === 'placeholders' ? 'placeholders' : 'empty') : undefined,
      );
      if (!scene) return;
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(), 130_000);
      setCheck({ status: 'checking' });
      startWait({
        spec: FLUX_CHECK_WAIT,
        message: mode
          ? '결과에 없던 물건이 생겼는지 확인하는 중이에요.'
          : '결과에 배치한 제품이 그대로 있는지 확인하는 중이에요.',
      });
      try {
        const checked = await requestFluxCheck(blob, scene, controller.signal, userId);
        finishWait(true);
        if (!live.current) return;
        setCheck({
          status: 'done',
          reading: readFluxCheck(checked, scene.fixtures, { emptyRoom: !!mode }),
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
  const notices = fluxResultNotices({
    products: placed ?? [],
    check,
    colors: colors?.status === 'corrected' && !result.correctedUrl ? undefined : colors,
    corrected: !showOriginal,
    showTiles: FLUX_SHOW_TILE_NOTICE,
    ...(mode ? { composite: { shifted } } : {}),
  });
  return (
    <section className={styles.panel} aria-label="AI 현장 사진 변환">
      <h3>AI로 현장 사진처럼</h3>
      <p className={styles.note}>
        버튼을 누를 때 고른 시점의 현재 After 이미지와 배치한 제품의 종류·위치·크기·색 정보를 Cloudflare로
        보내 변환해요. 결과가 나오면 배치한 제품이 그대로 있는지, 배치하지 않은 물건이 생겼는지 AI(Gemma)로 한
        번 더 확인하고, 벽·바닥 색은 원래 자재 색에 맞춰 보여 줘요(추가 요청 없음). 다시 만들 때마다 다른
        결과가 나오고 두 요청의 사용량이 새로 발생해요. 그래도 AI가 자재나 제품을 바꿀 수 있으니 원본과 비교해
        주세요.
      </p>
      {views && view && (
        <fieldset className="mb-3 min-w-0" disabled={busy || disabled}>
          <legend className="mb-1.5 text-xs font-semibold text-[color:var(--ink)]">AI 입력 시점</legend>
          <div className="flex flex-wrap gap-1.5">
            {views.choices.map((choice) => (
              <label key={choice} className={chipClass(choice === view)}>
                <input
                  type="radio"
                  name="flux-view"
                  className="sr-only"
                  value={choice}
                  checked={choice === view}
                  onChange={() => chooseView(choice)}
                />
                {FLUX_VIEW_LABELS[choice]}
                {choice === 'center' ? '(기본)' : ''}
              </label>
            ))}
          </div>
          <div className="mt-1.5 text-xs leading-relaxed text-[color:var(--muted)]">
            방 안에서 본 모습(천장 포함)으로 변환해요. 방 바깥의 빈 여백이 없어 AI가 없던 벽·물건을 덜
            만들어요.
            {result.url ? ' 시점을 바꾸면 지금 결과는 지워지니 먼저 저장해 주세요.' : ''}
          </div>
        </fieldset>
      )}
      {views && (
        <fieldset className="mb-3 min-w-0" disabled={busy || disabled}>
          <legend className="mb-1.5 text-xs font-semibold text-[color:var(--ink)]">변환 방식</legend>
          <div className="flex flex-wrap gap-1.5">
            {FLUX_METHODS.map((choice) => (
              <label key={choice.value} className={chipClass(choice.value === method)}>
                <input
                  type="radio"
                  name="flux-method"
                  className="sr-only"
                  value={choice.value}
                  checked={choice.value === method}
                  onChange={() => chooseMethod(choice.value)}
                />
                {choice.label}
              </label>
            ))}
          </div>
          <div
            className="mt-1.5 text-xs leading-relaxed text-[color:var(--muted)]"
            data-testid="flux-composite-note"
          >
            {mode
              ? `실험: AI에는 제품을 뺀 빈 방${mode === 'placeholders' ? '(제품 자리는 회색 표시)' : ''}을 보내고, 결과 위에 3D 렌더의 제품을 같은 자리·크기 그대로 올려요. 제품 모양은 그대로지만 매끈한 3D 질감으로 보일 수 있어요.`
              : '제품까지 AI가 다시 그려요. 사진 같지만 제품 모양이 바뀌거나 없던 물건이 생길 수 있어요.'}
            {result.url ? ' 방식을 바꾸면 지금 결과는 지워지니 먼저 저장해 주세요.' : ''}
          </div>
        </fieldset>
      )}
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
          {notices.warnings.length > 0 && (
            // One box, most important first: products, added objects, tile layout, then colour.
            <div
              role="alert"
              className="mt-2 space-y-1.5 rounded-[var(--radius-sm,8px)] border border-[color:var(--danger)] bg-[color:var(--paper)] px-3 py-2 text-xs leading-relaxed text-[color:var(--ink)]"
            >
              {notices.warnings.map((section) => (
                <div key={section.key} data-testid={`flux-${section.key}-warning`}>
                  {section.title && (
                    <div className="font-semibold text-[color:var(--danger)]">{section.title}</div>
                  )}
                  {section.lines.length > 1 || section.title ? (
                    <ul className="space-y-0.5">
                      {section.lines.map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  ) : (
                    <div>{section.lines[0]}</div>
                  )}
                </div>
              ))}
              {notices.suggestRetry && <div>다시 만들어 보세요. 자동으로 다시 만들지는 않아요.</div>}
            </div>
          )}
          {notices.infos.map((info) => (
            <div
              key={info.key}
              className="mt-2 text-xs leading-relaxed text-[color:var(--muted)]"
              data-testid={`flux-${info.key}-note`}
            >
              {info.text}
            </div>
          ))}
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
