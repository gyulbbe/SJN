/** Authored optional-shower rendering/controls regression. No AI or user project writes. */
import { chromium, expect } from '@playwright/test';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
const out = path.resolve(
  'test-results/reconstruction-fifteen-rebuild/20260915-start/shower-variant-browser-' +
    new Date().toISOString().replaceAll(':', '-'),
);
await mkdir(out, { recursive: true });
const loaded = new Map<string, string>(),
  sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const bundle = await build({
  stdin: {
    contents: [
      "export {createTemplateModel,disposeTemplateModel,renderReconstructionTemplate} from './src/lib/reconstruction/templates';",
      "export {showerVariantDefaults,showerModelPartBounds} from './src/lib/reconstruction/fixture-variants';",
      "export {default as Controls,fixtureForm} from './src/components/reconstruction/reconstruction-fixture-controls';",
      "export {DEFAULT_ROOM} from './src/lib/room-geometry';",
      "export {createRoot} from 'react-dom/client';export {createElement,useState} from 'react';",
    ].join('\n'),
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
  jsx: 'automatic',
  outfile: 'bundle.js',
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [
    {
      name: 'source-snapshot',
      setup(b) {
        b.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async (a) => {
          const bytes = await readFile(a.path);
          loaded.set(a.path, sha(bytes));
          return {
            contents: bytes,
            loader: a.path.endsWith('.tsx') ? 'tsx' : a.path.endsWith('.ts') ? 'ts' : 'js',
          };
        });
      },
    },
  ],
});
for (const [file, digest] of loaded)
  assert.equal(sha(await readFile(file)), digest, 'No source changes during bundle');
const js = bundle.outputFiles.find((x) => x.path.endsWith('.js'))!.text,
  css = bundle.outputFiles.find((x) => x.path.endsWith('.css'))?.text ?? '';
await writeFile(path.join(out, 'bundle.js'), js, { flag: 'wx' });
await writeFile(path.join(out, 'bundle.css'), css, { flag: 'wx' });
const html =
  '<html lang="ko"><meta charset="utf-8"><link rel="icon" href="data:,"><link rel="stylesheet" href="/bundle.css"><style>body{font:15px Arial;margin:24px;background:#f6f6f6}#renders{display:flex;gap:16px;flex-wrap:wrap}.card{width:250px;background:white;padding:12px}.card img{height:520px;max-width:248px;object-fit:contain}#controls{width:430px}</style><h1>샤워 기본 모형 · 합성 계약 검증</h1><p>사진 인식 결과가 아니며 기본 규격은 실측이 아님</p><div id="renders"></div><div id="controls"></div></html>';
const server = createServer((req, res) => {
  res.setHeader(
    'Content-Type',
    req.url === '/bundle.js' ? 'text/javascript' : req.url === '/bundle.css' ? 'text/css' : 'text/html',
  );
  res.end(req.url === '/bundle.js' ? js : req.url === '/bundle.css' ? css : html);
});
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
const origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const errors: string[] = [],
  requests: string[] = [];
