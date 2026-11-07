// Grading and pictures of the sanitary-ware AI direction-photo trial (docs/sanitary-direction-photos-20261107.md).
// No AI. Run from the repository (an ASCII working directory: sharp crashes on relative paths under a
// Korean one).
//
//   node tests/sanitary-guides/review.mjs sheets <engine> <rep|other>
//     Blind sheets: a row per class and view, the product's photo, then its candidates (G 1001·1002, and
//     C0 1001 for rep) in a seeded random order, lettered A, B, C; which is which stays in key.json.
//     → review/<engine>-<set>/page-NN.png, key.json
//   node tests/sanitary-guides/review.mjs scores <engine>
//     Each answer's outline against its own guide's (IoU) → review/<engine>-scores.json
//   node tests/sanitary-guides/review.mjs table <engine> <rep|other>
//     The grades (ratings-claude.txt, written before the key is opened: "<class> <view> <letter> <1|2|3> <y|n> [o k b c u]";
//     c colour or material unlike the photo, u could be registered as it is — Cloudflare only)
//     with the key and the scores: per class pass or fail, G against C0 → review/<engine>-<set>/table.json, table.md
//   node tests/sanitary-guides/review.mjs versus <engine> <set dir> <method A> <method B>
//     Two methods graded on the same sheets (METHODS=A,B NAME=<dir> sheets): per method the answers'
//     view and kind, per class view whether 1 of its 2 answers is right, and A against B per view
//   node tests/sanitary-guides/review.mjs both
//     The views made on both engines: the photo, the guide, the local answer and Cloudflare's (seed 1001),
//     with Claude's grade of the Cloudflare answer → 결과-cloudflare-N.png
//   node tests/sanitary-guides/review.mjs results <engine>
//     Per kind, a block per class: its photo and guides, then the answers → 결과-<engine>_<kind>.png
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { iou, outline } from '../direction-photo-real/measure.mjs';
import { OUT, PREP } from './paths.mjs';

const [command, engine, set] = process.argv.slice(2);
const manifest = JSON.parse(readFileSync(join(PREP, 'manifest.json'), 'utf8'));
const RUNS = join(OUT, 'runs', engine ?? '');
const VIEWS = ['front', 'left', 'right', 'back'];
const KOREAN = { front: '정면', left: '왼쪽', right: '오른쪽', back: '뒤' };
const KINDS = { T: '양변기', B: '세면대', U: '소변기', A: '욕조' };
const order = (a, b) =>
  'TBUA'.indexOf(a[0]) - 'TBUA'.indexOf(b[0]) || Number(a.slice(1)) - Number(b.slice(1));
const ids = Object.keys(manifest).sort(order);
const answer = (id, who, method, view, seed) => join(RUNS, id, who, method, `${view}-${seed}.png`);
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

/**
 * The candidates of a class, view and set: [method, seed, file] that exist. METHODS (comma-separated)
 * picks the methods; by default G and, for a representative, C0 (C0 was made with seed 1001 only).
 */
const METHODS = process.env.METHODS?.split(',');
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : undefined;
function candidates(id, who, view) {
  const methods = METHODS ?? ['G', ...(who === 'rep' ? ['C0'] : [])];
  const list = methods.flatMap((m) =>
    m === 'C0'
      ? [[m, 1001]]
      : [
          [m, 1001],
          [m, 1002],
        ],
  );
  return list
    .map(([method, seed]) => [method, seed, answer(id, who, method, view, seed)])
    .filter(([, , file]) => existsSync(file));
}
/** Views that have a guide for this product (the app's), in order. */
const viewsOf = (id, who) => VIEWS.filter((v) => manifest[id][who]?.guides.G?.[v]);

