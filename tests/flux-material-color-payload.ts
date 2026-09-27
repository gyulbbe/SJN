/**
 * FLUX material-colour comparison inputs (no AI call): the stage-3 measurement bathroom from the
 * left-corner room-eye view, one frame, with white wall tiles ("white", the stage-3 input) and with
 * beige ones ("beige"). For each: the capture, the 496 px model input, the region mask the app
 * would use for the colour check, the placed-product scene and the server prompt of this code.
 * Real calls use these files through a separate temporary Worker (not in the repository).
 *
 * Usage: node tests/run-browser-test.mjs tests/flux-material-color-payload.ts [--gpu]
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import sharp from 'sharp';

const gpu = process.argv.includes('--gpu');
const output = 'test-results/flux-material-color/payload';
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
  await page.route('http://127.0.0.1:43218/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' }),
  );
  await page.goto('http://127.0.0.1:43218/');
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
    const dataUrl = (blob: Blob) =>
      new Promise<string>((resolve) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result as string);
        r.readAsDataURL(blob);
      });
    const out = [];
    for (const [label, colors] of [
      ['white', {}],
      ['beige', { wall: '#d4c2a4' }],
    ] as const) {
      const { room, assets, snapshot } = await lib.buildRealismScene(colors);
      const reader = async (id: string) => assets[id];
      const viewer = new lib.RoomViewerRenderer();
      try {
        await viewer.setSnapshot(snapshot, reader);
        const view = lib.roomEyeView(room, 'left-corner');
        const blob = await viewer.export(view, { format: 'png', mode: 'after', longEdge: 1024 });
        const capture = await createImageBitmap(blob);
        const layout = lib.fluxInputLayout(capture.width, capture.height);
        const boxes = viewer.fixtureBounds(capture.width, capture.height, view);
        const mask = viewer.regionMask(capture.width, capture.height, view);
        const grounding = await lib.buildFluxGrounding({ snapshot, reader, capture, layout, boxes });
        capture.close();
        const input = await lib.prepareFluxImage(blob);
        out.push({
          label,
          capture: await dataUrl(blob),
          input: await dataUrl(input),
          layout,
          boxes,
          mask: {
            width: mask.width,
            height: mask.height,
            regions: mask.regions,
            data: Array.from(mask.data),
          },
          scene: grounding.scene,
          placed: grounding.placed,
          prompt: lib.buildFluxPrompt(grounding.scene),
        });
      } finally {
        viewer.dispose();
      }
    }
    return out;
  });
  if (errors.length) throw new Error(errors.join('\n'));
  const summary = [];
  for (const r of results) {
    const png = (url: string) => Buffer.from(url.split(',')[1], 'base64');
    await writeFile(`${output}/${r.label}-capture.png`, png(r.capture));
    await writeFile(`${output}/${r.label}-input.png`, png(r.input));
    await writeFile(`${output}/${r.label}-prompt-new.txt`, r.prompt);
    await writeFile(
      `${output}/${r.label}-scene.json`,
      JSON.stringify({ scene: r.scene, layout: r.layout }, null, 2),
    );
    // Labels in the red channel, plus a coloured view for checking by eye.
    const labels = Uint8Array.from(r.mask.data);
    await sharp(Buffer.from(labels), { raw: { width: r.mask.width, height: r.mask.height, channels: 1 } })
      .png()
      .toFile(`${output}/${r.label}-regions.png`);
    await writeFile(`${output}/${r.label}-regions.json`, JSON.stringify(r.mask.regions, null, 2));
    const palette = [
      [0, 0, 0],
      [230, 80, 80],
      [80, 180, 90],
      [80, 120, 230],
      [230, 190, 60],
      [170, 90, 200],
    ];
    const view = Buffer.alloc(r.mask.width * r.mask.height * 3);
    labels.forEach((label, i) =>
      view.set(label === 255 ? [255, 255, 255] : palette[label % palette.length], i * 3),
    );
    await sharp(view, { raw: { width: r.mask.width, height: r.mask.height, channels: 3 } })
      .composite([{ input: png(r.capture), blend: 'soft-light' }])
      .png()
      .toFile(`${output}/${r.label}-regions-view.png`);
    const counts = r.mask.regions.map((region, i) => ({
      ...region,
      share: +(labels.filter((label) => label === i + 1).length / labels.length).toFixed(3),
    }));
    // Every fixture box is mostly fixture pixels.
    const fixtureShare = Object.entries(r.boxes).map(([id, [left, top, right, bottom]]) => {
      let inside = 0,
        total = 0;
      for (let y = Math.floor(top * r.mask.height); y < Math.ceil(bottom * r.mask.height); y++)
        for (let x = Math.floor(left * r.mask.width); x < Math.ceil(right * r.mask.width); x++) {
          total++;
          if (labels[y * r.mask.width + x] === 255) inside++;
        }
      return { id, share: +(inside / Math.max(1, total)).toFixed(2) };
    });
    summary.push({
      label: r.label,
      capture: [r.mask.width, r.mask.height],
      regions: counts,
      fixtures: fixtureShare,
      unchecked: +(labels.filter((label) => label === 0).length / labels.length).toFixed(3),
      promptLength: r.prompt.length,
    });
  }
  // The white room is the stage-3 input: the capture should match the one the real results came from.
  const stage3 = 'test-results/export-realism-stage-3/payload/left-corner-single-capture.png';
  const same = await readFile(stage3)
    .then(async (old) => {
      const [a, b] = await Promise.all([
        sharp(old).raw().toBuffer(),
        sharp(`${output}/white-capture.png`).raw().toBuffer(),
      ]);
      let diff = 0;
      for (let i = 0; i < a.length; i++) diff = Math.max(diff, Math.abs(a[i] - b[i]));
      return a.length === b.length ? diff : -1;
    })
    .catch(() => null);
  await writeFile(
    `${output}/summary.json`,
    JSON.stringify({ gpu, stage3MaxPixelDiff: same, summary }, null, 2),
  );
  console.log(JSON.stringify({ gpu, stage3MaxPixelDiff: same, summary }, null, 2));
} finally {
  await browser.close();
}
