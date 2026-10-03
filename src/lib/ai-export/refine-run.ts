import type { Pixels } from './color';
import { resultOnCapture } from './composite';
import type { FluxProduct } from './product-prompt';
import type { FluxFixture } from './scene-contract';
import {
  alignToSilhouette,
  cropModelInput,
  cutoutAlpha,
  REFINE_CONCURRENCY,
  REFINE_MIN_IOU,
  refinedLayer,
  type ProductCrop,
  type RefinedLayer,
} from './refine';

/** One product to repaint: its close-up, what the server is told about it, its photo (if any). */
export type RefineProduct = {
  id: string;
  /** What the product is called in the dialog ("변기"). */
  label: string;
  crop: ProductCrop;
  fact: FluxProduct;
  /** The real product's photo on white, within the model's input size. */
  reference?: Blob;
};
export type KeptReason = 'request' | 'cutout' | 'empty' | 'size' | 'shape';
export type RefineOutcome =
  | {
      id: string;
      label: string;
      status: 'refined';
      layer: RefinedLayer;
      iou: number;
      plainIou: number;
      ratio: number;
    }
  | {
      id: string;
      label: string;
      status: 'kept';
      reason: KeptReason;
      /** In plain words, for the dialog. */
      message: string;
      /** The technical cause when there is one, for the console and the tests, not for the dialog. */
      detail?: string;
      iou?: number;
    };
/** What the page provides: PNG coding, the one request, and the cut-out of a picture on white. */
export type RefineDeps = {
  encode: (pixels: Pixels) => Promise<Blob>;
  decode: (blob: Blob) => Promise<Pixels>;
  request: (
    image: Blob,
    reference: Blob | undefined,
    seed: number,
    product: FluxProduct,
    signal: AbortSignal,
  ) => Promise<Blob>;
  /** A transparent PNG of the product in a picture (the background taken off). */
  cutout: (image: Blob, signal: AbortSignal) => Promise<Blob>;
};

/** A limit spent or a login refused ends the run: the next products would only meet the same wall. */
const ENDS_RUN = new Set([401, 402, 403, 429, 503]);
const KEPT_TEXT: Record<Exclude<KeptReason, 'shape' | 'request'>, string> = {
  cutout: '제품 윤곽을 따지 못했어요',
  empty: 'AI 결과에서 제품을 찾지 못했어요',
  size: 'AI 결과의 크기가 3D 제품과 많이 달라요',
};

/**
 * Repaints every product on its own, at most `concurrency` requests at a time (the cut-outs, which
 * the page makes one at a time, queue behind each other). Each product ends as repainted or kept as
 * the 3D render, with the reason in plain words; one failing never changes another, and nothing is
 * retried. Only an abort (the dialog closed, the time ran out) ends the whole run with an error.
 */
export async function runRefine(input: {
  products: readonly RefineProduct[];
  frame: { width: number; height: number };
  deps: RefineDeps;
  seed: number;
  signal: AbortSignal;
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
}): Promise<RefineOutcome[]> {
  const { products, frame, deps, seed, signal } = input;
  const outcomes = new Array<RefineOutcome>(products.length);
  let next = 0,
    done = 0,
    halted: string | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  const cut = (image: Blob) => {
    const run = queue.then(() => deps.cutout(image, signal));
    queue = run.catch(() => {});
    return run;
  };
  const kept = (
    product: RefineProduct,
    reason: KeptReason,
    message: string,
    iou?: number,
    detail?: string,
  ): RefineOutcome => ({
    id: product.id,
    label: product.label,
    status: 'kept',
    reason,
    message,
    ...(detail ? { detail } : {}),
    ...(iou === undefined ? {} : { iou }),
  });
  async function one(product: RefineProduct): Promise<RefineOutcome> {
    const { crop } = product;
    const model = cropModelInput(crop);
    let answer: Pixels;
    try {
      const image = await deps.encode(model.pixels);
      answer = await deps.decode(await deps.request(image, product.reference, seed, product.fact, signal));
    } catch (error) {
      signal.throwIfAborted();
      const message = error instanceof Error ? error.message : 'AI 요청에 실패했어요.';
      const status = (error as { status?: number })?.status;
      if (status !== undefined && ENDS_RUN.has(status)) halted = message;
      return kept(product, 'request', message);
    }
    // The answer on the close-up's own pixels, then its cut-out on the same grid.
    const size = { width: crop.width, height: crop.height };
    const onCrop = resultOnCapture(answer, model.layout, size);
    let alpha: Float32Array;
    try {
      alpha = cutoutAlpha(await deps.decode(await cut(await deps.encode(onCrop))), size);
    } catch (error) {
      signal.throwIfAborted();
      return kept(
        product,
        'cutout',
        KEPT_TEXT.cutout,
        undefined,
        error instanceof Error ? error.message : String(error),
      );
    }
    const alignment = alignToSilhouette(alpha, crop.coverage, crop.width, crop.height);
    if ('failure' in alignment) return kept(product, alignment.failure, KEPT_TEXT[alignment.failure]);
    if (alignment.iou < REFINE_MIN_IOU)
      return kept(
        product,
        'shape',
        `AI 결과의 모양이 3D 제품과 달라요(윤곽 겹침 ${Math.round(alignment.iou * 100)}%)`,
        alignment.iou,
      );
    return {
      id: product.id,
      label: product.label,
      status: 'refined',
      layer: refinedLayer({ crop, frame, ai: onCrop, alpha, alignment }),
      iou: alignment.iou,
      plainIou: alignment.plainIou,
      ratio: alignment.ratio,
    };
  }
  async function worker() {
    while (next < products.length) {
      signal.throwIfAborted();
      const index = next++;
      const product = products[index];
      outcomes[index] = halted
        ? kept(product, 'request', halted)
        : await one(product).catch((error) => {
            // Anything unexpected in one product's arithmetic leaves that product as the render.
            signal.throwIfAborted();
            return kept(product, 'cutout', error instanceof Error ? error.message : '제품을 다듬지 못했어요');
          });
      input.onProgress?.(++done, products.length);
    }
  }
  const workers = Math.max(1, Math.min(input.concurrency ?? REFINE_CONCURRENCY, products.length));
  await Promise.all(Array.from({ length: workers }, () => worker()));
  signal.throwIfAborted();
  return outcomes;
}

/**
 * What the server is told about a product: the placed fixture's kind, forms, colour, finish and
 * size. Its direction is left out on purpose: the close-up itself shows the angle (image 0), and a
 * wall-relative word ("faces the right wall") can contradict what the camera sees.
 */
export function productFact(fixture: FluxFixture): FluxProduct {
  return {
    kind: fixture.kind,
    forms: fixture.forms,
    color: fixture.color,
    finish: fixture.finish,
    sizeMm: fixture.sizeMm,
  };
}

// ---------- what a click costs ----------
/**
 * Workers AI bills klein 4B by 512 × 512 tiles: 5.37 neurons per input tile, 26.05 per output tile
 * (the platform's price list; the answer is twice the input in each direction). A product's close-up
 * is at most 496 px a side, so its call is one input tile (two with its photo) and at most four
 * output tiles: about 110–115 neurons, less for a narrow product.
 */
export const REFINE_NEURONS_PER_PRODUCT = 115;
/** The empty room's call is the same size as a whole-room conversion: about 110. */
export const REFINE_NEURONS_ROOM = 110;
export function refineEstimate(products: number) {
  return {
    calls: products + 1,
    neurons: Math.round(products * REFINE_NEURONS_PER_PRODUCT + REFINE_NEURONS_ROOM),
  };
}
