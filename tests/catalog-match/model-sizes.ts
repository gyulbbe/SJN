/**
 * The DINOv2 size comparison's shared pieces: the sizes, every rating so far (round 5, round 9 and the
 * comparison's own screen) and each size's first tile and first product.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { out, readJson } from './data';

export const SIZES = ['small', 'base', 'large'] as const;
const VARIANT = 'clean.rect.raw';
export type Rating = { section: string; item: string; candidate?: string; value?: number };
const ratingFiles = ['review', 'review-r9', 'review-models'].map((d) => join(out, d, 'ratings.jsonl'));
/** Every rating with a value so far, oldest first (a later one for the same candidate wins). */
export const allRatings = (): Rating[] =>
  ratingFiles
    .filter((f) => existsSync(f))
    .flatMap((f) =>
      readFileSync(f, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Rating),
    )
    .filter((r) => r.value);
/** Each size's first tile per face (`<size>.fused`, `<size>.dinov2`) and first product (`<size>.box`). */
export function firstPicks() {
  const tiles: Record<string, Record<string, string>> = {};
  const products: Record<string, Record<string, string>> = {};
  for (const size of SIZES) {
    const dir = join(out, `r1-tiles-m-${size}`);
    const best = readJson<{ bestModelMethod: string }>(join(dir, 'summary.json')).bestModelMethod;
    const top = readJson<Record<string, Record<string, string[]>>>(join(dir, 'photo-top12.json'));
    for (const [face, methods] of Object.entries(top)) {
      const fused = methods[`${VARIANT}|fused(classic+${best})`]?.[0];
      const alone = methods[`${VARIANT}|${best}`]?.[0];
      if (fused) (tiles[face] ??= {})[`${size}.fused`] = fused;
      if (alone) (tiles[face] ??= {})[`${size}.dinov2`] = alone;
    }
    const productTop = readJson<Record<string, Record<string, { id: string }[]>>>(
      join(out, `r4-products-m-${size}`, 'top12.json'),
    );
    for (const [query, methods] of Object.entries(productTop)) {
      const id = methods['dinov2.pooled.box']?.[0]?.id;
      if (id) (products[query] ??= {})[`${size}.box`] = id;
    }
  }
  return { tiles, products };
}
