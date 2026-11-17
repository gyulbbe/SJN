// The fixture-streaks trial's review set (no AI call, docs/fixture-streaks-20261117.md), for the ledge
// trial's screen (tests/ledge-ai/review): around the ceramics (toilet, basin, bathtub) of a picture,
// enlarged, the design beside the app as it is (`now`) against a candidate, sides at random, names
// blind. The candidate in --keep goes on every bathtub picture and on the pictures whose ceramics
// have the strongest light spread today (--top of them); the second candidate (--also) on the bathtubs
// and the --also-top strongest.
//
// --whole shows the whole pictures (s3: "평가 이미지를 전체로 보여줘"). --sets picks the picture sets (default dev,new,bath; the reviewer asked for registered products only,
// so s2 is new,reg).
//
//   node tests/fixture-streaks/review-build.mjs --set s2 --sets new,reg --keep k25s04qw --top 21 --also k50s04qw --also-top 9
//   node tests/ledge-ai/review/server.mjs --root fixture-streaks-20261117 --set s2 --port 8794
//   (s3: the same pairs as s2 with --whole)
// Output: test-results/fixture-streaks-20261117/review/<set>/items.json, key.json, pic/
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import sharp from 'sharp';
import { OUT } from './paths.mjs';

const arg = (name, fallback = '') => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const set = arg('set', 's1');
if (!/^[a-z0-9-]+$/.test(set)) throw new Error('--set <name>');
const keep = arg('keep', 'k25s04qw'),
  also = arg('also', ''),
  top = Number(arg('top', 18)),
  alsoTop = Number(arg('also-top', 6));
const sets = (arg('sets', 'dev,new,bath') || '').split(',');
/** --whole: the whole pictures instead of the crops around the ceramics (the reviewer's ask 11-17). */
const whole = process.argv.includes('--whole');
const rows = sets
  .flatMap((s) => JSON.parse(readFileSync(join(OUT, `pictures-${s}.json`), 'utf8')))
  .filter((r) => r.aligned && r[keep]);
const CERAMIC = ['toilet', 'basin', 'bath'];
const strongest = (row) => Math.max(...row[keep].fixtures.map((f) => f.spread));
const baths = rows.filter((r) => r.boxes.some((b) => b.kind === 'bath')).map((r) => r.id);
const others = rows
  .filter((r) => !baths.includes(r.id))
  .sort((x, y) => strongest(y) - strongest(x))
  .map((r) => r.id);

let state = 20261117;
const random = () => (state = (state * 1664525 + 1013904223) >>> 0) / 4294967296;
const shuffle = (list) => {
  for (let k = list.length - 1; k > 0; k--) {
    const j = Math.floor(random() * (k + 1));
    [list[k], list[j]] = [list[j], list[k]];
  }
  return list;
};
const pairs = [
  ...[...baths, ...others.slice(0, top)].map((source) => ({ source, candidate: keep })),
  ...(also ? [...baths, ...others.slice(0, alsoTop)].map((source) => ({ source, candidate: also })) : []),
];
shuffle(pairs);
for (const pair of pairs) pair.a = random() < 0.5 ? 'now' : pair.candidate;

const dir = join(OUT, 'review', set);
mkdirSync(join(dir, 'pic'), { recursive: true });
const rel = (path) => relative(OUT, path).replace(/\\/g, '/');
const byId = new Map(rows.map((row) => [row.id, row]));
const picture = (id, rule) => join(OUT, 'pictures', `${id}.${rule}.png`);
/** Around every ceramic box, grown by 12%, enlarged to WIDTH. */
const WIDTH = 1100;
async function crop(id, rule, file) {
  const row = byId.get(id);
  if (whole) {
    await sharp(picture(id, rule)).png().toFile(file);
    return rel(file);
  }
  const meta = await sharp(picture(id, rule)).metadata();
  const boxes = row.boxes.filter((b) => b.box && CERAMIC.includes(b.kind)).map((b) => b.box);
  const l = Math.min(...boxes.map((b) => b[0])),
    t = Math.min(...boxes.map((b) => b[1])),
    r = Math.max(...boxes.map((b) => b[2])),
    b = Math.max(...boxes.map((b) => b[3]));
  const pw = (r - l) * 0.12,
    ph = (b - t) * 0.12;
  const left = Math.max(0, Math.floor((l - pw) * meta.width)),
    top = Math.max(0, Math.floor((t - ph) * meta.height)),
    right = Math.min(meta.width, Math.ceil((r + pw) * meta.width)),
    bottom = Math.min(meta.height, Math.ceil((b + ph) * meta.height));
  await sharp(picture(id, rule))
    .extract({ left, top, width: right - left, height: bottom - top })
    .resize({ width: WIDTH })
    .png()
    .toFile(file);
  return rel(file);
}
const id = (k) => `${set}-p${String(k + 1).padStart(3, '0')}`;
const items = [];
const designs = new Map();
for (const [k, pair] of pairs.entries()) {
  if (!designs.has(pair.source))
    designs.set(pair.source, await crop(pair.source, 'ref', join(dir, 'pic', `design-${pair.source}.png`)));
  const b = pair.a === 'now' ? pair.candidate : 'now';
  items.push({
    id: id(k),
    design: designs.get(pair.source),
    a: await crop(pair.source, pair.a, join(dir, 'pic', `${id(k)}-a.png`)),
    b: await crop(pair.source, b, join(dir, 'pic', `${id(k)}-b.png`)),
  });
}
writeFileSync(
  join(dir, 'items.json'),
  JSON.stringify(
    {
      set,
      title: 'AI 결과 제품 위 빛 평가',
      flags: [],
      pairQuestion: '어느 쪽 제품(욕조·변기·세면대) 위의 빛이 더 자연스럽고 사진 같나',
      pairHint:
        '제품 위를 비스듬히 지나는 빛 줄기·큰 그늘이 거슬리는지, 반대로 제품이 너무 평평하거나 가짜 같거나 얼룩·테두리가 생겼는지 봐 주세요. 느낀 점은 글로 적어 주세요.',
      singles: [],
      pairs: items,
    },
    null,
    1,
  ),
);
writeFileSync(
  join(dir, 'key.json'),
  JSON.stringify({ pairs: Object.fromEntries(pairs.map((p, k) => [id(k), p])) }, null, 1),
);
console.log(
  `${set}: ${pairs.length} pairs (${baths.length} bathtub pictures), about ${Math.round((pairs.length * 8) / 60)} min`,
);
