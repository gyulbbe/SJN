/**
 * The DINOv2 size comparison's review items: round 5's thirty faces and twenty-eight products again, with
 * each size's first tile (fused with the model-free numbers, and DINOv2 alone) and first product
 * (`dinov2.pooled.box`). A candidate already rated for that face or product (round 5, round 9) is not
 * asked again; its rating is reused when scoring (models-score.ts). Which size gave what is kept in
 * the item, never shown; the order is fixed by a seed.
 *
 * Usage: node tests/run-browser-test.mjs tests/catalog-match/review/build-models.ts
 * Output: test-results/catalog-match/review-models/items.json (screen: server.mjs --dir review-models)
 */
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PublicPlacement } from '../../../src/lib/catalog/placement-contract';
import { out, readJson } from '../data';
import { allRatings, firstPicks } from '../model-sizes';
import { SNAPSHOT } from '../paths.mjs';
import type { Box, Quad } from '../tile-features';

const FACE = { back: '뒤 벽', left: '왼쪽 벽', right: '오른쪽 벽', floor: '바닥' } as Record<string, string>;
const KIND = { toilet: '변기', basin: '세면대', vanity: '세면대(하부장)', bath: '욕조' } as Record<
  string,
  string
>;
const index = readJson<{
  photos: {
    id: string;
    path: string;
    planes: { face: string; quad: Quad }[];
    candidates: { id?: string; kind: string; box: Box }[];
  }[];
}>(join(out, 'photos', 'index.json'));
const photoOf = new Map(index.photos.map((p) => [p.id, p]));
const snapshot = readJson<{ placements: PublicPlacement[] }>(join(SNAPSHOT, 'catalog.json'));
const byId = new Map(snapshot.placements.map((p) => [p.materialId, p]));
const files = new Map(readdirSync(join(SNAPSHOT, 'images')).map((f) => [f.replace(/\.[a-z]+$/, ''), f]));
const imagePath = (assetId: string) => join(SNAPSHOT, 'images', files.get(assetId)!);
const ratings = allRatings();
const rated = new Set(ratings.map((r) => `${r.item}|${r.candidate}`));
/** Round 5's rated faces or products (round 9 only rated some of the same faces again). */
const round5 = (prefix: string) => [
  ...new Set(ratings.filter((r) => r.item.startsWith(prefix)).map((r) => r.item)),
];
let seed = 20261103;
const shuffle = <T>(list: T[]) => {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i--) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const j = seed % (i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
};
/** The picks of one face or product not yet rated, merged: tile or product id → methods. */
const unrated = (item: string, picks: Record<string, string> = {}) => {
  const merged = new Map<string, string[]>();
  for (const [method, id] of Object.entries(picks))
    if (!rated.has(`${item}|${id}`)) merged.set(id, [...(merged.get(id) ?? []), method]);
  return shuffle([...merged]);
};
const { tiles: tilePicks, products: productPicks } = firstPicks();
const tiles = round5('tile:').flatMap((item) => {
  const key = item.replace('tile:', '');
  const [photo, face] = key.split(':');
  const candidates = unrated(item, tilePicks[key]);
  if (!candidates.length) return [];
  return [
    {
      id: item,
      title: `${photo} · ${FACE[face]} 타일`,
      note: '빨간 선 안의 타일과 비교해 주세요. 후보는 모두 같은 크기(900mm 정사각형)로 반복해 그렸어요.',
      photo: photoOf.get(photo)!.path,
      quad: photoOf.get(photo)!.planes.find((x) => x.face === face)!.quad,
      candidates: candidates.map(([id, methods]) => {
        const t = byId.get(id)!;
        return {
          key: id,
          methods,
          tile: {
            path: imagePath(t.textureAssetIds[0]),
            widthMm: t.widthMm,
            heightMm: t.heightMm,
            groutMm: t.defaultGroutWidth,
            groutColor: t.defaultGroutColor,
          },
        };
      }),
    },
  ];
});
const products = round5('product:').flatMap((item) => {
  const key = item.replace('product:', '');
  const [photo, candidateId] = key.split(':');
  const p = photoOf.get(photo)!;
  const c = p.candidates.find((x, i) => (x.id ?? `c${i}`) === candidateId);
  const candidates = unrated(item, productPicks[key]);
  if (!c || !candidates.length) return [];
  return [
    {
      id: item,
      title: `${photo} · ${KIND[c.kind] ?? c.kind}`,
      note: '빨간 상자 안의 제품과 비교해 주세요.',
      photo: p.path,
      boxes: [c.box],
      candidates: candidates.map(([id, methods]) => {
        const views = byId.get(id)!.views;
        return {
          key: id,
          methods,
          path: imagePath((views.find((v) => v.direction === '정면') ?? views[0]).assetId),
        };
      }),
    },
  ];
});
const sections = [
  { kind: 'tile', items: tiles },
  { kind: 'product', items: products },
];
const count = (items: { candidates: unknown[] }[]) => items.reduce((s, i) => s + i.candidates.length, 0);
const minutes = Math.round(((count(tiles) + count(products)) * 3) / 6) / 10;
mkdirSync(join(out, 'review-models'), { recursive: true });
writeFileSync(
  join(out, 'review-models', 'items.json'),
  JSON.stringify({ builtAt: new Date().toISOString(), estimateMinutes: minutes, sections }),
);
console.log(
  `tile ${tiles.length} faces / ${count(tiles)} new; product ${products.length} / ${count(products)} new; ≈ ${minutes} min`,
);
