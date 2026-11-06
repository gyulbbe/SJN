/**
 * Guide images for each sanitary-ware class (classes.ts), drawn in Chrome as the app draws its guide,
 * with a sheet per kind (the representative product's photo beside its class's guides) and two
 * tables. No AI, no network beyond this machine.
 *
 *   node tests/run-browser-test.mjs tests/sanitary-guides/render.ts <out dir> <photos dir> [class ids]
 *
 * <photos dir> is the collection (test-results/위생도기-화신-20261106: 목록.csv and the photos).
 * Run from the repository (an ASCII working directory: sharp crashes on relative paths under a Korean one).
 */
import { build } from 'esbuild';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';
import sharp, { type OverlayOptions } from 'sharp';
import { CLASSES, directionsOf, type SanitaryClass } from './classes';

const [OUT, PHOTOS, only] = process.argv.slice(3);
if (!OUT || !PHOTOS) throw new Error('usage: render.ts <out dir> <photos dir> [class ids]');
const classes = only ? CLASSES.filter((c) => only.split(',').includes(c.id)) : CLASSES;

// ---------- the collection: product names and photos ----------
const parseCsv = (line: string) => {
  const out: string[] = [];
  let cur = '',
    quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
};
const [head, ...lines] = readFileSync(path.join(PHOTOS, '목록.csv'), 'utf8')
  .replace(/^﻿/, '')
  .split(/\r?\n/)
  .filter(Boolean);
const columns = parseCsv(head);
const products = new Map(
  lines.map((line) => {
    const row = Object.fromEntries(parseCsv(line).map((v, i) => [columns[i], v]));
    return [Number(row.product_cd), row];
  }),
);
const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
  );
const photoOf = new Map<number, string>();
for (const file of walk(PHOTOS)) {
  const m = path.basename(file).match(/\[(\d+)\]_1\.\w+$/);
  if (m) photoOf.set(Number(m[1]), file);
}
const allMembers = CLASSES.flatMap((c) => c.members);
const missing = [...products.keys()].filter((cd) => !allMembers.includes(cd));
const twice = allMembers.filter((cd, i) => allMembers.indexOf(cd) !== i);
const unknown = allMembers.filter((cd) => !products.has(cd));
if (missing.length || twice.length || unknown.length)
  throw new Error(`classes: missing ${missing}, twice ${twice}, unknown ${unknown}`);

// ---------- draw in Chrome ----------
const bundle = await build({
  entryPoints: ['tests/sanitary-guides/browser.ts'],
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'esm',
  logLevel: 'warning',
});
const server = createServer((req, res) => {
  if (req.url === '/app.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    res.end(bundle.outputFiles[0].text);
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
  }
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--enable-gpu'],
});
type Drawn = { direction: string; width: number; height: number; png: string };
const drawn = new Map<string, Drawn[]>();
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto(`${origin}/`);
  for (const c of classes) {
    const guides = await page.evaluate(async (cls) => {
      const url = '/app.js';
      const app = (await import(url)) as { drawClass: (c: unknown) => Promise<Drawn[]> };
      return app.drawClass(cls);
    }, c);
    drawn.set(c.id, guides);
    const dir = path.join(OUT, c.kind, `${c.id} ${c.name}`);
    mkdirSync(dir, { recursive: true });
    for (const g of guides) writeFileSync(path.join(dir, `${g.direction}.png`), Buffer.from(g.png, 'base64'));
    console.log(c.id, c.name, guides.map((g) => `${g.direction} ${g.width}x${g.height}`).join(', '));
  }
} finally {
  await browser.close();
  server.close();
}

