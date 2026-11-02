/**
 * Round 4 scoring (no AI call): reads r4-ai/answers.jsonl and scores what has an answer.
 *
 *   boxes     development photos vs the annotation (IoU ≥ 0.5 by kind): saved DeepLab (2026-09-13),
 *             Gemma (new), Moondream; extras that sit on an annotated reflection are counted apart
 *   synth     board picks on synthetic faces vs the answer, against the board's own first place
 *             (the model-free method); method 10: Gemma's colour name as a filter
 *   order     the same board in three orders: is the same tile / product chosen
 *   products  "no match" on the two known misfits, false "no match" elsewhere, form vs annotation
 *   position  wall and third vs the annotation (development) and the draft (fifteen), and
 *             combinations with the model-free face-above and MoGe answers of round 2
 *
 * Usage: node tests/run-browser-test.mjs tests/catalog-match/r4-score.ts
 * Output: test-results/catalog-match/r4-ai/summary.json
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { out, readJson } from './data';
import { COLOURS } from './questions';
import {
  gemmaBox,
  matchBoxes,
  patternNeighbours,
  positionScore,
  type Box,
  type PlacedGuess,
  type PlacedTruth,
  type Wall,
} from './score';
import { SNAPSHOT } from './paths.mjs';

const answersFile = join(out, 'r4-ai', 'answers.jsonl');
type Answer = {
  part: string;
  photo: string;
  key: string;
  model: string;
  task: string;
  candidates?: string[];
  answer?: string;
  neurons: number;
  result: Record<string, unknown>;
};
const answers: Answer[] = existsSync(answersFile)
  ? readFileSync(answersFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  : [];
/** Gemma's JSON answer, or undefined. */
function gemmaJson(a: Answer): Record<string, unknown> | undefined {
  const r = a.result as { choices?: { message?: { content?: string } }[]; response?: string };
  const text = r.choices?.[0]?.message?.content ?? r.response;
  if (typeof text !== 'string')
    return typeof text === 'object' ? (text as Record<string, unknown>) : undefined;
  try {
    return JSON.parse(text.replace(/^```(json)?|```$/g, '').trim());
  } catch {
    return undefined;
  }
}
const clefAnswer = (a: Answer, id: string) =>
  (
    a.result as {
      answers?: Record<
        string,
        { choice: string; confidence: number; probabilities?: Record<string, number> }
      >;
    }
  ).answers?.[id];
/** The chosen candidate id (or 'none'), whatever the model. */
function choiceOf(a: Answer, question: 'tile' | 'product'): string | undefined {
  const pick =
    a.model === 'gemma'
      ? Number(gemmaJson(a)?.choice)
      : (() => {
          const c = clefAnswer(a, question)?.choice;
          return c === undefined ? NaN : c === 'none' ? 0 : Number(c);
        })();
  if (!Number.isFinite(pick)) return undefined;
  return pick === 0 ? 'none' : a.candidates?.[pick - 1];
}
const summary: Record<string, unknown> = { answers: answers.length };
const neurons = new Map<string, number>();
for (const a of answers)
  neurons.set(`${a.part}|${a.model}`, (neurons.get(`${a.part}|${a.model}`) ?? 0) + a.neurons);
summary.neurons = Object.fromEntries([...neurons].map(([k, v]) => [k, Math.round(v * 10) / 10]));

type Photo = {
  id: string;
  split: string;
  locked?: boolean;
  candidates: { id?: string; kind: string; box: Box; source?: string }[];
  truth?: { id: string; kind: string; box: Box; wall: string }[];
  reflections?: { box: Box }[];
};
const index = readJson<{ photos: Photo[] }>(join(out, 'photos', 'index.json'));
const PRODUCT = new Set(['toilet', 'basin', 'vanity', 'bath']);
const kindOf = (kind: string) =>
  kind === 'vanity' || kind === 'sink' ? 'basin' : kind === 'bathtub' ? 'bath' : kind;

