/**
 * Round 2 (no AI call): which wall each product stands against and where along it, by methods that
 * need no new AI answer, scored against the development photos' annotation (installation wall) and the
 * fifteen photos' draft answers (to be confirmed by the user in round 5).
 *
 *   baseline   every product on the back wall, in the photo's left-to-right order
 *   rule       the 2026-09-13 DeepLab analysis's installation wall (development photos)
 *   layout     the saved Gemma `layout` answer (fifteen photos, 2026-09-16)
 *   placement  the saved precise analysis's placement (`placementReview.requested`, fifteen photos)
 *   face-above the photo's face (the saved DeepLab faces) just above the product: no model at all
 *   moge       MoGe's wall planes, no camera fit: the first wall (inside every other plane) that the ray
 *              just above the product meets — the wall seen right behind it
 *
 * Products: toilets, basins (vanities) and baths. Positions along a wall go left to right as the photo
 * shows the wall, so the image x inside the wall's face is the place along it.
 *
 * Usage: node tests/run-browser-test.mjs tests/catalog-match/r2-position.ts
 * Output: test-results/catalog-match/r2-position/{summary.json,guesses.json}
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { out, readJson } from './data';
import { FIFTEEN_RUN } from './paths.mjs';
import { matchBoxes, positionScore, type Box, type PlacedGuess, type PlacedTruth, type Wall } from './score';

const target = join(out, 'r2-position');
mkdirSync(target, { recursive: true });
type Photo = {
  id: string;
  split: string;
  locked?: boolean;
  planes: { face: string; quad: { x: number; y: number }[] }[];
  candidates: {
    id?: string;
    kind: string;
    box: Box;
    wall?: string | null;
    mode?: string | null;
    requested?: { face: string; u: number; v: number } | null;
    foot?: { x: number; y: number } | null;
  }[];
  truth?: { id: string; kind: string; box: Box; wall: string; mounting: string }[];
};
const index = readJson<{ photos: Photo[] }>(join(out, 'photos', 'index.json'));
const draft = readJson<{
  photos: Record<string, { id: string; kind: string; wall: Wall; third: string | null; noMatch?: string }[]>;
}>(join(out, 'truth', 'fifteen-draft.json'));
const PRODUCT = new Set(['toilet', 'basin', 'vanity', 'bath']);
const kindOf = (kind: string) => (kind === 'vanity' ? 'basin' : kind);
const isWall = (w: unknown): w is Wall => w === 'back' || w === 'left' || w === 'right';

/** Where along a wall the image x is, from the wall face's x extent in the photo (0 left … 1 right). */
function alongWall(photo: Photo, wall: Wall, x: number) {
  const plane = photo.planes.find((p) => p.face === wall);
  if (!plane) return x;
  const xs = plane.quad.map((p) => p.x);
  const lo = Math.min(...xs),
    hi = Math.max(...xs);
  return hi > lo ? Math.max(0, Math.min(1, (x - lo) / (hi - lo))) : x;
}
const centreX = (b: Box) => (b.left + b.right) / 2;

// ---------- MoGe (no camera fit) ----------
type Plane = { normalCamera: [number, number, number]; offset: number; imageSupport?: { bounds: Box } };
type Observation = {
  intrinsics: { fx: number; fy: number; cx: number; cy: number };
  floor: Plane | null;
  walls: Plane[];
};
function mogeObservation(photo: Photo): Observation | undefined {
  if (photo.split === 'fifteen') {
    const report = readJson<{
      analysisDiagnostics?: { pipeline?: { depthGeometry?: { observation?: Observation } } };
    }>(join(FIFTEEN_RUN as string, photo.id, 'report-dom.json'));
    return report.analysisDiagnostics?.pipeline?.depthGeometry?.observation;
  }
  const file = join(out, 'moge-corpus', photo.id, 'webgpu-result.json');
  return existsSync(file) ? readJson<Observation>(file) : undefined;
}
/** back / left / right of each wall plane from its normal in camera space (x right, y down, z forward). */
function wallNames(walls: Plane[]): Wall[] {
  // The normal points from the wall into the room, towards the camera.
  const backIndex = walls.reduce(
    (best, w, i) => (-w.normalCamera[2] > -walls[best].normalCamera[2] ? i : best),
    0,
  );
  return walls.map((w, i) => {
    const [nx, , nz] = w.normalCamera;
    if (i === backIndex && -nz >= Math.abs(nx)) return 'back';
    return nx > 0 ? 'left' : 'right';
  });
}
const ray = (o: Observation, x: number, y: number): [number, number, number] => [
  (x - o.intrinsics.cx) / o.intrinsics.fx,
  (y - o.intrinsics.cy) / o.intrinsics.fy,
  1,
];
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const hit = (p: Plane, r: number[]) => {
  const d = dot(p.normalCamera, r);
  if (Math.abs(d) < 1e-6) return undefined;
  const t = -p.offset / d;
  return t > 0 ? ([r[0] * t, r[1] * t, r[2] * t] as const) : undefined;
};
function mogeWall(o: Observation, box: Box): Wall | undefined {
  if (!o.walls.length) return;
  const names = wallNames(o.walls);
  // The wall seen just above the product: the first wall plane the ray meets inside every other plane.
  const r = ray(o, centreX(box), Math.max(0, box.top - 0.02));
  const planes = [...o.walls, ...(o.floor ? [o.floor] : [])];
  let best: { t: number; i: number } | undefined;
  o.walls.forEach((w, i) => {
    const p = hit(w, r);
    if (!p) return;
    const inside = planes.every((q) => q === w || dot(q.normalCamera, [...p]) + q.offset > -0.05);
    if (inside && (!best || p[2] < best.t)) best = { t: p[2], i };
  });
  return best ? names[best.i] : undefined;
}

