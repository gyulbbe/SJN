/** Actual raster marker checks. Reuses saved geometry; no inference or input writes. */
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import type { AssetRecord, MaterialVersion, ProjectDocument } from '../src/lib/types';
const input =
  process.env.SJN_VIEWPORT_INPUT ??
  'test-results/reconstruction-fifteen-rebuild/20260915-start/variants/final-fifteen-v4-room-estimates-20260915/additional-06/scene.json';
const out = 'test-results/reconstruction-fifteen-rebuild/20260915-start/source-viewport-shadow-audit';
const phase = process.env.SJN_VIEWPORT_PHASE ?? 'after';
const bytes = await readFile(input),
  sha = createHash('sha256').update(bytes).digest('hex');
const source = JSON.parse(bytes.toString()) as {
  document: ProjectDocument;
  versions: MaterialVersion[];
  assets: (Omit<AssetRecord, 'blob'> & { blobBase64?: string })[];
};
const built = await build({
  stdin: {
    contents:
      "export {RoomViewerRenderer} from './src/lib/room-viewer/renderer';export {createRoomViewCamera,roomViewViewport,sourceRoomView,resetRoomView,rotateRoomView} from './src/lib/room-viewer/view-state';export {Mesh,SphereGeometry,MeshBasicMaterial,Vector3} from 'three';",
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
  globalName: 'Probe',
});
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-webgl'] });
try {
  await mkdir(out, { recursive: true });
  const page = await browser.newPage(),
    errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/*', (r) => r.fulfill({ contentType: 'text/html', body: '<html></html>' }));
  await page.goto('http://127.0.0.1:43917/');
  await page.addScriptTag({ content: built.outputFiles[0].text });
  const result = await page.evaluate(async (source) => {
    const m = (
      window as unknown as {
        Probe: typeof import('../src/lib/room-viewer/renderer') &
          typeof import('../src/lib/room-viewer/view-state') &
          typeof import('three');
      }
    ).Probe;
    const project = source.document,
      scene = project.shared.comparison!.before,
      baseView = project.roomView!;
    const assets = new Map(
      source.assets
        .filter((a) => a.blobBase64)
        .map((a) => [
          a.id,
          {
            ...a,
            blob: new Blob([Uint8Array.from(atob(a.blobBase64!), (c) => c.charCodeAt(0))], { type: a.mime }),
          } as AssetRecord,
        ]),
    );
    const renderer = new m.RoomViewerRenderer();
    await renderer.setSnapshot(
      {
        scene: project.designs[0].scene,
        beforeScene: scene,
        materials: Object.fromEntries(source.versions.map((v) => [v.id, v])),
        roomView: baseView,
      },
      async (id) => assets.get(id),
    );
    const original = renderer.render(1600, 1067, baseView, 'before').toDataURL();
    const state = renderer as unknown as {
      prepared: { before: { world: import('three').Scene }; after: { world: import('three').Scene } };
      renderer: import('three').WebGLRenderer;
    };
    const scenarios = [
      {
        id: 'portrait',
        width: 1600,
        height: 1067,
        mode: 'before',
        image: baseView.sourceCamera!.image,
        shadow: true,
      },
      {
        id: 'portrait-after',
        width: 1600,
        height: 1067,
        mode: 'after',
        image: baseView.sourceCamera!.image,
        shadow: true,
      },
      {
        id: 'portrait-no-shadow',
        width: 1600,
        height: 1067,
        mode: 'before',
        image: baseView.sourceCamera!.image,
        shadow: false,
      },
      {
        id: 'compare',
        width: 2000,
        height: 800,
        mode: 'compare',
        image: baseView.sourceCamera!.image,
        shadow: true,
      },
      {
        id: 'landscape',
        width: 1600,
        height: 1067,
        mode: 'before',
        image: { width: 1400, height: 600 },
        shadow: true,
      },
      {
        id: 'square',
        width: 1000,
        height: 600,
        mode: 'before',
        image: { width: 600, height: 600 },
        shadow: true,
      },
      {
        id: 'mobile',
        width: 420,
        height: 740,
        mode: 'before',
        image: baseView.sourceCamera!.image,
        shadow: true,
      },
      {
        id: 'fit',
        width: 1000,
        height: 600,
        mode: 'before',
        image: baseView.sourceCamera!.image,
        shadow: true,
      },
      {
        id: 'turn',
        width: 1000,
        height: 600,
        mode: 'before',
        image: baseView.sourceCamera!.image,
        shadow: true,
      },
      {
        id: 'pan-zoom',
        width: 1000,
        height: 600,
        mode: 'before',
        image: baseView.sourceCamera!.image,
        shadow: true,
      },
      {
        id: 'portrait-reset',
        width: 1600,
        height: 1067,
        mode: 'before',
        image: baseView.sourceCamera!.image,
        shadow: true,
      },
    ] as const;
    const rows: unknown[] = [];
    const outputs: Record<string, string> = {};
    const allErrors: number[] = [];
    for (const scenario of scenarios) {
      let view = {
        ...structuredClone(baseView),
        sourceCamera: { ...structuredClone(baseView.sourceCamera!), image: { ...scenario.image } },
      };
      if (scenario.id === 'fit') view = m.resetRoomView(view, 'room-fit') as typeof view;
      if (scenario.id === 'turn') view = m.rotateRoomView(view, 'right') as typeof view;
      if (scenario.id === 'pan-zoom') view = { ...view, zoom: 1.5, pan: { x: 0.08, y: -0.05 } };
      state.renderer.shadowMap.enabled = scenario.shadow;
      const width = scenario.width,
        height = scenario.height,
        panelWidth = scenario.mode === 'compare' ? width / 2 : width;
      const camera = m.createRoomViewCamera(scene.room!, panelWidth / height, view),
        rect = m.roomViewViewport(panelWidth, height, view);
      const markers = [
        { color: 0xff0000, nx: 0.35, ny: 0.25 },
        { color: 0x00ff00, nx: 0.5, ny: 0.5 },
        { color: 0x0000ff, nx: 0.65, ny: 0.75 },
      ];
      const meshes: import('three').Mesh[] = [];
      for (const world of [state.prepared.before.world, state.prepared.after.world])
        for (const marker of markers) {
          const ray = new m.Vector3(marker.nx * 2 - 1, 1 - marker.ny * 2, 0.5).unproject(camera);
          const local = ray.clone().applyMatrix4(camera.matrixWorldInverse);
          local.multiplyScalar(1200 / -local.z);
          const radius = 8 / view.zoom;
          const mesh = new m.Mesh(
            new m.SphereGeometry(radius, 20, 12),
            new m.MeshBasicMaterial({
              color: marker.color,
              transparent: true,
              depthTest: false,
              depthWrite: false,
              toneMapped: false,
            }),
          );
          mesh.position.copy(local.applyMatrix4(camera.matrixWorld));
          mesh.renderOrder = 100000;
          world.add(mesh);
          meshes.push(mesh);
        }
      const output = renderer.render(width, height, view, scenario.mode),
        canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(output, 0, 0);
      const pixels = ctx.getImageData(0, 0, width, height).data;
      const panels = scenario.mode === 'compare' ? 2 : 1,
        centroids = [];
      for (let panel = 0; panel < panels; panel++)
        for (const [index, marker] of markers.entries()) {
          let sx = 0,
            sy = 0,
            count = 0;
          for (let y = 0; y < height; y++)
            for (let x = panel * panelWidth; x < (panel + 1) * panelWidth; x++) {
              const i = (y * width + x) * 4;
              if (
                pixels[i + index] > 200 &&
                pixels[i + ((index + 1) % 3)] < 60 &&
                pixels[i + ((index + 2) % 3)] < 60
              ) {
                sx += x + 0.5;
                sy += y + 0.5;
                count++;
              }
            }
          const mathExpected = {
            x: panel * panelWidth + rect.x + marker.nx * rect.width,
            y: height - rect.y - (1 - marker.ny) * rect.height,
          };
          // WebGL's integer viewport conversion is distinct from optical projection.
          const rasterExpected = {
            x: panel * panelWidth + Math.round(rect.x) + marker.nx * Math.round(rect.width),
            y: height - Math.round(rect.y) - (1 - marker.ny) * Math.round(rect.height),
          };
          const actual = { x: sx / count, y: sy / count };
          const rasterErrorPx = Math.hypot(actual.x - rasterExpected.x, actual.y - rasterExpected.y);
          allErrors.push(count ? rasterErrorPx : Infinity);
          centroids.push({
            panel,
            index,
            count,
            mathExpected,
            rasterExpected,
            actual,
            rasterErrorPx,
            opticalErrorPx: Math.hypot(actual.x - mathExpected.x, actual.y - mathExpected.y),
          });
        }
      outputs[scenario.id] = canvas.toDataURL();
      rows.push({ scenario, viewport: rect, centroids, diagnostics: renderer.diagnostics() });
      for (const mesh of meshes) {
        mesh.removeFromParent();
        mesh.geometry.dispose();
        for (const mat of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) mat.dispose();
      }
    }
    const identicalAfterResize = outputs.portrait === outputs['portrait-reset'];
    renderer.dispose();
    return {
      original,
      outputs,
      rows,
      allErrors,
      identicalAfterResize,
      assetScope: source.assets.every((a) => a.blobBase64)
        ? 'full saved assets'
        : 'metadata-only assets: material fallbacks; marker/geometry/shadow test, not full texture quality',
    };
  }, source);
  await writeFile(out + '/' + phase + '-scene.png', Buffer.from(result.original.split(',')[1], 'base64'));
  for (const [name, data] of Object.entries(result.outputs))
    await writeFile(
      out + '/' + phase + '-' + name + '-markers.png',
      Buffer.from(data.split(',')[1], 'base64'),
    );
  await writeFile(
    out + '/' + phase + '-extended-report.json',
    JSON.stringify(
      {
        input,
        sha,
        ...result,
        original: undefined,
        outputs: undefined,
        errors,
        browser: await browser.version(),
      },
      null,
      2,
    ),
  );
  assert.deepEqual(errors, []);
  assert.equal(
    createHash('sha256')
      .update(await readFile(input))
      .digest('hex'),
    sha,
  );
  if (phase.startsWith('after')) {
    for (const error of result.allErrors)
      assert.ok(Number.isFinite(error) && error < 1, 'Actual raster marker error ' + error);
    assert.ok(result.identicalAfterResize);
  }
  console.log(
    JSON.stringify(
      {
        phase,
        maximumRasterErrorPx: Math.max(...result.allErrors),
        checks: result.allErrors.length,
        identicalAfterResize: result.identicalAfterResize,
        scope: result.assetScope,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
