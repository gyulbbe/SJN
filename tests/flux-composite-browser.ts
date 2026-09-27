/**
 * Real-WebGL check of the composite FLUX export (no AI call): the renderer's layers of one frame
 * (full, room with the fixtures' shadows, empty room, fixture coverage) rebuild the plain export;
 * the grey placeholders stay under the fixtures; a mock model answer (the input scaled back up)
 * gets our fixtures composited at their render pixels; a mock answer with the floor moved is flagged;
 * and the export-only photo choice follows the camera without changing the footprint.
 * Writes the comparison inputs (empty room, placeholders, scene, prompts, layers) to
 * test-results/flux-composite/payload/.
 *
 * Usage: node tests/run-browser-test.mjs tests/flux-composite-browser.ts [--gpu]
 */
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import sharp from 'sharp';

const gpu = process.argv.includes('--gpu');
const output = 'test-results/flux-composite/payload';
await mkdir(output, { recursive: true });
const bundle = await build({
  stdin: {
    contents: `export * from './src/lib/room-viewer/renderer';export * from './src/lib/room-viewer/view-state';export {VIEWER_CEILING_COLOR} from './src/lib/room-viewer/ceiling';export {buildFluxRoomScene} from './tests/helpers/flux-room-scene';export {buildFluxGrounding,visibleCeiling} from './src/lib/ai-export/scene';export {fluxInputLayout} from './src/lib/ai-export/contract';export {prepareFluxImage,pixelsToPng,readPixels} from './src/lib/ai-export/client';export {buildFluxPrompt} from './src/lib/ai-export/prompt';export {fluxSceneSchema} from './src/lib/ai-export/scene-contract';export {fluxView} from './src/lib/ai-export/view';export * from './src/lib/ai-export/composite';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
  globalName: 'Composite',
});
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: gpu
    ? ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--enable-gpu']
    : ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (e) => {
    if (e.type() === 'error') errors.push(e.text());
  });
  await page.route('http://127.0.0.1:43223/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' }),
  );
  await page.goto('http://127.0.0.1:43223/');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const run = await page.evaluate(async () => {
    type Lib = typeof import('../src/lib/room-viewer/renderer') &
      typeof import('../src/lib/room-viewer/view-state') &
      typeof import('../src/lib/room-viewer/ceiling') &
      typeof import('./helpers/flux-room-scene') &
      typeof import('../src/lib/ai-export/scene') &
      typeof import('../src/lib/ai-export/contract') &
      typeof import('../src/lib/ai-export/client') &
      typeof import('../src/lib/ai-export/prompt') &
      typeof import('../src/lib/ai-export/scene-contract') &
      typeof import('../src/lib/ai-export/view') &
      typeof import('../src/lib/ai-export/composite');
    type Pixels = import('../src/lib/ai-export/color').Pixels;
    const lib = (window as unknown as { Composite: Lib }).Composite;
    const gl = document.createElement('canvas').getContext('webgl2');
    const debug = gl?.getExtension('WEBGL_debug_renderer_info');
    const gpuName = gl && debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : 'unknown';
    const dataUrl = (blob: Blob) =>
      new Promise<string>((resolve) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result as string);
        r.readAsDataURL(blob);
      });
    const png = async (image: Pixels) => dataUrl(await lib.pixelsToPng(image));
    const diff = (a: ArrayLike<number>, b: ArrayLike<number>, only?: (i: number) => boolean) => {
      let max = 0,
        sum = 0,
        n = 0,
        over2 = 0;
      for (let i = 0; i < a.length; i += 4) {
        if (only && !only(i / 4)) continue;
        for (let c = 0; c < 3; c++) {
          const d = Math.abs(a[i + c] - b[i + c]);
          max = Math.max(max, d);
          sum += d;
          n++;
          if (d > 2) over2++;
        }
      }
      return { max, mean: n ? sum / n : 0, over2, n };
    };
    /** The model's answer if it changed nothing: the input scaled to twice its size (optionally moved down). */
    const mockAnswer = async (input: Blob, shiftDown = 0) => {
      const bitmap = await createImageBitmap(input);
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width * 2;
      canvas.height = bitmap.height * 2;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, 0, shiftDown, canvas.width, canvas.height);
      bitmap.close();
      return lib.readPixels(await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), 'image/png')));
    };
    const configs = [
      { walls: 'terrazzo', preset: 'center' },
      { walls: 'terrazzo', preset: 'right-corner' },
      { walls: 'white', preset: 'center' },
      { walls: 'white', preset: 'right-corner' },
    ] as const;
    const out = [];
    for (const config of configs) {
      const { room, assets, snapshot, imageWidth, imageHeight } = await lib.buildFluxRoomScene({
        walls: config.walls,
      });
      const reader = async (id: string) => assets[id];
      const view = lib.fluxView(room, config.preset, {});
      const edge = Math.min(1024, Math.max(imageWidth, imageHeight));
      const viewer = new lib.RoomViewerRenderer();
      try {
        await viewer.setSnapshot(snapshot, reader, { exportAngles: true });
        const blob = await viewer.export(view, { format: 'png', mode: 'after', longEdge: edge });
        const started = performance.now();
        const layers = viewer.exportLayers(view, { longEdge: edge });
        const layersMs = Math.round(performance.now() - started);
        const mask = viewer.regionMask(
          Math.min(edge, (edge * imageWidth) / imageHeight),
          Math.min(edge, (edge * imageHeight) / imageWidth),
          view,
        );
        const boxesById = viewer.fixtureBounds(imageWidth, imageHeight, view);
        const boxes = Object.values(boxesById);
        const exported = await lib.readPixels(blob);
        // 1. The full layer is the plain export.
        const fullVsExport = diff(layers.full, exported.data);
        // 2. Fixtures over (empty × shadow) rebuild the render.
        const fixtures = lib.fixtureLayer(layers);
        const shadow = lib.shadowLayer(layers);
        const size = { width: layers.width, height: layers.height };
        const emptyPixels = { ...size, data: layers.empty };
        const rebuilt = lib.compositeFixtures({ room: emptyPixels, fixtures, shadow });
        const rebuild = diff(rebuilt.data, layers.full);
        let covered = 0,
          partial = 0,
          shadowed = 0;
        for (let i = 0; i < layers.coverage.length; i++) {
          if (layers.coverage[i] === 255) covered++;
          else if (layers.coverage[i] > 0) partial++;
          if (shadow[i] < 0.97) shadowed++;
        }
        // 3. Placeholders sit strictly under full coverage.
        const placeholder = lib.placeholderRoom(layers);
        let grey = 0,
          greyUncovered = 0;
        for (let i = 0; i < layers.coverage.length; i++) {
          if (
            placeholder.data[i * 4] === lib.PLACEHOLDER_GREY &&
            layers.empty[i * 4] !== lib.PLACEHOLDER_GREY
          ) {
            grey++;
            if (layers.coverage[i] < 250) greyUncovered++;
          }
        }
        // 4. A mock answer that changes nothing: fixtures at their render pixels, unshifted.
        const input = await lib.prepareFluxImage(await lib.pixelsToPng(emptyPixels));
        const layout = lib.fluxInputLayout(layers.width, layers.height);
        const composed = lib.composeFluxResult({
          result: await mockAnswer(input),
          input: emptyPixels,
          layers,
          mask,
          layout,
          boxes,
        });
        // Fully covered fixture pixels away from the edge: the render's own.
        const inner = (i: number) => {
          const x = i % layers.width,
            y = Math.floor(i / layers.width);
          if (x < 2 || y < 2 || x >= layers.width - 2 || y >= layers.height - 2) return false;
          for (let dy = -2; dy <= 2; dy++)
            for (let dx = -2; dx <= 2; dx++)
              if (layers.coverage[i + dy * layers.width + dx] < 255) return false;
          return true;
        };
        // Position first, with light matching off: the render's own pixels.
        const answer = lib.resultOnCapture(await mockAnswer(input), layout, size);
        const placedOnly = lib.compositeFixtures({ room: answer, fixtures, shadow });
        const fixtureMatch = diff(placedOnly.data, layers.full, inner);
        // Then the light: an unchanged room asks for (almost) no change.
        const gains = lib.fixtureGains({ ai: answer, layers, mask, shadow, boxes });
        // 5. The model moved the room down by 12 result px: flagged.
        const moved = lib.composeFluxResult({
          result: await mockAnswer(input, 12),
          input: emptyPixels,
          layers,
          mask,
          layout,
          boxes,
        });
        // Payload for the real comparison.
        const bitmap = await createImageBitmap(blob);
        const grounding = await lib.buildFluxGrounding({
          snapshot,
          reader,
          capture: bitmap,
          layout: lib.fluxInputLayout(bitmap.width, bitmap.height),
          boxes: boxesById,
          ceiling: lib.visibleCeiling(mask) ? lib.VIEWER_CEILING_COLOR : undefined,
        });
        bitmap.close();
        const scenes = {
          current: grounding.scene,
          'empty-room': { ...grounding.scene, fixtures: [], mode: 'empty-room' as const },
          placeholders: { ...grounding.scene, fixtures: [], mode: 'placeholders' as const },
        };
        const inputB = await lib.prepareFluxImage(await lib.pixelsToPng(placeholder));
        const coverageImage = {
          ...size,
          data: Uint8ClampedArray.from({ length: layers.coverage.length * 4 }, (_, i) =>
            i % 4 === 3 ? 255 : layers.coverage[Math.floor(i / 4)],
          ),
        };
        out.push({
          label: `${config.walls}-${config.preset}`,
          layersMs,
          size,
          fullVsExport,
          rebuild,
          covered,
          partial,
          shadowed,
          grey,
          greyUncovered,
          fixtureMatch,
          gains: gains.map((g) => ({ gain: g.gain.map((v) => +v.toFixed(3)), ring: g.ringPixels })),
          withLight: diff(composed.raw.data, layers.full, inner),
          floor: composed.floor,
          shifted: composed.shifted,
          framing: composed.review.framing.score,
          movedFloor: moved.floor,
          movedShifted: moved.shifted,
          valid: Object.fromEntries(
            Object.entries(scenes).map(([k, s]) => [k, lib.fluxSceneSchema.safeParse(s).success]),
          ),
          prompts: Object.fromEntries(Object.entries(scenes).map(([k, s]) => [k, lib.buildFluxPrompt(s)])),
          scenes,
          layout,
          boxes: boxesById,
          placed: grounding.placed,
          images: {
            capture: await dataUrl(blob),
            'input-current': await dataUrl(await lib.prepareFluxImage(blob)),
            'input-empty-room': await dataUrl(input),
            'input-placeholders': await dataUrl(inputB),
            shadowed: await png({ ...size, data: layers.shadowed }),
            empty: await png(emptyPixels),
            coverage: await png(coverageImage),
            'mock-composite': await png(composed.raw),
          },
          mask: {
            width: mask.width,
            height: mask.height,
            regions: mask.regions,
            // base64: the labels are too many for a JSON number list.
            base64: btoa(Array.from(mask.data, (v) => String.fromCharCode(v)).join('')),
          },
        });
      } finally {
        viewer.dispose();
      }
    }
    // 6. The export-only photo choice: a cabinet with front, right-diagonal and right-side photos.
    const angles: Record<string, unknown> = {};
    {
      const { room, assets, snapshot, imageWidth, imageHeight } = await lib.buildFluxRoomScene({
        product: true,
      });
      const reader = async (id: string) => assets[id];
      for (const exportAngles of [false, true]) {
        const viewer = new lib.RoomViewerRenderer();
        try {
          await viewer.setSnapshot(snapshot, reader, { exportAngles });
          for (const preset of ['center', 'right-corner'] as const) {
            const view = lib.fluxView(room, preset, {});
            // A plain frame of this view (an export would restore the previous live frame after).
            viewer.render(1024, 683, view, 'after');
            const prepared = (
              viewer as unknown as { prepared: { after: { fixtures: { group: import('three').Group } } } }
            ).prepared.after.fixtures.group;
            const cabinet = prepared.children.find((c) => c.userData.fixtureId === 'cabinet')!;
            const planes: { viewIndex: number; visible: boolean }[] = [];
            cabinet.traverse((node) => {
              if (typeof node.userData.viewIndex === 'number')
                planes.push({ viewIndex: node.userData.viewIndex, visible: node.visible });
            });
            angles[`${exportAngles ? 'export' : 'live'}-${preset}`] = {
              planes: planes.map((p) => p.viewIndex),
              shown: planes.find((p) => p.visible)?.viewIndex,
              box: viewer.fixtureBounds(imageWidth, imageHeight, view).cabinet?.map((v) => +v.toFixed(4)),
            };
          }
        } finally {
          viewer.dispose();
        }
      }
      // The saved choice is untouched.
      angles.savedViewIndex = snapshot.scene.fixtures.find((f) => f.id === 'cabinet')!.viewIndex;
    }
    return { gpuName, out, angles };
  });
  assert.deepEqual(errors, [], errors.join('\n'));
  const toPng = (url: string) => Buffer.from(url.split(',')[1], 'base64');
  const summary = [];
  for (const r of run.out) {
    for (const [name, url] of Object.entries(r.images))
      await writeFile(`${output}/${r.label}-${name}.png`, toPng(url));
    for (const [name, prompt] of Object.entries(r.prompts))
      await writeFile(`${output}/${r.label}-prompt-${name}.txt`, prompt);
    await writeFile(
      `${output}/${r.label}-scene.json`,
      JSON.stringify({ scenes: r.scenes, layout: r.layout, boxes: r.boxes, placed: r.placed }, null, 2),
    );
    await writeFile(`${output}/${r.label}-mask.json`, JSON.stringify(r.mask));
    assert.equal(r.fullVsExport.max, 0, `${r.label}: the full layer differs from the export`);
    // Fixtures exactly; the shadow is a brightness ratio (not per channel), so shaded room pixels
    // may differ by a few levels.
    assert.ok(
      r.rebuild.max <= 6 && r.rebuild.mean < 0.1,
      `${r.label}: layers rebuild the render (max ${r.rebuild.max}, over 2 levels ${r.rebuild.over2})`,
    );
    assert.ok(r.covered > 1000 && r.partial > 0, `${r.label}: fixtures covered with antialiased edges`);
    assert.ok(r.shadowed > 0, `${r.label}: the fixtures cast a shadow on the room`);
    assert.ok(r.grey > 0 && r.greyUncovered === 0, `${r.label}: placeholders stay under the fixtures`);
    assert.ok(
      r.fixtureMatch.max <= 1,
      `${r.label}: composited fixtures keep the render's pixels (max ${r.fixtureMatch.max})`,
    );
    for (const g of r.gains)
      assert.ok(
        g.gain.every((v) => Math.abs(v - 1) < 0.06),
        `${r.label}: unchanged room, light gain near 1 (${g.gain})`,
      );
    assert.equal(r.shifted, false, `${r.label}: an unchanged answer is not flagged`);
    assert.equal(r.movedShifted, true, `${r.label}: a moved floor line is flagged`);
    for (const [k, v] of Object.entries(r.valid))
      assert.equal(v, true, `${r.label} ${k} scene failed the schema`);
    assert.doesNotMatch(
      r.prompts['empty-room'],
      /It must remain|Image 0 contains exactly/,
      `${r.label}: no fixture in the empty prompt`,
    );
    summary.push({
      label: r.label,
      layersMs: r.layersMs,
      fullVsExport: r.fullVsExport.max,
      rebuild: { max: r.rebuild.max, mean: +r.rebuild.mean.toFixed(4), over2: r.rebuild.over2 },
      covered: r.covered,
      partial: r.partial,
      shadowed: r.shadowed,
      placeholders: { grey: r.grey, uncovered: r.greyUncovered },
      fixtureMatch: {
        max: r.fixtureMatch.max,
        mean: +r.fixtureMatch.mean.toFixed(3),
        pixels: r.fixtureMatch.n / 3,
      },
      gains: r.gains,
      withLight: { max: r.withLight.max, mean: +r.withLight.mean.toFixed(3) },
      floor: r.floor,
      framing: +r.framing.toFixed(2),
      moved: { floor: r.movedFloor, shifted: r.movedShifted },
      promptLengths: Object.fromEntries(Object.entries(r.prompts).map(([k, p]) => [k, p.length])),
    });
  }
  // The terrazzo room is the 2026-09-27 room: same capture as that comparison's input.
  const earlier = 'test-results/flux-input-in-room/payload/eye-center-capture.png';
  let sameAsEarlier: number | undefined;
  if (existsSync(earlier)) {
    const a = await sharp(await readFile(earlier))
      .raw()
      .toBuffer();
    const b = await sharp(await readFile(`${output}/terrazzo-center-capture.png`))
      .raw()
      .toBuffer();
    sameAsEarlier = -1;
    if (a.length === b.length) {
      sameAsEarlier = 0;
      for (let i = 0; i < a.length; i++) sameAsEarlier = Math.max(sameAsEarlier, Math.abs(a[i] - b[i]));
    }
  }
  const report = { gpu, gpuName: run.gpuName, sameAsEarlier, summary, angles: run.angles };
  await writeFile(`${output}/summary${gpu ? '-gpu' : ''}.json`, JSON.stringify(report, null, 2));
  const angles = run.angles as Record<string, { planes: number[]; shown: number; box: number[] }>;
  // Live views switch only between exact sides; the export picks the diagonal from the corner and
  // never builds the narrow side photo; the footprint and the saved choice stay.
  assert.equal(angles['live-right-corner'].shown, 0);
  assert.equal(angles['export-center'].shown, 0);
  assert.equal(angles['export-right-corner'].shown, 1);
  assert.deepEqual(angles['export-right-corner'].planes.sort(), [0, 1]);
  assert.deepEqual(angles['export-right-corner'].box, angles['live-right-corner'].box);
  assert.equal(run.angles.savedViewIndex, 0);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
