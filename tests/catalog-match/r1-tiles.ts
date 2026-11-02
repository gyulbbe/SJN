/**
 * Round 1 scoring (no AI call): ranks the catalog for every query face with each model-free and
 * browser-model method, on every crop variant, and scores the synthetic faces against their answer
 * (strict and same-pattern top 1/5/20, CIEDE2000 of the first). Weights, the fused method and the
 * crop variant are chosen on the development half only; the report half is scored once with them.
 * For the photos (no answer) it keeps each method's first 12, for the AI boards and the people.
 *
 * Usage: node tests/run-browser-test.mjs tests/catalog-match/r1-tiles.ts
 *          [--tag q8 --models dinov2-small-q8,siglip2-b16-q8 --catalog catalog-q8 --synth queries-synth-q8 --photos queries-photos-q8]
 * Output: test-results/catalog-match/r1-tiles[-tag]/{summary.json,photo-top12.json,timing-node.json}
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cosineRow,
  loadCatalog,
  loadQueries,
  out,
  readJson,
  readMatrix,
  type Classic,
  type Matrix,
} from './data';
import { patternNeighbours, rankOf, topN } from './score';
import { colourDistance, deltaE2000, sizeDistance, textureDistance } from './tile-features';

const arg = (name: string, fallback: string) => {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? fallback : process.argv[at + 1];
};
const TAG = arg('tag', '');
const target = join(out, TAG ? `r1-tiles-${TAG}` : 'r1-tiles');
/** Where the catalog embeddings are (the model-free numbers always come from features/catalog). */
const CATALOG_MATRICES = join(out, 'features', arg('catalog', 'catalog'));
mkdirSync(target, { recursive: true });
const catalog = loadCatalog();
const groups = readJson<{ pairs: [string, string][] }>(join(out, 'features', 'catalog', 'groups.json'));
const same = patternNeighbours(
  catalog.tiles.map((t) => t.id),
  groups.pairs,
);
const usable = (face: string) =>
  catalog.tiles
    .map((t, i) => [t, i] as const)
    .filter(([t]) => (face === 'floor' ? t.usage !== 'wall' : t.usage !== 'floor'));

