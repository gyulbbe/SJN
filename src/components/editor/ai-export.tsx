'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fluxCheckScene,
  pixelsToPng,
  prepareFluxImage,
  readPixels,
  requestFluxCheck,
  requestFluxImage,
  requestFluxProduct,
} from '@/lib/ai-export/client';
import {
  framing,
  projectCapture,
  reviewResultColors,
  type Pixels,
  type RegionMask,
} from '@/lib/ai-export/color';
import { fluxInputLayout, type FluxInputLayout } from '@/lib/ai-export/contract';
import type { FluxCheckWall } from '@/lib/ai-export/check-contract';
import { fluxResultNotices, readFluxCheck, type FluxNoticeInput } from '@/lib/ai-export/notices';
import { FLUX_FRONT, fluxOrbitView } from '@/lib/ai-export/view';
import { restoreBackdrop } from '@/lib/ai-export/backdrop';
import type { RoomOrbit, RoomViewState } from '@/lib/room-viewer/view-state';
import AiViewPicker, { type AiPreview } from './ai-view-picker';
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
import { ownMask, REFINE_MAX_PRODUCTS, type OwnMask } from '@/lib/ai-export/refine';
import {
  productFact,
  refineEstimate,
  runRefine,
  type RefineOutcome,
  type RefineProduct,
} from '@/lib/ai-export/refine-run';
import type { BackgroundRemovalClient } from '@/lib/background-removal/client';
import styles from './ai-export.module.css';

type Result = { url?: string; correctedUrl?: string; elapsed?: number; error?: string };
/**
 * The conversion method, chosen in the dialog: the current one (the model repaints the whole
 * render), experiment A/B (the model repaints the room without fixtures, bare or with grey
 * stand-ins, and ours go back on top) or experiment C (A, and each product repainted on its own).
 * C is the default when the room has a product it can repaint (a saved 3D product or a standard
 * model); with none, C would only be A, so the current one stays the default. This browser
 * remembers the choice, "current" too (a convenience only: unreadable storage means the default).
 */
