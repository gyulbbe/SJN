/**
 * The review's results (round 5): the user's 1 비슷함 / 2 그럭저럭 / 3 아님 per candidate, credited to
 * every method that put that candidate first; "맞는 게 없어 보임" per item; the rooms' 1–5 per
 * combination; and the confirmed positions, written as the fifteen's answer sheet and used to score
 * round 2 and round 4's position answers again.
 *
 * Usage: node tests/run-browser-test.mjs tests/catalog-match/review/score.ts
 * Output: test-results/catalog-match/review/summary.json, truth/fifteen-confirmed.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { out, readJson } from '../data';
import { positionScore, type PlacedGuess, type PlacedTruth, type Wall } from '../score';

type Rating = {
  section: string;
  item: string;
  candidate?: string;
  value?: number;
  none?: boolean;
  complete?: boolean;
  at?: string;
  products?: { id: string; wall: Wall | 'unknown'; third: string }[];
};
const ratings = readFileSync(join(out, 'review', 'ratings.jsonl'), 'utf8')
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line) as Rating);
type Item = { id: string; candidates?: { key: string; methods: string[] }[] };
const items = readJson<{ sections: { kind: string; items: Item[] }[] }>(join(out, 'review', 'items.json'));
/** The last value given (a later press replaces an earlier one). */
const last = new Map<string, Rating>();
for (const r of ratings) if (r.candidate !== undefined) last.set(`${r.item}|${r.candidate}`, r);
const none = new Set(ratings.filter((r) => r.none).map((r) => r.item));

const summary: Record<string, unknown> = { ratings: ratings.length };
for (const kind of ['tile', 'product', 'overall']) {
  const section = items.sections.find((s) => s.kind === kind)!;
  const byMethod: Record<string, { n: number; values: Record<number, number> }> = {};
  for (const item of section.items)
    for (const c of item.candidates ?? []) {
      const value = last.get(`${item.id}|${c.key}`)?.value;
      if (!value) continue;
      for (const method of c.methods) {
        const row = (byMethod[method] ??= { n: 0, values: {} });
        row.n++;
        row.values[value] = (row.values[value] ?? 0) + 1;
      }
    }
  summary[kind] = Object.fromEntries(
    Object.entries(byMethod).map(([method, row]) => {
      const mean = Object.entries(row.values).reduce((s, [v, n]) => s + Number(v) * n, 0) / row.n;
      return [method, { n: row.n, values: row.values, mean: Math.round(mean * 100) / 100 }];
    }),
  );
  if (kind !== 'overall')
    summary[`${kind}NoneLooksRight`] = section.items.filter((i) => none.has(i.id)).map((i) => i.id);
}

// ---------- the confirmed positions ----------
const confirmed: Record<string, { id: string; wall: Wall | 'unknown'; third: string }[]> = {};
for (const r of ratings.filter((x) => x.section === 'position' && x.products))
  confirmed[r.item.replace('pos:', '')] = r.products!;
const draft = readJson<{ photos: Record<string, { id: string; wall: string; third: string | null }[]> }>(
  join(out, 'truth', 'fifteen-draft.json'),
);
let changedWall = 0,
  changedThird = 0,
  total = 0;
for (const [photo, products] of Object.entries(confirmed))
  for (const p of products) {
    const d = draft.photos[photo]?.find((x) => x.id === p.id);
    total++;
    if (d && d.wall !== p.wall) changedWall++;
    if (d && (d.third ?? 'middle') !== p.third) changedThird++;
  }
summary.positionCorrections = { products: total, wallChanged: changedWall, thirdChanged: changedThird };
writeFileSync(
  join(out, 'truth', 'fifteen-confirmed.json'),
  JSON.stringify(
    {
      version: 1,
      confirmedBy: 'user on the review screen',
      confirmedAt: ratings.find((r) => r.section === 'position')?.at,
      photos: confirmed,
    },
    null,
    1,
  ),
);
const thirdU: Record<string, number> = { left: 1 / 6, middle: 0.5, right: 5 / 6 };
const r2 = readJson<Record<string, Record<string, PlacedGuess[]>>>(join(out, 'r2-position', 'guesses.json'));
const r4 = readFileSync(join(out, 'r4-ai', 'answers.jsonl'), 'utf8')
  .split(/\r?\n/)
  .filter(Boolean)
  .map(
    (l) =>
      JSON.parse(l) as {
        part: string;
        photo: string;
        model: string;
        candidates?: string[];
        result: Record<string, unknown>;
      },
  );
