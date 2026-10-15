import { PRODUCT_DIRECTIONS, type ProductDirection } from '../product-direction';
import type { Point } from '../types';
import { standsOnFloor, type DirectionPhotoCategory } from './contract';
import type { MaterialInput } from '../types';

/** Candidates made for each direction (the person picks one). */
export const DIRECTION_PHOTO_CANDIDATES = 2;

export type DirectionPlan = {
  /** The directions the model is asked for, in order. */
  made: ProductDirection[];
  /** 오른쪽 from the 왼쪽 photo turned over, when the product is the same on both sides. */
  mirrored: ProductDirection[];
  /** Not made, with the reason in plain words. */
  skipped: { direction: ProductDirection; reason: string }[];
};

/**
 * Which photos a run makes. 정면 and 왼쪽 always; 오른쪽 from the model only when the product is not
 * the same on both sides (else it is the 왼쪽 photo turned over, which saves the calls); 뒤 only for
 * a product that stands on the floor (a wall product's back is against the wall: no view shows it),
 * and not for a toilet (it stands against the wall, and its back came out as its front in nearly
 * every trial answer).
 */
export function planDirections(input: {
  category?: DirectionPhotoCategory;
  installation: MaterialInput['installation'];
  symmetric: boolean;
}): DirectionPlan {
  const plan: DirectionPlan = { made: ['정면', '왼쪽'], mirrored: [], skipped: [] };
  if (input.symmetric) plan.mirrored.push('오른쪽');
  else plan.made.push('오른쪽');
  if (input.category === 'toilet')
    plan.skipped.push({ direction: '뒤', reason: '변기는 벽에 붙여 설치해서 뒤 사진을 만들지 않아요' });
  else if (standsOnFloor(input.installation)) plan.made.push('뒤');
  else plan.skipped.push({ direction: '뒤', reason: '벽에 거는 제품은 뒤 사진을 만들지 않아요' });
  // Keep the list's order (정면·왼쪽·오른쪽·뒤).
  plan.made.sort((a, b) => PRODUCT_DIRECTIONS.indexOf(a) - PRODUCT_DIRECTIONS.indexOf(b));
  return plan;
}

// ---------- what a run costs ----------
/**
 * Workers AI bills klein 4B by 512 × 512 tiles: 5.37 neurons per input tile and 26.05 per output
 * tile (the platform's price list, as in refine-run.ts). The guide and each photo are at most 496 px
 * a side (one tile each); the answer is twice the guide.
 */
const INPUT_TILE_NEURONS = 5.37;
const OUTPUT_TILE_NEURONS = 26.05;
const tiles = (width: number, height: number) => Math.ceil(width / 512) * Math.ceil(height / 512);
export function callNeurons(guide: { width: number; height: number }, photos: number): number {
  return (1 + photos) * INPUT_TILE_NEURONS + tiles(guide.width * 2, guide.height * 2) * OUTPUT_TILE_NEURONS;
}
/** The calls and neurons (an estimate) of making `candidates` answers for each guide. */
export function runEstimate(
  guides: readonly { width: number; height: number }[],
  photos: number,
  candidates = DIRECTION_PHOTO_CANDIDATES,
): { calls: number; neurons: number } {
  return {
    calls: guides.length * candidates,
    neurons: Math.round(guides.reduce((sum, guide) => sum + callNeurons(guide, photos), 0) * candidates),
  };
}

// ---------- the anchor ----------
/**
 * The anchor of a cut-out photo from its opaque outline: the middle of its bottom edge for a product
 * that stands on the floor (where it touches the floor), its centre for a wall product (as the form's
 * defaults put it, now on the product itself). `alpha` is one byte a pixel, top-down. None when
 * nothing is opaque.
 */
export function anchorFromAlpha(
  alpha: ArrayLike<number>,
  width: number,
  height: number,
  onFloor: boolean,
  threshold = 128,
): Point | undefined {
  let left = width,
    right = -1,
    top = height,
    bottom = -1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      if (alpha[y * width + x] < threshold) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  if (right < 0) return undefined;
  const round = (value: number) => Math.round(value * 10000) / 10000;
  return {
    x: round((left + right + 1) / 2 / width),
    y: round(onFloor ? (bottom + 1) / height : (top + bottom + 1) / 2 / height),
  };
}

// ---------- one run ----------
export type DirectionJob = { direction: ProductDirection; candidate: number; seed: number };
export type DirectionJobOutcome =
  | { job: DirectionJob; status: 'made'; image: Blob }
  | { job: DirectionJob; status: 'failed'; message: string; sent: boolean };
/** A spent limit or a refused login ends the run: the next requests would only meet the same wall. */
export const ENDS_RUN = new Set([401, 402, 403, 429, 503]);

/** The jobs of a run: `candidates` for each direction, each with its own seed. */
export function directionJobs(
  directions: readonly ProductDirection[],
  candidates: number,
  seed: () => number,
): DirectionJob[] {
  return directions.flatMap((direction) =>
    Array.from({ length: candidates }, (_, candidate) => ({ direction, candidate, seed: seed() })),
  );
}

/**
 * Sends the jobs, at most `concurrency` at a time. Every job ends as made or failed (with the
 * message); nothing is retried. A limit or login refusal stops sending: the jobs not sent yet fail
 * with the same message (`sent: false`). Cancelling (the signal) ends the whole run with an error.
 */
export async function runDirectionJobs(input: {
  jobs: readonly DirectionJob[];
  request: (job: DirectionJob, signal: AbortSignal) => Promise<Blob>;
  signal: AbortSignal;
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
}): Promise<DirectionJobOutcome[]> {
  const { jobs, signal } = input;
  const outcomes = new Array<DirectionJobOutcome>(jobs.length);
  let next = 0,
    done = 0,
    halted: string | undefined;
  async function worker() {
    while (next < jobs.length) {
      signal.throwIfAborted();
      const index = next++;
      const job = jobs[index];
      if (halted) outcomes[index] = { job, status: 'failed', message: halted, sent: false };
      else
        try {
          outcomes[index] = { job, status: 'made', image: await input.request(job, signal) };
        } catch (error) {
          signal.throwIfAborted();
          const message = error instanceof Error ? error.message : 'AI 요청에 실패했어요.';
          const status = (error as { status?: number })?.status;
          if (status !== undefined && ENDS_RUN.has(status)) halted = message;
          outcomes[index] = { job, status: 'failed', message, sent: true };
        }
      input.onProgress?.(++done, jobs.length);
    }
  }
  const workers = Math.max(1, Math.min(input.concurrency ?? 2, jobs.length));
  await Promise.all(Array.from({ length: workers }, () => worker()));
  signal.throwIfAborted();
  return outcomes;
}
