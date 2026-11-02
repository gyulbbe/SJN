/**
 * Round 6 (no AI call): whole combinations drawn as rooms. For each photo and combination, the
 * combination's tile for every face, its product for every product, and its wall and place, built
 * with the app's placement functions and drawn by its 3D renderer (scene-page.ts). The answers come
 * from earlier rounds' saved results; nothing is asked again. Faces the photo does not show take the
 * back wall's tile (walls) or any floor-usable tile chosen for the photo (floor).
 *
 * Usage: node tests/run-browser-test.mjs tests/catalog-match/r6-scenes.ts --combos combos.json [--split fifteen,corpus-dev]
 *   combos.json: [{ "name": "A", "tiles": "<photo-top12 key>" | "gemma" | "clef-flash", "products": "<r4-products method>" | "gemma",
 *                   "position": "face-above" | "moge" | "gemma" | "baseline" }]
 * Output: test-results/catalog-match/r6-scenes/<combo>/<photo>.jpg, results.json
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { PublicPlacement } from '../../src/lib/catalog/placement-contract';
import { out, readJson } from './data';
import { SNAPSHOT } from './paths.mjs';
import { openHarness } from './browser/harness';
import type * as ScenePage from './browser/scene-page';

const arg = (name: string, fallback: string) => {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? fallback : process.argv[at + 1];
};
type Combo = { name: string; tiles: string; products: string; position: string; tilesDir?: string };
const combos = readJson<Combo[]>(resolve(arg('combos', join(out, 'r6-scenes', 'combos.json'))));
const splits = arg('split', 'fifteen,corpus-dev').split(',');
const target = join(out, 'r6-scenes');

type Box = { left: number; top: number; right: number; bottom: number };
type Wall = 'back' | 'left' | 'right';
const index = readJson<{
  photos: {
    id: string;
    split: string;
    locked?: boolean;
    room: { widthMm: number; depthMm: number; heightMm: number };
    candidates: { id?: string; kind: string; box: Box }[];
    truth?: { id: string; kind: string; box: Box }[];
  }[];
}>(join(out, 'photos', 'index.json'));
const snapshot = readJson<{ placements: PublicPlacement[] }>(join(SNAPSHOT, 'catalog.json'));
const byId = new Map(snapshot.placements.map((p) => [p.materialId, p]));
const files = new Map(readdirSync(join(SNAPSHOT, 'images')).map((f) => [f.replace(/\.[a-z]+$/, ''), f]));
const imagePath = (assetId: string) => join(SNAPSHOT, 'images', files.get(assetId)!);
const answers = readFileSync(join(out, 'r4-ai', 'answers.jsonl'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map(
    (l) =>
      JSON.parse(l) as {
        part: string;
        key: string;
        photo: string;
        model: string;
        candidates?: string[];
        result: Record<string, unknown>;
      },
  );
const gemmaJson = (result: Record<string, unknown>) => {
  const text = (result as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content;
  try {
    return text ? (JSON.parse(text) as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
};
/** The model's pick on a board: a candidate id, 'none', or undefined. */
function pick(part: string, key: string, model: string): string | undefined {
  const a = answers.find((x) => x.part === part && x.key === key && x.model === model);
  if (!a) return undefined;
  const n =
    model === 'gemma'
      ? Number(gemmaJson(a.result)?.choice)
      : (() => {
          const c = (a.result as { answers?: Record<string, { choice: string }> }).answers?.[
            part === 'tiles' ? 'tile' : 'product'
          ]?.choice;
          return c === 'none' ? 0 : Number(c);
        })();
  if (!Number.isFinite(n)) return undefined;
  return n === 0 ? 'none' : a.candidates?.[n - 1];
}
const productTop = readJson<Record<string, Record<string, { id: string }[]>>>(
  join(out, 'r4-products', 'top12.json'),
);
const r2 = readJson<Record<string, Record<string, { id: string; wall: Wall; u: number }[]>>>(
  join(out, 'r2-position', 'guesses.json'),
);
const PRODUCT = new Set(['toilet', 'basin', 'vanity', 'bath']);
const thirdU: Record<string, number> = { left: 1 / 6, middle: 0.5, right: 5 / 6 };
const draft = readJson<{ photos: Record<string, { id: string; kind: string }[]> }>(
  join(out, 'truth', 'fifteen-draft.json'),
);
const kindOf = (kind: string) => (kind === 'vanity' ? 'basin' : kind);
/** Round 2 keyed the fifteen's products by the draft's ids: a saved candidate meets them by kind, left to right. */
function roundTwoId(photo: (typeof index.photos)[number], candidateId: string): string {
  if (photo.split === 'corpus-dev') return candidateId;
  const candidates = photo.candidates
    .map((c, i) => ({ ...c, id: c.id ?? `c${i}` }))
    .filter((c) => PRODUCT.has(c.kind));
  const candidate = candidates.find((c) => c.id === candidateId)!;
  const same = candidates
    .filter((c) => kindOf(c.kind) === kindOf(candidate.kind))
    .sort((a, b) => a.box.left + a.box.right - (b.box.left + b.box.right));
  return (
    draft.photos[photo.id]?.filter((d) => d.kind === kindOf(candidate.kind))[same.indexOf(candidate)]?.id ??
    candidateId
  );
}

