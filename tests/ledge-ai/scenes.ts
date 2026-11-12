/**
 * The ledge AI trial's scenes (no AI call, docs/ledge-ai-trials-20261111.md): each built with the export
 * trial's scene builder and captured as the export dialog captures it (the outside orbit on white at
 * 1024 px, the 496 px model input, the facts and the app's prompt), and for the trial's methods:
 *   - structures.json: what a view shows of the ledges and niches (S1, structures.ts) with image boxes
 *   - ledge-mask.png: where the ledges' faces are in the capture (S5 and measuring)
 *   - input-emph.png: the capture with the ledges' faces shaded further apart (S2)
 *   - elev/: the same from 12° above (S3), with its own facts, prompt, structures and mask
 *   - ref-structure.png: a colour-coded diagram of the built shape alone (S4)
 * The two held-out scenes go to holdout/ and are opened only in the last round.
 *
 * Usage: node tests/run-browser-test.mjs tests/ledge-ai/scenes.ts [--gpu] [--only id,id] [--holdout]
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import type { PublicRecord } from '../export-photoreal/scene-builder';
import { HOLDOUT, OUT, SCENES, SNAPSHOT } from './paths.mjs';
import { SPECS } from './specs';

const gpu = process.argv.includes('--gpu');
const withHoldout = process.argv.includes('--holdout');
const only = (() => {
  const i = process.argv.indexOf('--only');
  return i > 0 ? new Set(process.argv[i + 1].split(',')) : undefined;
})();
/** The elevated view of S3. */
const ELEVATION = 12;

