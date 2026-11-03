/**
 * Round 9's scores against the criteria written before it ran (docs/catalog-match-trials-20261102.md
 * §3). Each part is scored when its data is there:
 *
 *   ② pieces   development photos: pieces more than 10% inside an annotated box (doors, windows, mirrors,
 *              glass, shelves, products and the annotation's `ignore` boxes), now and after ②; faces
 *              that lose their usable piece (300 × 300 mm); the fifteen: the user's "tile only" rate
 *   ③ check    the fifteen against the user's marks; the development photos against the boxes
 *   ④ picks    the user's ratings of the picks that changed, and the round 5 thirty faces
 *
 * The annotation and the user's marks are read here only, never by an AI call or a per-photo branch.
 *
 * Usage: node tests/run-browser-test.mjs tests/catalog-match/r9-score.ts
 * Output: test-results/catalog-match/r9-inspect/summary.json
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { out, readJson } from './data';
import { dirty, notTile, overlapShare, rectIou, type Inspection } from './inspect';
import { ROOT } from './paths.mjs';
import { cleanRectangle, type Box, type Quad, type UvRect } from './tile-features';

type Region = { quad: Quad; mm: { widthMm: number; heightMm: number }; uv?: UvRect };
type Face = { id: string; photo: string; split: string; face: string; regions: { clean?: Region } };
const target = join(out, 'r9-inspect');
mkdirSync(target, { recursive: true });
const before = readJson<Face[]>(join(out, 'features', 'queries-photos-q8', 'faces.json'));
const after = readJson<Face[]>(join(out, 'features', 'queries-photos-r9', 'faces.json'));
const beforeOf = new Map(before.map((f) => [f.id, f]));
const index = readJson<{
  photos: { id: string; split: string; planes: { face: string; quad: Quad }[]; candidates: { box: Box }[] }[];
}>(join(out, 'photos', 'index.json'));
const usable = (r?: Region) => !!r && r.mm.widthMm >= 300 && r.mm.heightMm >= 300;
const box = (b: number[]): Box => ({ left: b[0], top: b[1], right: b[2], bottom: b[3] });
const corpus = readJson<{
  cases: {
    id: string;
    split: string;
    annotation: { fixtures: { bounds: number[] }[]; ignore?: { bounds: number[] }[] };
  }[];
}>(join(ROOT as string, 'tests', 'fixtures', 'reconstruction-corpus-v1.json'));
/** Everything annotated that is not wall or floor tile. */
const notTileBoxes = new Map(
  corpus.cases.map((c) => [
    c.id,
    [
      ...c.annotation.fixtures.map((f) => box(f.bounds)),
      ...(c.annotation.ignore ?? []).map((i) => box(i.bounds)),
    ],
  ]),
);
const pct = (n: number, d: number) => (d ? Math.round((100 * n) / d) : null);
const summary: Record<string, unknown> = {};

// ---------- ② pieces ----------
{
  const rows = after.map((f) => {
    const was = beforeOf.get(f.id)?.regions.clean;
    const now = f.regions.clean;
    const boxes = notTileBoxes.get(f.photo);
    const p = index.photos.find((x) => x.id === f.photo)!;
    const plane = p.planes.find((x) => x.face === f.face)!;
    const wasUv = cleanRectangle(
      plane.quad,
      p.candidates.map((c) => c.box),
    );
    return {
      id: f.id,
      split: f.split,
      wasUsable: usable(was),
      nowUsable: usable(now),
      changed: !now || !wasUv || !now.uv || rectIou(now.uv, wasUv) < 0.8,
      overlapBefore: boxes && was ? overlapShare(was.quad, boxes) : undefined,
      overlapAfter: boxes && now ? overlapShare(now.quad, boxes) : undefined,
    };
  });
  const dev = rows.filter((r) => r.split === 'corpus-dev');
  const over = (key: 'overlapBefore' | 'overlapAfter') => dev.filter((r) => (r[key] ?? 0) > 0.1).length;
  const lost = rows.filter((r) => r.wasUsable && !r.nowUsable);
  summary.pieces = {
    faces: rows.length,
    usableBefore: rows.filter((r) => r.wasUsable).length,
    usableAfter: rows.filter((r) => r.nowUsable).length,
    lost: lost.length,
    lostShare: pct(lost.length, rows.length),
    lostIds: lost.map((r) => r.id),
    changed: rows.filter((r) => r.changed).length,
    changedFifteen: rows.filter((r) => r.changed && r.split === 'fifteen').length,
    dev: {
      faces: dev.length,
      over10Before: over('overlapBefore'),
      over10After: over('overlapAfter'),
      reduction: pct(over('overlapBefore') - over('overlapAfter'), over('overlapBefore')),
      meanOverlapBefore: pct(
        dev.reduce((s, r) => s + (r.overlapBefore ?? 0), 0),
        dev.filter((r) => r.overlapBefore !== undefined).length,
      ),
      meanOverlapAfter: pct(
        dev.reduce((s, r) => s + (r.overlapAfter ?? 0), 0),
        dev.filter((r) => r.overlapAfter !== undefined).length,
      ),
      lostFacesOver10Before: dev.filter((r) => r.wasUsable && !r.nowUsable && (r.overlapBefore ?? 0) > 0.1)
        .length,
    },
  };
  writeFileSync(join(target, 'pieces.json'), JSON.stringify(rows, null, 1));
}