// ---------- boxes ----------
{
  const methods: Record<
    string,
    { hits: number; misses: number; extras: number; onReflection: number; photos: number }
  > = {};
  const add = (name: string, photo: Photo, predicted: { kind: string; box: Box }[]) => {
    const truth = (photo.truth ?? [])
      .filter((t) => PRODUCT.has(t.kind))
      .map((t) => ({ ...t, kind: kindOf(t.kind) }));
    const m = matchBoxes(
      truth,
      predicted.map((p) => ({ ...p, kind: kindOf(p.kind) })).filter((p) => PRODUCT.has(p.kind)),
      0.5,
    );
    const row = (methods[name] ??= { hits: 0, misses: 0, extras: 0, onReflection: 0, photos: 0 });
    row.photos++;
    row.hits += m.hits.length;
    row.misses += m.misses.length;
    row.extras += m.extras.length;
    row.onReflection += m.extras.filter((e) =>
      (photo.reflections ?? []).some(
        (r) => matchBoxes([{ kind: 'x', box: r.box }], [{ kind: 'x', box: e.box }], 0.3).hits.length,
      ),
    ).length;
  };
  for (const photo of index.photos.filter((p) => p.split === 'corpus-dev')) {
    add('deeplab-2026-09-13', photo, photo.candidates);
    const gemma = answers.find((a) => a.part === 'boxes' && a.photo === photo.id && a.model === 'gemma');
    const items =
      (gemma && (gemmaJson(gemma)?.items as { kind: string; bbox_2d: number[] }[] | undefined)) ?? undefined;
    if (items)
      add(
        'gemma',
        photo,
        items.map((i) => ({ kind: i.kind, box: gemmaBox(i.bbox_2d) })),
      );
    const moon = answers.filter((a) => a.part === 'boxes' && a.photo === photo.id && a.model === 'moondream');
    if (moon.length === 3) {
      const boxes = moon.flatMap((a) =>
        (
          (
            a.result as {
              result?: { objects?: { x_min: number; y_min: number; x_max: number; y_max: number }[] };
            }
          ).result?.objects ?? []
        ).map((o) => ({
          kind: a.task.replace('detect-', ''),
          box: { left: o.x_min, top: o.y_min, right: o.x_max, bottom: o.y_max },
        })),
      );
      add('moondream', photo, boxes);
    }
  }
  summary.boxes = methods;
}

// ---------- synthetic boards and method 10 ----------
{
  const snapshot = readJson<{ placements: { materialId: string; color: string }[] }>(
    join(SNAPSHOT, 'catalog.json'),
  );
  const colourOf = new Map(snapshot.placements.map((p) => [p.materialId, p.color]));
  const groups = readJson<{ pairs: [string, string][] }>(join(out, 'features', 'catalog', 'groups.json'));
  const same = patternNeighbours([...colourOf.keys()], groups.pairs);
  const synth = answers.filter((a) => a.part === 'synth');
  const table: Record<string, { n: number; strict: number; pattern: number; none: number; inBoard: number }> =
    {};
  const row = (name: string) => (table[name] ??= { n: 0, strict: 0, pattern: 0, none: 0, inBoard: 0 });
  const keys = [...new Set(synth.map((a) => a.key))];
  for (const key of keys) {
    const some = synth.find((a) => a.key === key)!;
    const answer = some.answer!;
    const candidates = some.candidates!;
    const inBoard = candidates.some((c) => same.get(answer)?.has(c));
    const score = (name: string, pick: string | undefined) => {
      const r = row(name);
      r.n++;
      if (inBoard) r.inBoard++;
      if (pick === 'none') r.none++;
      if (pick === answer) r.strict++;
      if (pick && pick !== 'none' && same.get(answer)?.has(pick)) r.pattern++;
    };
    score('board first place (model-free)', candidates[0]);
    for (const a of synth.filter((x) => x.key === key)) score(a.model, choiceOf(a, 'tile'));
    // Method 10: the first candidate whose registered colour has Gemma's colour name.
    const gemma = synth.find((x) => x.key === key && x.model === 'gemma');
    const colour = gemma && COLOURS[String(gemmaJson(gemma)?.colour)];
    if (colour)
      score(
        'method 10: gemma colour filter → first place',
        candidates.find((c) => colourOf.get(c)?.includes(colour)) ?? candidates[0],
      );
  }
  summary.synth = table;
}

