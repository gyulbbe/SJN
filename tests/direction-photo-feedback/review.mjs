// Grading and pictures of the "고칠 점" trial (docs/direction-photo-feedback-20261107.md). No AI. Run from
// the repository (an ASCII working directory: sharp crashes on relative paths under a Korean one).
//
//   node tests/direction-photo-feedback/review.mjs sheets <engine>
//     Blind sheets: a row per case, the earlier answer, its guide and the product photo, then the new
//     answers in a seeded random order, lettered A–D; which is which stays in key.json.
//     → review/<engine>/page-N.png, key.json
//   node tests/direction-photo-feedback/review.mjs table <engine>
//     The grades (ratings-claude.txt, written before the key is opened:
//     "<case> <letter> <followed y|n> <kept y|n> <against the earlier b|s|w>") with the key, per way
//     (A/B) and kind of words (fix/ko) → review/<engine>/table.md, table.json
//   node tests/direction-photo-feedback/review.mjs picture <engine>
//     After table: a row per case, the earlier answer and the answers in a fixed order with their
//     grades → 고칠점-<engine>.png
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { OUT, SANITARY, SANITARY_PREP } from './paths.mjs';

const CASES = [
  ['B1', 'left', 'G', '사선으로 돎', '똑바로 본 모습', '옆에서 똑바로 본 모습으로 그려 주세요'],
  ['B6', 'left', 'G', '회색', '사진 색 그대로', '사진처럼 흰색으로 해 주세요'],
  ['B15', 'left', 'G', '벽 그림자', '벽·그림자 없이', '벽과 그림자를 없애 주세요'],
  ['U2', 'left', 'G2', '큰 상자가 생김', '없는 물건 빼기', '위에 있는 큰 상자를 빼 주세요'],
  ['B12', 'left', 'G2', '선 그림', '가이드 모양 그대로', '가이드 모양대로 실제 사진처럼 그려 주세요'],
];
const ARMS = [
  ['A', 'fix'],
  ['A', 'ko'],
  ['B', 'fix'],
  ['B', 'ko'],
];
/** The control (way A, nothing asked): graded on its own sheet (NAME=control) against the earlier answer. */
const CONTROL = process.env.NAME === 'control';
// ARMS=A:fix,A:ko,A:none picks the ways and words shown (the Cloudflare check: each case's words and the control).
const SHEET_ARMS = process.env.ARMS
  ? process.env.ARMS.split(',').map((arm) => arm.split(':'))
  : CONTROL
    ? [['A', 'none']]
    : ARMS;
const [command, engine] = process.argv.slice(2);
const manifest = JSON.parse(readFileSync(join(SANITARY_PREP, 'manifest.json'), 'utf8'));
const answer = (id, view, frame, words, seed = 1001) =>
  join(OUT, 'runs', engine, `${id}-${view}-${frame}-${words}-${seed}.png`);
