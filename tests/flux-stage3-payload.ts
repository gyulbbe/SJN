/**
 * Builds the FLUX inputs for the stage-3 real comparison (no AI call): the stage-2 measurement
 * bathroom from the room-eye view, as one frame and as an 8-sample average, each with the model
 * input (496 px), the placed-product scene and the server prompt. Real calls use these files
 * through a separate temporary Worker. (The fixture masks used to evaluate painting fixtures back,
 * not adopted, are in commit c98ef27.)
 *
 * Usage: node tests/run-browser-test.mjs tests/flux-stage3-payload.ts [--gpu]
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';

const gpu = process.argv.includes('--gpu');
const output = 'test-results/export-realism-stage-3/payload';
await mkdir(output, { recursive: true });
const bundle = await build({
  stdin: {
    contents: `export * from './src/lib/room-viewer/renderer';export * from './src/lib/room-viewer/view-state';export {buildRealismScene} from './tests/helpers/export-realism-scene';export {buildFluxGrounding} from './src/lib/ai-export/scene';export {fluxInputLayout} from './src/lib/ai-export/contract';export {prepareFluxImage} from './src/lib/ai-export/client';export {buildFluxPrompt} from './src/lib/ai-export/prompt';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
  globalName: 'Payload',
});
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: gpu
    ? ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--enable-gpu']
    : ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('http://127.0.0.1:43214/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' }),
  );
  await page.goto('http://127.0.0.1:43214/');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const results = await page.evaluate(async () => {
    type Lib = typeof import('../src/lib/room-viewer/renderer') &
      typeof import('../src/lib/room-viewer/view-state') &
      typeof import('./helpers/export-realism-scene') &
      typeof import('../src/lib/ai-export/scene') &
      typeof import('../src/lib/ai-export/contract') &
      typeof import('../src/lib/ai-export/client') &
      typeof import('../src/lib/ai-export/prompt');
    const lib = (window as unknown as { Payload: Lib }).Payload;
    const { room, assets, snapshot } = await lib.buildRealismScene();
    const reader = async (id: string) => assets[id];
    const viewer = new lib.RoomViewerRenderer();
    const dataUrl = (blob: Blob) =>
      new Promise<string>((resolve) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result as string);
        r.readAsDataURL(blob);
      });
    const out = [];
    try {
      await viewer.setSnapshot(snapshot, reader);
      for (const name of ['center', 'left-corner'] as const) {
        const view = lib.roomEyeView(room, name);
        for (const samples of [1, 8]) {
          const started = performance.now();
          const blob = await viewer.export(view, {
            format: 'png',
            mode: 'after',
            longEdge: 1024,
            ...(samples > 1 ? { quality: { samples } } : {}),
          });
          const exportMs = performance.now() - started;
          const capture = await createImageBitmap(blob);
          const layout = lib.fluxInputLayout(capture.width, capture.height);
          const boxes = viewer.fixtureBounds(capture.width, capture.height, view);
          const grounding = await lib.buildFluxGrounding({ snapshot, reader, capture, layout, boxes });
          capture.close();
          const input = await lib.prepareFluxImage(blob);
          const inputBitmap = await createImageBitmap(input);
          out.push({
            label: `${name}-${samples === 1 ? 'single' : 'acc8'}`,
            samples,
            exportMs: Math.round(exportMs),
            capture: await dataUrl(blob),
            input: await dataUrl(input),
            inputSize: [inputBitmap.width, inputBitmap.height],
            layout,
            scene: grounding.scene,
            placed: grounding.placed,
            prompt: lib.buildFluxPrompt(grounding.scene),
          });
          inputBitmap.close();
        }
      }
    } finally {
      viewer.dispose();
    }
    return out;
  });
  if (errors.length) throw new Error(errors.join('\n'));
  const summary = [];
  for (const r of results) {
    const png = (url: string) => Buffer.from(url.split(',')[1], 'base64');
    await writeFile(`${output}/${r.label}-capture.png`, png(r.capture));
    await writeFile(`${output}/${r.label}-input.png`, png(r.input));
    await writeFile(`${output}/${r.label}-prompt.txt`, r.prompt);
    await writeFile(
      `${output}/${r.label}-scene.json`,
      JSON.stringify({ scene: r.scene, layout: r.layout }, null, 2),
    );
    summary.push({
      label: r.label,
      samples: r.samples,
      exportMs: r.exportMs,
      inputSize: r.inputSize,
      fixtures: r.scene.fixtures.map((f) => f.kind),
      placed: r.placed,
      promptLength: r.prompt.length,
    });
  }
  await writeFile(`${output}/summary.json`, JSON.stringify({ gpu, summary }, null, 2));
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await browser.close();
}
