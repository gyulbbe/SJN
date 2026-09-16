import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

// Replays real saved MoGe dense arrays in a real browser Worker. No model inference or remote photo upload.
const input = resolve(
  process.env.MOGE_REPLAY_INPUT ??
    'test-results/reconstruction-browser-cloud/2026-09-15T14-37-49-793Z/moge-fifteen-geometry/pc-03',
);
const output = resolve(process.env.MOGE_TEST_OUTPUT ?? 'test-results/moge-plane-worker-replay');
await mkdir(output, { recursive: true });
const names = [
  'webgpu-result.json',
  'metadata.json',
  'semantic-floor.bin',
  'semantic-wall.bin',
  ...['points', 'normal', 'mask', 'depth'].map((x) => `webgpu-dense-${x}.bin`),
];
const files = new Map(
  await Promise.all(names.map(async (name) => [name, await readFile(resolve(input, name))] as const)),
);
const worker = await build({
  stdin: {
    contents: `import {extractMogePlanes} from './src/lib/reconstruction/moge-browser/planes'; self.onmessage=({data})=>{const start=performance.now();try{const planes=extractMogePlanes(data.dense,data.semantic);self.postMessage({planes,elapsedMs:performance.now()-start});}catch(error){self.postMessage({error:String(error)});}};`,
    resolveDir: process.cwd(),
  },
  write: false,
  bundle: true,
  platform: 'browser',
  format: 'esm',
  logLevel: 'warning',
});
await writeFile(resolve(output, 'worker.js'), worker.outputFiles[0].contents);
const server = createServer((req, res) => {
  const name = (req.url ?? '/').slice(1);
  if (name === 'worker.js') {
    res.setHeader('Content-Type', 'text/javascript');
    res.end(worker.outputFiles[0].contents);
  } else if (files.has(name)) {
    res.setHeader('Content-Type', name.endsWith('.json') ? 'application/json' : 'application/octet-stream');
    res.end(files.get(name));
  } else {
    res.setHeader('Content-Type', 'text/html');
    res.end('<html><body>Real saved geometry plane Worker replay</body></html>');
  }
});
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  const result = await page.evaluate(async () => {
    const json = async (name: string) => (await fetch('/' + name)).json();
    const bytes = async (name: string) => (await fetch('/' + name)).arrayBuffer();
    const row = await json('webgpu-result.json'),
      metadata = await json('metadata.json');
    const dense = {
      width: row.raw.width,
      height: row.raw.height,
      intrinsics: row.intrinsics,
      diagnostics: row.diagnostics,
      points: new Float32Array(await bytes('webgpu-dense-points.bin')),
      normal: new Float32Array(await bytes('webgpu-dense-normal.bin')),
      depth: new Float32Array(await bytes('webgpu-dense-depth.bin')),
      mask: new Uint8Array(await bytes('webgpu-dense-mask.bin')),
    };
    const semantic = {
      width: metadata.mask.width,
      height: metadata.mask.height,
      floor: new Uint8Array(await bytes('semantic-floor.bin')),
      wall: new Uint8Array(await bytes('semantic-wall.bin')),
      regions: metadata.regions,
    };
    let ticks = 0;
    const ticker = setInterval(() => ticks++, 20),
      worker = new Worker('/worker.js', { type: 'module' });
    try {
      return await new Promise<Record<string, unknown>>((resolve, reject) => {
        worker.onmessage = ({ data }) =>
          resolve({ ...data, mainThreadTimerTicks: ticks, browser: navigator.userAgent });
        worker.onerror = () => reject(new Error('plane worker failed'));
        worker.postMessage({ dense, semantic });
      });
    } finally {
      clearInterval(ticker);
      worker.terminate();
    }
  });
  if (result.error) throw new Error(String(result.error));
  const planes = result.planes as { floor: unknown; walls: unknown[]; evidence: { revision: string } };
  const report = {
    scope: 'real-browser-worker-plane-only-replay-from-real-model-dense-arrays; no inference',
    input,
    completedAt: new Date().toISOString(),
    sources: [...files].map(([name, bytes]) => ({
      name,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })),
    workerSha256: createHash('sha256').update(worker.outputFiles[0].contents).digest('hex'),
    ...result,
  };
  await writeFile(
    resolve(output, 'report.json'),
    JSON.stringify(
      report,
      (_key, value) => (ArrayBuffer.isView(value) ? Array.from(value as unknown as number[]) : value),
      2,
    ),
  );
  console.log(
    JSON.stringify({
      revision: planes.evidence.revision,
      walls: planes.walls.length,
      floor: !!planes.floor,
      elapsedMs: result.elapsedMs,
      mainThreadTimerTicks: result.mainThreadTimerTicks,
      browser: result.browser,
    }),
  );
} finally {
  await browser.close();
  await new Promise<void>((done) => server.close(() => done()));
}