const earlier = (id, method, view) => join(SANITARY, 'runs', 'cf', id, 'rep', method, `${view}-1001.png`);
const dir = join(
  OUT,
  'review',
  process.env.NAME && !CONTROL ? process.env.NAME : CONTROL ? `${engine}-control` : (engine ?? ''),
);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const svg = (w, h, lines) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${lines
      .map(
        ([t, size, y, weight = 400, x = 6]) =>
          `<text x="${x}" y="${y}" font-family="Malgun Gothic" font-size="${size}" font-weight="${weight}" fill="#111">${esc(t)}</text>`,
      )
      .join('')}</svg>`,
  );
const tile = (file, size) =>
  sharp(file)
    .flatten({ background: '#ffffff' })
    .resize(size, size, { fit: 'contain', background: '#ffffff' })
    .png()
    .toBuffer();

if (command === 'sheets') {
  mkdirSync(dir, { recursive: true });
  let seed = 20261108;
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const CELL = 260,
    LABEL = 150,
    GAP = 8;
  const key = {};
  const comp = [];
  let top = 0;
  for (const [id, view, method, fault] of CASES) {
    const list = SHEET_ARMS.map(([frame, words]) => [frame, words, answer(id, view, frame, words)]).filter(
      ([, , f]) => existsSync(f),
    );
    if (!list.length) continue;
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    const product = manifest[id].rep;
    comp.push({
      input: svg(LABEL, CELL, [
        [id, 24, 32, 700],
        [`${view}`, 16, 58],
        [fault, 15, 84],
      ]),
      left: 0,
      top,
    });
    const heads = ['이전 답', '가이드', '제품 사진'];
    for (const [i, f] of [earlier(id, method, view), product.guides.G[view], product.ref].entries()) {
      comp.push({ input: await tile(f, CELL), left: LABEL + i * (CELL + GAP), top });
      comp.push({
        input: svg(CELL, 26, [[heads[i], 16, 20]]),
        left: LABEL + i * (CELL + GAP),
        top: top + CELL,
      });
    }
    for (const [k, [frame, words, file]] of list.entries()) {
      const letter = 'ABCD'[k];
      key[`${id} ${letter}`] = { frame, words, file };
      const left = LABEL + (3 + k) * (CELL + GAP);
      comp.push({ input: await tile(file, CELL), left, top });
      comp.push({ input: svg(CELL, 26, [[letter, 20, 21, 700]]), left, top: top + CELL });
    }
    top += CELL + 34;
  }
  const width = LABEL + 7 * (CELL + GAP);
  await sharp({ create: { width, height: top, channels: 3, background: '#e4e4e4' } })
    .composite(comp)
    .png()
    .toFile(join(dir, 'page-1.png'));
  writeFileSync(join(dir, 'key.json'), JSON.stringify(key, null, 1));
  console.log(Object.keys(key).length, 'answers →', dir);
}

const readGrades = () => {
  const key = JSON.parse(readFileSync(join(dir, 'key.json'), 'utf8'));
  const grades = [];
  for (const line of readFileSync(join(dir, 'ratings-claude.txt'), 'utf8').split(/\r?\n/)) {
    const m = line.trim().match(/^(\S+) ([ABCD]) ([yn]) ([yn]) ([bsw])$/);
    if (!m) continue;
    const k = key[`${m[1]} ${m[2]}`];
    if (!k) throw new Error(`no key for ${m[1]} ${m[2]}`);
    grades.push({ id: m[1], ...k, followed: m[3] === 'y', kept: m[4] === 'y', against: m[5] });
  }
  if (grades.length !== Object.keys(key).length)
    throw new Error(`graded ${grades.length} of ${Object.keys(key).length}`);
  return grades;
};

if (command === 'table') {
  const grades = readGrades();
  const lines = [
    '| 방식 | 글 | 따름 | 나머지 지킴 | 둘 다 | 이전보다 나음/같음/못함 |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const [frame, words] of SHEET_ARMS) {
    const g = grades.filter((x) => x.frame === frame && x.words === words);
    if (!g.length) continue;
    const n = g.length;
    lines.push(
      `| ${frame} | ${{ fix: '빠른 선택', ko: '한국어 글', none: '아무것도 안 씀' }[words]} | ${g.filter((x) => x.followed).length}/${n} | ${g.filter((x) => x.kept).length}/${n} | ${g.filter((x) => x.followed && x.kept).length}/${n} | ${['b', 's', 'w'].map((a) => g.filter((x) => x.against === a).length).join('/')} |`,
    );
  }
  for (const frame of ['A', 'B']) {
    const g = grades.filter((x) => x.frame === frame);
    if (g.length)
      lines.push(
        `\n${frame}: 따르고 나머지도 지킴 ${g.filter((x) => x.followed && x.kept).length}/${g.length}`,
      );
  }
  const ko = grades.filter((x) => x.words === 'ko');
  if (ko.length)
    lines.push(
      `한국어 글을 따른 곳(A·B 중 하나라도): ${new Set(ko.filter((x) => x.followed).map((x) => x.id)).size}/5`,
    );
  writeFileSync(join(dir, 'table.md'), lines.join('\n') + '\n');
  writeFileSync(join(dir, 'table.json'), JSON.stringify(grades, null, 1));
  console.log(lines.join('\n'));
}

if (command === 'picture') {
  const grades = readGrades();
  const CELL = 200,
    GAP = 6,
    COL = CELL + GAP,
    LABEL = 190;
  const WORD = { fix: '빠른 선택', ko: '한국어 글', none: '아무것도 안 씀' };
  const heads = ['이전 답', '가이드', ...SHEET_ARMS.map(([f, w]) => `${f} · ${WORD[w]}`)];
  const width = LABEL + heads.length * COL + GAP;
  const comp = [
    {
      input: svg(
        width,
        28,
        heads.map((t, i) => [t, 15, 20, 700, LABEL + i * COL + 4]),
      ),
      left: 0,
      top: 0,
    },
  ];
  let y = 30;
  for (const [id, view, method, fault, fixLabel, ko] of CASES) {
    const product = manifest[id].rep;
    comp.push({
      input: svg(LABEL, CELL, [
        [`${id} ${view}`, 18, 24, 700],
        [`문제: ${fault}`, 13, 48],
        [`빠른 선택: ${fixLabel}`, 12, 70],
        [`글: ${ko.slice(0, 14)}`, 12, 90],
        [ko.length > 14 ? ko.slice(14) : '', 12, 108],
      ]),
      left: 0,
      top: y,
    });
    const files = [
      earlier(id, method, view),
      product.guides.G[view],
      ...SHEET_ARMS.map(([f, w]) => answer(id, view, f, w)),
    ];
    for (const [i, f] of files.entries()) {
      if (!existsSync(f)) continue;
      comp.push({ input: await tile(f, CELL), left: LABEL + i * COL, top: y });
      if (i < 2) continue;
      const [frame, words] = SHEET_ARMS[i - 2];
      const g = grades.find((x) => x.id === id && x.frame === frame && x.words === words);
      if (g)
        comp.push({
          input: svg(CELL, 20, [
            [
              `${g.followed ? '따름' : '안 따름'} · ${g.kept ? '나머지 지킴' : '나머지 깨짐'} · ${{ b: '나음', s: '같음', w: '못함' }[g.against]}`,
              12,
              15,
            ],
          ]),
          left: LABEL + i * COL,
          top: y + CELL - 20,
        });
    }
    y += COL;
  }
  const file = join(OUT, `고칠점-${process.env.NAME ?? engine}.png`);
  await sharp({ create: { width, height: y, channels: 3, background: '#e9e9e9' } })
    .composite(comp)
    .png()
    .toFile(file);
  console.log(file);
}
