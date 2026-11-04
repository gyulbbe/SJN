// The export-photoreal trial's own arithmetic and request building (docs/export-photoreal-trials-20261104.md):
// neurons, the ledger's refusals, rank agreement, the variants' one change each, and that the current
// method is rebuilt exactly as the app sends it. No AI call, no browser.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fluxInputLayout, FLUX_PROMPT } from '../src/lib/ai-export/contract';
import { buildFluxPrompt, FLUX_CUTAWAY_SENTENCE } from '../src/lib/ai-export/prompt';
import {
  budgetCheck,
  fluxNeurons,
  spearman,
  tokenNeurons,
  PRICES,
  type LedgerRow,
} from './export-photoreal/budget';
import {
  fluxRequest,
  PHOTO_SENTENCE,
  REFERENCE_SENTENCE,
  shortPrompt,
  pngSize,
} from './export-photoreal/methods';
import { SPECS } from './export-photoreal/specs';

const at = '2026-11-04T10:00:00.000Z';
const row = (neurons: number, model = '@cf/black-forest-labs/flux-2-klein-4b', when = at): LedgerRow => ({
  at: when,
  model,
  neurons,
  status: 200,
});

describe('export-photoreal neurons', () => {
  it('prices a 496 × 336 input with a twice-as-large answer at about 110 neurons', () => {
    expect(fluxNeurons([{ width: 496, height: 336 }], { width: 992, height: 672 })).toBeCloseTo(109.57, 2);
  });
  it('counts a 768 input and every reference image as input tiles', () => {
    expect(fluxNeurons([{ width: 768, height: 512 }], { width: 1536, height: 1024 })).toBeCloseTo(
      2 * 5.37 + 6 * 26.05,
      2,
    );
    expect(
      fluxNeurons(
        [
          { width: 496, height: 336 },
          { width: 256, height: 256 },
          { width: 256, height: 256 },
        ],
        { width: 992, height: 672 },
      ),
    ).toBeCloseTo(3 * 5.37 + 4 * 26.05, 2);
  });
  it('turns Gemma tokens into neurons at $0.011 per thousand', () => {
    expect(tokenNeurons(PRICES['@cf/google/gemma-4-26b-a4b-it'], 940, 130)).toBeCloseTo(12.09, 1);
  });
});

describe('export-photoreal ledger', () => {
  it('refuses past 90% of the budget', () => {
    const rows = Array.from({ length: 81 }, () => row(110, undefined, '2026-11-03T10:00:00.000Z'));
    expect(budgetCheck(rows, { at, model: 'x', cost: 110 }).ok).toBe(false);
    expect(budgetCheck(rows.slice(0, 70), { at, model: 'x', cost: 110 }).ok).toBe(true);
  });
  it('refuses past the day share, and counts only that UTC day', () => {
    const today = Array.from({ length: 54 }, () => row(110));
    const limits = { budget: 100_000, daily: 6_000 };
    expect(budgetCheck(today, { at, model: 'x', cost: 110 }, new Set(), limits).ok).toBe(false);
    const yesterday = today.map((r) => ({ ...r, at: '2026-11-03T23:59:00.000Z' }));
    expect(budgetCheck(yesterday, { at, model: 'x', cost: 110 }, new Set(), limits).ok).toBe(true);
  });
  it('refuses a second call of an unpriced image model until its cost is confirmed', () => {
    const sdxl = '@cf/stabilityai/stable-diffusion-xl-base-1.0';
    expect(budgetCheck([], { at, model: sdxl, cost: 100 }).ok).toBe(true);
    const once = [row(100, sdxl)];
    expect(budgetCheck(once, { at, model: sdxl, cost: 100 }).ok).toBe(false);
    expect(budgetCheck(once, { at, model: sdxl, cost: 100 }, new Set([sdxl])).ok).toBe(true);
  });
  it('does not count refused rows', () => {
    const rows = Array.from({ length: 100 }, () => ({ ...row(110), status: 'refused' }));
    expect(budgetCheck(rows, { at, model: 'x', cost: 110 }).ok).toBe(true);
  });
});

describe('export-photoreal rank agreement', () => {
  it('is 1 for the same order, −1 for the reverse, averages ties', () => {
    expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1);
    expect(spearman([1, 2, 3, 4], [4, 3, 2, 1])).toBeCloseTo(-1);
    expect(spearman([1, 1, 2, 3], [1, 2, 3, 4])).toBeCloseTo(0.949, 3);
    expect(Number.isNaN(spearman([1, 1, 1], [1, 2, 3]))).toBe(true);
  });
});

describe('export-photoreal scenes and variants', () => {
  it('keeps two held-out scenes and eight for development, with unique ids', () => {
    expect(SPECS.filter((s) => s.holdout).map((s) => s.id)).toEqual(['large', 'side']);
    expect(SPECS.filter((s) => !s.holdout)).toHaveLength(8);
    expect(new Set(SPECS.map((s) => s.id)).size).toBe(SPECS.length);
  });
  const prompt = `${FLUX_PROMPT} ${FLUX_CUTAWAY_SENTENCE} Floor: grey tiles. 1. A toilet. Image 0 contains exactly these fixtures: 1 toilet. Each one keeps its type, position, size, shape and colour; no fixture turns into a different object and nothing is added.`;
  it('the short prompt keeps the instruction, the cutaway sentence and the count only', () => {
    expect(shortPrompt(prompt)).toBe(
      `${FLUX_PROMPT} ${FLUX_CUTAWAY_SENTENCE} Image 0 contains exactly these fixtures: 1 toilet. Each one keeps its type, position, size, shape and colour; no fixture turns into a different object and nothing is added.`,
    );
  });
  it('the photo and reference sentences are added once, right after the cutaway sentence', () => {
    for (const sentence of [PHOTO_SENTENCE, REFERENCE_SENTENCE]) {
      const at = prompt.indexOf(FLUX_CUTAWAY_SENTENCE) + FLUX_CUTAWAY_SENTENCE.length;
      const changed = `${prompt.slice(0, at)} ${sentence}${prompt.slice(at)}`;
      expect(changed.split(sentence)).toHaveLength(2);
      expect(changed.replace(` ${sentence}`, '')).toBe(prompt);
    }
  });
});

// The scene folders are written by scenes.ts (test-results, outside git); checked when present.
const root = join(process.cwd(), '..', 'SJN', 'test-results', 'export-photoreal', 'scenes');
const built = existsSync(join(root, 'white', 'grounding.json'));
describe.skipIf(!built)('export-photoreal current method = the app request', () => {
  it.each(SPECS.filter((s) => !s.holdout).map((s) => s.id))('%s: same prompt and input size', (id) => {
    const dir = join(root, id);
    const { scene } = JSON.parse(readFileSync(join(dir, 'grounding.json'), 'utf8'));
    const request = fluxRequest('current', dir);
    expect(request.prompt).toBe(buildFluxPrompt(scene));
    const capture = pngSize(readFileSync(join(dir, 'capture.png')));
    const layout = fluxInputLayout(capture.width, capture.height);
    expect(pngSize(request.images[0])).toEqual({ width: layout.width, height: layout.height });
    expect([request.width, request.height]).toEqual([layout.width * 2, layout.height * 2]);
    expect(request.images).toHaveLength(1);
  });
});
