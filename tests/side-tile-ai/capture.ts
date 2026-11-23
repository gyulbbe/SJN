/**
 * The side-tile AI trial's captures (no AI call): each scene (specs.ts) drawn as editor.tsx `capture`
 * draws it for today's method (orbit, one After frame, regions, fixture and surface boxes, the
 * widened-joints frame, the room behind the fixtures and its less glossy copy), with the renderer of
 * one commit (revision.ts): `before` 6e0ca52, `after` 3037c8e (HEAD of the trial branch).
 *
 * Usage: node tests/run-browser-test.mjs tests/side-tile-ai/capture.ts --rev before|after [--only olive-0,...] [--gpu]
 * Output: test-results/side-tile-ai-20261121/<rev>/scenes/<scene>/
 *   capture.png input.png joints.png behind.png soft.png mask.png mask-outside.png regions.json
 *   mask-behind.png regions-behind.json grounding.json prompt.txt layout.json spec.json
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { build, type Plugin } from 'esbuild';
import sharp from 'sharp';
import { trialCatalog } from './catalog';
import { CANDIDATES } from '../room-depth/candidates.mjs';
import { OUT, REVISIONS } from './paths.mjs';
import { revisionPlugin } from './revision';
import { trialSpecs } from './specs';

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
// A room-depth candidate (tests/room-depth/candidates.mjs): its base renderer with source text swaps.
const rev = arg('rev') as string;
const candidate = (
  CANDIDATES as unknown as Record<string, { base: string; patch: Record<string, [string, string][]> }>
)[rev];
if (!(rev in REVISIONS) && !candidate) throw new Error('--rev before|after|<candidate>');
const commit = candidate ? candidate.base : (REVISIONS as Record<string, string>)[rev];
const only = arg('only')?.split(',');
const gpu = process.argv.includes('--gpu');
const { plugin, swapped } = revisionPlugin(commit);
const patched = Object.keys(candidate?.patch ?? {});
if (swapped.some((path) => patched.some((name) => path.endsWith(name))))
  throw new Error('a patched file differs between the base commit and HEAD');
const patchPlugin: Plugin = {
  name: 'room-depth-patch',
  setup(b) {
    b.onLoad({ filter: /[.]ts$/ }, (args) => {
      const path = args.path.replace(/\\/g, '/');
      const swaps = Object.entries(candidate?.patch ?? {}).find(([name]) => path.endsWith(name))?.[1];
      if (!swaps) return undefined;
      // The checkout may have CRLF line ends; the swaps are written with LF.
      let text = readFileSync(args.path, 'utf8').replace(/\r\n/g, '\n');
      for (const [from, to] of swaps) {
        if (!text.includes(from)) throw new Error(`patch: no "${from}" in ${args.path}`);
        text = text.replace(from, to);
      }
      return { contents: text, loader: 'ts' };
    });
  },
};
console.log(`${rev} (${commit}${candidate ? ' + patch' : ''}): swapped ${swapped.join(', ') || 'none'}`);

const { records, files, imageFiles } = trialCatalog();
const SPECS = trialSpecs(Object.keys(records)).filter((s) => !only || only.includes(s.id));
const bundle = await build({
  stdin: {
    contents: [
      "export * from './src/lib/room-viewer/renderer';",
      "export { buildSpecScene } from './tests/export-photoreal/scene-builder';",
      "export { buildFluxGrounding, visibleCeiling } from './src/lib/ai-export/scene';",
      "export { fluxInputLayout } from './src/lib/ai-export/contract';",
      "export { prepareFluxImage } from './src/lib/ai-export/client';",
      "export { buildFluxPrompt } from './src/lib/ai-export/prompt';",
      "export { fluxOrbitView, snapFluxOrbit, FLUX_BACKDROP } from './src/lib/ai-export/view';",
      "export { VIEWER_CEILING_COLOR } from './src/lib/room-viewer/ceiling';",
      "export { defaultRoomView } from './src/lib/room-viewer/view-state';",
      "export { GLARE_SOFT_ROUGHNESS, inputPxPerMm, widenedJointMm, widenJoints } from './src/lib/ai-export/joints';",
    ].join(''),
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
  globalName: 'Lib',
  plugins: [patchPlugin, plugin],
});
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: gpu
    ? ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--enable-gpu']
    : ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const ORIGIN = 'http://127.0.0.1:43247';
const summary: Record<string, unknown> = {};
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route(`${ORIGIN}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith('/images/'))
      return route.fulfill({
        body: (await import('node:fs')).readFileSync(files[decodeURIComponent(path.slice(8))]),
      });
    return route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' });
  });
  await page.goto(`${ORIGIN}/`);
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.evaluate((f) => {
    (window as unknown as { IMAGE_FILES: Record<string, string> }).IMAGE_FILES = f;
  }, imageFiles);
  for (const spec of SPECS) {
    const used = Object.fromEntries(
      [spec.wall, spec.floor, ...(spec.products ?? []).map((p) => p.materialId)].map((m) => [m, records[m]]),
    );
    const started = Date.now();
    const r = await page.evaluate(
      async ({ spec, used }) => {
        type Lib = typeof import('../../src/lib/room-viewer/renderer') &
          typeof import('../export-photoreal/scene-builder') &
          typeof import('../../src/lib/ai-export/scene') &
          typeof import('../../src/lib/ai-export/contract') &
          typeof import('../../src/lib/ai-export/client') &
          typeof import('../../src/lib/ai-export/prompt') &
          typeof import('../../src/lib/ai-export/view') &
          typeof import('../../src/lib/room-viewer/ceiling') &
          typeof import('../../src/lib/room-viewer/view-state') &
          typeof import('../../src/lib/ai-export/joints');
        const lib = (window as unknown as { Lib: Lib }).Lib;
        const base64 = (bytes: Uint8Array | Uint8ClampedArray) => {
          let text = '';
          for (let i = 0; i < bytes.length; i += 0x8000)
            text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          return btoa(text);
        };
        const blob64 = async (blob: Blob) => base64(new Uint8Array(await blob.arrayBuffer()));
        const built = await lib.buildSpecScene(spec, used);
        const snapshot = built.snapshot;
        const reader = async (id: string) => built.assets[id];
        const { imageWidth: width, imageHeight: height } = snapshot.scene;
        const edge = Math.min(1024, Math.max(width, height));
        // As ai-export.tsx: the picker's orbit snapped, then its view.
        const view = lib.fluxOrbitView(lib.snapFluxOrbit({ azimuth: spec.azimuth, elevation: 0 }));
        const frame = {
          width: Math.min(edge, (edge * width) / height),
          height: Math.min(edge, (edge * height) / width),
        };
        const viewer = new lib.RoomViewerRenderer();
        try {
          await viewer.setSnapshot(snapshot, reader, { background: lib.FLUX_BACKDROP });
          const blob = await viewer.export(view, { format: 'png', mode: 'after', longEdge: edge });
          const regions = viewer.regionMask(frame.width, frame.height, view);
          // Today's method (not composite): the room behind the fixtures and its less glossy copy.
          const own = viewer.exportLayers(view, { longEdge: edge });
          const behindRegions = viewer.regionMask(regions.width, regions.height, view, {
            withoutFixtures: true,
          });
          const soft = viewer.exportLayers(view, { longEdge: edge, roughness: lib.GLARE_SOFT_ROUGHNESS });
          const boxes = viewer.fixtureBounds(width, height, view);
          const surfaceBoxes = viewer.surfaceBounds(
            width,
            height,
            view,
            snapshot.scene.surfaces.filter((s) => s.region).map((s) => s.id),
          );
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
              background: lib.FLUX_BACKDROP,
            });
            joints = await widened.export(view, { format: 'png', mode: 'after', longEdge: edge });
          } finally {
            widened.dispose();
          }
          const bitmap = await createImageBitmap(blob);
          const layout = lib.fluxInputLayout(bitmap.width, bitmap.height);
          const grounding = await lib.buildFluxGrounding({
            snapshot,
            reader,
            capture: bitmap,
            layout,
            boxes,
            surfaceBoxes,
            ceiling: lib.visibleCeiling(regions) ? lib.VIEWER_CEILING_COLOR : undefined,
            cutaway: true,
            azimuth: view.orbit ? view.orbit.azimuth : undefined,
          });
          const size = { width: bitmap.width, height: bitmap.height };
          bitmap.close();
          // The editor's own 3D view (view-state defaultRoomView, as tests/side-wall/render.ts draws it).
          const editorFrame = viewer.render(1200, 800, lib.defaultRoomView(), 'after');
          const editorCopy = document.createElement('canvas');
          editorCopy.width = editorFrame.width;
          editorCopy.height = editorFrame.height;
          editorCopy.getContext('2d')!.drawImage(editorFrame, 0, 0);
          const editor = editorCopy.toDataURL('image/png').split(',')[1];
          return {
            editor,
            capture: await blob64(blob),
            input: await blob64(await lib.prepareFluxImage(blob)),
            joints: await blob64(joints),
            behind: { width: own.width, height: own.height, data: base64(own.shadowed) },
            soft: { width: soft.width, height: soft.height, data: base64(soft.shadowed) },
            layout,
            size,
            grounding: { scene: grounding.scene, placed: grounding.placed },
            prompt: lib.buildFluxPrompt(grounding.scene),
            mask: { width: regions.width, height: regions.height, regions: regions.regions },
            maskData: base64(regions.data),
            outsideData: base64(regions.outside),
            behindMask: {
              width: behindRegions.width,
              height: behindRegions.height,
              regions: behindRegions.regions,
            },
            behindData: base64(behindRegions.data),
            behindOutside: base64(behindRegions.outside),
          };
        } finally {
          viewer.dispose();
        }
      },
      { spec, used },
    );
    if (errors.length) throw new Error(errors.join('\n'));
    const dir = join(OUT as string, rev, 'scenes', spec.id);
    mkdirSync(dir, { recursive: true });
    const buf = (b: string) => Buffer.from(b, 'base64');
    writeFileSync(join(dir, 'capture.png'), buf(r.capture));
    writeFileSync(join(dir, 'editor-3d.png'), buf(r.editor));
    writeFileSync(join(dir, 'input.png'), buf(r.input));
    writeFileSync(join(dir, 'joints.png'), buf(r.joints));
    for (const [name, layer] of [
      ['behind.png', r.behind],
      ['soft.png', r.soft],
    ] as const)
      await sharp(buf(layer.data), { raw: { width: layer.width, height: layer.height, channels: 4 } })
        .png()
        .toFile(join(dir, name));
    writeFileSync(join(dir, 'grounding.json'), JSON.stringify(r.grounding, null, 1));
    writeFileSync(join(dir, 'layout.json'), JSON.stringify({ layout: r.layout, size: r.size }));
    writeFileSync(join(dir, 'prompt.txt'), r.prompt);
    writeFileSync(join(dir, 'spec.json'), JSON.stringify(spec, null, 1));
    writeFileSync(join(dir, 'regions.json'), JSON.stringify(r.mask));
    writeFileSync(join(dir, 'regions-behind.json'), JSON.stringify(r.behindMask));
    for (const [name, data, m] of [
      ['mask.png', r.maskData, r.mask],
      ['mask-outside.png', r.outsideData, r.mask],
      ['mask-behind.png', r.behindData, r.behindMask],
      ['mask-behind-outside.png', r.behindOutside, r.behindMask],
    ] as const)
      await sharp(buf(data), { raw: { width: m.width, height: m.height, channels: 1 } })
        .png()
        .toFile(join(dir, name));
    summary[spec.id] = {
      input: [r.layout.width, r.layout.height],
      prompt: r.prompt.length,
      ms: Date.now() - started,
    };
    console.log(rev, spec.id, JSON.stringify(summary[spec.id]));
  }
} finally {
  await browser.close();
}
writeFileSync(
  join(OUT as string, rev, 'capture-summary.json'),
  JSON.stringify({ rev: commit, patch: candidate?.patch, swapped, gpu, summary }, null, 1),
);