if (command === 'sheets') {
  const dir = join(OUT, 'review', process.env.NAME ?? `${engine}-${set}`);
  mkdirSync(dir, { recursive: true });
  let seed = 20261107;
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rows = [];
  for (const id of ids)
    for (const view of viewsOf(id, set).filter((v) => !ONLY || ONLY.has(`${id}:${v}`))) {
      const list = candidates(id, set, view);
      if (!list.length) continue;
      for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [list[i], list[j]] = [list[j], list[i]];
      }
      rows.push({ id, view, photo: manifest[id][set].ref, guide: manifest[id][set].guides.G[view], list });
    }
  const CELL = 300,
    LABEL = 120,
    PER = 5;
  const key = {};
  for (let p = 0; p * PER < rows.length; p++) {
    const page = rows.slice(p * PER, (p + 1) * PER);
    const comp = [];
    for (const [r, row] of page.entries()) {
      const top = r * (CELL + 30);
      comp.push({
        input: svg(LABEL, CELL, [
          [row.id, 26, 34, 700],
          [`${KOREAN[row.view]} (${row.view})`, 18, 64],
        ]),
        left: 0,
        top,
      });
      comp.push({ input: await tile(row.photo, CELL), left: LABEL, top });
      comp.push({ input: svg(CELL, 26, [['제품 사진', 16, 20]]), left: LABEL, top: top + CELL });
      // Cloudflare ran one method (G) only: its guide beside the answer unblinds nothing and shows the
      // view meant (the methods trial's lesson: a basin side reads as a front without its guide).
      if (engine === 'cf') {
        const left = LABEL + 3 * (CELL + 8);
        comp.push({ input: await tile(row.guide, CELL), left, top });
        comp.push({ input: svg(CELL, 26, [['가이드', 16, 20]]), left, top: top + CELL });
      }
      for (const [k, [method, s, file]] of row.list.entries()) {
        const letter = 'ABCD'[k];
        key[`${row.id} ${row.view} ${letter}`] = { method, seed: s, file };
        const left = LABEL + (k + 1) * (CELL + 8);
        comp.push({ input: await tile(file, CELL), left, top });
        comp.push({ input: svg(CELL, 26, [[letter, 20, 21, 700]]), left, top: top + CELL });
      }
    }
    const width = LABEL + (1 + Math.max(3, ...page.map((r) => r.list.length))) * (CELL + 8),
      height = page.length * (CELL + 30);
    await sharp({ create: { width, height, channels: 3, background: '#e4e4e4' } })
      .composite(comp)
      .png()
      .toFile(join(dir, `page-${String(p + 1).padStart(2, '0')}.png`));
  }
  writeFileSync(join(dir, 'key.json'), JSON.stringify(key, null, 1));
  console.log(`${rows.length} rows on ${Math.ceil(rows.length / PER)} pages → ${dir}`);
}

if (command === 'scores') {
  const out = [];
  const cache = new Map();
  const outlineOf = async (file) => {
    if (!cache.has(file)) cache.set(file, await outline(file));
    return cache.get(file);
  };
  for (const id of ids)
    for (const who of ['rep', 'other']) {
      const product = manifest[id][who];
      if (!product) continue;
      for (const method of ['G', 'C0', 'G2'])
        for (const view of VIEWS) {
          const guide = product.guides[method === 'C0' ? 'C0' : 'G']?.[view];
          if (!guide) continue;
          for (const seed of [1001, 1002]) {
            const file = answer(id, who, method, view, seed);
            if (!existsSync(file)) continue;
            const a = await outlineOf(file);
            const g = await outlineOf(guide);
            // Against the class's guide too: does C0's answer still come out the class's shape?
            const cls = product.guides.G[view];
            out.push({
              id,
              who,
              method,
              view,
              seed,
              iou: Number(iou(g.mask, a.mask).toFixed(3)),
              iouClass: Number(iou((await outlineOf(cls)).mask, a.mask).toFixed(3)),
              aspect: Number(a.aspect.toFixed(2)),
              aspectGuide: Number(g.aspect.toFixed(2)),
            });
          }
        }
    }
  writeFileSync(join(OUT, 'review', `${engine}-scores.json`), JSON.stringify(out, null, 1));
  console.log(`${out.length} answers scored`);
}