// ---------- sheets: per kind, a row per class ----------
const CELL = 250,
  GAP = 8,
  LABEL = 230,
  ROW = CELL + 16;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const text = (lines: [string, number, number?][], w: number, h: number) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${lines
      .map(
        ([t, size, weight = 400], i) =>
          `<text x="4" y="${24 + i * 26}" font-family="Malgun Gothic" font-size="${size}" font-weight="${weight}" fill="#111">${esc(t)}</text>`,
      )
      .join('')}</svg>`,
  );
const tile = async (input: string | Buffer) =>
  sharp(input)
    .flatten({ background: '#ffffff' })
    .resize(CELL, CELL, { fit: 'contain', background: '#ffffff' })
    .png()
    .toBuffer();
const HEADS = ['대표 사진', '정면', '왼쪽', '오른쪽', '뒤'];
for (const kind of [...new Set(classes.map((c) => c.kind))]) {
  const rows = classes.filter((c) => c.kind === kind);
  const width = LABEL + 5 * (CELL + GAP) + GAP;
  const comp: OverlayOptions[] = [];
  for (const [i, h] of HEADS.entries())
    comp.push({ input: text([[h, 20, 700]], CELL, 34), left: LABEL + GAP + i * (CELL + GAP), top: 4 });
  let y = 40;
  for (const c of rows) {
    const rep = products.get(c.rep)!;
    const [w, h, d] = c.sizeMm;
    comp.push({
      input: text(
        [
          [`${c.id} ${c.name}`, 19, 700],
          [`${w}×${h}×${d} mm (폭×높이×깊이)`, 15],
          [
            `제품 ${c.members.length}개 · ${c.installation === 'wall' ? '벽·상판' : c.installation === 'embedded' ? '바닥에 묻음' : '바닥'}`,
            15,
          ],
          [`대표: ${rep['품번']}`.slice(0, 26), 15],
          ...(c.note ? ([[c.note.slice(0, 26), 13]] as [string, number][]) : []),
          ...(c.note && c.note.length > 26 ? ([[c.note.slice(26, 52), 13]] as [string, number][]) : []),
        ],
        LABEL,
        ROW,
      ),
      left: 0,
      top: y,
    });
    const photo = photoOf.get(c.rep);
    if (photo) comp.push({ input: await tile(photo), left: LABEL + GAP, top: y });
    for (const g of drawn.get(c.id) ?? []) {
      const col = HEADS.indexOf(g.direction);
      comp.push({
        input: await tile(Buffer.from(g.png, 'base64')),
        left: LABEL + GAP + col * (CELL + GAP),
        top: y,
      });
    }
    y += ROW;
  }
  await sharp({ create: { width, height: y + 8, channels: 3, background: '#eeeeee' } })
    .composite(comp)
    .png()
    .toFile(path.join(OUT, `가이드-한눈에_${kind}${only ? '_일부' : ''}.png`));
}

// ---------- tables ----------
const csv = (rows: (string | number)[][]) =>
  '﻿' +
  rows
    .map((r) => r.map((v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v)).join(','))
    .join('\r\n') +
  '\r\n';
const modelName = (c: SanitaryClass) =>
  c.model.from === 'app'
    ? `앱 표준 모형(${c.model.form}${c.model.skirt ? ', ' + c.model.skirt : ''})`
    : c.model.from === 'trial'
      ? `방향 사진 시험 형태(${c.model.shape})`
      : `새 형태(${c.model.shape})`;
if (!only) {
  writeFileSync(
    path.join(OUT, '분류표.csv'),
    csv([
      [
        '분류',
        '대분류',
        '이름',
        '설치',
        '폭(mm)',
        '높이(mm)',
        '깊이(mm)',
        '방향',
        '가이드 모형',
        '제품 수',
        '대표 제품',
        '비고',
      ],
      ...CLASSES.map((c) => [
        c.id,
        c.kind,
        c.name,
        c.installation,
        ...c.sizeMm,
        directionsOf(c).join(' '),
        modelName(c),
        c.members.length,
        products.get(c.rep)!['품번'],
        c.note ?? '',
      ]),
    ]),
  );
  writeFileSync(
    path.join(OUT, '제품별 분류.csv'),
    csv([
      [
        '브랜드',
        '사이트 대분류',
        '사이트 소분류',
        '품번',
        '설명',
        '규격',
        '가이드 분류',
        '가이드 이름',
        'product_cd',
      ],
      ...CLASSES.flatMap((c) =>
        c.members.map((cd) => {
          const p = products.get(cd)!;
          return [p['브랜드'], p['대분류'], p['소분류'], p['품번'], p['설명'], p['규격'], c.id, c.name, cd];
        }),
      ),
    ]),
  );
}
console.log(`done: ${classes.length} classes → ${OUT}`);
