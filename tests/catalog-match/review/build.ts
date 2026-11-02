/**
 * The review screen's items (round 5) for the fifteen photos: the draft position answers to confirm,
 * two faces a photo with every method's first tile, every product with every method's first product,
 * and the round 6 rooms to score 1–5. Candidates the methods share are shown once; which method gave
 * what is kept in the item for scoring, never shown. The order is fixed by a seed. An estimate of the
 * time (3 s a tile or product, 10 s a position photo, 5 s a room) is printed.
 *
 * Usage: node tests/run-browser-test.mjs tests/catalog-match/review/build.ts
 *          --tiles-dir r1-tiles-q8 --tile-methods "clean.rect.raw|a,clean.rect.raw|b" --product-methods dinov2.pooled.box,...
 *          [--combos A,B]
 * Output: test-results/catalog-match/review/items.json
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PublicPlacement } from '../../../src/lib/catalog/placement-contract';
import { out, readJson } from '../data';
import { SNAPSHOT } from '../paths.mjs';

const arg = (name: string, fallback: string) => {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? fallback : process.argv[at + 1];
};
const tilesDir = join(out, arg('tiles-dir', 'r1-tiles-q8'));
const tileMethods = arg('tile-methods', '').split(',').filter(Boolean);
const productMethods = arg('product-methods', 'dinov2.pooled.box').split(',');
const combos = arg('combos', '').split(',').filter(Boolean);
type Box = { left: number; top: number; right: number; bottom: number };
const index = readJson<{
  photos: {
    id: string;
    split: string;
    path: string;
    planes: { face: string; quad: { x: number; y: number }[] }[];
    candidates: { id?: string; kind: string; box: Box }[];
  }[];
}>(join(out, 'photos', 'index.json'));
const draft = readJson<{
  photos: Record<string, { id: string; kind: string; wall: string; third: string | null; shape: string }[]>;
}>(join(out, 'truth', 'fifteen-draft.json'));
const snapshot = readJson<{ placements: PublicPlacement[] }>(join(SNAPSHOT, 'catalog.json'));
const byId = new Map(snapshot.placements.map((p) => [p.materialId, p]));
const files = new Map(readdirSync(join(SNAPSHOT, 'images')).map((f) => [f.replace(/\.[a-z]+$/, ''), f]));
const imagePath = (assetId: string) => join(SNAPSHOT, 'images', files.get(assetId)!);
const photoTop = readJson<Record<string, Record<string, string[]>>>(join(tilesDir, 'photo-top12.json'));
const productTop = readJson<Record<string, Record<string, { id: string }[]>>>(
  join(out, 'r4-products', 'top12.json'),
);
const answers = readFileSync(join(out, 'r4-ai', 'answers.jsonl'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map(
    (l) =>
      JSON.parse(l) as {
        part: string;
        key: string;
        model: string;
        candidates?: string[];
        result: Record<string, unknown>;
      },
  );
function aiPick(part: string, key: string, model: string): string | undefined {
  const a = answers.find((x) => x.part === part && x.key === key && x.model === model);
  if (!a) return;
  let n: number;
  if (model === 'gemma') {
    try {
      n = Number(
        JSON.parse((a.result as { choices: { message: { content: string } }[] }).choices[0].message.content)
          .choice,
      );
    } catch {
      return;
    }
  } else {
    const c = (a.result as { answers?: Record<string, { choice: string }> }).answers?.[
      part === 'tiles' ? 'tile' : 'product'
    ]?.choice;
    n = c === 'none' ? 0 : Number(c);
  }
  return Number.isFinite(n) && n > 0 ? a.candidates?.[n - 1] : undefined;
}
let seed = 20261102;
const shuffle = <T>(list: T[]) => {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const j = seed % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};
const KIND = { toilet: '변기', basin: '세면대', vanity: '세면대(하부장)', bath: '욕조' } as Record<
  string,
  string
>;
const FACE = { back: '뒤 벽', left: '왼쪽 벽', right: '오른쪽 벽', floor: '바닥' } as Record<string, string>;
const PRODUCT = new Set(Object.keys(KIND));
const fifteen = index.photos.filter((p) => p.split === 'fifteen');

const position = fifteen.flatMap((p) => {
  const products = p.candidates
    .map((c, i) => ({ ...c, id: c.id ?? `c${i}` }))
    .filter((c) => PRODUCT.has(c.kind));
  if (!products.length) return [];
  const kindOf = (k: string) => (k === 'vanity' ? 'basin' : k);
  const answersOf = draft.photos[p.id] ?? [];
  return [
    {
      id: `pos:${p.id}`,
      title: `${p.id} · 제품 위치`,
      photo: p.path,
      boxes: products.map((c) => c.box),
      products: products.map((c) => {
        const same = products
          .filter((x) => kindOf(x.kind) === kindOf(c.kind))
          .sort((a, b) => a.box.left + a.box.right - (b.box.left + b.box.right));
        const d = answersOf.filter((x) => x.kind === kindOf(c.kind))[same.indexOf(c)];
        return {
          id: d?.id ?? c.id,
          label: KIND[c.kind] ?? c.kind,
          wall: d?.wall ?? 'unknown',
          third: d?.third ?? 'middle',
        };
      }),
    },
  ];
});
const tiles = fifteen.flatMap((p) => {
  const faces = p.planes.map((plane) => plane.face).filter((f) => photoTop[`${p.id}:${f}`]);
  const chosenFaces = [
    faces.find((f) => f === 'back') ?? faces[0],
    faces.find((f) => f === 'floor') ?? faces.find((f) => f !== 'back'),
  ].filter((f, i, all) => f && all.indexOf(f) === i) as string[];
  return chosenFaces.map((face) => {
    const key = `${p.id}:${face}`;
    const picks = new Map<string, string[]>();
    const add = (method: string, id?: string) => id && picks.set(id, [...(picks.get(id) ?? []), method]);
    for (const m of tileMethods) add(m, photoTop[key]?.[m]?.[0]);
    add('gemma', aiPick('tiles', key, 'gemma'));
    add('clef-flash', aiPick('tiles', key, 'clef-flash'));
    return {
      id: `tile:${key}`,
      title: `${p.id} · ${FACE[face]} 타일`,
      note: '빨간 선 안의 타일과 비교해 주세요. 후보는 모두 같은 크기(900mm 정사각형)로 반복해 그렸어요.',
      photo: p.path,
      quad: p.planes.find((x) => x.face === face)!.quad,
      candidates: shuffle([...picks]).map(([id, methods]) => {
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
    };
  });
});
const products = fifteen.flatMap((p) =>
  p.candidates
    .map((c, i) => ({ ...c, id: c.id ?? `c${i}` }))
    .filter((c) => PRODUCT.has(c.kind))
    .map((c) => {
      const key = `${p.id}:${c.id}`;
      const picks = new Map<string, string[]>();
      const add = (method: string, id?: string) => id && picks.set(id, [...(picks.get(id) ?? []), method]);
      for (const m of productMethods) add(m, productTop[key]?.[m]?.[0]?.id);
      add('gemma', aiPick('products', key, 'gemma'));
      add('clef-flash', aiPick('products', key, 'clef-flash'));
      return {
        id: `product:${key}`,
        title: `${p.id} · ${KIND[c.kind] ?? c.kind}`,
        note: '빨간 상자 안의 제품과 비교해 주세요.',
        photo: p.path,
        boxes: [c.box],
        candidates: shuffle([...picks]).map(([id, methods]) => {
          const views = byId.get(id)!.views;
          return {
            key: id,
            methods,
            path: imagePath((views.find((v) => v.direction === '정면') ?? views[0]).assetId),
          };
        }),
      };
    }),
);
const overall = combos.length
  ? fifteen.map((p) => ({
      id: `overall:${p.id}`,
      title: `${p.id} · 전체`,
      note: '사진과 같은 각도를 맞추지는 않았어요. 방 전체의 타일·제품·자리가 얼마나 비슷한지 봐 주세요.',
      photo: p.path,
      candidates: shuffle(
        combos
          .filter((c) => existsSync(join(out, 'r6-scenes', c, `${p.id}.jpg`)))
          .map((c) => ({ key: c, methods: [c], path: join(out, 'r6-scenes', c, `${p.id}.jpg`) })),
      ),
    }))
  : [];
const sections = [
  { kind: 'position', items: position },
  { kind: 'tile', items: tiles },
  { kind: 'product', items: products },
  { kind: 'overall', items: overall },
];
const seconds =
  position.length * 10 +
  tiles.reduce((s, t) => s + t.candidates.length * 3, 0) +
  products.reduce((s, t) => s + t.candidates.length * 3, 0) +
  overall.reduce((s, t) => s + t.candidates.length * 5, 0);
mkdirSync(join(out, 'review'), { recursive: true });
writeFileSync(
  join(out, 'review', 'items.json'),
  JSON.stringify({
    builtAt: new Date().toISOString(),
    estimateMinutes: Math.round(seconds / 6) / 10,
    sections,
  }),
);
console.log(
  sections
    .map(
      (s) =>
        `${s.kind} ${s.items.length} items / ${s.items.reduce((n, i) => n + ((i as { candidates?: unknown[] }).candidates?.length ?? 1), 0)} ratings`,
    )
    .join('; '),
  `≈ ${Math.round(seconds / 6) / 10} min`,
);
