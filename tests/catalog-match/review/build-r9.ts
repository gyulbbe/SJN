/**
 * Round 9's review items for the fifteen: first every face's piece as round 1 cut it (the red outline on
 * the photo and the piece beside it) to mark what it shows and the tile's state, the truth for Gemma's
 * check; then, of the thirty round 5 faces, those whose tile changed under ④ and whose new tile was not
 * rated in round 5. Which rule changed a tile is kept in the item, never shown.
 *
 * Usage: node tests/run-browser-test.mjs tests/catalog-match/review/build-r9.ts
 * Output: test-results/catalog-match/review-r9/items.json (screen: server.mjs --dir review-r9)
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PublicPlacement } from '../../../src/lib/catalog/placement-contract';
import { out, readJson } from '../data';
import { SNAPSHOT } from '../paths.mjs';
import type { Quad } from '../tile-features';

const FACE = { back: '뒤 벽', left: '왼쪽 벽', right: '오른쪽 벽', floor: '바닥' } as Record<string, string>;
const index = readJson<{
  photos: { id: string; split: string; path: string; planes: { face: string; quad: Quad }[] }[];
}>(join(out, 'photos', 'index.json'));
const pieces = readJson<
  { id: string; photo: string; split: string; face: string; regions: { clean?: { quad: Quad } } }[]
>(join(out, 'features', 'queries-photos-q8', 'faces.json'));
const report = readJson<{ faces: { id: string; before: string; after: string; mode: string }[] }>(
  join(out, 'r9-inspect', 'report.json'),
);
const snapshot = readJson<{ placements: PublicPlacement[] }>(join(SNAPSHOT, 'catalog.json'));
const byId = new Map(snapshot.placements.map((p) => [p.materialId, p]));
const files = new Map(readdirSync(join(SNAPSHOT, 'images')).map((f) => [f.replace(/\.[a-z]+$/, ''), f]));
const photoOf = new Map(index.photos.map((p) => [p.id, p]));

const inspect = pieces
  .filter((p) => p.split === 'fifteen' && p.regions.clean)
  .map((p) => ({
    id: `inspect:now:${p.id}`,
    title: `${p.photo} · ${FACE[p.face]} 조각`,
    note: '빨간 선 안이 타일 색·무늬를 찾을 때 쓰는 부분이에요.',
    photo: photoOf.get(p.photo)!.path,
    quad: p.regions.clean!.quad,
    crop: join(out, 'crops', 'photos', `${p.id.replace(':', '-')}.jpg`),
  }));
const old = readFileSync(join(out, 'review', 'ratings.jsonl'), 'utf8')
  .split(/\r?\n/)
  .filter(Boolean)
  .map((l) => JSON.parse(l) as { item: string; candidate?: string; value?: number });
const ratedBefore = new Set(old.filter((r) => r.value).map((r) => `${r.item}|${r.candidate}`));
const thirty = new Set(old.filter((r) => r.item.startsWith('tile:') && r.value).map((r) => r.item));
const tiles = report.faces
  .filter(
    (f) => f.before !== f.after && thirty.has(`tile:${f.id}`) && !ratedBefore.has(`tile:${f.id}|${f.after}`),
  )
  .map((f) => {
    const [photo, face] = f.id.split(':');
    const t = byId.get(f.after)!;
    return {
      id: `tile:${f.id}`,
      title: `${photo} · ${FACE[face]} 타일`,
      note: '빨간 선 안의 타일과 비교해 주세요. 후보는 모두 같은 크기(900mm 정사각형)로 반복해 그렸어요.',
      photo: photoOf.get(photo)!.path,
      quad: photoOf.get(photo)!.planes.find((x) => x.face === face)!.quad,
      candidates: [
        {
          key: f.after,
          methods: [`r9.${f.mode}`],
          tile: {
            path: join(SNAPSHOT, 'images', files.get(t.textureAssetIds[0])!),
            widthMm: t.widthMm,
            heightMm: t.heightMm,
            groutMm: t.defaultGroutWidth,
            groutColor: t.defaultGroutColor,
          },
        },
      ],
    };
  });
const sections = [
  { kind: 'inspect', items: inspect },
  { kind: 'tile', items: tiles },
];
const minutes = Math.round((inspect.length * 6 + tiles.length * 4) / 6) / 10;
mkdirSync(join(out, 'review-r9'), { recursive: true });
writeFileSync(
  join(out, 'review-r9', 'items.json'),
  JSON.stringify({ builtAt: new Date().toISOString(), estimateMinutes: minutes, sections }),
);
console.log(`inspect ${inspect.length} pieces; tile ${tiles.length} new picks; ≈ ${minutes} min`);
