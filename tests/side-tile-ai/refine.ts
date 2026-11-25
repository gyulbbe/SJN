/**
 * The side-tile AI trial's finished results (no AI call): each local answer (flux.ts) finished as
 * ai-export.tsx finishes it for today's method, with the same revision's capture: the backdrop back
 * where the model kept the framing (backdrop.ts), the fixture outline the model drew by the app's cut-out
 * model (BiRefNet lite fp16, the pinned file in tmp/background-model, served from disk; crops by
 * fixture-outline.ts `outlineCrops`, alpha read back as ai-export.tsx `fixtureCuts` does), then
 * current-refine.ts with the widened joints, the room behind the fixtures and its less glossy copy.
 *
 * The finishing code is the same at both commits (only the renderer differs, revision.ts), so it runs
 * as checked out; what differs is the capture each revision drew and the answer to it.
 *
 * Usage: node tests/run-browser-test.mjs tests/side-tile-ai/refine.ts [--only olive-0,...]
 * Output: test-results/side-tile-ai-20261121/<rev>/{original,refined,cuts}/<scene>-<seed>.png, refine.json
 */
import { chromium } from '@playwright/test';
import { build, type BuildOptions } from 'esbuild';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import path, { join } from 'node:path';
import sharp from 'sharp';
import { restoreBackdrop } from '../../src/lib/ai-export/backdrop';
import { framing, projectCapture, type Pixels, type RegionMask } from '../../src/lib/ai-export/color';
import type { FluxInputLayout } from '../../src/lib/ai-export/contract';
import { refineCurrentResult } from '../../src/lib/ai-export/current-refine';
import { cropPixels, outlineCrops, type Cut } from '../../src/lib/ai-export/fixture-outline';
import type { FluxScene } from '../../src/lib/ai-export/scene-contract';
import { BACKGROUND_MODEL, OUT, REVISIONS } from './paths.mjs';

// --rev a,b: these result folders only (a room-depth candidate's too); default the two revisions.
const revs = (() => {
  const i = process.argv.indexOf('--rev');
  return i > 0 ? process.argv[i + 1].split(',') : Object.keys(REVISIONS as Record<string, string>);
})();
// --tuning '{json}': refineCurrentResult tuning (trial only); --suffix s: write refined-s/ instead of refined/.
const tuning = (() => {
  const i = process.argv.indexOf('--tuning');
  return i > 0
    ? (JSON.parse(process.argv[i + 1]) as Parameters<typeof refineCurrentResult>[0]['tuning'])
    : undefined;
})();
const refinedDir = (() => {
  const i = process.argv.indexOf('--suffix');
  return i > 0 ? `refined-${process.argv[i + 1]}` : 'refined';
})();
const only = (() => {
  const i = process.argv.indexOf('--only');
  return i > 0 ? process.argv[i + 1].split(',') : undefined;
})();
const runtime = path.resolve('node_modules/onnxruntime-web/dist');
if (!existsSync(join(BACKGROUND_MODEL as string, 'model_fp16.onnx')))
  throw new Error('no tmp/background-model/model_fp16.onnx');

async function rgba(file: string): Promise<Pixels> {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return {
    width: info.width,
    height: info.height,
    data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length),
  };
}
async function gray(file: string): Promise<Uint8Array> {
  return new Uint8Array(await sharp(file).extractChannel(0).raw().toBuffer());
}
const png = (p: Pixels) =>
  sharp(Buffer.from(p.data.buffer, p.data.byteOffset, p.data.length), {
    raw: { width: p.width, height: p.height, channels: 4 },
  })
    .png()
    .toBuffer();

