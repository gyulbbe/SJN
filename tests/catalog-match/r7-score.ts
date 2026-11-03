/**
 * Round 7 (최종 평가 12장): the chosen combination (A + ③ check + ④ rule) run once on the held-out
 * photos, scored automatically against their annotation the way the development photos were:
 *
 *   boxes     Gemma's products vs the annotation (IoU ≥ 0.5 by kind), the saved DeepLab boxes beside
 *   position  Gemma's wall for the annotation's product boxes vs the annotation's wall
 *   colour    products the colour rule turns away (a strong body colour; every public toilet is white)
 *   check     ③ on today's pieces: pieces more than half inside an annotated box (fixtures and `ignore`)
 *             called not tile, and pieces clear of every box called not tile
 *   rule      ④: how each face was handled and how sure (no truth for the tiles themselves)
 *   cost      the round's neurons a photo, from the ledger
 *
 * Nothing here is tuned: the combination and the rule were fixed before the held-out photos were read.
 *
 * Usage: node tests/run-browser-test.mjs tests/catalog-match/r7-score.ts
 * Output: test-results/catalog-match/r7-final/summary.json
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { out, readJson } from './data';
import { dirty, notTile, overlapShare, type Inspection } from './inspect';
import { ROOT } from './paths.mjs';
import { gemmaBox, matchBoxes, positionScore, type Box, type PlacedGuess, type Wall } from './score';
import type { Quad } from './tile-features';

const target = join(out, 'r7-final');
mkdirSync(target, { recursive: true });
const lines = <T>(file: string): T[] =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .map((l) => JSON.parse(l) as T)
    : [];
type Answer = {
  part: string;
  photo: string;
  key: string;
  model: string;
  candidates?: string[];
  result: unknown;
};
const answers = lines<Answer>(join(target, 'answers.jsonl'));
const gemmaJson = (a?: { result: unknown }) => {
  const text = (a?.result as { choices?: { message?: { content?: string } }[] } | undefined)?.choices?.[0]
    ?.message?.content;
  try {
    return text ? (JSON.parse(text) as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
};
type Photo = {
  id: string;
  split: string;
  candidates: { kind: string; box: Box }[];
  truth?: { id: string; kind: string; box: Box; wall: string }[];
  reflections?: { box: Box }[];
};
const index = readJson<{ heldoutOpened: boolean; photos: Photo[] }>(join(out, 'photos', 'index.json'));
if (!index.heldoutOpened) throw new Error('run photos.mjs --heldout first');
const photos = index.photos.filter((p) => p.split === 'heldout');
const PRODUCT = new Set(['toilet', 'basin', 'vanity', 'bath']);
const kindOf = (kind: string) =>
  kind === 'vanity' || kind === 'sink' ? 'basin' : kind === 'bathtub' ? 'bath' : kind;
const tally = <T>(rows: T[], key: (row: T) => string) =>
  Object.fromEntries(
    Object.entries(
      rows.reduce<Record<string, number>>((t, row) => ((t[key(row)] = (t[key(row)] ?? 0) + 1), t), {}),
    ).sort((x, y) => y[1] - x[1]),
  );
const summary: Record<string, unknown> = { photos: photos.length };

// ---------- boxes ----------
{
  const rows: Record<string, { hits: number; misses: number; extras: number; onReflection: number }> = {};
  const add = (name: string, photo: Photo, predicted: { kind: string; box: Box }[]) => {
    const truth = (photo.truth ?? [])
      .filter((t) => PRODUCT.has(t.kind))
      .map((t) => ({ ...t, kind: kindOf(t.kind) }));
    const m = matchBoxes(
      truth,
      predicted.map((p) => ({ ...p, kind: kindOf(p.kind) })).filter((p) => PRODUCT.has(p.kind)),
      0.5,
    );
    const row = (rows[name] ??= { hits: 0, misses: 0, extras: 0, onReflection: 0 });
    row.hits += m.hits.length;
    row.misses += m.misses.length;
    row.extras += m.extras.length;
    row.onReflection += m.extras.filter((e) =>
      (photo.reflections ?? []).some(
        (r) => matchBoxes([{ kind: 'x', box: r.box }], [{ kind: 'x', box: e.box }], 0.3).hits.length,
      ),
    ).length;
  };
  let answered = 0;
  for (const photo of photos) {
    add('deeplab-2026-09-13', photo, photo.candidates);
    const items = gemmaJson(answers.find((a) => a.part === 'boxes' && a.photo === photo.id))?.items as
      { kind: string; bbox_2d: number[] }[] | undefined;
    if (!items) continue;
    answered++;
    add(
      'gemma',
      photo,
      items.map((i) => ({ kind: i.kind, box: gemmaBox(i.bbox_2d) })),
    );
  }
  summary.boxes = { answered, ...rows };
}

// ---------- position ----------
{
  const thirdU: Record<string, number> = { left: 1 / 6, middle: 0.5, right: 5 / 6 };
  let products = 0,
    same = 0,
    missing = 0;
  for (const photo of photos) {
    const truth = (photo.truth ?? [])
      .filter((t) => PRODUCT.has(t.kind))
      .map((t) => ({
        id: t.id,
        wall: ['back', 'left', 'right'].includes(t.wall) ? (t.wall as Wall) : ('unknown' as const),
      }));
    const a = answers.find((x) => x.part === 'position' && x.photo === photo.id && x.model === 'gemma');
    const guesses: PlacedGuess[] = [];
    for (const item of (gemmaJson(a)?.items as { box: number; wall: Wall; third: string }[] | undefined) ??
      []) {
      const id = a?.candidates?.[item.box - 1];
      if (id) guesses.push({ id, wall: item.wall, u: thirdU[item.third] ?? 0.5 });
    }
    const s = positionScore(truth, guesses);
    products += s.known;
    same += s.sameWall * s.known;
    missing += s.missing;
  }
  summary.position = { products, sameWall: products ? Math.round((100 * same) / products) : null, missing };
}

// ---------- colour ----------
{
  const STRONG = new Set(['blue', 'green', 'yellow', 'pink', 'other']);
  const queries = readJson<{ id: string; kind: string }[]>(
    join(out, 'features', 'products-heldout', 'queries.json'),
  );
  const rows = queries.map((q) => {
    const colour = gemmaJson(answers.find((a) => a.part === 'colour' && a.key === q.id))?.colour;
    return { kind: q.kind, colour: colour === undefined ? 'no answer' : String(colour) };
  });
  summary.colour = Object.fromEntries(
    [...new Set(rows.map((r) => r.kind))].map((kind) => {
      const of = rows.filter((r) => r.kind === kind);
      return [
        kind,
        {
          n: of.length,
          turnedAway: of.filter((r) => STRONG.has(r.colour)).length,
          colours: tally(of, (r) => r.colour),
        },
      ];
    }),
  );
}

// ---------- ③ check ----------
{
  const corpus = readJson<{
    cases: {
      id: string;
      annotation: { fixtures: { bounds: number[] }[]; ignore?: { bounds: number[] }[] };
    }[];
  }>(join(ROOT as string, 'tests', 'fixtures', 'reconstruction-corpus-v1.json'));
  const box = (b: number[]): Box => ({ left: b[0], top: b[1], right: b[2], bottom: b[3] });
  const boxesOf = new Map(
    corpus.cases.map((c) => [
      c.id,
      [
        ...c.annotation.fixtures.map((f) => box(f.bounds)),
        ...(c.annotation.ignore ?? []).map((i) => box(i.bounds)),
      ],
    ]),
  );
  const faces = readJson<{ id: string; photo: string; regions: { clean?: { quad: Quad } } }[]>(
    join(out, 'features', 'queries-heldout-q8', 'faces.json'),
  ).filter((f) => f.regions.clean);
  const calls = lines<{ photo: string; faces: string[]; neurons: number; result: unknown }>(
    join(out, 'r9-inspect', 'answers-heldout.jsonl'),
  );
  const checks = new Map<string, Inspection>();
  let formatErrors = 0;
  for (const a of calls) {
    const pieces = gemmaJson(a)?.pieces as (Inspection & { number: number })[] | undefined;
    if (!pieces || pieces.length !== a.faces.length) formatErrors++;
    for (const p of pieces ?? [])
      if (a.faces[p.number - 1]) checks.set(`${a.photo}:${a.faces[p.number - 1]}`, p);
  }
  const rows = faces
    .filter((f) => checks.has(f.id))
    .map((f) => ({
      check: checks.get(f.id)!,
      overlap: overlapShare(f.regions.clean!.quad, boxesOf.get(f.photo) ?? []),
    }));
  const half = rows.filter((r) => r.overlap > 0.5);
  const clear = rows.filter((r) => r.overlap === 0);
  summary.check = {
    calls: calls.length,
    formatErrors,
    neuronsPerPhoto: calls.length
      ? Math.round((10 * calls.reduce((s, a) => s + (a.neurons ?? 0), 0)) / calls.length) / 10
      : null,
    pieces: rows.length,
    notTile: rows.filter((r) => notTile(r.check)).length,
    dirty: rows.filter((r) => dirty(r.check)).length,
    halfInsideBoxes: half.length,
    caught: half.filter((r) => notTile(r.check)).length,
    clearOfBoxes: clear.length,
    calledNotTile: clear.filter((r) => notTile(r.check)).length,
    content: tally(rows, (r) => `${r.check.content}/${r.check.tile_visible}`),
  };
}

// ---------- ④ rule ----------
{
  const file = join(out, 'r9-inspect', 'report-heldout.json');
  if (existsSync(file)) {
    const faces = readJson<{ faces: { before: string; after: string; mode: string; confidence: string }[] }>(
      file,
    ).faces;
    summary.rule = {
      faces: faces.length,
      changed: faces.filter((f) => f.before !== f.after).length,
      modes: tally(faces, (f) => f.mode),
      confidence: tally(faces, (f) => f.confidence),
    };
  }
}

// ---------- cost ----------
{
  const ledger = lines<{ round: string; task: string; neurons?: number; status: number | string }>(
    join(out, 'ledger.jsonl'),
  ).filter((r) => r.round === 'r7');
  const total = ledger.reduce((s, r) => s + (r.neurons ?? 0), 0);
  summary.cost = {
    calls: ledger.length,
    failed: ledger.filter((r) => r.status !== 200).length,
    neurons: Math.round(total),
    perPhoto: photos.length ? Math.round((10 * total) / photos.length) / 10 : null,
    byTask: Object.fromEntries(
      [...new Set(ledger.map((r) => r.task))].map((task) => [
        task,
        Math.round(ledger.filter((r) => r.task === task).reduce((s, r) => s + (r.neurons ?? 0), 0)),
      ]),
    ),
  };
}
writeFileSync(join(target, 'summary.json'), JSON.stringify(summary, null, 1));
console.log(JSON.stringify(summary, null, 1));