// ---------- order ----------
{
  const result: Record<string, { stable: number; n: number; picks: string[][] }> = {};
  for (const a of answers.filter((x) => x.part === 'order')) {
    const base = a.key.split('#')[0];
    const original = answers.find(
      (x) => (x.part === 'tiles' || x.part === 'products') && x.key === base && x.model === a.model,
    );
    const shuffles = answers.filter(
      (x) => x.part === 'order' && x.key.startsWith(base + '#') && x.model === a.model,
    );
    if (!original || shuffles.length < 2 || a !== shuffles[0]) continue;
    const question = original.part === 'tiles' ? 'tile' : 'product';
    const picks = [original, ...shuffles].map((x) => choiceOf(x, question) ?? '?');
    const r = (result[`${a.model}|${question}`] ??= { stable: 0, n: 0, picks: [] });
    r.n++;
    if (picks.every((p) => p === picks[0])) r.stable++;
    r.picks.push(picks);
  }
  summary.order = result;
}

// ---------- products ----------
{
  const draft = readJson<{ photos: Record<string, { id: string; kind: string; noMatch?: string }[]> }>(
    join(out, 'truth', 'fifteen-draft.json'),
  );
  const misfits = new Set(['pc-04|toilet', 'remote-02|basin']);
  // The criterion: white toilets wrongly turned away (every public toilet is white). Other kinds are
  // shown apart: the catalogue has one test bath and no vanity, so 'none' may be right for them.
  const queries = readJson<{ id: string; kind: string }[]>(join(out, 'features', 'products', 'queries.json'));
  const table: Record<string, Record<string, { none: number; n: number }>> = {};
  for (const a of answers.filter((x) => x.part === 'products')) {
    const [photo] = a.key.split(':');
    const kind = queries.find((q) => q.id === a.key)?.kind ?? 'unknown';
    const group =
      misfits.has(`${photo}|${kind}`) && draft.photos[photo]
        ? 'misfit (teal toilet, yellow basin)'
        : kind === 'toilet'
          ? 'white toilet'
          : kind;
    const r = ((table[a.model] ??= {})[group] ??= { none: 0, n: 0 });
    r.n++;
    if (choiceOf(a, 'product') === 'none') r.none++;
  }
  summary.products = table;
  // The basin's form against the annotation (development) and the draft (fifteen), where either says one.
  const fifteenDraft = readJson<{ photos: Record<string, { id: string; kind: string; shape: string }[]> }>(
    join(out, 'truth', 'fifteen-draft.json'),
  );
  const formOf = (text: string) =>
    /vanity/.test(text)
      ? 'vanity'
      : /pedestal/.test(text)
        ? 'pedestal'
        : /vessel|counter/.test(text)
          ? 'vessel'
          : /wall/.test(text)
            ? 'wall-hung'
            : undefined;
  const forms: Record<string, { right: number; n: number }> = {};
  for (const a of answers.filter((x) => x.part === 'products')) {
    const [photo, item] = a.key.split(':');
    const p = index.photos.find((x) => x.id === photo)!;
    let truth: string | undefined;
    if (p.split === 'corpus-dev') {
      const t = (p.truth ?? []).find((x) => x.id === item) as
        { kind: string; basinVariant?: string } | undefined;
      if (t && (t.kind === 'basin' || t.kind === 'vanity'))
        truth = formOf(t.kind === 'vanity' ? 'vanity' : (t.basinVariant ?? ''));
    } else {
      const kind = queries.find((q) => q.id === a.key)?.kind;
      if (kind === 'basin') {
        const basins = fifteenDraft.photos[photo]?.filter((d) => d.kind === 'basin') ?? [];
        if (basins.length === 1) truth = formOf(basins[0].shape);
      }
    }
    if (!truth) continue;
    const said =
      a.model === 'gemma' ? String(gemmaJson(a)?.form ?? '') : (clefAnswer(a, 'form')?.choice ?? '');
    const r = (forms[a.model] ??= { right: 0, n: 0 });
    r.n++;
    if (said === truth) r.right++;
  }
  summary.basinForm = forms;
}