// ---------- the cut-out model in a browser, served from disk ----------
const bundles = new Map<string, string>();
const entries: [string, BuildOptions][] = [
  [
    '/bg/client.js',
    {
      stdin: {
        contents: "export { BackgroundRemovalClient } from './src/lib/background-removal/client';",
        resolveDir: process.cwd(),
      },
    },
  ],
  ['/bg/worker.ts', { entryPoints: ['src/lib/background-removal/worker.ts'] }],
];
for (const [route, options] of entries) {
  const result = await build({
    ...options,
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'esm',
    logLevel: 'warning',
  });
  bundles.set(route, result.outputFiles[0].text);
}
const inbox = new Map<string, Buffer>();
const outbox = new Map<string, Buffer>();
const server = createServer(async (req, res) => {
  try {
    const route = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    if (req.method === 'POST' && route.startsWith('/save/')) {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      outbox.set(route.slice(6), Buffer.concat(chunks));
      res.end('ok');
      return;
    }
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
    if (route.startsWith('/image/') && inbox.has(route.slice(7))) {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(inbox.get(route.slice(7)));
      return;
    }
    const name = path.basename(route);
    const file = name.endsWith('.onnx') ? join(BACKGROUND_MODEL as string, name) : join(runtime, name);
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
  } catch (error) {
    res.writeHead(500);
    res.end(String(error));
  }
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const summary: Record<string, unknown> = {};
try {
  const context = await browser.newContext();
  for (const pattern of [
    'https://huggingface.co/**',
    'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.29.0/dist/**',
  ])
    await context.route(pattern, (route) =>
      route.fulfill({
        status: 307,
        headers: {
          location: `${origin}/${path.basename(new URL(route.request().url()).pathname)}`,
          'access-control-allow-origin': '*',
        },
      }),
    );
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin}/`);
  await page.evaluate(async (url) => {
    const { BackgroundRemovalClient } = (await import(
      url
    )) as typeof import('../../src/lib/background-removal/client');
    (window as unknown as { bg: InstanceType<typeof BackgroundRemovalClient> }).bg =
      new BackgroundRemovalClient();
  }, '/bg/client.js');
  const cutout = async (key: string, image: Buffer): Promise<Buffer> => {
    inbox.set(key, image);
    await page.evaluate(async (key) => {
      const bg = (window as unknown as { bg: { run(b: Blob, p: () => void): Promise<{ blob: Blob }> } }).bg;
      const blob = await (await fetch(`/image/${encodeURIComponent(key)}`)).blob();
      const result = await bg.run(blob, () => {});
      await fetch(`/save/${encodeURIComponent(key)}`, { method: 'POST', body: result.blob });
    }, key);
    if (errors.length) throw new Error(errors.join('\n'));
    const out = outbox.get(key);
    if (!out) throw new Error(`no cut-out for ${key}`);
    return out;
  };

  for (const rev of revs) {
    const root = join(OUT as string, rev);
    for (const sub of ['original', refinedDir, 'cuts']) mkdirSync(join(root, sub), { recursive: true });
    for (const file of readdirSync(join(root, 'raw')).filter((f) => f.endsWith('.png'))) {
      const id = file.slice(0, -4);
      const scene = id.replace(/-\d+$/, '');
      if (only && !only.includes(scene)) continue;
      const dir = join(root, 'scenes', scene);
      const capture = await rgba(join(dir, 'capture.png'));
      const regions = JSON.parse(readFileSync(join(dir, 'regions.json'), 'utf8')) as Omit<RegionMask, 'data'>;
      const mask: RegionMask = {
        ...regions,
        data: await gray(join(dir, 'mask.png')),
        outside: await gray(join(dir, 'mask-outside.png')),
      };
      const behindRegions = JSON.parse(readFileSync(join(dir, 'regions-behind.json'), 'utf8')) as Omit<
        RegionMask,
        'data'
      >;
      const behindMask: RegionMask = {
        ...behindRegions,
        data: await gray(join(dir, 'mask-behind.png')),
        outside: await gray(join(dir, 'mask-behind-outside.png')),
      };
      const { layout } = JSON.parse(readFileSync(join(dir, 'layout.json'), 'utf8')) as {
        layout: FluxInputLayout;
      };
      const { scene: facts } = JSON.parse(readFileSync(join(dir, 'grounding.json'), 'utf8')) as {
        scene: FluxScene;
      };
      const fixtures = facts.fixtures ?? [];
      const answer = await rgba(join(root, 'raw', file));
      // As ai-export.tsx: the backdrop back first, only where the model kept the framing.
      const frame = framing(projectCapture(capture, layout, answer), answer);
      const restored =
        frame.aligned && mask.outside
          ? restoreBackdrop({ result: answer, capture, mask, layout, shift: frame })
          : undefined;
      const raw = restored ?? answer;
      writeFileSync(join(root, 'original', file), await png(raw));
      // The model's fixture outline (fixtureCuts).
      const cuts: Cut[] = [];
      for (const crop of outlineCrops(fixtures, raw)) {
        const key = `${rev}~${id}~${crop.fixture}`;
        const result = await cutout(key, await png(cropPixels(raw, crop)));
        writeFileSync(join(root, 'cuts', `${id}-${crop.fixture}.png`), result);
        const cut = await rgba(join(root, 'cuts', `${id}-${crop.fixture}.png`));
        const alpha = new Uint8Array(crop.width * crop.height);
        for (let y = 0; y < crop.height; y++)
          for (let x = 0; x < crop.width; x++) {
            const sx = Math.min(cut.width - 1, Math.floor(((x + 0.5) * cut.width) / crop.width)),
              sy = Math.min(cut.height - 1, Math.floor(((y + 0.5) * cut.height) / crop.height));
            alpha[y * crop.width + x] = cut.data[(sy * cut.width + sx) * 4 + 3];
          }
        cuts.push({ ...crop, alpha });
      }
      const refined = refineCurrentResult({
        raw,
        capture,
        mask,
        layout,
        fixtures,
        joints: await rgba(join(dir, 'joints.png')),
        behind: { image: await rgba(join(dir, 'behind.png')), mask: behindMask },
        cuts,
        soft: await rgba(join(dir, 'soft.png')),
        ...(tuning ? { tuning } : {}),
      });
      const shown = refined.shown;
      if (shown) writeFileSync(join(root, refinedDir, file), await png(shown));
      // REFINE_STAGES=1: also the picture after the joints step and after the colour step, and the
      // colour step's own face measures (before and after, as the app measures them; item 4).
      if (process.env.REFINE_STAGES === '1') {
        const face = (c: { region: number; kind: string; reference: number[]; result: number[] }) => ({
          region: c.region,
          kind: c.kind,
          design: +c.reference[0].toFixed(2),
          got: +c.result[0].toFixed(2),
        });
        mkdirSync(join(root, `${refinedDir}-faces`), { recursive: true });
        writeFileSync(
          join(root, `${refinedDir}-faces`, file.replace(/\.png$/, '.json')),
          JSON.stringify(
            {
              frame: refined.review.framing,
              before: refined.review.changes.map(face),
              after: (refined.review.residual ?? []).map(face),
            },
            null,
            1,
          ),
        );
      }
      if (process.env.REFINE_STAGES === '1')
        for (const [stage, image] of [
          ['joints', refined.joints?.image],
          ['colour', refined.review.corrected],
        ] as const)
          if (image) {
            mkdirSync(join(root, `${refinedDir}-${stage}`), { recursive: true });
            writeFileSync(join(root, `${refinedDir}-${stage}`, file), await png(image));
          }
      summary[`${rev}/${id}`] = {
        aligned: refined.review.framing.aligned,
        backdrop: !!restored,
        cuts: cuts.length,
        joints: refined.joints?.restored.length ?? 0,
        bodies: refined.bodies?.length ?? 0,
        refined: !!shown,
      };
      console.log(rev, id, JSON.stringify(summary[`${rev}/${id}`]));
    }
  }
} finally {
  await browser.close();
  server.close();
}
writeFileSync(
  join(OUT as string, process.argv.includes('--rev') ? `refine-${revs.join('-')}.json` : 'refine.json'),
  JSON.stringify(summary, null, 1),
);
