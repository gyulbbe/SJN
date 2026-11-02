/**
 * Product choice without AI (round 4's browser-model part): the products in the photos against the
 * public products' direction photos, by DINOv2 / CLIP / SigLIP2, on the plain box or the BiRefNet
 * cut-out, taking each product's best direction photo. Scores what can be scored without people:
 * the kind of the first answer when the kind is not given, and the "no match" colour gate (a cut-out
 * whose colour is far from every candidate's). Keeps each method's first 12 of the right kind for the
 * AI boards and the people.
 *
 * Usage: node tests/run-browser-test.mjs tests/catalog-match/r4-products-local.ts
 * Output: test-results/catalog-match/r4-products/{summary.json,top12.json}
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cosineRow, out, readJson, readMatrix } from './data';

const arg = (name: string, fallback: string) => {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? fallback : process.argv[at + 1];
};
const dir = join(out, 'features', 'products');
const TAG = arg('tag', '');
const target = join(out, TAG ? `r4-products-${TAG}` : 'r4-products');
mkdirSync(target, { recursive: true });
type View = { id: string; category: string; direction: string; path: string };
type Query = { id: string; photo: string; split: string; kind: string };
const views = readJson<View[]>(join(dir, 'catalog.json'));
const queries = readJson<Query[]>(join(dir, 'queries.json'));
const products = [...new Set(views.map((v) => v.id))];
const categoryOf = new Map(views.map((v) => [v.id, v.category]));
const methods: { name: string; catalog: string; query: string }[] = [];
for (const model of arg('models', 'dinov2-small-q4f16,clip-b32-q4f16,siglip2-b16-q4f16').split(','))
  for (const output of ['pooled', 'patchmean'])
    for (const variant of ['box', 'cutout'])
      methods.push({
        name: `${model.split('-')[0]}.${output}.${variant}`,
        catalog: `catalog.${model}.white.${output}`,
        query: `query.${model}.${variant}.${output}`,
      });

const summary: Record<string, unknown> = {
  queries: queries.length,
  products: products.length,
  views: views.length,
};
const top12: Record<string, Record<string, { id: string; score: number }[]>> = {};
const kindTable: Record<string, unknown> = {};
for (const method of methods) {
  const cat = readMatrix(join(dir, `${method.catalog}.f32`), views.length);
  const q = readMatrix(join(dir, `${method.query}.f32`), queries.length);
  if (!cat || !q) continue;
  let right = 0;
  queries.forEach((query, r) => {
    const best = new Map<string, number>();
    views.forEach((view, i) => {
      const score = cosineRow(cat, i, q.data, r * q.dims);
      if (score > (best.get(view.id) ?? -Infinity)) best.set(view.id, score);
    });
    const ranked = [...best].sort((a, b) => b[1] - a[1]);
    if (categoryOf.get(ranked[0][0]) === query.kind) right++;
    (top12[query.id] ??= {})[method.name] = ranked
      .filter(([id]) => categoryOf.get(id) === query.kind)
      .slice(0, 12)
      .map(([id, score]) => ({ id, score: Number(score.toFixed(4)) }));
  });
  kindTable[method.name] = { kindRight: right / queries.length, n: queries.length };
}
summary.kindWithoutFilter = kindTable;
writeFileSync(join(target, 'summary.json'), JSON.stringify(summary, null, 1));
writeFileSync(join(target, 'top12.json'), JSON.stringify(top12));
for (const [name, s] of Object.entries(kindTable as Record<string, { kindRight: number }>))
  console.log(name.padEnd(28), 'kind right (no filter)', (100 * s.kindRight).toFixed(0) + '%');
