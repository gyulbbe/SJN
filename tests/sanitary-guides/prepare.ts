/**
 * Preparation of the sanitary-ware AI direction-photo trial (docs/sanitary-direction-photos-20261107.md),
 * no AI: for every class, in a real Chrome on the GPU,
 *
 * - its representative product ("rep") and one member not looked at while making the shapes ("other":
 *   the first member whose photo is not the representative's and whose size the site gives),
 * - their photos as the material form prepares them (BiRefNet, then prepareReferenceImage),
 * - G: the class's guide at each product's own size, for the views the app makes (prompts.ts viewsOf),
 * - C0: the app's closest standard model for the representative, where the class's shape is not the app's.
 *
 * Everything goes to <OUT>/prep/<class>/<rep|other>/, listed in prep/manifest.json, with a sheet of the
 * cut-out photos to look at before any run.
 *
 *   node tests/run-browser-test.mjs tests/sanitary-guides/prepare.ts [class ids]
 */
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import sharp, { type OverlayOptions } from 'sharp';
import { BACKGROUND_MODEL } from '../direction-photo-methods/paths.mjs';
import { appSize, readCatalog, seriesOf } from './catalog';
import { CLASSES, type SanitaryClass } from './classes';
import { PHOTOS, PREP } from './paths.mjs';
import { APP_FORM, KOREAN_VIEW, NO_C0, viewsOf } from './prompts';

const only = process.argv.slice(3).filter((a) => !a.startsWith('--'));
const classes = only.length ? CLASSES.filter((c) => only.join(',').split(',').includes(c.id)) : CLASSES;
mkdirSync(PREP, { recursive: true });
const catalog = readCatalog(PHOTOS);
/**
 * A photo at 32 × 32 in grey. The site puts one set photo on a two-piece's or a pedestal's upper and
 * lower items and on a colour's twins: those come out the same to the pixel (measured 2026-11-07: 0),
 * while two products' renders that only look alike differ by 25 or more somewhere.
 */
const look = async (file: string) =>
  sharp(file).flatten({ background: '#ffffff' }).resize(32, 32, { fit: 'fill' }).greyscale().raw().toBuffer();
const sameLook = (a: Buffer, b: Buffer) => a.every((v, i) => Math.abs(v - b[i]) <= 2);

export type Who = 'rep' | 'other';
export type PreparedProduct = {
  cd: number;
  name: string;
  photo: string;
  sizeMm: [number, number, number];
  ref: string;
  cutout: string;
  /** method → view (front, left, …) → guide file */
  guides: Partial<Record<'G' | 'C0', Record<string, string>>>;
};
export type Manifest = Record<string, Partial<Record<Who, PreparedProduct>> & { otherNote?: string }>;

type Job = {
  id: string;
  who: Who;
  cls: SanitaryClass;
  cd: number;
  sizeMm: [number, number, number];
  photo: string;
  c0?: string;
};
const jobs: Job[] = [];
const notes: Record<string, string> = {};
for (const c of classes) {
  const repPhoto = catalog.photos.get(c.rep)?.[0];
  if (!repPhoto) throw new Error(`${c.id}: no photo of ${c.rep}`);
  jobs.push({
    id: c.id,
    who: 'rep',
    cls: c,
    cd: c.rep,
    sizeMm: c.sizeMm,
    photo: repPhoto,
    ...(c.model.from !== 'app' && !NO_C0.has(c.id) && { c0: APP_FORM[c.id] }),
  });
  // The other product: the first member of another series whose photo is not the representative's
  // render again; failing that, the first member of the same series with a photo of its own.
  const repLook = await look(repPhoto);
  const repSeries = seriesOf(catalog.rows.get(c.rep)?.['품번'] ?? '');
  const candidates: { cd: number; photo: string; size: [number, number, number]; series: string }[] = [];
  let reason = c.members.length === 1 ? '제품이 하나뿐' : '대표와 다른 사진이 없음';
  for (const cd of c.members) {
    if (cd === c.rep) continue;
    const photo = catalog.photos.get(cd)?.[0];
    if (!photo || sameLook(repLook, await look(photo))) continue;
    const size = appSize(c.kind, catalog.rows.get(cd)?.['규격'] ?? '');
    if (!size) {
      reason = '다른 사진의 제품에 규격이 없음';
      continue;
    }
    // A towel-rail basin's guide adds its 60 mm rail to the catalogue height, as the class does.
    if (c.id === 'B7') size[1] += 60;
    candidates.push({ cd, photo, size, series: seriesOf(catalog.rows.get(cd)?.['품번'] ?? '') });
  }
  const other = candidates.find((m) => m.series !== repSeries) ?? candidates[0];
  if (other) {
    jobs.push({ id: c.id, who: 'other', cls: c, cd: other.cd, sizeMm: other.size, photo: other.photo });
    if (other.series === repSeries) notes[c.id] = '다른 시리즈가 없어 같은 시리즈의 다른 제품';
  } else notes[c.id] = reason;
}

