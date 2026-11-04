/**
 * The renderer probe (no AI call, docs §3 "렌더러 가능성"): probe-page.ts in Chrome on this PC's GPU,
 * the white scene's wall and floor tiles from the public snapshot. three-gpu-pathtracer is installed
 * only in a throwaway folder (tmp/export-photoreal/render-probe, `npm install`; never in the app),
 * and both three copies resolve to that folder's 0.185.1 so the page has one three.
 *
 * Usage: node tests/run-browser-test.mjs tests/export-photoreal/render-probe/probe.ts [--headed]
 * Output: test-results/export-photoreal/render-probe/{webgl,ssgi,path}.png, probe.json
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { OUT, ROOT, SNAPSHOT } from '../paths.mjs';

const probeModules = join(ROOT as string, 'tmp', 'export-photoreal', 'render-probe', 'node_modules');
if (!existsSync(join(probeModules, 'three-gpu-pathtracer')))
  throw new Error('install the probe first: npm install in tmp/export-photoreal/render-probe');
const target = join(OUT as string, 'render-probe');
mkdirSync(target, { recursive: true });
const probeDir = join(probeModules, '..');
const bundle = await build({
  entryPoints: [resolve('tests/export-photoreal/render-probe/probe-page.ts')],
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'esm',
  logLevel: 'warning',
  plugins: [
    {
      // Every three and pathtracer import from the probe folder: one three for the whole page.
      name: 'probe-modules',
      setup(b) {
        b.onResolve({ filter: /^(three|three-gpu-pathtracer|three-mesh-bvh)(\/|$)/ }, async (args) => {
          if (args.pluginData === 'probe') return;
          return b.resolve(args.path, { kind: args.kind, resolveDir: probeDir, pluginData: 'probe' });
        });
      },
    },
  ],
});
const catalog = JSON.parse(readFileSync(join(SNAPSHOT as string, 'catalog.json'), 'utf8')) as {
  placements: { materialId: string; textureAssetIds: string[] }[];
};
const files = new Map(
  readdirSync(join(SNAPSHOT as string, 'images')).map((f) => [f.replace(/\.[a-z]+$/, ''), f]),
);
const texture = (id: string) =>
  files.get(catalog.placements.find((p) => p.materialId === id)!.textureAssetIds[0])!;
const wall = texture('630d6290-9ec9-4027-97d7-ce0001ba3c8d'),
  floor = texture('591b59df-0c9c-473b-bd86-4a78a8d67050');
const server = createServer((req, res) => {
  const route = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (route === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end('<!doctype html><meta charset="utf-8"><body></body>');
  }
  if (route === '/probe.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    return res.end(bundle.outputFiles[0].text);
  }
  if (route.startsWith('/images/')) {
    res.writeHead(200);
    return res.end(readFileSync(join(SNAPSHOT as string, 'images', decodeURIComponent(route.slice(8)))));
  }
  res.writeHead(404);
  res.end();
});
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch({
  channel: 'chrome',
  headless: !process.argv.includes('--headed'),
  args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=d3d11'],
});
const report: Record<string, unknown> = {};
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(`${origin}/`);
  await page.evaluate(`(async () => { window.probe = await import('/probe.js'); })()`);
  const run = async (name: string, call: string) => {
    try {
      const out = (await page.evaluate(call)) as { png?: string } & Record<string, unknown>;
      if (out.png) writeFileSync(join(target, `${name}.png`), Buffer.from(out.png.split(',')[1], 'base64'));
      delete out.png;
      report[name] = { ...out, errors: errors.splice(0) };
    } catch (error) {
      report[name] = { failed: String(error).slice(0, 600), errors: errors.splice(0) };
    }
    console.log(name, JSON.stringify(report[name]).slice(0, 400));
  };
  await run('adapter', `window.probe.adapter()`);
  await run('webgl', `window.probe.webgl('/images/${wall}', '/images/${floor}')`);
  await run('ssgi', `window.probe.screenSpace('/images/${wall}', '/images/${floor}')`);
  await run('ssgi-plain', `window.probe.screenSpace('/images/${wall}', '/images/${floor}', 1, false)`);
  await run('path', `window.probe.pathTraced('/images/${wall}', '/images/${floor}')`);
  report.userAgent = await page.evaluate(() => navigator.userAgent);
} finally {
  await browser.close();
  server.close();
}
writeFileSync(
  join(target, 'probe.json'),
  JSON.stringify({ at: new Date().toISOString(), ...report }, null, 1),
);