// ---------- the guesses ----------
type Item = {
  id: string;
  kind: string;
  box: Box;
  floorStanding: boolean;
  candidate?: Photo['candidates'][number];
};
const methods = ['baseline', 'rule', 'layout', 'placement', 'face-above', 'moge'] as const;
const METHODS_OF: Record<string, readonly (typeof methods)[number][]> = {
  'corpus-dev': ['baseline', 'rule', 'face-above', 'moge'],
  fifteen: ['baseline', 'layout', 'placement', 'face-above', 'moge'],
};
/** The saved photo face that contains a point (image coordinates), if any. */
function faceAt(photo: Photo, x: number, y: number): string | undefined {
  const inside = (q: { x: number; y: number }[]) => {
    let hit = false;
    for (let i = 0, j = q.length - 1; i < q.length; j = i++)
      if (q[i].y > y !== q[j].y > y && x < ((q[j].x - q[i].x) * (y - q[i].y)) / (q[j].y - q[i].y) + q[i].x)
        hit = !hit;
    return hit;
  };
  return photo.planes.find((p) => p.face !== 'floor' && inside(p.quad))?.face;
}
const layoutWalls = (photoId: string): Map<string, string> => {
  const dir = join(FIFTEEN_RUN as string, photoId);
  for (const file of readdirSync(dir).filter((f) => f.endsWith('-request.json'))) {
    const request = join(dir, file);
    if (readJson<{ fields: { operation: string } }>(request).fields.operation !== 'layout') continue;
    const raw = readFileSync(request.replace('-request.json', '-model-raw.txt'), 'utf8');
    try {
      const answer = JSON.parse(raw) as { observations: { id: string; wall: string }[] };
      return new Map(answer.observations.map((o) => [o.id, o.wall]));
    } catch {
      return new Map();
    }
  }
  return new Map();
};
function guess(photo: Photo, items: Item[], method: (typeof methods)[number]): PlacedGuess[] {
  const o = method === 'moge' ? mogeObservation(photo) : undefined;
  const layout = method === 'layout' ? layoutWalls(photo.id) : undefined;
  return items.flatMap((item): PlacedGuess[] => {
    let wall: unknown;
    let u: number | undefined;
    if (method === 'baseline') wall = 'back';
    else if (method === 'rule' || method === 'placement') {
      if (!item.candidate) return [];
      wall = item.candidate.wall;
      const requested = item.candidate.requested;
      if (method === 'placement' && requested && isWall(wall))
        u =
          requested.face === 'floor'
            ? wall === 'left'
              ? 1 - requested.v
              : wall === 'right'
                ? requested.v
                : requested.u
            : requested.u;
    } else if (method === 'layout') {
      if (!item.candidate?.id) return [];
      wall = layout!.get(item.candidate.id);
    } else if (method === 'face-above')
      wall = faceAt(photo, centreX(item.box), Math.max(0, item.box.top - 0.02));
    else wall = o ? mogeWall(o, item.box) : undefined;
    if (!isWall(wall)) return [];
    return [{ id: item.id, wall, u: u ?? alongWall(photo, wall, centreX(item.box)) }];
  });
}