if (command === 'table') {
  const dir = join(OUT, 'review', `${engine}-${set}`);
  const key = JSON.parse(readFileSync(join(dir, 'key.json'), 'utf8'));
  const scores = JSON.parse(readFileSync(join(OUT, 'review', `${engine}-scores.json`), 'utf8'));
  const grades = {};
  for (const line of readFileSync(join(dir, 'ratings-claude.txt'), 'utf8').split(/\r?\n/)) {
    const m = line.trim().match(/^(\S+) (\S+) ([ABC]) ([123]) ([yn])(?: (.*))?$/);
    if (!m) continue;
    const [, id, view, letter, dir_, same, problems = ''] = m;
    const k = key[`${id} ${view} ${letter}`];
    if (!k) throw new Error(`no key for ${id} ${view} ${letter}`);
    grades[`${id} ${view} ${letter}`] = {
      id,
      view,
      ...k,
      dir: Number(dir_),
      same: same === 'y',
      problems: problems.trim(),
    };
  }
  const missing = Object.keys(key).filter((k) => !grades[k]);
  if (missing.length) throw new Error(`not graded: ${missing.join(', ')}`);
  const correctionsFile = join(dir, 'after-key-corrections.json');
  const corrections = existsSync(correctionsFile) ? JSON.parse(readFileSync(correctionsFile, 'utf8')) : {};
  for (const [k, change] of Object.entries(corrections)) Object.assign(grades[k], change);
  const scoreOf = (g) =>
    scores.find(
      (s) =>
        s.id === g.id && s.who === set && s.method === g.method && s.view === g.view && s.seed === g.seed,
    );
  const good = (g) => g && g.dir === 1 && g.same;
  const all = Object.values(grades).map((g) => ({
    ...g,
    iou: scoreOf(g)?.iou,
    iouClass: scoreOf(g)?.iouClass,
  }));
  const classes = {};
  for (const g of all) {
    const c = (classes[g.id] ??= { id: g.id, views: {} });
    (c.views[g.view] ??= []).push(g);
  }
  const lines = [
    `| 분류 | 방향 | G 1001 | G 1002 | ${set === 'rep' ? 'C0 1001 | G와 C0 |' : ''}`,
    `| --- | --- | --- | --- | ${set === 'rep' ? '--- | --- |' : ''}`,
  ];
  const cell = (g) =>
    g ? `${g.dir}${g.same ? 'y' : 'n'}${g.problems ? ' ' + g.problems : ''} (${g.iou ?? '-'})` : '-';
  const compare = { better: 0, same: 0, worse: 0 };
  const summary = [];
  for (const c of Object.values(classes).sort((a, b) => order(a.id, b.id))) {
    let pass = true;
    for (const view of VIEWS.filter((v) => c.views[v])) {
      const list = c.views[view];
      const g1 = list.find((g) => g.method === 'G' && g.seed === 1001);
      const g2 = list.find((g) => g.method === 'G' && g.seed === 1002);
      const c0 = list.find((g) => g.method === 'C0');
      if (!good(g1) && !good(g2)) pass = false;
      let versus = '';
      if (c0 && g1) {
        const rank = (g) => (good(g) ? 2 : g.dir === 1 || g.same ? 1 : 0);
        const d =
          rank(g1) - rank(c0) ||
          Math.sign((g1.iou ?? 0) - (c0.iou ?? 0)) * (Math.abs((g1.iou ?? 0) - (c0.iou ?? 0)) > 0.05);
        versus = d > 0 ? 'G 나음' : d < 0 ? 'G 못함' : '같음';
        compare[d > 0 ? 'better' : d < 0 ? 'worse' : 'same']++;
      }
      lines.push(
        `| ${c.id} | ${KOREAN[view]} | ${cell(g1)} | ${cell(g2)} | ${set === 'rep' ? `${cell(c0)} | ${versus} |` : ''}`,
      );
    }
    summary.push({ id: c.id, pass });
  }
  const passed = summary.filter((s) => s.pass).map((s) => s.id);
  const failed = summary.filter((s) => !s.pass).map((s) => s.id);
  const head = [
    `통과 ${passed.length}/${summary.length}: ${passed.join(' ')}`,
    `통과 못 함: ${failed.join(' ')}`,
    ...(set === 'rep'
      ? [
          `G와 C0(seed 1001, 방향 ${compare.better + compare.same + compare.worse}개): G 나음 ${compare.better}, 같음 ${compare.same}, G 못함 ${compare.worse}`,
        ]
      : []),
    `칸: 방향(1 맞음·2 살짝·3 틀림) 종류(y/n) 문제(o 없던 물건·k 다른 종류·b 배경) (가이드와 윤곽 겹침)`,
    '',
  ];
  writeFileSync(join(dir, 'table.md'), head.join('\n') + lines.join('\n') + '\n');
  writeFileSync(join(dir, 'table.json'), JSON.stringify({ passed, failed, compare, grades: all }, null, 1));
  console.log(head.join('\n'));
}