// ---------- the browser page: the class guides, the app's models and the photo preparation ----------
const server = createServer();
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const rewrite = (file: string, from: string, to: string) => {
  const source = readFileSync(file, 'utf8');
  if (!source.includes(from)) throw new Error(`${file}: ${from} 없음`);
  return source.replace(from, to);
};
const local = {
  name: 'local-background-removal',
  setup(plugin: {
    onLoad: (
      options: { filter: RegExp },
      load: (args: { path: string }) => { contents: string; loader: 'ts' },
    ) => void;
  }) {
    plugin.onLoad({ filter: /background-removal[\\/]client\.ts$/ }, ({ path: file }) => ({
      contents: rewrite(
        file,
        "new URL('./worker.ts', import.meta.url)",
        "new URL('./worker.js', import.meta.url)",
      ),
      loader: 'ts',
    }));
    plugin.onLoad({ filter: /background-removal[\\/]model\.ts$/ }, ({ path: file }) => {
      const runtime = rewrite(
        file,
        "'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.29.0/dist/'",
        `'${origin}/'`,
      );
      const modelUrl =
        '`https://huggingface.co/${BACKGROUND_MODEL_ID}/resolve/${BACKGROUND_MODEL_REVISION}/onnx/';
      if (!runtime.includes(modelUrl)) throw new Error(`${file}: 모델 주소 없음`);
      return { contents: runtime.replace(modelUrl, '`' + origin + '/'), loader: 'ts' };
    });
  },
};
const bundles = new Map<string, string>();
for (const [route, entry] of [
  ['/bg/app.js', 'tests/sanitary-guides/browser.ts'],
  ['/bg/worker.js', 'src/lib/background-removal/worker.ts'],
] as const) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'esm',
    logLevel: 'warning',
    plugins: [local],
  });
  bundles.set(route, result.outputFiles[0].text);
}
const runtime = path.resolve('node_modules/onnxruntime-web/dist');
server.on('request', (req, res) => {
  const route = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (bundles.has(route)) {
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    res.end(bundles.get(route));
    return;
  }
  if (route === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
    return;
  }
  const name = path.basename(route);
  const file = path.join(name.endsWith('.onnx') ? BACKGROUND_MODEL : runtime, name);
  if (!existsSync(file)) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, {
    'Content-Type': file.endsWith('.wasm')
      ? 'application/wasm'
      : /\.m?js$/.test(file)
        ? 'text/javascript'
        : 'application/octet-stream',
    'Content-Length': statSync(file).size,
    'Access-Control-Allow-Origin': '*',
  });
  createReadStream(file).pipe(res);
});

