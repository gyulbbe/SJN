/**
 * The DINOv2 size comparison (small, base, large, all q8 on WASM), against the criteria written
 * before it ran (docs/catalog-match-trials-20261102.md §3):
 *
 *   people     round 5's thirty faces (fused first, DINOv2 alone first) and twenty-eight products
 *              (`dinov2.pooled.box` first): "similar" / "so-so" / "no", every rating so far reused
 *   synthetic  same-pattern top 1/5/20 of the fused method and of DINOv2 alone (r1-tiles-m-<size>)
 *   products   the first product's kind without a kind filter (r4-products-m-<size>)
 *   download   the model file and the tile and product feature files a user would get
 *   time       the browser part of one photo on this PC and on a slowed one (r8-lowspec-<size>)
 *
 * Usage: node tests/run-browser-test.mjs tests/catalog-match/models-score.ts
 * Output: test-results/catalog-match/models-compare/summary.json
 */
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { out, readJson } from './data';
import { MODELS } from './paths.mjs';
import { allRatings, firstPicks, SIZES } from './model-sizes';

const target = join(out, 'models-compare');
mkdirSync(target, { recursive: true });
const ratings = allRatings();
const valueOf = new Map(ratings.map((r) => [`${r.item}|${r.candidate}`, r.value!]));
const thirty = [...new Set(ratings.filter((r) => r.item.startsWith('tile:')).map((r) => r.item))];
const products28 = [...new Set(ratings.filter((r) => r.item.startsWith('product:')).map((r) => r.item))];
const { tiles, products } = firstPicks();
/** How a method's first picks were rated over the given items. */
function rate(
  items: string[],
  prefix: string,
  picks: Record<string, Record<string, string>>,
  method: string,
) {
  const row = { similar: 0, soSo: 0, no: 0, missing: 0, n: items.length };
  for (const item of items) {
    const id = picks[item.replace(prefix, '')]?.[method];
    const v = id && valueOf.get(`${item}|${id}`);
    if (v === 1) row.similar++;
    else if (v === 2) row.soSo++;
    else if (v === 3) row.no++;
    else row.missing++;
  }
  return row;
}
type Top = { 1: number; 5: number; 20: number };
const pct = (t: Top) => ({
  1: Math.round(100 * t[1]),
  5: Math.round(100 * t[5]),
  20: Math.round(100 * t[20]),
});
const models = readJson<Record<string, { bytes: number }>>(join(MODELS as string, 'models.json'));
const median = (values: number[]) => [...values].sort((a, b) => a - b)[values.length >> 1];

const bySize: Record<string, Record<string, unknown>> = {};
for (const size of SIZES) {
  const r1 = readJson<{
    bestModelMethod: string;
    fuseWeight: number;
    results: Record<'dev' | 'report', Record<string, { pattern: Top }>>;
  }>(join(out, `r1-tiles-m-${size}`, 'summary.json'));
  const fused = `fused(classic+${r1.bestModelMethod})`;
  const kind = readJson<{ kindWithoutFilter: Record<string, { kindRight: number }> }>(
    join(out, `r4-products-m-${size}`, 'summary.json'),
  ).kindWithoutFilter['dinov2.pooled.box'];
  // e.g. dinov2.patchmean.repeat → dinov2-<size>-q8.repeat.patchmean.f32
  const [, output, catalogKind] = r1.bestModelMethod.split('.');
  const tileFile = join(
    out,
    'features',
    size === 'small' ? 'catalog-q8' : `catalog-${size}-q8`,
    `dinov2-${size}-q8.${catalogKind}.${output}.f32`,
  );
  const productFile = join(
    out,
    'features',
    size === 'small' ? 'products' : `products-${size}`,
    `catalog.dinov2-${size}-q8.white.pooled.f32`,
  );
  const modelBytes = models[`dinov2-${size}/onnx/model_quantized.onnx`].bytes;
  const tileBytes = existsSync(tileFile) ? statSync(tileFile).size : 0;
  const productBytes = existsSync(productFile) ? statSync(productFile).size : 0;
  const lowFile = join(out, `r8-lowspec-${size}`, 'summary.json');
  const low = existsSync(lowFile)
    ? readJson<Record<string, { modelMs: number; perPhoto: { total: number }[] } | unknown>>(lowFile)
    : undefined;
  const time = low
    ? Object.fromEntries(
        ['webgpu', 'wasm-1thread', 'wasm-1thread-cpu4x'].map((c) => {
          const run = low[c] as { modelMs: number; perPhoto: { total: number }[] } | undefined;
          return [
            c,
            run && { modelMs: run.modelMs, photoMedianMs: median(run.perPhoto.map((p) => p.total)) },
          ];
        }),
      )
    : undefined;
  bySize[size] = {
    method: r1.bestModelMethod,
    fuseWeight: r1.fuseWeight,
    people: {
      tileFused: rate(thirty, 'tile:', tiles, `${size}.fused`),
      tileAlone: rate(thirty, 'tile:', tiles, `${size}.dinov2`),
      product: rate(products28, 'product:', products, `${size}.box`),
    },
    synthetic: {
      fused: { dev: pct(r1.results.dev[fused].pattern), report: pct(r1.results.report[fused].pattern) },
      alone: {
        dev: pct(r1.results.dev[r1.bestModelMethod].pattern),
        report: pct(r1.results.report[r1.bestModelMethod].pattern),
      },
    },
    productKindRight: Math.round(100 * kind.kindRight),
    download: {
      modelMB: Math.round(modelBytes / 1e5) / 10,
      tileFeaturesMB: Math.round(tileBytes / 1e5) / 10,
      productFeaturesMB: Math.round(productBytes / 1e5) / 10,
      totalMB: Math.round((modelBytes + tileBytes + productBytes) / 1e5) / 10,
    },
    time,
  };
}

// The criteria, each size against small.
type People = { similar: number };
const small = bySize.small as {
  people: { tileFused: People; product: People };
  synthetic: { fused: { report: { 5: number } } };
};
const verdict = Object.fromEntries(
  SIZES.filter((s) => s !== 'small').map((size) => {
    const s = bySize[size] as typeof small & {
      download: { totalMB: number };
      time?: Record<string, { photoMedianMs: number } | undefined>;
    };
    const tile = s.people.tileFused.similar - small.people.tileFused.similar;
    const product = s.people.product.similar - small.people.product.similar;
    const slow = s.time?.['wasm-1thread-cpu4x']?.photoMedianMs;
    return [
      size,
      {
        tileMore: tile,
        productMore: product,
        people: (tile >= 3 && product >= 0) || (product >= 3 && tile >= 0),
        synthetic: s.synthetic.fused.report[5] >= small.synthetic.fused.report[5],
        download: s.download.totalMB <= 150,
        time: slow !== undefined && slow <= 120_000,
      },
    ];
  }),
);
const summary = { thirty: thirty.length, products: products28.length, bySize, verdict };
writeFileSync(join(target, 'summary.json'), JSON.stringify(summary, null, 1));
console.log(JSON.stringify(summary, null, 1));