const catalog = JSON.parse(readFileSync(join(SNAPSHOT as string, 'catalog.json'), 'utf8')) as {
  placements: (PublicRecord & { materialId: string })[];
};
const records: Record<string, PublicRecord> = Object.fromEntries(
  catalog.placements.map((p) => [p.materialId, p]),
);
const imageFiles = Object.fromEntries(
  readdirSync(join(SNAPSHOT as string, 'images')).map((f) => [f.replace(/\.[a-z]+$/, ''), f]),
);
const bundle = await build({
  stdin: {
    contents: [
      "export * from './src/lib/room-viewer/renderer';",
      "export { buildSpecScene } from './tests/export-photoreal/scene-builder';",
      "export { buildFluxGrounding, toInputBox, visibleCeiling, visibleWalls } from './src/lib/ai-export/scene';",
      "export { fluxInputLayout } from './src/lib/ai-export/contract';",
      "export { prepareFluxImage } from './src/lib/ai-export/client';",
      "export { buildFluxPrompt } from './src/lib/ai-export/prompt';",
      "export { fluxSceneSchema } from './src/lib/ai-export/scene-contract';",
      "export { fluxOrbitView, FLUX_BACKDROP } from './src/lib/ai-export/view';",
      "export { VIEWER_CEILING_COLOR } from './src/lib/room-viewer/ceiling';",
      "export { validateWallFeatures } from './src/lib/wall-features';",
      "export { describeStructures } from './tests/ledge-ai/structures';",
      "export { MeshBasicMaterial, Color } from 'three';",
    ].join(''),
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
  globalName: 'Lib',
});
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: gpu
    ? ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--enable-gpu']
    : ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const ORIGIN = 'http://127.0.0.1:43241';
const summary: Record<string, unknown> = {};
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route(`${ORIGIN}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith('/images/')) {
      const file = join(SNAPSHOT as string, 'images', decodeURIComponent(path.slice(8)));
      return route.fulfill({ body: readFileSync(file) });
    }
    return route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' });
  });
  await page.goto(`${ORIGIN}/`);
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.evaluate((files) => {
    (window as unknown as { IMAGE_FILES: Record<string, string> }).IMAGE_FILES = files;
  }, imageFiles);
  for (const spec of SPECS) {
    if (only && !only.has(spec.id)) continue;
    if (spec.holdout && !withHoldout) continue;
    const needed = new Set([spec.wall, spec.floor]);
    const used = Object.fromEntries([...needed].map((m) => [m, records[m]]));
    const started = Date.now();
    const r = await page.evaluate(
      async ({ spec, used, elevation }) => {
        type Lib = typeof import('../../src/lib/room-viewer/renderer') &
          typeof import('../export-photoreal/scene-builder') &
          typeof import('../../src/lib/ai-export/scene') &
          typeof import('../../src/lib/ai-export/contract') &
          typeof import('../../src/lib/ai-export/client') &
          typeof import('../../src/lib/ai-export/prompt') &
          typeof import('../../src/lib/ai-export/scene-contract') &
          typeof import('../../src/lib/ai-export/view') &
          typeof import('../../src/lib/room-viewer/ceiling') &
          typeof import('../../src/lib/wall-features') &
          typeof import('./structures') &
          Pick<typeof import('three'), 'MeshBasicMaterial' | 'Color'>;
        const lib = (window as unknown as { Lib: Lib }).Lib;
        const base64 = async (blob: Blob) => {
          const bytes = new Uint8Array(await blob.arrayBuffer());
          let text = '';
          for (let i = 0; i < bytes.length; i += 0x8000)
            text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          return btoa(text);
        };
        const issues = lib.validateWallFeatures(spec.room as never, spec.features);
        if (issues.length) throw new Error(`wall features: ${JSON.stringify(issues)}`);
        const { room, assets, snapshot } = await lib.buildSpecScene(spec, used);
        const reader = async (assetId: string) => assets[assetId];
        const { imageWidth: width, imageHeight: height } = snapshot.scene;
        const edge = Math.min(1024, Math.max(width, height));
        const ledges = new Set((spec.features ?? []).filter((f) => f.kind === 'ledge').map((f) => f.id));
        type Piece = { role: string; featureId?: string };
        type Node = {
          name?: string;
          isMesh?: boolean;
          visible: boolean;
          material: { color: { multiplyScalar(n: number): void } };
          geometry?: { userData: { wallFeature?: Piece } };
        };
        /** The meshes of a prepared room, each with the wall-feature piece it draws (if any). */
        const meshes = (viewer: InstanceType<Lib['RoomViewerRenderer']>) => {
          const found: { node: Node; piece?: Piece; fixture: boolean }[] = [];
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const after = (viewer as any).prepared.after;
          after.surfaces.group.traverse((node: Node) => {
            if (node.isMesh) found.push({ node, piece: node.geometry?.userData.wallFeature, fixture: false });
          });
          after.fixtures.group.traverse((node: Node) => {
            if (node.isMesh) found.push({ node, fixture: true });
          });
          return found;
        };
        const isLedge = (piece?: Piece) => !!piece?.featureId && ledges.has(piece.featureId);
        /** Flat colours instead of the room's materials: a mask or a diagram of the same view. */
        const paint = (
          viewer: InstanceType<Lib['RoomViewerRenderer']>,
          colour: (piece: Piece | undefined, fixture: boolean) => string,
        ) => {
          const made = new Map<string, InstanceType<Lib['MeshBasicMaterial']>>();
          for (const { node, piece, fixture } of meshes(viewer)) {
            const hex = colour(piece, fixture);
            let material = made.get(hex);
            if (!material) {
              material = new lib.MeshBasicMaterial({ color: new lib.Color(hex), toneMapped: false, side: 2 });
              made.set(hex, material);
            }
            (node as unknown as { material: unknown }).material = material;
          }
        };
        const shoot = async (
          view: ReturnType<Lib['fluxOrbitView']>,
          background: string,
          change?: (viewer: InstanceType<Lib['RoomViewerRenderer']>) => void,
        ) => {
          const viewer = new lib.RoomViewerRenderer();
          try {
            await viewer.setSnapshot(snapshot, reader, { background });
            change?.(viewer);
            return await viewer.export(view, { format: 'png', mode: 'after', longEdge: edge });
          } finally {
            viewer.dispose();
          }
        };
        const capture = async (view: ReturnType<Lib['fluxOrbitView']>) => {
          const viewer = new lib.RoomViewerRenderer();
          try {
            await viewer.setSnapshot(snapshot, reader, { background: lib.FLUX_BACKDROP });
            const blob = await viewer.export(view, { format: 'png', mode: 'after', longEdge: edge });
            const regions = viewer.regionMask(
              Math.min(edge, (edge * width) / height),
              Math.min(edge, (edge * height) / width),
              view,
            );
            const boxes = viewer.fixtureBounds(width, height, view);
            const ceiling = lib.visibleCeiling(regions) ? lib.VIEWER_CEILING_COLOR : undefined;
            const bitmap = await createImageBitmap(blob);
            const layout = lib.fluxInputLayout(bitmap.width, bitmap.height);
            const grounding = await lib.buildFluxGrounding({
              snapshot,
              reader,
              capture: bitmap,
              layout,
              boxes,
              surfaceBoxes: {},
              ceiling,
              cutaway: true,
              azimuth: view.orbit ? view.orbit.azimuth : undefined,
            });
            const size = { width: bitmap.width, height: bitmap.height };
            bitmap.close();
            // The structures as this view shows them, their boxes in the padded model input.
            viewer.render(size.width, size.height, view, 'after');
            const structures = lib
              .describeStructures(
                room,
                spec.features,
                (face, u, v, outMm) => viewer.faceToFrame(face, u, v, outMm),
                (face) => grounding.scene.surfaces.find((s) => s.faces.includes(face) && !s.box)?.color,
              )
              .map((structure) => ({ ...structure, box: lib.toInputBox(structure.box, layout) }));
            const input = await lib.prepareFluxImage(blob);
            return {
              capture: await base64(blob),
              input: await base64(input),
              layout,
              size,
              grounding: { scene: grounding.scene, placed: grounding.placed },
              valid: lib.fluxSceneSchema.safeParse(grounding.scene).success,
              prompt: lib.buildFluxPrompt(grounding.scene),
              structures,
              // White where a ledge's face shows, black elsewhere and where a product stands before it.
              mask: await base64(
                await shoot(view, '#000000', (v) =>
                  paint(v, (piece, fixture) => (!fixture && isLedge(piece) ? '#ffffff' : '#000000')),
                ),
              ),
            };
          } finally {
            viewer.dispose();
          }
        };
        const front = lib.fluxOrbitView({ azimuth: spec.azimuth, elevation: 0 });
        const level = await capture(front);
        const elevated = await capture(lib.fluxOrbitView({ azimuth: spec.azimuth, elevation }));
        // S2: the ledge's faces further apart in shade (front and ends darker, the top lighter).
        const emphasised = await shoot(front, lib.FLUX_BACKDROP, (viewer) => {
          const done = new Set<unknown>();
          for (const { node, piece } of meshes(viewer)) {
            if (!isLedge(piece) || done.has(node.material)) continue;
            done.add(node.material);
            node.material.color.multiplyScalar(
              piece!.role === 'front' ? 0.84 : piece!.role === 'reveal-top' ? 1.08 : 0.8,
            );
          }
        });
        // S4: the built shape alone, colour-coded, the products left out.
        const diagram = await shoot(front, '#ffffff', (viewer) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (viewer as any).prepared.after.fixtures.group.visible = false;
          paint(viewer, (piece, fixture) => {
            if (fixture) return '#ffffff';
            if (isLedge(piece))
              return piece!.role === 'front'
                ? '#e8742c'
                : piece!.role === 'reveal-top'
                  ? '#f6c89a'
                  : '#b4541c';
            if (piece?.featureId) return piece.role === 'rear' ? '#3f6fb5' : '#2c4f85';
            return piece?.role === 'floor-extension' ? '#9a9a9a' : '#cfcfcf';
          });
        });
        return {
          level,
          elevated,
          emphasised: await base64(await lib.prepareFluxImage(emphasised)),
          emphasisedCapture: await base64(emphasised),
          diagram: await base64(await lib.prepareFluxImage(diagram)),
        };
      },
      { spec, used, elevation: ELEVATION },
    );
    if (errors.length) throw new Error(errors.join('\n'));
    const dir = join((spec.holdout ? HOLDOUT : SCENES) as string, spec.id);
    const buf = (b: string) => Buffer.from(b, 'base64');
    const save = (folder: string, shot: typeof r.level) => {
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, 'capture.png'), buf(shot.capture));
      writeFileSync(join(folder, 'input.png'), buf(shot.input));
      writeFileSync(join(folder, 'ledge-mask.png'), buf(shot.mask));
      writeFileSync(join(folder, 'grounding.json'), JSON.stringify(shot.grounding, null, 1));
      writeFileSync(join(folder, 'layout.json'), JSON.stringify({ layout: shot.layout, size: shot.size }));
      writeFileSync(join(folder, 'structures.json'), JSON.stringify(shot.structures, null, 1));
      writeFileSync(join(folder, 'prompt-current.txt'), shot.prompt);
    };
    save(dir, r.level);
    save(join(dir, 'elev'), r.elevated);
    writeFileSync(join(dir, 'spec.json'), JSON.stringify(spec, null, 1));
    writeFileSync(join(dir, 'input-emph.png'), buf(r.emphasised));
    writeFileSync(join(dir, 'capture-emph.png'), buf(r.emphasisedCapture));
    writeFileSync(join(dir, 'ref-structure.png'), buf(r.diagram));
    summary[spec.id] = {
      holdout: !!spec.holdout,
      input: [r.level.layout.width, r.level.layout.height],
      valid: r.level.valid && r.elevated.valid,
      fixtures: r.level.grounding.scene.fixtures.length,
      prompt: r.level.prompt.length,
      structures: r.level.structures.map((s) => `${s.kind}${s.kind === 'ledge' ? ':' + s.shape : ''}`),
      elevatedStructures: r.elevated.structures.length,
      ms: Date.now() - started,
    };
    console.log(spec.id, JSON.stringify(summary[spec.id]));
  }
} finally {
  await browser.close();
}
mkdirSync(OUT as string, { recursive: true });
writeFileSync(
  join(OUT as string, `scenes-summary${withHoldout ? '-holdout' : ''}.json`),
  JSON.stringify({ gpu, summary }, null, 1),
);
