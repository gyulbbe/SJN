/**
 * One review set's scores (no AI call): per method the people's "real photo" and "my design" means
 * and how often each problem was marked, and how well each automatic score ranks the results like
 * people do (Spearman; used for choosing only at 0.5 or more, docs §3):
 *   framing      the colour check's framing score (higher: framing kept)
 *   colour       mean ΔE2000 without lightness over the faces, model's answer (lower: colour kept)
 *   lightness    mean |L*| change over the faces (lower)
 *   products     the lowest BiRefNet overlap of the placed products (higher)
 *   gemma        products Gemma did not find + large added objects (lower)
 *   clip         CLIP P("a photo") of the shown picture (higher: real), against "real photo"
 *
 * Usage: node tests/run-browser-test.mjs tests/export-photoreal/review/score.ts --set r2
 * Output: test-results/export-photoreal/review/<set>/summary.json
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spearman } from '../budget';
import { resultBase } from '../io';
import { openLab } from '../lab';
import { OUT } from '../paths.mjs';

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const set = arg('set') ?? 'r2';
const dir = join(OUT as string, 'review', set);
const items = (
  JSON.parse(readFileSync(join(dir, 'items.json'), 'utf8')) as { items: { id: string; right: string }[] }
).items;
const key = JSON.parse(readFileSync(join(dir, 'key.json'), 'utf8')) as Record<
  string,
  { method: string; scene: string; seed?: number }
>;
const answers: Record<string, { realism?: number; design?: number; problems?: number[] }> = {};
for (const line of readFileSync(join(dir, 'ratings.jsonl'), 'utf8').split('\n').filter(Boolean)) {
  const row = JSON.parse(line) as { item: string; field: 'realism' | 'design' | 'problems'; value: never };
  (answers[row.item] ??= {})[row.field] = row.value;
}
const PROBLEMS = ['product', 'added', 'tile', 'framing', 'distortion'] as const;
const read = <T>(file: string): T | undefined =>
  existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as T) : undefined;

// CLIP of every shown picture, cached beside the ratings.
const clipFile = join(dir, 'clip.json');
const clip: Record<string, number> = read(clipFile) ?? {};
const missing = items.filter((i) => clip[i.id] === undefined);
if (missing.length) {
  const lab = await openLab({ gpu: true });
  try {
    const values = await lab.clipReal(missing.map((i) => join(OUT as string, i.right)));
    missing.forEach((i, n) => (clip[i.id] = +values[n].toFixed(4)));
  } finally {
    await lab.close();
  }
  writeFileSync(clipFile, JSON.stringify(clip, null, 1));
}

type Row = {
  id: string;
  method: string;
  scene: string;
  realism: number;
  design: number;
  problems: number[];
  auto: Record<string, number | undefined>;
};
const rows: Row[] = items.map(({ id }) => {
  const k = key[id];
  const a = answers[id] ?? {};
  const base = k.seed !== undefined ? resultBase(k.method, k.scene, k.seed) : undefined;
  const post = base
    ? read<{ framing: { score: number }; changes?: { colorDeltaE: number; lightnessDelta: number }[] }>(
        `${base}.post.json`,
      )
    : undefined;
  const products = base ? read<{ iou: number }[]>(`${base}.products.json`) : undefined;
  const check = base
    ? read<{ reading?: { missing: number[]; extras: unknown[] } }>(`${base}.check.json`)
    : undefined;
  const changes = post?.changes ?? [];
  const mean = (v: number[]) => (v.length ? v.reduce((s, x) => s + x, 0) / v.length : undefined);
  return {
    id,
    method: k.method,
    scene: k.scene,
    realism: a.realism ?? NaN,
    design: a.design ?? NaN,
    problems: a.problems ?? [],
    auto: {
      framing: post?.framing.score,
      colour: mean(changes.map((c) => c.colorDeltaE)),
      lightness: mean(changes.map((c) => Math.abs(c.lightnessDelta))),
      products: products?.length ? Math.min(...products.map((p) => p.iou)) : undefined,
      gemma: check?.reading ? check.reading.missing.length + check.reading.extras.length : undefined,
      clip: clip[id],
    },
  };
});

const byMethod: Record<string, unknown> = {};
for (const method of [...new Set(rows.map((r) => r.method))]) {
  const of = rows.filter((r) => r.method === method);
  const mean = (f: (r: Row) => number) => +(of.reduce((s, r) => s + f(r), 0) / of.length).toFixed(2);
  byMethod[method] = {
    n: of.length,
    realism: mean((r) => r.realism),
    design: mean((r) => r.design),
    problems: Object.fromEntries(
      PROBLEMS.map((p, i) => [p, of.filter((r) => r.problems.includes(i + 1)).length]),
    ),
    bigProblems: of.filter((r) => r.problems.some((p) => p === 1 || p === 2 || p === 4)).length,
    scenes: Object.fromEntries(of.map((r) => [r.scene, [r.realism, r.design, r.problems.join('') || '-']])),
  };
}
// The automatic scores against people, over the results that have them.
const agreement: Record<string, { against: string; n: number; rho: number }> = {};
const pairs: [string, 'realism' | 'design', number][] = [
  ['framing', 'design', 1],
  ['colour', 'design', -1],
  ['lightness', 'design', -1],
  ['products', 'design', 1],
  ['gemma', 'design', -1],
  ['clip', 'realism', 1],
];
for (const [score, against, sign] of pairs) {
  const have = rows.filter((r) => r.auto[score] !== undefined && Number.isFinite(r[against]));
  agreement[score] = {
    against,
    n: have.length,
    rho: +(
      sign *
      spearman(
        have.map((r) => r.auto[score]!),
        have.map((r) => r[against]),
      )
    ).toFixed(3),
  };
}
// BiRefNet's "gone or changed" (< 0.5) against people's product mark, result by result.
const productAgreement = (() => {
  const have = rows.filter((r) => r.auto.products !== undefined);
  const both = have.filter((r) => r.auto.products! < 0.5 && r.problems.includes(1)).length;
  const autoOnly = have.filter((r) => r.auto.products! < 0.5 && !r.problems.includes(1)).length;
  const peopleOnly = have.filter((r) => r.auto.products! >= 0.5 && r.problems.includes(1)).length;
  return { results: have.length, both, autoOnly, peopleOnly };
})();
const summary = { set, items: rows.length, byMethod, agreement, productAgreement, rows };
writeFileSync(join(dir, 'summary.json'), JSON.stringify(summary, null, 1));
console.log(JSON.stringify({ byMethod, agreement, productAgreement }, null, 1));