const index = readJson<{
  photos: { id: string; candidates: { id?: string; kind: string; box: { left: number; right: number } }[] }[];
}>(join(out, 'photos', 'index.json'));
const PRODUCT = new Set(['toilet', 'basin', 'vanity', 'bath']);
const kindOf = (k: string) => (k === 'vanity' ? 'basin' : k);
/** A saved candidate's id → its answer-sheet id (by kind, left to right), as rounds 2 and 4 did. */
function sheetId(photo: string, candidateId: string, sheet: { id: string }[]): string | undefined {
  const candidates = index.photos
    .find((p) => p.id === photo)!
    .candidates.map((c, i) => ({ ...c, id: c.id ?? `c${i}` }))
    .filter((c) => PRODUCT.has(c.kind));
  const c = candidates.find((x) => x.id === candidateId);
  if (!c) return;
  const same = candidates
    .filter((x) => kindOf(x.kind) === kindOf(c.kind))
    .sort((a, b) => a.box.left + a.box.right - (b.box.left + b.box.right));
  return sheet.filter((s) => s.id.endsWith(`-${kindOf(c.kind)}`))[same.indexOf(c)]?.id;
}
const position: Record<string, ReturnType<typeof positionScore>[]> = {};
for (const [photo, sheet] of Object.entries(confirmed)) {
  const truth: PlacedTruth[] = sheet.map((s) => ({ id: s.id, wall: s.wall, u: thirdU[s.third] }));
  const guesses: Record<string, PlacedGuess[]> = {};
  for (const m of ['baseline', 'layout', 'placement', 'face-above', 'moge'])
    if (r2[photo]?.[m]) guesses[m] = r2[photo][m];
  for (const a of r4.filter((x) => x.part === 'position' && x.photo === photo)) {
    const ids = (a.candidates ?? []).map((c) => sheetId(photo, c, sheet));
    const g: PlacedGuess[] = [];
    if (a.model === 'gemma') {
      const text = (a.result as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message
        ?.content;
      let parsed: { items?: { box: number; wall: Wall; third: string }[] } = {};
      try {
        parsed = JSON.parse(text ?? '{}');
      } catch {
        /* no answer */
      }
      for (const item of parsed.items ?? []) {
        const id = ids[item.box - 1];
        if (id) g.push({ id, wall: item.wall, u: thirdU[item.third] ?? 0.5 });
      }
    } else {
      const answers = (a.result as { answers?: Record<string, { choice: string }> }).answers ?? {};
      ids.forEach((id, i) => {
        const wall = answers[`wall_${i + 1}`]?.choice as Wall | undefined;
        if (id && wall) g.push({ id, wall, u: thirdU[answers[`third_${i + 1}`]?.choice ?? 'middle'] });
      });
    }
    guesses[a.model] = g;
  }
  for (const [m, g] of Object.entries(guesses)) (position[m] ??= []).push(positionScore(truth, g));
}
summary.positionConfirmed = Object.fromEntries(
  Object.entries(position).map(([m, rows]) => {
    const known = rows.reduce((s, r) => s + r.known, 0);
    const third = rows.filter((r) => r.sameThird !== undefined);
    return [
      m,
      {
        products: known,
        sameWall: Math.round((100 * rows.reduce((s, r) => s + r.sameWall * r.known, 0)) / Math.max(1, known)),
        sameThird: third.length
          ? Math.round((100 * third.reduce((s, r) => s + r.sameThird!, 0)) / third.length)
          : null,
        noAnswer: rows.reduce((s, r) => s + r.missing, 0),
      },
    ];
  }),
);
writeFileSync(join(out, 'review', 'summary.json'), JSON.stringify(summary, null, 1));
console.log(JSON.stringify(summary, null, 1));