const harness = await openHarness({
  pageEntry: resolve('tests/catalog-match/browser/scene-page.ts'),
  gpu: true,
});
const results: Record<string, Record<string, unknown>> = {};
try {
  for (const combo of combos) {
    const tileTop = readJson<Record<string, Record<string, string[]>>>(
      join(out, combo.tilesDir ?? 'r1-tiles-q8', 'photo-top12.json'),
    );
    mkdirSync(join(target, combo.name), { recursive: true });
    for (const photo of index.photos.filter((p) => !p.locked && splits.includes(p.split))) {
      // Tiles: the combination's pick for every face the photo shows.
      const chosen: Partial<Record<string, string>> = {};
      for (const face of ['back', 'left', 'right', 'floor']) {
        const key = `${photo.id}:${face}`;
        const top = Object.entries(tileTop[key] ?? {}).find(([k]) => k === combo.tiles)?.[1];
        let id: string | undefined;
        if (combo.tiles === 'gemma' || combo.tiles === 'clef-flash') id = pick('tiles', key, combo.tiles);
        else id = top?.[0];
        if (id && id !== 'none') chosen[face] = id;
        else if (id === 'none' && tileTop[key]) chosen[face] = Object.values(tileTop[key])[0]?.[0];
      }
      const wallTile = chosen.back ?? chosen.left ?? chosen.right;
      const tiles: Record<string, { placement: PublicPlacement; path: string }> = {};
      for (const face of ['back', 'left', 'right', 'floor']) {
        const id =
          chosen[face] ??
          (face === 'floor'
            ? Object.values(chosen).find((t) => t && byId.get(t)!.usage !== 'wall')
            : wallTile);
        if (id) tiles[face] = { placement: byId.get(id)!, path: imagePath(byId.get(id)!.textureAssetIds[0]) };
      }
      // Products: the ones round 4 asked about (saved Gemma boxes / the annotation's).
      const items =
        photo.split === 'corpus-dev'
          ? (photo.truth ?? [])
              .filter((t) => PRODUCT.has(t.kind))
              .map((t) => ({ id: t.id, query: `${photo.id}:${t.id}` }))
          : photo.candidates
              .map((c, i) => ({ ...c, id: c.id ?? `c${i}` }))
              .filter((c) => PRODUCT.has(c.kind))
              .map((c) => ({ id: c.id, query: `${photo.id}:${c.id}` }));
      const positionAnswer = answers.find(
        (x) => x.part === 'position' && x.photo === photo.id && x.model === 'gemma',
      );
      const gemmaItems =
        (positionAnswer &&
          (gemmaJson(positionAnswer.result)?.items as
            { box: number; wall: Wall; third: string }[] | undefined)) ??
        [];
      const products: ScenePage.SceneSpec['products'] = [];
      let noMatch = 0;
      items.forEach((item, i) => {
        const id =
          combo.products === 'gemma'
            ? pick('products', item.query, 'gemma')
            : productTop[item.query]?.[combo.products]?.[0]?.id;
        if (!id || id === 'none') {
          noMatch++;
          return;
        }
        // Position: the round 2 answer is keyed by the draft's / annotation's id; Gemma's by box number.
        const g = gemmaItems.find((x) => x.box === i + 1);
        const r = r2[photo.id]?.[combo.position]?.find((x) => x.id === roundTwoId(photo, item.id));
        const wall: Wall = combo.position === 'gemma' ? (g?.wall ?? 'back') : (r?.wall ?? g?.wall ?? 'back');
        const u = combo.position === 'gemma' ? thirdU[g?.third ?? 'middle'] : (r?.u ?? 0.5);
        const placement = byId.get(id)!;
        products.push({
          placement,
          paths: Object.fromEntries(placement.views.map((v) => [v.assetId, imagePath(v.assetId)])),
          wall,
          u,
        });
      });
      const spec: ScenePage.SceneSpec = {
        id: photo.id,
        room: photo.room,
        tiles,
        products,
        out: join('r6-scenes', combo.name, `${photo.id}.jpg`),
      };
      const result = await harness.page.evaluate(
        (s) => (window as unknown as { CM: typeof ScenePage }).CM.renderScene(s as never),
        spec,
      );
      (results[combo.name] ??= {})[photo.id] = {
        ...result,
        noMatch,
        products: items.length,
        tiles: Object.fromEntries(Object.entries(tiles).map(([f, t]) => [f, t.placement.materialId])),
      };
      process.stdout.write(`\r${combo.name} ${photo.id}      `);
    }
  }
} finally {
  console.log();
  writeFileSync(join(target, 'results.json'), JSON.stringify(results, null, 1));
  await harness.close();
}