type FluxMethod = 'current' | FluxRoomMode | 'refine';
const FLUX_METHODS: { value: FluxMethod; label: string }[] = [
  { value: 'current', label: '지금 방식' },
  { value: 'empty-room', label: '실험 A · 빈 방 합성' },
  { value: 'placeholders', label: '실험 B · 회색 자리 합성' },
  { value: 'refine', label: '실험 C · 제품별 다듬기' },
];
export const FLUX_COMPOSITE_FLAG = 'sjn:flux-composite';
/** The method this browser remembers; none when it never chose (or storage is unreadable). */
function savedMethod(): FluxMethod | undefined {
  try {
    const value = window.localStorage.getItem(FLUX_COMPOSITE_FLAG);
    return value === 'current' || value === 'empty-room' || value === 'placeholders' || value === 'refine'
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}
function saveMethod(method: FluxMethod) {
  try {
    window.localStorage.setItem(FLUX_COMPOSITE_FLAG, method);
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
/**
 * The per-product export's time limit: the room's request, then every product asked two at a time
 * and cut out one at a time, and the first run also loads the cut-out model (about 98 MB).
 */
const REFINE_LIMIT_MS = 150_000;
const REFINE_LIMIT_PER_PRODUCT_MS = 30_000;
/** What the cut-out model is doing, in words (nothing once it is working). */
function cutoutNote(progress: { stage: string; loadedBytes?: number; totalBytes?: number }) {
  if (progress.stage === 'download' && progress.totalBytes)
    return `윤곽을 따는 모델을 받는 중이에요(처음 한 번, ${Math.round((progress.loadedBytes ?? 0) / 1e6)}/${Math.round(progress.totalBytes / 1e6)}MB)`;
  if (['loading-runtime', 'checking', 'download', 'initializing'].includes(progress.stage))
    return '윤곽을 따는 모델을 준비하는 중이에요';
  return undefined;
}
/**
 * The products to repaint, in the grounding's order (the easily replaced kinds first): the ones with
 * a close-up, at most REFINE_MAX_PRODUCTS, each with what the server is told about it and its photo.
 */
function refineProducts(source: FluxCaptureSource, grounding: FluxGrounding | undefined): RefineProduct[] {
  const refine = source.refine;
  if (!refine || !grounding) return [];
  const crops = new Map(refine.crops.map((crop) => [crop.id, crop]));
  const products: RefineProduct[] = [];
  grounding.placed.forEach((placed, index) => {
    const crop = crops.get(placed.id);
    const fixture = grounding.scene.fixtures[index];
    if (!crop || !fixture || products.length >= REFINE_MAX_PRODUCTS) return;
    products.push({
      id: placed.id,
      label: placed.label,
      crop,
      fact: productFact(fixture),
      ...(refine.references[placed.id] ? { reference: refine.references[placed.id] } : {}),
    });
  });
  return products;
}
/** A radio shown as a pill (view and method choices). */
const chipClass = (checked: boolean) =>
  `cursor-pointer rounded-full border px-3 py-1 text-xs has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60 has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 ${
    checked
      ? 'border-[color:var(--ink)] bg-[color:var(--ink)] font-semibold text-[color:var(--paper)]'
      : 'border-[color:var(--line)] bg-[color:var(--paper)] text-[color:var(--ink)]'
  }`;
/** What the per-product export is and what one click of it costs, said before the click. */
function refineNote(products: number) {
  if (!products)
    return '실험: 다듬을 제품이 없어요(입체 제품이나 표준 모형이 아닌 제품과 유리·거울은 3D 렌더 그대로예요). 빈 방만 AI로 변환하고 제품은 3D 렌더를 올려요(실험 A와 같아요).';
  const estimate = refineEstimate(products);
  return `실험: 빈 방은 AI에 보내고, 제품은 하나씩 크게 잘라 따로 AI로 다듬은 뒤 같은 자리·크기에 올려요. 지금 배치에서 다듬을 제품은 ${products}개라 AI 요청이 ${estimate.calls}회(제품 ${products} + 빈 방 1) 나가고 최대 약 ${estimate.neurons}뉴런(추정)이 들어요. 지금 방식은 1회·약 110뉴런이에요. 처음 한 번은 제품 윤곽을 따는 모델(약 98MB)을 받아요. 모양이 달라진 제품은 3D 렌더로 두고 알려 드려요. 사진에 없는 옆·뒤 면은 AI의 추측이에요.`;
}
export default function AiExport({
  capture,
  room,
  filename,
  userId,
  disabled,
  onBusyChange,
}: {
  /**
   * Renders the After for the AI input from the chosen view (none: the legacy front composite);
   * `composite` also returns the room and fixture layers of the same frame.
   */
  capture: (view?: RoomViewState, composite?: boolean, refine?: boolean) => Promise<FluxCaptureSource>;
  /**
   * The room the input is drawn in, with the input's aspect and a live preview renderer; absent
   * for a scene without room dimensions (the 2D front composite, no turning).
   */
  room?: {
    aspect: number;
    prepare: (composite: boolean) => Promise<AiPreview>;
    /** How many placed products the per-product export would repaint (one request each). */
    refinable?: number;
  };
  filename: string;
  userId?: string | null;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
}) {
  const live = useRef(true);
  // The view lives only while the dialog is open: it starts in front of the room every time.
  const [orbit, setOrbit] = useState<RoomOrbit>(FLUX_FRONT);
  /** The view the fixed source was captured from. */
  const [sent, setSent] = useState<RoomOrbit>();
  const [sourceUrl, setSourceUrl] = useState('');
  const [result, setResult] = useState<Result>({});
  const [busy, setBusy] = useState(false);
  const [placed, setPlaced] = useState<FluxPlacedProduct[]>();
  const [check, setCheck] = useState<FluxNoticeInput['check']>();
  const [colors, setColors] = useState<FluxNoticeInput['colors']>();
  const [showOriginal, setShowOriginal] = useState(false);
  const [shifted, setShifted] = useState(false);
  /** The model reframed an outside view, so its white margin could not be put back. */
  const [marginKept, setMarginKept] = useState(false);
  // Only scenes drawn in the room can be composited.
  const [method, setMethod] = useState<FluxMethod>(() =>
    room ? (savedMethod() ?? (room.refinable ? 'refine' : 'current')) : 'current',
  );
  const refining = !!room && method === 'refine';
  // The per-product export sends the room empty, as experiment A does.
  const mode: FluxRoomMode | undefined =
    room && method !== 'current' ? (method === 'refine' ? 'empty-room' : method) : undefined;
  /** The per-product export's progress (products done of all) and what the cut-out model is doing. */
  const [refineProgress, setRefineProgress] = useState<{ done: number; total: number; note?: string }>();
  const [refineSummary, setRefineSummary] = useState<{
    refined: string[];
    kept: { label: string; message: string }[];
  }>();
  const cancelled = useRef(false);
  // A stable handle for the picker, so a store update does not rebuild its renderer.
  const prepareRef = useRef(room?.prepare);
  prepareRef.current = room?.prepare;
  const prepare = useCallback((composite: boolean) => prepareRef.current!(composite), []);
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
    /** The per-product export: the products to repaint and every close-up's silhouette on the frame. */
    refine?: { products: RefineProduct[]; owns: OwnMask[] };
    /** The cut-out model's worker, made when the first product needs it. */
    background?: BackgroundRemovalClient;
    urls: string[];
    controller?: AbortController;
  }>({ urls: [] });
  useEffect(() => {
    live.current = true;
    const current = state.current;
    return () => {
      live.current = false;
      current.controller?.abort();
      current.background?.dispose();
      current.urls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);
  /**
   * A new method, or converting after turning, is a new comparison: the source and everything made
   * from it start over. Only turning keeps the result on screen until the next conversion.
   */
  const restart = useCallback(() => {
    state.current.image = undefined;
    state.current.grounding = undefined;
    state.current.color = undefined;
    state.current.walls = undefined;
    state.current.composite = undefined;
    state.current.refine = undefined;
    setRefineProgress(undefined);
    setRefineSummary(undefined);
    setSent(undefined);
    setShifted(false);
    setMarginKept(false);
    setSourceUrl('');
    setPlaced(undefined);
    setResult({});
    setCheck(undefined);
    setColors(undefined);
    setShowOriginal(false);
  }, []);
  function chooseMethod(next: FluxMethod) {
    if (busy || next === method) return;
    setMethod(next);
    saveMethod(next);
    restart();
  }
  const turned = !!sent && (sent.azimuth !== orbit.azimuth || sent.elevation !== orbit.elevation);
  async function generate() {
    if (state.current.controller || disabled) return;
    // Turned since the fixed source was captured: this conversion starts a new comparison.
    if (turned) restart();
    const controller = new AbortController();
    state.current.controller = controller;
    cancelled.current = false;
    setRefineSummary(undefined);
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
        // Exactly the picker's camera: the same view, fit and lens.
        const captured = { ...orbit };
        const source = await capture(room ? fluxOrbitView(captured) : undefined, !!mode, refining);
        setSent(room ? captured : undefined);
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
            cutaway: source.cutaway,
          });
        } catch {
          grounding = undefined;
        } finally {
          bitmap.close();
        }
        controller.signal.throwIfAborted();
        state.current.refine =
          refining && layers && source.refine
            ? {
                products: refineProducts(source, grounding),
                owns: source.refine.crops.map((crop) =>
                  ownMask(crop, { width: layers.width, height: layers.height }),
                ),
              }
            : undefined;
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
      let blob = await requestFluxImage(state.current.image, seed, controller.signal, userId, sentScene);
      controller.signal.throwIfAborted();
      // Only a finished server conversion counts toward this browser's usual time.
      finishWait(true);
      const color = state.current.color;
      // The white backdrop around an outside view goes back in before anything else reads the
      // result (the colour check, the composite, the AI check, the download): walls, glass or
      // windows the model drew there are gone. Only where the model kept the framing, judged on its
      // own picture (restored first, a reframed result would look aligned).
      let marginKept = false;
      if (color?.mask.outside) {
        const raw = await readPixels(blob);
        const frame = framing(projectCapture(color.capture, color.layout, raw), raw);
        const restored = frame.aligned
          ? restoreBackdrop({
              result: raw,
              capture: color.capture,
              mask: color.mask,
              layout: color.layout,
              shift: frame,
            })
          : undefined;
        if (restored) blob = await pixelsToPng(restored);
        marginKept = !frame.aligned;
        controller.signal.throwIfAborted();
      }
      setMarginKept(marginKept);
      const composite = state.current.composite;
      // The per-product export: every product repainted on its own, then each one stands or falls
      // on its own (the room's request above is already answered, so a failing product costs only
      // itself).
      let outcomes: RefineOutcome[] = [];
      const refineState = state.current.refine;
      if (composite && color && refineState?.products.length) {
        const products = refineState.products;
        clearTimeout(timer);
        timer = setTimeout(
          () => controller.abort(),
          REFINE_LIMIT_MS + REFINE_LIMIT_PER_PRODUCT_MS * products.length,
        );
        startWait({ message: '제품을 하나씩 따로 다듬는 중이에요.' });
        setRefineProgress({ done: 0, total: products.length });
        outcomes = await runRefine({
          products,
          frame: { width: composite.layers.width, height: composite.layers.height },
          seed,
          signal: controller.signal,
          onProgress: (done, total) => live.current && setRefineProgress((p) => ({ ...p, done, total })),
          deps: {
            encode: pixelsToPng,
            decode: readPixels,
            request: (image, reference, requestSeed, product, signal) =>
              requestFluxProduct(image, reference, requestSeed, product, signal, userId),
            cutout: async (image) => {
              if (!state.current.background) {
                const { BackgroundRemovalClient } = await import('@/lib/background-removal/client');
                state.current.background = new BackgroundRemovalClient();
              }
              const result = await state.current.background.run(image, (progress) => {
                if (live.current) setRefineProgress((p) => (p ? { ...p, note: cutoutNote(progress) } : p));
              });
              return result.blob;
            },
          },
        });
        finishWait(false);
        if (!live.current) return;
        setRefineProgress(undefined);
        setRefineSummary({
          refined: outcomes.flatMap((o) => (o.status === 'refined' ? [o.label] : [])),
          kept: outcomes.flatMap((o) =>
            o.status === 'kept' ? [{ label: o.label, message: o.message }] : [],
          ),
        });
      } else if (composite && refining) setRefineSummary({ refined: [], kept: [] });
      if (composite && color) {
        // Our fixtures back on the model's room, where the render put them (no AI call).
        const composed = composeFluxResult({
          result: await readPixels(blob),
          input: color.capture,
          layers: composite.layers,
          mask: color.mask,
          layout: color.layout,
          boxes: composite.boxes,
          ...(outcomes.length
            ? {
                refine: {
                  layers: outcomes.flatMap((o) => (o.status === 'refined' ? [o.layer] : [])),
                  owns: refineState?.owns ?? [],
                },
              }
            : {}),
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
              ? {
                  status: 'corrected',
                  warnings: composed.review.warnings,
                  unmatched: composed.review.unmatched,
                }
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
            setColors({ status: 'corrected', warnings: review.warnings, unmatched: review.unmatched });
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
      const message = cancelled.current
        ? '제품 다듬기를 취소했어요. 이미 보낸 AI 요청은 사용량에 포함될 수 있어요.'
        : controller.signal.aborted
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
      // A stopped run leaves no cut-out half done: the next run starts a clean worker.
      if (controller.signal.aborted) {
        state.current.background?.dispose();
        state.current.background = undefined;
      }
      if (live.current) {
        setRefineProgress(undefined);
        setBusy(false);
        onBusyChange(false);
      }
    }
  }
  /** Stops the per-product export: the requests already sent still count toward the usage. */
  function cancelRefine() {
    cancelled.current = true;
    state.current.controller?.abort();
  }
  const shown = showOriginal || !result.correctedUrl ? result.url : result.correctedUrl;
  const notices = fluxResultNotices({
    products: placed ?? [],
    check,
    colors: colors?.status === 'corrected' && !result.correctedUrl ? undefined : colors,
    corrected: !showOriginal,
    showTiles: FLUX_SHOW_TILE_NOTICE,
    ...(mode ? { composite: { shifted, ...(refineSummary ? { refine: refineSummary } : {}) } } : {}),
    ...(marginKept ? { backdrop: 'reframed' as const } : {}),
  });
  return (
    <section className={styles.panel} aria-label="AI 현장 사진 변환">
      <h3>AI로 현장 사진처럼</h3>
      <p className={styles.note}>
        {room ? '버튼을 누를 때 아래 미리보기 시점 그대로의' : '버튼을 누를 때의'} 현재 After 이미지와 배치한
        제품의 종류·위치·크기·색 정보를 Cloudflare로 보내 변환해요. 결과가 나오면 배치한 제품이 그대로 있는지,
        배치하지 않은 물건이 생겼는지 AI(Gemma)로 한 번 더 확인하고, 벽·바닥 색은 원래 자재 색에 맞추고 밝기가
        크게 달라지면 그것도 되돌려 보여 줘요(추가 요청 없음). 다시 만들 때마다 다른 결과가 나오고 두 요청의
        사용량이 새로 발생해요. 그래도 AI가 자재나 제품을 바꿀 수 있으니 원본과 비교해 주세요.
      </p>
      {room && (
        <>
          <AiViewPicker
            aspect={room.aspect}
            prepare={prepare}
            composite={!!mode}
            orbit={orbit}
            onOrbit={setOrbit}
            locked={busy || disabled}
          />
          {turned && result.url && (
            <div
              className="-mt-1.5 mb-3 text-xs leading-relaxed text-[color:var(--ink)]"
              data-testid="flux-view-turned"
            >
              시점을 바꿨어요. 다시 변환하면 새 비교로 시작하니 지금 결과는 먼저 저장해 주세요.
            </div>
          )}
        </>
      )}
      {room && (
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
            {refining
              ? refineNote(room?.refinable ?? 0)
              : mode
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
              {busy
                ? '4B 변환 중…'
                : `AI 변환 · flux-2-klein-4b${result.url && !turned ? ' 다시 만들기' : ''}`}
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
          {busy && refineProgress && (
            <div
              className="mt-2 flex flex-wrap items-center gap-2 text-xs leading-relaxed text-[color:var(--ink)]"
              data-testid="flux-refine-progress"
              role="status"
            >
              <span>
                제품 다듬기 {refineProgress.done}/{refineProgress.total}개
                {refineProgress.note ? ` · ${refineProgress.note}` : ''}
              </span>
              <button type="button" className="btn" data-testid="flux-refine-cancel" onClick={cancelRefine}>
                제품 다듬기 취소
              </button>
            </div>
          )}
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