// ---------- the user's marks (the fifteen) ----------
type Mark = {
  item: string;
  /** tile-only / some-other / mostly-other */
  only?: string;
  others?: string[];
  state?: string;
  pattern?: string;
};
const marksFile = join(out, 'review-r9', 'ratings.jsonl');
const marks = new Map<string, Mark>();
const ratings: { item: string; candidate?: string; value?: number; section: string }[] = [];
if (existsSync(marksFile))
  for (const line of readFileSync(marksFile, 'utf8').split(/\r?\n/)) {
    if (!line) continue;
    const row = JSON.parse(line);
    if (row.section === 'inspect' && row.only) marks.set(row.item, row);
    if (row.section === 'tile' && row.value) ratings.push(row);
  }
// ---------- ③ check (today's pieces: ② was not adopted, 2026-11-03) ----------
const answers = readFileSync(join(target, 'answers-now.jsonl'), 'utf8')
  .split(/\r?\n/)
  .filter(Boolean)
  .map((l) => JSON.parse(l) as { photo: string; faces: string[]; neurons: number; result: unknown });
const checks = new Map<string, Inspection>();
let formatErrors = 0;
for (const a of answers) {
  try {
    const content = (a.result as { choices: { message: { content: string } }[] }).choices[0].message.content;
    const pieces = (JSON.parse(content) as { pieces: (Inspection & { number: number })[] }).pieces;
    if (pieces.length !== a.faces.length) formatErrors++;
    for (const p of pieces) if (a.faces[p.number - 1]) checks.set(`${a.photo}:${a.faces[p.number - 1]}`, p);
  } catch {
    formatErrors++;
  }
}
const tally = <T>(rows: T[], key: (row: T) => string) =>
  Object.entries(
    rows.reduce<Record<string, number>>((t, row) => ((t[key(row)] = (t[key(row)] ?? 0) + 1), t), {}),
  ).sort((x, y) => y[1] - x[1]);