if (command === 'results') {
  // Compact sheets for a person: a class per block, its photo then the first answer (seed 1001) of each
  // view made with the class guide, and below it the app's current guide's answer (C0) when there is one.
  // Representative products by kind (13 classes a page), then the unseen products.
  const CELL = 190,
    GAP = 6,
    COL = CELL + GAP;
  const width = 5 * COL + GAP;
  const pages = [];
  for (const [prefix, kind] of Object.entries(KINDS)) {
    const list = ids.filter((i) => i.startsWith(prefix));
    for (let p = 0; p * 13 < list.length; p++)
      pages.push({
        name: `${kind}${list.length > 13 ? `-${p + 1}` : ''}`,
        who: 'rep',
        ids: list.slice(p * 13, (p + 1) * 13),
      });
  }
  const unseen = ids.filter((i) => manifest[i].other);
  for (let p = 0; p * 13 < unseen.length; p++)
    pages.push({ name: `안본제품-${p + 1}`, who: 'other', ids: unseen.slice(p * 13, (p + 1) * 13) });
  for (const page of pages) {
    const comp = [
      {
        input: svg(
          width,
          30,
          ['정면', '왼쪽', '오른쪽', '뒤'].map((t, i) => [t, 20, 24, 700, (i + 1) * COL + 8]),
        ),
        left: 0,
        top: 0,
      },
    ];
    let y = 34;
    for (const id of page.ids) {
      const product = manifest[id][page.who];
      const rows = [['분류 가이드', 'G'], ...(product.guides.C0 ? [['지금 앱 가이드', 'C0']] : [])];
      const [w, h, d] = product.sizeMm;
      comp.push({
        input: svg(width, 24, [[`${id} · ${product.name} · ${w}×${h}×${d} mm`, 15, 18, 700]]),
        left: 0,
        top: y,
      });
      y += 24;
      for (const [r, [, method]] of rows.entries()) {
        if (r === 0) comp.push({ input: await tile(product.ref, CELL), left: GAP, top: y });
        for (const [i, v] of VIEWS.entries()) {
          const file = answer(id, page.who, method, v, 1001);
          if (existsSync(file))
            comp.push({ input: await tile(file, CELL), left: (i + 1) * COL + GAP, top: y });
        }
        if (r > 0)
          comp.push({
            input: svg(CELL, 60, [
              ['↓ 지금 앱 가이드로', 14, 22],
              ['만든 것', 14, 42],
            ]),
            left: GAP,
            top: y + CELL / 2 - 30,
          });
        else if (rows.length > 1)
          comp.push({
            input: svg(CELL, 22, [['↑ 분류 가이드로 만든 것 →', 12, 16]]),
            left: GAP,
            top: y + CELL - 22,
          });
        y += COL;
      }
      y += 10;
    }
    await sharp({ create: { width, height: y, channels: 3, background: '#e9e9e9' } })
      .composite(comp)
      .png()
      .toFile(join(OUT, `결과-${engine}_${page.name}.png`));
    console.log(page.name, y);
  }
}

if (command === 'both') {
  const key = JSON.parse(readFileSync(join(OUT, 'review', 'cf-rep', 'key.json'), 'utf8'));
  const table = JSON.parse(readFileSync(join(OUT, 'review', 'cf-rep', 'table.json'), 'utf8'));
  const CELL = 200,
    GAP = 6,
    COL = CELL + GAP,
    LABEL = 170;
  const rows = Object.keys(key).map((k) => {
    const [id, view] = k.split(' ');
    return { id, view, grade: table.grades.find((g) => g.id === id && g.view === view) };
  });
  const heads = ['제품 사진', '분류 가이드', '무료 FLUX', 'Cloudflare'];
  const PER = 21;
  for (let p = 0; p * PER < rows.length; p++) {
    const page = rows.slice(p * PER, (p + 1) * PER);
    const width = LABEL + 4 * COL + GAP;
    const comp = [
      {
        input: svg(
          width,
          30,
          heads.map((t, i) => [t, 18, 22, 700, LABEL + i * COL + 8]),
        ),
        left: 0,
        top: 0,
      },
    ];
    let y = 32;
    for (const { id, view, grade } of page) {
      const product = manifest[id].rep;
      const verdict = grade.dir === 1 ? '방향 맞음' : grade.dir === 2 ? '살짝 돎' : '사진 각도로 돎';
      comp.push({
        input: svg(LABEL, CELL, [
          [id, 22, 30, 700],
          [KOREAN[view], 17, 56],
          [verdict, 14, 90, grade.dir === 1 ? 700 : 400],
          [grade.same ? '종류 같음' : '종류 다름', 14, 112],
          ...(grade.problems.includes('c') ? [['색 다름', 14, 134]] : []),
          ...(grade.problems.includes('u') ? [['그대로 등록 가능', 14, 156, 700]] : []),
        ]),
        left: 0,
        top: y,
      });
      const files = [
        product.ref,
        product.guides.G[view],
        join(OUT, 'runs', 'local', id, 'rep', 'G', `${view}-1001.png`),
        join(OUT, 'runs', 'cf', id, 'rep', 'G', `${view}-1001.png`),
      ];
      for (const [i, f] of files.entries())
        if (existsSync(f)) comp.push({ input: await tile(f, CELL), left: LABEL + i * COL, top: y });
      y += COL;
    }
    await sharp({ create: { width, height: y, channels: 3, background: '#e9e9e9' } })
      .composite(comp)
      .png()
      .toFile(join(OUT, `결과-cloudflare-${p + 1}.png`));
    console.log('page', p + 1, y);
  }
}