// ---------- the methods ----------
type Method = {
  name: string;
  /** Distance of catalog tile `i` to query row `r` (lower is closer). */
  distance: (r: number, i: number) => number;
};
type QuerySet = ReturnType<typeof loadQueries>;
const MODELS = arg('models', 'dinov2-small-q4f16,clip-b32-q4f16,siglip2-b16-q4f16').split(',');
function modelMethods(q: QuerySet): Method[] {
  const methods: Method[] = [];
  for (const model of MODELS)
    for (const output of ['pooled', 'patchmean'])
      for (const [qKind, cKind] of [
        ['full', 'single'],
        ['window', 'repeat'],
      ]) {
        const cat = readMatrix(
          join(CATALOG_MATRICES, `${model}.${cKind}.${output}.f32`),
          catalog.tiles.length,
        );
        const query = q.matrix(`${model}.${qKind}.${output}`);
        if (!cat || !query) continue;
        methods.push({
          name: `${model.split('-')[0]}.${output}.${cKind}`,
          distance: (r, i) => 1 - cosineRow(cat as Matrix, i, query.data, r * query.dims),
        });
      }
  return methods;
}
/** Size from the crop's repeat (autocorrelation period × mm per pixel), when there is one. */
function measuredSize(c: Classic, mm: { widthMm: number; heightMm: number }, px: { w: number; h: number }) {
  const [x, y] = c.texture.period;
  if (!x || !y) return undefined;
  return { widthMm: (x * mm.widthMm) / px.w, heightMm: (y * mm.heightMm) / px.h };
}
type Weights = { hist: number; mean: number; texture: number; size: number };
function classicMethods(q: QuerySet, weights: Weights): Method[] {
  const crop = (r: number) => {
    const { widthMm, heightMm } = q.rows[r].mm;
    const ratio = widthMm / Math.max(1, heightMm);
    // The crop was drawn 384 px on its long side, then shrunk to 256 for the numbers.
    return ratio >= 1 ? { w: 256, h: 256 / ratio } : { w: 256 * ratio, h: 256 };
  };
  return [
    {
      name: 'lab-mean',
      distance: (r, i) => deltaE2000(q.classic[r].colour.mean, catalog.tiles[i].classic.colour.mean) / 100,
    },
    {
      name: 'lab-hist',
      distance: (r, i) => colourDistance(q.classic[r].colour, catalog.tiles[i].classic.colour),
    },
    {
      name: 'classic',
      distance: (r, i) => {
        const a = q.classic[r],
          b = catalog.tiles[i].classic;
        return (
          weights.hist * colourDistance(a.colour, b.colour) +
          (weights.mean * deltaE2000(a.colour.mean, b.colour.mean)) / 30 +
          weights.texture * textureDistance(a.texture, b.texture) +
          weights.size * sizeDistance(catalog.tiles[i], measuredSize(a, q.rows[r].mm, crop(r)))
        );
      },
    },
  ];
}
/** Rank fusion of two methods (weighted reciprocal ranks). */
function fused(name: string, a: Method, b: Method, wb: number, candidates: (r: number) => number[]): Method {
  const cache = new Map<number, Map<number, number>>();
  return {
    name,
    distance: (r, i) => {
      let scores = cache.get(r);
      if (!scores) {
        scores = new Map();
        const ids = candidates(r);
        for (const [method, weight] of [
          [a, 1 - wb],
          [b, wb],
        ] as const) {
          const order = [...ids].sort((x, y) => method.distance(r, x) - method.distance(r, y));
          order.forEach((id, rank) => scores!.set(id, (scores!.get(id) ?? 0) + weight / (20 + rank)));
        }
        cache.set(r, scores);
      }
      return -(scores.get(i) ?? 0);
    },
  };
}

// ---------- scoring ----------
function rankAll(q: QuerySet, method: Method, rowsOf: number[]) {
  return rowsOf.map((r) => {
    const face = q.faces.find((f) => f.id === q.rows[r].query)!;
    const pool = usable(face.face);
    const ranked = pool
      .map(([t, i]) => [t.id, method.distance(r, i)] as const)
      .sort((x, y) => x[1] - y[1])
      .map(([id]) => id);
    return { r, face, ranked };
  });
}
function score(q: QuerySet, method: Method, rowsOf: number[]) {
  const ranked = rankAll(q, method, rowsOf);
  const strict = ranked.map(({ face, ranked }) => rankOf(ranked, (id) => id === face.materialId));
  const pattern = ranked.map(({ face, ranked }) =>
    rankOf(ranked, (id) => same.get(face.materialId!)!.has(id)),
  );
  const mean = (id: string) => catalog.tiles.find((t) => t.id === id)!.classic.colour.mean;
  const dE = ranked.map(({ face, ranked }) => deltaE2000(mean(ranked[0]), mean(face.materialId!)));
  dE.sort((a, b) => a - b);
  return { strict: topN(strict), pattern: topN(pattern), deltaEMedian: dE[dE.length >> 1], ranked };
}
const rowsWhere = (q: QuerySet, variant: string, split?: string) =>
  q.rows
    .map((row, r) => [row, r] as const)
    .filter(
      ([row]) =>
        row.variant === variant && (!split || q.faces.find((f) => f.id === row.query)!.split === split),
    )
    .map(([, r]) => r);

const synth = loadQueries(join(out, 'features', arg('synth', 'queries-synth')));
const variants = [...new Set(synth.rows.map((row) => row.variant))];
const summary: Record<string, unknown> = {
  catalogTakenAt: catalog.takenAt,
  faces: synth.faces.length,
  variants,
};