const check: Record<string, unknown> = {
  calls: answers.length,
  formatErrors,
  neuronsPerPhoto: Math.round((10 * answers.reduce((s, a) => s + (a.neurons ?? 0), 0)) / answers.length) / 10,
  pieces: checks.size,
  notTile: [...checks.values()].filter(notTile).length,
  dirty: [...checks.values()].filter(dirty).length,
};
summary.check = check;
// Development photos: Gemma's "not tile" against the boxes (a piece more than half inside one).
{
  const pieces = readJson<{ id: string; split: string; overlapBefore?: number }[]>(
    join(target, 'pieces.json'),
  );
  const dev = pieces.filter(
    (p) => p.split === 'corpus-dev' && checks.has(p.id) && p.overlapBefore !== undefined,
  );
  check.dev = {
    pieces: dev.length,
    halfInsideBoxes: dev.filter((p) => p.overlapBefore! > 0.5).length,
    caught: dev.filter((p) => p.overlapBefore! > 0.5 && notTile(checks.get(p.id)!)).length,
    clearOfBoxes: dev.filter((p) => p.overlapBefore === 0).length,
    calledNotTile: dev.filter((p) => p.overlapBefore === 0 && notTile(checks.get(p.id)!)).length,
  };
}
// The fifteen against the user's marks.
if (marks.size) {
  const pairs = before
    .filter((f) => f.split === 'fifteen')
    .map((f) => ({ f, mark: marks.get(`inspect:now:${f.id}`), check: checks.get(f.id) }))
    .filter((x): x is { f: Face; mark: Mark; check: Inspection } => !!x.mark && !!x.check);
  const mostly = pairs.filter((x) => x.mark.only === 'mostly-other');
  const tileOnly = pairs.filter((x) => x.mark.only === 'tile-only');
  const userClean = pairs.filter((x) => x.mark.state === 'clean');
  const stated = pairs.filter((x) => x.mark.state && x.mark.state !== 'unknown');
  Object.assign(check, {
    pairs: pairs.length,
    userTileOnly: tileOnly.length,
    userSomeOther: pairs.filter((x) => x.mark.only === 'some-other').length,
    userMostlyOther: mostly.length,
    notTileRecall: { caught: mostly.filter((x) => notTile(x.check)).length, of: mostly.length },
    notTileFalse: { wrong: tileOnly.filter((x) => notTile(x.check)).length, of: tileOnly.length },
    dirtyAgree: {
      same: stated.filter((x) => dirty(x.check) === (x.mark.state !== 'clean')).length,
      of: stated.length,
    },
    dirtyFalse: { wrong: userClean.filter((x) => dirty(x.check)).length, of: userClean.length },
    userDirty: pairs.filter((x) => x.mark.state === 'slightly-dirty' || x.mark.state === 'very-dirty').length,
    userOthers: tally(
      pairs.flatMap((x) => x.mark.others ?? []),
      (o) => o,
    ),
    onlyVsContent: tally(pairs, (x) => `${x.mark.only} → ${x.check.content}/${x.check.tile_visible}`),
    stateVsMarks: tally(
      pairs,
      (x) => `${x.mark.pattern}/${x.mark.state} → ${x.check.state}/${x.check.marks}`,
    ),
  });
}

// ---------- ④ picks ----------
const reportFile = join(target, 'report.json');
if (ratings.length && existsSync(reportFile)) {
  const report = readJson<{ faces: { id: string; before: string; after: string }[] }>(reportFile);
  const old = readFileSync(join(out, 'review', 'ratings.jsonl'), 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { item: string; candidate?: string; value?: number });
  const value = (rows: { item: string; candidate?: string; value?: number }[], face: string, tile: string) =>
    rows.filter((r) => r.item === `tile:${face}` && r.candidate === tile && r.value).at(-1)?.value;
  const rated = (face: string, tile: string) => value(ratings, face, tile) ?? value(old, face, tile);
  const thirty = new Set(
    old.filter((r) => r.item.startsWith('tile:') && r.value).map((r) => r.item.replace('tile:', '')),
  );
  const changed = report.faces.filter((f) => f.before !== f.after && thirty.has(f.id));
  let better = 0,
    worse = 0,
    same = 0,
    missing = 0;
  for (const f of changed) {
    const a = rated(f.id, f.before),
      b = rated(f.id, f.after);
    if (!a || !b) missing++;
    else if (b < a) better++;
    else if (b > a) worse++;
    else same++;
  }
  const similar = (key: 'before' | 'after') =>
    report.faces.filter((f) => thirty.has(f.id) && rated(f.id, f[key]) === 1).length;
  summary.picks = {
    thirty: thirty.size,
    changed: changed.length,
    better,
    worse,
    same,
    missing,
    net: better - worse,
    similarBefore: { n: similar('before'), pct: pct(similar('before'), thirty.size) },
    similarAfter: { n: similar('after'), pct: pct(similar('after'), thirty.size) },
  };
}
writeFileSync(join(target, 'summary.json'), JSON.stringify(summary, null, 1));
console.log(JSON.stringify(summary, null, 1));