try {
  const page = await browser.newPage({ viewport: { width: 1220, height: 1120 } });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => requests.push(r.url()));
  await page.goto(origin);
  const results = await page.evaluate(async (base) => {
    const m = await import(base + '/bundle.js');
    const forms = [
      {
        id: 'legacy',
        label: '기존 저장 모양 유지',
        widthMm: 300,
        heightMm: 1300,
        depthMm: 300,
        baseHeightMm: 750,
      },
      ...['hand-spray', 'handheld-rail', 'overhead-set', 'handheld-wall', 'overhead-head'].map((v) => ({
        id: v,
        label: v,
        ...m.showerVariantDefaults(v),
      })),
    ];
    const results = [];
    for (const d of forms) {
      const opts = {
        ...d,
        version: 2,
        kind: 'shower',
        color: '#949c9e',
        room: m.DEFAULT_ROOM,
        face: 'back',
        u: 0.5,
        v: 0.5,
        aspect: 1.5,
      };
      const start = performance.now(),
        model = m.createTemplateModel(opts),
        parts = m.showerModelPartBounds(model);
      m.disposeTemplateModel(model);
      const r = await m.renderReconstructionTemplate(opts),
        png = await new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.readAsDataURL(r.blob);
        });
      const card = document.createElement('div');
      card.className = 'card';
      const text = document.createElement('p');
      text.textContent = d.label + ' ' + d.widthMm + '×' + d.heightMm + '×' + d.depthMm + 'mm';
      const img = document.createElement('img');
      img.src = png;
      card.append(text, img);
      document.querySelector('#renders')!.append(card);
      await img.decode();
      results.push({
        id: d.id,
        png,
        dimensions: d,
        parts,
        anchor: r.anchor,
        elapsedMs: performance.now() - start,
      });
    }
    function Host() {
      const [form, setForm] = m.useState({
        ...m.fixtureForm(
          { room: { heightMm: 2400 } },
          {
            reconstruction: {
              kind: 'shower',
              version: 2,
              widthMm: 223,
              heightMm: 681,
              depthMm: 137,
              baseHeightMm: 533,
            },
            roomPlacement: { face: 'left', u: 0.23, v: 0.67 },
            anchor: { x: 0.5, y: 0.5 },
          },
        ),
      });
      const [dimensions, setDimensions] = m.useState({ widthMm: 223, heightMm: 681, depthMm: 137 });
      (window as unknown as { showerForm: unknown }).showerForm = { form, dimensions };
      return m.createElement(m.Controls, {
        kind: 'shower',
        value: form,
        dimensions,
        disabled: false,
        onChange: setForm,
        onBasinVariant: () => {},
        onShowerDefaults: (v: string) => {
          const d = m.showerVariantDefaults(v);
          setDimensions({ widthMm: d.widthMm, heightMm: d.heightMm, depthMm: d.depthMm });
          setForm({ ...form, baseHeightMm: d.baseHeightMm });
        },
      });
    }
    m.createRoot(document.querySelector('#controls')).render(m.createElement(Host));
    return results;
  }, origin);
  for (const r of results)
    await writeFile(path.join(out, r.id + '.png'), Buffer.from(r.png.split(',')[1], 'base64'), {
      flag: 'wx',
    });
  await expect(page.getByLabel('샤워 형태')).toHaveValue('');
  await page.getByLabel('샤워 형태').selectOption('hand-spray');
  const read = () =>
    page.evaluate(
      () =>
        (
          window as unknown as {
            showerForm: { form: Record<string, unknown>; dimensions: Record<string, number> };
          }
        ).showerForm,
    );
  const preserved = await read();
  assert.equal(preserved.form.showerVariant, 'hand-spray');
  assert.equal(preserved.form.baseHeightMm, 533);
  assert.equal(preserved.form.face, 'left');
  assert.deepEqual(preserved.dimensions, { widthMm: 223, heightMm: 681, depthMm: 137 });
  await page.getByRole('button', { name: '이 형태의 기본 규격 적용' }).click();
  const explicit = await read();
  assert.equal(explicit.form.baseHeightMm, 450);
  assert.equal(explicit.form.face, 'left');
  assert.deepEqual(explicit.dimensions, { widthMm: 180, heightMm: 450, depthMm: 120 });
  for (const variant of ['handheld-wall', 'overhead-head']) {
    await page.getByLabel('샤워 형태').selectOption(variant);
    const selected = await read();
    assert.equal(selected.form.showerVariant, variant);
    assert.deepEqual(selected.dimensions, explicit.dimensions);
    assert.equal(selected.form.baseHeightMm, explicit.form.baseHeightMm);
  }
  const headOnly = results.find(r => r.id === 'overhead-head')!;
  assert.ok(headOnly.parts['overhead-head']);
  for (const part of ['handset', 'hose', 'rail']) assert.equal(headOnly.parts[part], undefined);
  const handheld = results.find(r => r.id === 'handheld-wall')!;
  assert.ok(handheld.parts.handset && handheld.parts.hose);
  assert.equal(handheld.parts.rail, undefined);
  assert.equal(handheld.parts['overhead-head'], undefined);
  await page.getByLabel('샤워 형태').selectOption('');
  const cleared = await read();
  assert.equal(cleared.form.showerVariant, undefined);
  assert.deepEqual(cleared.dimensions, explicit.dimensions);
  await page.screenshot({ path: path.join(out, 'comparison-and-controls.png'), fullPage: true });
  assert.deepEqual(errors, []);
  assert.ok(requests.every((url) => url.startsWith(origin)));
  await writeFile(
    path.join(out, 'manifest.json'),
    JSON.stringify(
      {
        status: 'passed',
        createdAt: new Date().toISOString(),
        authoredInput: true,
        aiCalls: 0,
        userProjectWrites: 0,
        browser: await browser.version(),
        renderer: 'Chromium WebGL ANGLE SwiftShader',
        errors,
        requests,
        sourceFiles: [...loaded].map(([file, sha256]) => ({ file, sha256 })),
        bundleSha256: sha(js),
        tests: {
          renderSixForms: true,
          newVariantsHaveOnlyObservedComponentTypes: true,
          subtypeSelectionPreservesDimensions: true,
          explicitDefaultsOnly: true,
          clearingSubtypePreservesDimensions: true,
        },
        results: results.map((r) => ({
          id: r.id,
          dimensions: r.dimensions,
          parts: r.parts,
          anchor: r.anchor,
          elapsedMs: r.elapsedMs,
          pngFile: r.id + '.png',
        })),
        cleanup:
          'Each template render disposes model/renderer and forces context loss; browser/server closed in finally.',
      },
      null,
      2,
    ),
    { flag: 'wx' },
  );
  console.log(JSON.stringify({ out, status: 'passed', forms: results.length, aiCalls: 0 }));
} finally {
  await browser.close();
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
}