if (command === 'versus') {
  const [, , , , name, a, b] = process.argv;
  const dir = join(OUT, 'review', name);
  const key = JSON.parse(readFileSync(join(dir, 'key.json'), 'utf8'));
  const grades = [];
  for (const line of readFileSync(join(dir, 'ratings-claude.txt'), 'utf8').split(/\r?\n/)) {
    const m = line.trim().match(/^(\S+) (\S+) ([ABCD]) ([123]) ([yn])(?: (.*))?$/);
    if (!m) continue;
    const k = key[`${m[1]} ${m[2]} ${m[3]}`];
    if (!k) throw new Error(`no key for ${m[1]} ${m[2]} ${m[3]}`);
    grades.push({
      id: m[1],
      view: m[2],
      ...k,
      dir: Number(m[4]),
      same: m[5] === 'y',
      problems: (m[6] ?? '').trim(),
    });
  }
  if (grades.length !== Object.keys(key).length)
    throw new Error(`graded ${grades.length} of ${Object.keys(key).length}`);
  const good = (g) => g.dir === 1 && g.same;
  const lines = [];
  for (const method of [a, b]) {
    const list = grades.filter((g) => g.method === method);
    lines.push(
      `${method}: ${list.length}장 · 방향 맞음 ${list.filter((g) => g.dir === 1).length} · 살짝 ${list.filter((g) => g.dir === 2).length} · 틀림 ${list.filter((g) => g.dir === 3).length} · 종류 같음 ${list.filter((g) => g.same).length} · 배경 ${list.filter((g) => g.problems.includes('b')).length}`,
    );
  }
  const slots = [...new Set(grades.map((g) => `${g.id} ${g.view}`))];
  const pass = { [a]: 0, [b]: 0 };
  const versus = { better: [], same: [], worse: [] };
  const rows = ['| 분류 | 방향 | ' + a + ' | ' + b + ' |', '| --- | --- | --- | --- |'];
  for (const slot of slots) {
    const of = (m) => grades.filter((g) => `${g.id} ${g.view}` === slot && g.method === m);
    const score = (m) => of(m).filter(good).length * 10 + of(m).filter((g) => g.dir === 2).length;
    for (const m of [a, b]) if (of(m).some(good)) pass[m]++;
    const d = score(b) - score(a);
    versus[d > 0 ? 'better' : d < 0 ? 'worse' : 'same'].push(slot);
    const cell = (m) =>
      of(m)
        .map((g) => `${g.dir}${g.same ? 'y' : 'n'}${g.problems ? ' ' + g.problems : ''}`)
        .join(', ');
    const [id, view] = slot.split(' ');
    rows.push(`| ${id} | ${KOREAN[view]} | ${cell(a)} | ${cell(b)} |`);
  }
  lines.push(`2장 중 1장 이상 방향·종류 맞음(${slots.length}곳): ${a} ${pass[a]} · ${b} ${pass[b]}`);
  lines.push(`${b}가 나음 ${versus.better.length}: ${versus.better.join(', ')}`);
  lines.push(`같음 ${versus.same.length} · ${b}가 못함 ${versus.worse.length}: ${versus.worse.join(', ')}`);
  writeFileSync(join(dir, 'table.md'), lines.join('\n') + '\n\n' + rows.join('\n') + '\n');
  writeFileSync(join(dir, 'table.json'), JSON.stringify({ pass, versus, grades }, null, 1));
  console.log(lines.join('\n'));
}