// 1. The crop variant: lab-hist and DINOv2 (pooled, single) on the development half.
const baseWeights: Weights = { hist: 1, mean: 0.5, texture: 0.3, size: 0.1 };
const variantTable: Record<string, unknown> = {};
for (const variant of variants) {
  const rows = rowsWhere(synth, variant, 'dev');
  const methods = [
    ...classicMethods(synth, baseWeights).slice(1, 2),
    ...modelMethods(synth).filter((m) => m.name === 'dinov2.pooled.single'),
  ];
  variantTable[variant] = Object.fromEntries(
    methods.map((m) => {
      const s = score(synth, m, rows);
      return [m.name, { n: s.pattern.n, strict: s.strict, pattern: s.pattern }];
    }),
  );
}
summary.variantChoice = variantTable;
const variantScore = (v: string) =>
  Object.values(variantTable[v] as Record<string, { pattern: { 5: number } }>).reduce(
    (sum, m) => sum + m.pattern[5],
    0,
  );
const chosenVariant = [...variants].sort((a, b) => variantScore(b) - variantScore(a))[0];
summary.chosenVariant = chosenVariant;
console.log('variant choice (dev, pattern top-5 of lab-hist + dinov2):');
for (const v of variants) console.log('  ', v.padEnd(20), variantScore(v).toFixed(3));
console.log('chosen', chosenVariant);

// 2. The classic weights: a small grid on the development half.
const devRows = rowsWhere(synth, chosenVariant, 'dev');
let best = { weights: baseWeights, value: -1 };
for (const hist of [0.5, 1])
  for (const mean of [0, 0.5, 1, 2])
    for (const texture of [0, 0.3, 0.6, 1])
      for (const size of [0, 0.1, 0.3]) {
        const weights = { hist, mean, texture, size };
        const s = score(synth, classicMethods(synth, weights)[2], devRows);
        const value = s.pattern[5] + s.pattern[1] * 0.5;
        if (value > best.value) best = { weights, value };
      }
summary.classicWeights = best.weights;
console.log('classic weights', best.weights);

// 3. All methods on dev; the best model method; the fusion weight on dev.
const all = (q: QuerySet) => [...classicMethods(q, best.weights), ...modelMethods(q)];
const devTable = Object.fromEntries(
  all(synth).map((m) => {
    const s = score(synth, m, devRows);
    return [m.name, { strict: s.strict, pattern: s.pattern, deltaEMedian: s.deltaEMedian }];
  }),
);
const bestModel = Object.entries(devTable)
  .filter(([name]) => !['lab-mean', 'lab-hist', 'classic'].includes(name))
  .sort((a, b) => b[1].pattern[5] - a[1].pattern[5] || b[1].pattern[1] - a[1].pattern[1])[0][0];
const pool = (q: QuerySet) => (r: number) =>
  usable(q.faces.find((f) => f.id === q.rows[r].query)!.face).map(([, i]) => i);
let fuseWeight = 0.5,
  fuseValue = -1;
for (const w of [0.3, 0.5, 0.7]) {
  const methods = all(synth);
  const m = fused(
    'fused',
    methods.find((x) => x.name === 'classic')!,
    methods.find((x) => x.name === bestModel)!,
    w,
    pool(synth),
  );
  const s = score(synth, m, devRows);
  if (s.pattern[5] + s.pattern[1] * 0.5 > fuseValue) {
    fuseValue = s.pattern[5] + s.pattern[1] * 0.5;
    fuseWeight = w;
  }
}
summary.bestModelMethod = bestModel;
summary.fuseWeight = fuseWeight;
const withFusion = (q: QuerySet) => {
  const methods = all(q);
  return [
    ...methods,
    fused(
      `fused(classic+${bestModel})`,
      methods.find((x) => x.name === 'classic')!,
      methods.find((x) => x.name === bestModel)!,
      fuseWeight,
      pool(q),
    ),
  ];
};