// ---------- position ----------
{
  const draft = readJson<{
    photos: Record<string, { id: string; kind: string; wall: Wall; third: string | null }[]>;
  }>(join(out, 'truth', 'fifteen-draft.json'));
  const r2 = readJson<Record<string, Record<string, PlacedGuess[]>>>(
    join(out, 'r2-position', 'guesses.json'),
  );
  const thirdU: Record<string, number> = { left: 1 / 6, middle: 0.5, right: 5 / 6 };
  const results: Record<string, Record<string, ReturnType<typeof positionScore>[]>> = {};
  for (const photo of index.photos.filter((p) => !p.locked && p.split !== 'heldout')) {
    let truth: PlacedTruth[];
    if (photo.split === 'corpus-dev')
      truth = (photo.truth ?? [])
        .filter((t) => PRODUCT.has(t.kind))
        .map((t) => ({
          id: t.id,
          wall: ['back', 'left', 'right'].includes(t.wall) ? (t.wall as Wall) : 'unknown',
        }));
    else
      truth = (draft.photos[photo.id] ?? []).map((d) => ({
        id: d.id,
        wall: d.wall,
        u: d.third ? thirdU[d.third] : undefined,
      }));
    const guesses: Record<string, PlacedGuess[]> = {};
    for (const a of answers.filter((x) => x.part === 'position' && x.photo === photo.id)) {
      const boxIds = a.candidates ?? [];
      // Fifteen: the asked boxes are the saved candidates; their answers meet the draft by kind order (as round 2).
      const mapId = (i: number) => (photo.split === 'corpus-dev' ? boxIds[i] : r2Map(photo, boxIds[i]));
      const items: PlacedGuess[] = [];
      if (a.model === 'gemma')
        for (const item of (gemmaJson(a)?.items as
          { box: number; wall: Wall; third: string }[] | undefined) ?? []) {
          const id = mapId(item.box - 1);
          if (id) items.push({ id, wall: item.wall, u: thirdU[item.third] ?? 0.5 });
        }
      else
        boxIds.forEach((_, i) => {
          const wall = clefAnswer(a, `wall_${i + 1}`)?.choice as Wall | undefined,
            third = clefAnswer(a, `third_${i + 1}`)?.choice;
          const id = mapId(i);
          if (id && wall) items.push({ id, wall, u: thirdU[third ?? 'middle'] });
        });
      guesses[a.model] = items;
    }
    for (const m of ['face-above', 'moge']) if (r2[photo.id]?.[m]) guesses[m] = r2[photo.id][m];
    // Combination: Gemma, unless face-above and MoGe agree against it.
    if (guesses.gemma)
      guesses['gemma+agreement'] = guesses.gemma.map((g) => {
        const f = guesses['face-above']?.find((x) => x.id === g.id),
          m = guesses.moge?.find((x) => x.id === g.id);
        return f && m && f.wall === m.wall && f.wall !== g.wall ? { ...g, wall: f.wall } : g;
      });
    for (const [name, g] of Object.entries(guesses)) {
      const s = positionScore(truth, g);
      if (photo.split === 'corpus-dev') s.sameThird = undefined;
      ((results[photo.split] ??= {})[name] ??= []).push(s);
    }
  }
  const total = (rows: ReturnType<typeof positionScore>[]) => {
    const known = rows.reduce((s, r) => s + r.known, 0);
    const third = rows.filter((r) => r.sameThird !== undefined);
    return {
      products: known,
      sameWall: known ? rows.reduce((s, r) => s + r.sameWall * r.known, 0) / known : 0,
      noAnswer: rows.reduce((s, r) => s + r.missing, 0),
      sameThird: third.length ? third.reduce((s, r) => s + r.sameThird!, 0) / third.length : null,
    };
  };
  summary.position = Object.fromEntries(
    Object.entries(results).map(([split, byMethod]) => [
      split,
      Object.fromEntries(Object.entries(byMethod).map(([m, rows]) => [m, total(rows)])),
    ]),
  );
}
/** Fifteen: a saved candidate's id → the draft answer's id (by kind, left to right), as round 2 did. */
function r2Map(photo: Photo, candidateId: string): string | undefined {
  const draft =
    readJson<{ photos: Record<string, { id: string; kind: string }[]> }>(
      join(out, 'truth', 'fifteen-draft.json'),
    ).photos[photo.id] ?? [];
  const candidates = photo.candidates
    .map((c, i) => ({ ...c, id: c.id ?? `c${i}` }))
    .filter((c) => PRODUCT.has(c.kind));
  const candidate = candidates.find((c) => c.id === candidateId);
  if (!candidate) return;
  const kind = kindOf(candidate.kind);
  const same = candidates
    .filter((c) => kindOf(c.kind) === kind)
    .sort((a, b) => (a.box.left + a.box.right) / 2 - (b.box.left + b.box.right) / 2);
  return draft.filter((d) => d.kind === kind)[same.indexOf(candidate)]?.id;
}

writeFileSync(join(out, 'r4-ai', 'summary.json'), JSON.stringify(summary, null, 1));
console.log(JSON.stringify(summary, (key, value) => (key === 'picks' ? undefined : value), 1));