const results: Record<string, Record<string, unknown>> = {};
const guesses: Record<string, unknown> = {};
for (const split of ['corpus-dev', 'fifteen']) {
  const perMethod = Object.fromEntries(methods.map((m) => [m, [] as ReturnType<typeof positionScore>[]]));
  for (const photo of index.photos.filter((p) => p.split === split && !p.locked)) {
    let items: Item[], truth: PlacedTruth[];
    if (split === 'corpus-dev') {
      const fixtures = (photo.truth ?? []).filter((t) => PRODUCT.has(t.kind));
      // Position is scored on the annotated boxes (finding them is scored on its own).
      const candidates = photo.candidates
        .filter((c) => PRODUCT.has(c.kind))
        .map((c) => ({ ...c, kind: kindOf(c.kind) }));
      const matched = matchBoxes(
        fixtures.map((f) => ({ ...f, kind: kindOf(f.kind) })),
        candidates,
        0.25,
      );
      items = fixtures.map((f) => ({
        id: f.id,
        kind: kindOf(f.kind),
        box: f.box,
        floorStanding: f.mounting !== 'wall',
        candidate: matched.hits.find(([t]) => t.id === f.id)?.[1],
      }));
      truth = fixtures.map((f) => ({
        id: f.id,
        wall: isWall(f.wall) ? f.wall : 'unknown',
        u: centreX(f.box),
      }));
    } else {
      const answers = draft.photos[photo.id] ?? [];
      const candidates = photo.candidates.filter((c) => PRODUCT.has(c.kind));
      // The draft has no boxes: answers meet the saved candidates by kind, in left-to-right order.
      items = [];
      for (const kind of ['toilet', 'basin', 'bath']) {
        const a = answers.filter((x) => x.kind === kind);
        const c = candidates
          .filter((x) => kindOf(x.kind) === kind)
          .sort((p, q) => centreX(p.box) - centreX(q.box));
        a.forEach((answer, i) => {
          const candidate = c[i];
          if (candidate)
            items.push({
              id: answer.id,
              kind,
              box: candidate.box,
              floorStanding: candidate.mode !== 'wall',
              candidate,
            });
        });
      }
      const thirdU = { left: 1 / 6, middle: 0.5, right: 5 / 6 } as Record<string, number>;
      truth = answers.map((a) => ({ id: a.id, wall: a.wall, u: a.third ? thirdU[a.third] : undefined }));
    }
    for (const method of METHODS_OF[split]) {
      const g = guess(photo, items, method);
      const s = positionScore(truth, g);
      // The development annotation has no place along the wall: its u is only the left-right order.
      if (split === 'corpus-dev') s.sameThird = undefined;
      perMethod[method].push(s);
      guesses[photo.id] ??= {} as Record<string, unknown>;
      (guesses[photo.id] as Record<string, unknown>)[method] = g;
    }
  }
  results[split] = Object.fromEntries(
    methods
      .filter((m) => perMethod[m].length)
      .map((m) => {
        const rows = perMethod[m];
        const known = rows.reduce((s, r) => s + r.known, 0);
        const sameWall = rows.reduce((s, r) => s + r.sameWall * r.known, 0);
        const missing = rows.reduce((s, r) => s + r.missing, 0);
        const pairs = rows.reduce((s, r) => s + r.orderPairs, 0);
        const order = rows.reduce((s, r) => s + (r.order ?? 0) * r.orderPairs, 0);
        const thirdRows = rows.filter((r) => r.sameThird !== undefined);
        return [
          m,
          {
            photos: rows.length,
            products: known,
            sameWall: known ? sameWall / known : 0,
            noAnswer: missing,
            order: pairs ? order / pairs : null,
            orderPairs: pairs,
            sameThird: thirdRows.length
              ? thirdRows.reduce((s, r) => s + r.sameThird!, 0) / thirdRows.length
              : null,
          },
        ];
      }),
  );
}
writeFileSync(join(target, 'summary.json'), JSON.stringify(results, null, 1));
writeFileSync(join(target, 'guesses.json'), JSON.stringify(guesses));
for (const [split, table] of Object.entries(results)) {
  console.log(`\n${split}`);
  for (const [m, s] of Object.entries(table as Record<string, Record<string, number | null>>))
    console.log(
      `  ${m.padEnd(10)} photos ${s.photos} products ${s.products} same wall ${(100 * s.sameWall!).toFixed(0)}% no answer ${s.noAnswer} order ${s.order === null ? '-' : (100 * s.order).toFixed(0) + '%'} (${s.orderPairs}) third ${s.sameThird === null ? '-' : (100 * s.sameThird).toFixed(0) + '%'}`,
    );
}
