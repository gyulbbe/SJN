/** Private real DeepLab capture. Opt-in local manifest; never uploads or bundles user photographs. */
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, relative, extname } from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import assert from 'node:assert/strict';
const manifest = process.env.BASIN_OBSERVATION_MANIFEST;
if (!manifest) throw new Error('Set BASIN_OBSERVATION_MANIFEST to a local private JSON list.');
const cases = JSON.parse(await readFile(manifest, 'utf8')) as { id: string; path: string }[];
const output = resolve(process.env.BASIN_CAPTURE_OUTPUT ?? 'test-results/reconstruction-basin-capture');
assert(!relative(resolve('test-results'), output).startsWith('..'));
const entries = await Promise.all(cases.map(async (item) => ({ ...item, bytes: await readFile(item.path) })));
const entry = await build({
  stdin: { contents: "export {segmentRoom} from './src/lib/segmentation';", resolveDir: process.cwd() },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
});
const worker = await build({
  entryPoints: ['src/lib/segmentation/worker.ts'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
});
await mkdir(output, { recursive: true });
for (const file of [
  'src/lib/reconstruction/basin-observations.ts',
  'src/lib/reconstruction/candidates.ts',
  'src/lib/segmentation/worker.ts',
  'src/lib/segmentation/index.ts',
]) {
  const bytes = await readFile(file);
  await mkdir(resolve(output, 'source', file, '..'), { recursive: true });
  await writeFile(resolve(output, 'source', file), bytes);
}
const root = resolve('public');
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url!, 'http://localhost').pathname;
    if (path === '/') {
      res.setHeader('Content-Type', 'text/html');
      res.end('<html><head><link rel="icon" href="data:,"></head><body>세면볼 원시 관측 검증</body></html>');
      return;
    }
    if (path === '/index.js' || path === '/worker.ts') {
      res.setHeader('Content-Type', 'text/javascript');
      res.end(path === '/index.js' ? entry.outputFiles[0].text : worker.outputFiles[0].text);
      return;
    }
    const input = entries.find((item) => path === '/input/' + item.id);
    if (input) {
      res.setHeader('Content-Type', 'image/jpeg');
      res.end(input.bytes);
      return;
    }
    const file = resolve(root, '.' + path);
    if (relative(root, file).startsWith('..')) throw Error('out of scope');
    res.setHeader(
      'Content-Type',
      extname(file) === '.wasm'
        ? 'application/wasm'
        : extname(file) === '.json'
          ? 'application/json'
          : 'application/octet-stream',
    );
    res.end(await readFile(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
const origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const results = [];
try {
  for (const item of entries) {
    const directory = resolve(output, item.id);
    await mkdir(directory, { recursive: true });
    const page = await browser.newPage();
    const errors: string[] = [],
      external: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => {
      if (!r.url().startsWith(origin) && !r.url().startsWith('blob:')) external.push(r.url());
    });
    await page.goto(origin);
    const captured = await page.evaluate(
      async ({ origin, id }) => {
        const m = await import(origin + '/index.js'),
          blob = await (await fetch('/input/' + id)).blob();
        const started = performance.now(),
          stages: { message: string; elapsedMs: number }[] = [];
        const controller = new AbortController();
        const result = await m.segmentRoom(
          blob,
          (message: string) => stages.push({ message, elapsedMs: performance.now() - started }),
          { quality: 'reconstruction', captureBasins: true, signal: controller.signal },
        );
        const totalMs = performance.now() - started;
        const to64 = (blob: Blob) =>
          new Promise<string>((done, fail) => {
            const r = new FileReader();
            r.onload = () => done((r.result as string).split(',')[1]);
            r.onerror = () => fail(r.error);
            r.readAsDataURL(blob);
          });
        const passes = [];
        for (const pass of result.basinDiagnostics.passes)
          passes.push({ ...pass, rgba: undefined, rgbaBase64: await to64(new Blob([pass.rgba])) });
        return {
          width: result.width,
          height: result.height,
          objects: result.objects,
          passes,
          stages,
          totalMs,
          browser: navigator.userAgent,
        };
      },
      { origin, id: item.id },
    );
    const summaries = [];
    for (const [index, pass] of captured.passes.entries()) {
      const rgba = Buffer.from(pass.rgbaBase64, 'base64');
      assert.equal(rgba.length, pass.width * pass.height * 4);
      const stem = 'pass-' + String(index).padStart(2, '0');
      await writeFile(resolve(directory, stem + '.rgba.bin'), rgba);
      await sharp(rgba, { raw: { width: pass.width, height: pass.height, channels: 4 } })
        .png()
        .toFile(resolve(directory, stem + '.png'));
      await writeFile(
        resolve(directory, stem + '.json'),
        JSON.stringify({ ...pass, rgbaBase64: undefined, rgbaFile: stem + '.rgba.bin' }, null, 2),
      );
      summaries.push({
        context: pass.context,
        width: pass.width,
        height: pass.height,
        sourceRegion: pass.sourceRegion,
        flipped: pass.flipped,
        components: pass.components.map(
          (c: {
            id: string;
            hasPedestal: boolean;
            inspection: { evidence?: unknown; diagnostic: unknown };
          }) => ({ id: c.id, hasPedestal: c.hasPedestal, ...c.inspection }),
        ),
      });
    }
    const report = {
      scope:
        'Actual DeepLab WASM reconstruction passes; diagnostic capture only; no new model or external transmission',
      id: item.id,
      input: {
        name: item.path.split(/[\\/]/).at(-1),
        sha256: createHash('sha256').update(item.bytes).digest('hex'),
      },
      ...captured,
      passes: undefined,
      passSummaries: summaries,
      errors,
      external,
    };
    await writeFile(resolve(directory, 'report.json'), JSON.stringify(report, null, 2));
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    const summary = {
      id: item.id,
      totalMs: captured.totalMs,
      passes: captured.passes.length,
      components: captured.passes.reduce(
        (sum: number, p: { components: unknown[] }) => sum + p.components.length,
        0,
      ),
    };
    results.push(summary);
    console.log(JSON.stringify(summary));
    await page.close();
  }
  await writeFile(resolve(output, 'summary.json'), JSON.stringify(results, null, 2));
} finally {
  await browser.close();
  await new Promise<void>((done) => server.close(() => done()));
}
