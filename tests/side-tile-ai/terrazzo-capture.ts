/**
 * The supervisor's empty-room Cloudflare check (2026-11-21, `side1-terrazzo-center`, seed 424242) as a
 * composite-replay.ts scene folder, no AI call. That answer was made from the input that
 * tests/flux-composite-browser.ts writes for its `terrazzo-center` room (the test terrazzo room of
 * tests/helpers/flux-room-scene.ts, old 1200 mm in-room eye, renderer as checked out). This draws the same
 * frame the same way and adds what the replay needs and that test does not keep: the region mask with
 * its outside part, the fixtures' boxes, the layout and the widened-joints frame (as ai-export.tsx sends
 * them in composite mode). It checks that the empty-room input it makes is byte-identical to the one the
 * answer came from, so the replay puts the answer back on the very frame it was made for.
 *
 * Usage: node tests/run-browser-test.mjs tests/side-tile-ai/terrazzo-capture.ts [--sent <input-empty.png>]
 *   --sent: the input the answer was made from
 *   (default test-results/export-photoreal/scenes/side1-terrazzo-center/input-empty.png)
 * Output: test-results/side-tile-ai-20261121/after/composite/terrazzo-center/ (as composite-capture.ts)
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import sharp from 'sharp';
import { OUT } from './paths.mjs';

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const sent = arg('sent') ?? 'test-results/export-photoreal/scenes/side1-terrazzo-center/input-empty.png';
if (!existsSync(sent)) throw new Error(`no ${sent}`);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const bundle = await build({
  stdin: {
    contents: [
      "export * from './src/lib/room-viewer/renderer';",
      "export { buildFluxRoomScene, presetFluxView } from './tests/helpers/flux-room-scene';",
      "export { fluxInputLayout } from './src/lib/ai-export/contract';",
      "export { prepareFluxImage, pixelsToPng } from './src/lib/ai-export/client';",
      "export { inputPxPerMm, widenedJointMm, widenJoints } from './src/lib/ai-export/joints';",
    ].join(''),
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
  globalName: 'Lib',
});
// The same switches as tests/flux-composite-browser.ts without --gpu.
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: [
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
  ],
});
const ORIGIN = 'http://127.0.0.1:43249';
try {
  const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route(`${ORIGIN}/**`, (route) =>
    route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' }),
  );
  await page.goto(`${ORIGIN}/`);
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const r = await page.evaluate(async () => {
    type Lib = typeof import('../../src/lib/room-viewer/renderer') &
      typeof import('../helpers/flux-room-scene') &
      typeof import('../../src/lib/ai-export/contract') &
      typeof import('../../src/lib/ai-export/client') &
      typeof import('../../src/lib/ai-export/joints');
    const lib = (window as unknown as { Lib: Lib }).Lib;
    const base64 = (bytes: Uint8Array | Uint8ClampedArray) => {
      let text = '';
      for (let i = 0; i < bytes.length; i += 0x8000)
        text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(text);
    };
    const blob64 = async (blob: Blob) => base64(new Uint8Array(await blob.arrayBuffer()));
    // As tests/flux-composite-browser.ts for { walls: 'terrazzo', preset: 'center' }.
    const { room, assets, snapshot, imageWidth, imageHeight } = await lib.buildFluxRoomScene({
      walls: 'terrazzo',
    });
    const reader = async (id: string) => assets[id];
    const view = lib.presetFluxView(room, 'center');
    const edge = Math.min(1024, Math.max(imageWidth, imageHeight));
    const frame = {
      width: Math.min(edge, (edge * imageWidth) / imageHeight),
      height: Math.min(edge, (edge * imageHeight) / imageWidth),
    };
    const viewer = new lib.RoomViewerRenderer();
    try {
      await viewer.setSnapshot(snapshot, reader, { exportAngles: true });
      const layers = viewer.exportLayers(view, { longEdge: edge });
      const regions = viewer.regionMask(frame.width, frame.height, view);
      const boxes = viewer.fixtureBounds(imageWidth, imageHeight, view);
      viewer.render(frame.width, frame.height, view, 'after');
      const perMm = lib.inputPxPerMm(
        (face, u, v) => viewer.faceToFrame(face, u, v),
        snapshot.scene.room!,
        frame,
        lib.fluxInputLayout(frame.width, frame.height).scale,
      );
      const widened = new lib.RoomViewerRenderer();
      let joints: Blob;
      try {
        await widened.setSnapshot(lib.widenJoints(snapshot, lib.widenedJointMm(perMm)), reader, {
          exportAngles: true,
        });
        joints = await widened.export(view, { format: 'png', mode: 'after', longEdge: edge });
      } finally {
        widened.dispose();
      }
      const empty = { width: layers.width, height: layers.height, data: layers.empty };
      const input = await lib.prepareFluxImage(await lib.pixelsToPng(empty));
      return {
        input: await blob64(input),
        joints: await blob64(joints),
        perMm,
        layers: {
          width: layers.width,
          height: layers.height,
          full: base64(layers.full),
          shadowed: base64(layers.shadowed),
          empty: base64(layers.empty),
          coverage: base64(layers.coverage),
        },
        layout: lib.fluxInputLayout(layers.width, layers.height),
        boxes: Object.values(boxes),
        mask: { width: regions.width, height: regions.height, regions: regions.regions },
        maskData: base64(regions.data),
        outsideData: base64(regions.outside),
      };
    } finally {
      viewer.dispose();
    }
  });
  if (errors.length) throw new Error(errors.join('\n'));
  const buf = (b: string) => Buffer.from(b, 'base64');
  const made = buf(r.input),
    original = readFileSync(sent);
  const same = sha(made) === sha(original);
  const dir = join(OUT as string, 'after', 'composite', 'terrazzo-center');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'input-empty.png'), made);
  writeFileSync(join(dir, 'joints.png'), buf(r.joints));
  const { width, height } = r.layers;
  for (const name of ['full', 'shadowed', 'empty'] as const)
    await sharp(buf(r.layers[name]), { raw: { width, height, channels: 4 } })
      .png()
      .toFile(join(dir, `${name}.png`));
  await sharp(buf(r.layers.coverage), { raw: { width, height, channels: 1 } })
    .png()
    .toFile(join(dir, 'coverage.png'));
  for (const [name, data] of [
    ['mask.png', r.maskData],
    ['mask-outside.png', r.outsideData],
  ] as const)
    await sharp(buf(data), { raw: { width: r.mask.width, height: r.mask.height, channels: 1 } })
      .png()
      .toFile(join(dir, name));
  writeFileSync(join(dir, 'regions.json'), JSON.stringify(r.mask));
  writeFileSync(join(dir, 'boxes.json'), JSON.stringify(r.boxes));
  writeFileSync(join(dir, 'layout.json'), JSON.stringify(r.layout));
  const spec = {
    id: 'terrazzo-center',
    sent,
    sentSha: sha(original),
    madeSha: sha(made),
    same,
    perMm: r.perMm,
  };
  writeFileSync(join(dir, 'spec.json'), JSON.stringify(spec, null, 1));
  console.log(JSON.stringify({ ...spec, size: `${width}x${height}` }));
  if (!same) throw new Error('the empty-room input differs from the one the answer was made from');
} finally {
  await browser.close();
}