// 4. Both halves with everything fixed; conditions on the report half.
const report: Record<string, unknown> = {};
const conditionOf = (photo: string) => {
  const c = readJson<{
    cases: { id: string; preset: string; light: { kind: string }; longEdge: number; fixtures: boolean }[];
  }>(join(out, 'synth', 'cases.json')).cases.find((x) => x.id === photo)!;
  return c;
};
for (const split of ['dev', 'report']) {
  const rows = rowsWhere(synth, chosenVariant, split);
  report[split] = Object.fromEntries(
    withFusion(synth).map((m) => {
      const s = score(synth, m, rows);
      const by = (key: (c: ReturnType<typeof conditionOf>) => string) => {
        const groupsOf = new Map<string, number[]>();
        s.ranked.forEach(({ face, ranked }) => {
          const k = key(conditionOf(face.photo));
          groupsOf.set(k, [
            ...(groupsOf.get(k) ?? []),
            rankOf(ranked, (id) => same.get(face.materialId!)!.has(id)),
          ]);
        });
        return Object.fromEntries([...groupsOf].map(([k, ranks]) => [k, topN(ranks)]));
      };
      return [
        m.name,
        {
          strict: s.strict,
          pattern: s.pattern,
          deltaEMedian: s.deltaEMedian,
          ...(split === 'report'
            ? {
                byResolution: by((c) => String(c.longEdge)),
                byView: by((c) => (c.preset === 'orbit' ? 'above' : 'inside')),
                byLight: by((c) => (c.light.kind === 'neutral' ? 'neutral' : 'cast')),
                byProducts: by((c) => (c.fixtures ? 'products' : 'none')),
              }
            : {}),
        },
      ];
    }),
  );
}
summary.results = report;
writeFileSync(join(target, 'summary.json'), JSON.stringify(summary, null, 1));
const line = (
  name: string,
  s: { strict: Record<string, number>; pattern: Record<string, number>; deltaEMedian: number },
) =>
  `${name.padEnd(42)} strict ${[1, 5, 20].map((k) => (100 * s.strict[k]).toFixed(0).padStart(3)).join(' ')} | pattern ${[1, 5, 20].map((k) => (100 * s.pattern[k]).toFixed(0).padStart(3)).join(' ')} | dE ${s.deltaEMedian.toFixed(1)}`;
for (const split of ['dev', 'report']) {
  console.log(`\n${split} (${chosenVariant})`);
  for (const [name, s] of Object.entries(report[split] as Record<string, never>)) console.log(line(name, s));
}

// The synthetic development faces' first 12 with their answer, for AI boards that can be scored.
const synthTop: Record<string, { answer: string; top: Record<string, string[]> }> = {};
for (const m of withFusion(synth))
  for (const { face, ranked } of rankAll(synth, m, rowsWhere(synth, chosenVariant, 'dev'))) {
    synthTop[face.id] ??= { answer: face.materialId!, top: {} };
    synthTop[face.id].top[m.name] = ranked.slice(0, 12);
  }
writeFileSync(join(target, 'synth-top12.json'), JSON.stringify(synthTop));

// 5. The photos: each method's first 12 on the chosen variant (and on the plain whole face).
const photos = loadQueries(join(out, 'features', arg('photos', 'queries-photos')));
const photoTop: Record<string, Record<string, string[]>> = {};
for (const variant of [chosenVariant, 'auto.rect.raw'])
  for (const m of withFusion(photos)) {
    for (const { face, ranked } of rankAll(photos, m, rowsWhere(photos, variant))) {
      photoTop[face.id] ??= {};
      photoTop[face.id][`${variant}|${m.name}`] = ranked.slice(0, 12);
    }
  }
writeFileSync(join(target, 'photo-top12.json'), JSON.stringify(photoTop));
// The comparison time of one face against the whole catalog, per method (node, this PC).
const timing: Record<string, number> = {};
for (const m of withFusion(photos)) {
  const rows = rowsWhere(photos, chosenVariant).slice(0, 10);
  const started = performance.now();
  rankAll(photos, m, rows);
  timing[m.name] = (performance.now() - started) / rows.length;
}
writeFileSync(join(target, 'timing-node.json'), JSON.stringify(timing, null, 1));
console.log(
  '\nms per face vs the whole catalog (node):',
  Object.entries(timing)
    .map(([k, v]) => `${k} ${v.toFixed(0)}`)
    .join(', '),
);