const manifestFile = path.join(PREP, 'manifest.json');
const manifest: Manifest = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, 'utf8')) : {};
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: [
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--use-angle=d3d11',
    '--enable-gpu',
    '--enable-unsafe-webgpu',
  ],
});
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto(`${origin}/`);
  for (const job of jobs) {
    const views = viewsOf(job.cls);
    const made = await page.evaluate(
      async ({ cls, sizeMm, c0, directions, photo }) => {
        type Drawn = { direction: string; png: string };
        type App = {
          drawClass: (c: unknown, o: unknown) => Promise<Drawn[]>;
          encode: (b: Blob) => Promise<string>;
          prepareReferenceImage: (photo: Blob) => Promise<Blob>;
          BackgroundRemovalClient: new () => {
            run: (blob: Blob, onProgress: () => void) => Promise<{ blob: Blob }>;
            dispose: () => void;
          };
        };
        const url = '/bg/app.js';
        const app = (await import(url)) as App;
        const G = await app.drawClass(cls, { sizeMm, directions });
        const C0 = c0 ? await app.drawClass(cls, { sizeMm, directions, appForm: c0 }) : [];
        const client = new app.BackgroundRemovalClient();
        try {
          const blob = new Blob([Uint8Array.from(atob(photo), (ch) => ch.charCodeAt(0))]);
          const cut = await client.run(blob, () => {});
          const ref = await app.prepareReferenceImage(cut.blob);
          return { G, C0, cutout: await app.encode(cut.blob), ref: await app.encode(ref) };
        } finally {
          client.dispose();
        }
      },
      {
        cls: job.cls,
        sizeMm: job.sizeMm,
        c0: job.c0,
        directions: views.map((v) => KOREAN_VIEW[v]),
        photo: readFileSync(job.photo).toString('base64'),
      },
    );
    const dir = path.join(PREP, job.id, job.who);
    const write = (name: string, base64: string) => {
      const file = path.join(dir, name);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, Buffer.from(base64, 'base64'));
      return file;
    };
    const byView = (drawn: { direction: string; png: string }[], method: string) =>
      Object.fromEntries(
        views.map((v) => {
          const g = drawn.find((d) => d.direction === KOREAN_VIEW[v]);
          if (!g) throw new Error(`${job.id} ${method}: no ${v} guide`);
          return [v, write(`${method}/${v}.png`, g.png)];
        }),
      );
    manifest[job.id] = {
      ...manifest[job.id],
      [job.who]: {
        cd: job.cd,
        name: catalog.rows.get(job.cd)?.['품번'] ?? String(job.cd),
        photo: job.photo,
        sizeMm: job.sizeMm,
        cutout: write('photo-cutout.png', made.cutout),
        ref: write('ref.png', made.ref),
        guides: { G: byView(made.G, 'G'), ...(made.C0.length && { C0: byView(made.C0, 'C0') }) },
      },
    };
    if (notes[job.id]) manifest[job.id].otherNote = notes[job.id];
    else delete manifest[job.id].otherNote;
    console.log(
      job.id,
      job.who,
      job.cd,
      job.sizeMm.join('×'),
      Object.keys(manifest[job.id][job.who]!.guides).join(','),
    );
  }
} finally {
  await browser.close();
  server.close();
}
writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));

// ---------- a sheet of the prepared photos, to look at before any run ----------
const CELL = 200;
const label = (t: string) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CELL}" height="22"><text x="2" y="16" font-family="Malgun Gothic" font-size="14">${t.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</text></svg>`,
  );
const cells: OverlayOptions[] = [];
const ids = Object.keys(manifest);
const columns = 8;
for (const [i, id] of ids.entries()) {
  for (const [k, who] of (['rep', 'other'] as const).entries()) {
    const p = manifest[id][who];
    const left = (i % columns) * (CELL + 6),
      top = Math.floor(i / columns) * (2 * (CELL + 24) + 12) + k * (CELL + 24);
    cells.push({ input: label(`${id} ${who === 'rep' ? '대표' : '안 본'} ${p ? p.cd : '-'}`), left, top });
    if (p)
      cells.push({
        input: await sharp(p.ref)
          .flatten({ background: '#ffffff' })
          .resize(CELL, CELL, { fit: 'contain', background: '#ffffff' })
          .png()
          .toBuffer(),
        left,
        top: top + 22,
      });
  }
}
const rows = Math.ceil(ids.length / columns);
await sharp({
  create: {
    width: columns * (CELL + 6),
    height: rows * (2 * (CELL + 24) + 12),
    channels: 3,
    background: '#dddddd',
  },
})
  .composite(cells)
  .png()
  .toFile(path.join(PREP, '준비한-사진.png'));
console.log(`done: ${jobs.length} products of ${classes.length} classes → ${PREP}`);
