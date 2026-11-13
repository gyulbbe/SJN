/**
 * The tile AI trial's scenes (no AI call, docs/tile-ai-trials-20261113.md): each built with the export
 * trial's scene builder and captured as the export dialog captures it (the outside orbit on white at
 * 1024 px, the 496 px model input, the facts and the app's prompt), and for the trial's methods:
 *   - mask.png + regions.json: which wall or floor covers each capture pixel (scoring, T6), and
 *     mask-outside.png: where the capture showed nothing of the room
 *   - input-grout.png / input-groutc.png: the same capture with the joints drawn at least 1.25 input
 *     pixels wide (T1), in the catalogue's joint colour or one that stands out from the tile
 *   - input-groutu.png: the same as input-grout.png, but a wall tile that is scored into a grid of
 *     smaller rectangles is laid as those rectangles with 0.75-pixel joints (elsewhere the same picture)
 *   - input-992.png: the capture at twice the model input (T5)
 *   - sample-wall.png: the wall tile laid flat and close (T3)
 *   - tiles.json: the numbers the sentences are built from (T2), and how wide a joint is in the input
 * The two held-out scenes go to holdout/ and are opened only in the last round.
 *
 * Usage: node tests/run-browser-test.mjs tests/tile-ai/scenes.ts [--gpu] [--only id,id] [--holdout]
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import sharp from 'sharp';
import type { PublicRecord } from '../export-photoreal/scene-builder';
import { HOLDOUT, OUT, SCENES, SNAPSHOT } from './paths.mjs';
import { visibleUnits, type TileFacts, type TileLayer } from './sentences';
import { SPECS } from './specs';

const gpu = process.argv.includes('--gpu');
const withHoldout = process.argv.includes('--holdout');
const only = (() => {
  const i = process.argv.indexOf('--only');
  return i > 0 ? new Set(process.argv[i + 1].split(',')) : undefined;
})();
/** T1: a joint is drawn at least this wide in the model input, measured on the back wall. */
const MIN_JOINT_PX = 1.25;
/** T1 for a scored tile: the joint between its rectangles, thinner so close rows do not turn grey. */
const UNIT_JOINT_PX = 0.75;
/** T3: the model input's pixels per millimetre of the sample (a 600 mm tile is 330 pixels wide). */
const SAMPLE_PX_PER_MM = 0.55;

type Record_ = PublicRecord & {
  materialId: string;
  textureAssetIds: string[];
  widthMm: number;
  heightMm: number;
  defaultGroutWidth?: number;
  defaultGroutColor?: string;
  defaultPattern?: string;
};
const catalog = JSON.parse(readFileSync(join(SNAPSHOT as string, 'catalog.json'), 'utf8')) as {
  placements: Record_[];
};
const records: Record<string, Record_> = Object.fromEntries(catalog.placements.map((p) => [p.materialId, p]));
const imageFiles = Object.fromEntries(
  readdirSync(join(SNAPSHOT as string, 'images')).map((f) => [f.replace(/\.[a-z]+$/, ''), f]),
);
const texture = (materialId: string) =>
  join(SNAPSHOT as string, 'images', imageFiles[records[materialId].textureAssetIds[0]]);
const grey = async (materialId: string) => {
  const { data, info } = await sharp(texture(materialId))
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data };
};
const bundle = await build({
  stdin: {
    contents: [
      "export * from './src/lib/room-viewer/renderer';",
      "export { buildSpecScene } from './tests/export-photoreal/scene-builder';",
      "export { buildFluxGrounding, visibleCeiling } from './src/lib/ai-export/scene';",
      "export { fluxInputLayout } from './src/lib/ai-export/contract';",
      "export { prepareFluxImage } from './src/lib/ai-export/client';",
      "export { buildFluxPrompt } from './src/lib/ai-export/prompt';",
      "export { fluxSceneSchema } from './src/lib/ai-export/scene-contract';",
      "export { fluxOrbitView, FLUX_BACKDROP } from './src/lib/ai-export/view';",
      "export { VIEWER_CEILING_COLOR } from './src/lib/room-viewer/ceiling';",
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
const ORIGIN = 'http://127.0.0.1:43242';
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
    const needed = new Set([spec.wall, spec.floor, ...(spec.regions ?? []).map((r) => r.materialId)]);
    const used = Object.fromEntries(
      [...needed].map((m) => [
        m,
        m === spec.wall && spec.wallPattern
          ? { ...records[m], defaultPattern: spec.wallPattern }
          : records[m],
      ]),
    );
    const started = Date.now();
    // A tile scored into a grid of smaller rectangles is laid as those rectangles in `groutu`.
    const wallUnits = visibleUnits(await grey(spec.wall));
    const unitTile =
      wallUnits.cols > 1 && wallUnits.rows > 1
        ? {
            widthMm: records[spec.wall].widthMm / wallUnits.cols,
            heightMm: records[spec.wall].heightMm / wallUnits.rows,
          }
        : undefined;
    const r = await page.evaluate(
      async ({ spec, used, minJointPx, unitTile, unitJointPx }) => {
        type Lib = typeof import('../../src/lib/room-viewer/renderer') &
          typeof import('../export-photoreal/scene-builder') &
          typeof import('../../src/lib/ai-export/scene') &
          typeof import('../../src/lib/ai-export/contract') &
          typeof import('../../src/lib/ai-export/client') &
          typeof import('../../src/lib/ai-export/prompt') &
          typeof import('../../src/lib/ai-export/scene-contract') &
          typeof import('../../src/lib/ai-export/view') &
          typeof import('../../src/lib/room-viewer/ceiling');
        const lib = (window as unknown as { Lib: Lib }).Lib;
        const base64 = (bytes: Uint8Array) => {
          let text = '';
          for (let i = 0; i < bytes.length; i += 0x8000)
            text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          return btoa(text);
        };
        const blob64 = async (blob: Blob) => base64(new Uint8Array(await blob.arrayBuffer()));
        const view = lib.fluxOrbitView({ azimuth: spec.azimuth, elevation: 0 });
        const built = await lib.buildSpecScene(spec, used);
        const { imageWidth: width, imageHeight: height } = built.snapshot.scene;
        const edge = Math.min(1024, Math.max(width, height));
        /** The capture of a scene as the export dialog takes it. */
        const shoot = async (scene: Awaited<ReturnType<Lib['buildSpecScene']>>) => {
          const viewer = new lib.RoomViewerRenderer();
          try {
            await viewer.setSnapshot(scene.snapshot, async (id: string) => scene.assets[id], {
              background: lib.FLUX_BACKDROP,
            });
            return await viewer.export(view, { format: 'png', mode: 'after', longEdge: edge });
          } finally {
            viewer.dispose();
          }
        };
        const viewer = new lib.RoomViewerRenderer();
        try {
          const reader = async (id: string) => built.assets[id];
          await viewer.setSnapshot(built.snapshot, reader, { background: lib.FLUX_BACKDROP });
          const blob = await viewer.export(view, { format: 'png', mode: 'after', longEdge: edge });
          const bitmap = await createImageBitmap(blob);
          const size = { width: bitmap.width, height: bitmap.height };
          const regions = viewer.regionMask(size.width, size.height, view);
          const boxes = viewer.fixtureBounds(width, height, view);
          const layout = lib.fluxInputLayout(size.width, size.height);
          const grounding = await lib.buildFluxGrounding({
            snapshot: built.snapshot,
            reader,
            capture: bitmap,
            layout,
            boxes,
            surfaceBoxes: {},
            ceiling: lib.visibleCeiling(regions) ? lib.VIEWER_CEILING_COLOR : undefined,
            cutaway: true,
            azimuth: view.orbit ? view.orbit.azimuth : undefined,
          });
          bitmap.close();
          // How many capture pixels a millimetre of the back wall takes, across and up.
          viewer.render(size.width, size.height, view, 'after');
          const corner = (u: number, v: number) => viewer.faceToFrame('back', u, v);
          const a = corner(0, 0.5),
            b = corner(1, 0.5),
            c = corner(0.5, 0),
            d = corner(0.5, 1);
          const perMm =
            a && b && c && d
              ? [
                  (Math.abs(b.x - a.x) * size.width) / built.room.widthMm,
                  (Math.abs(d.y - c.y) * size.height) / built.room.heightMm,
                ]
              : [0, 0];
          const inputPerMm = Math.min(perMm[0], perMm[1]) * layout.scale;
          // T1: the joints at least `minJointPx` wide in the model input.
          const jointMm = inputPerMm > 0 ? Math.ceil(minJointPx / inputPerMm) : 10;
          const luminance = (hex: string) => {
            const n = parseInt(hex.slice(1), 16);
            return 0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
          };
          const surfaces = grounding.scene.surfaces;
          const wall = surfaces.find((s) => s.faces.some((f) => f !== 'floor') && !s.box),
            floor = surfaces.find((s) => s.faces.includes('floor') && !s.box);
          const stands = (tile?: string) => (tile && luminance(tile) < 110 ? '#d2d2cc' : '#85857f');
          const widened = (contrast: boolean) => ({
            ...spec,
            wallGrout: {
              color: contrast ? stands(wall?.color) : (wall?.groutColor ?? '#d5d1c9'),
              widthMm: Math.max(jointMm, wall?.groutMm ?? 0),
            },
            floorGrout: {
              color: contrast ? stands(floor?.color) : (floor?.groutColor ?? '#d5d1c9'),
              widthMm: Math.max(jointMm, floor?.groutMm ?? 0),
            },
          });
          const grout = await shoot(await lib.buildSpecScene(widened(false), used));
          const groutc = await shoot(await lib.buildSpecScene(widened(true), used));
          // T1 for a scored tile: every rectangle is its own tile with a thinner joint, so the thin
          // lines inside a tile are in the picture too.
          const groutu = unitTile
            ? await shoot(
                await lib.buildSpecScene(
                  {
                    ...widened(false),
                    wallGrout: {
                      color: wall?.groutColor ?? '#d5d1c9',
                      widthMm: inputPerMm > 0 ? Math.ceil(unitJointPx / inputPerMm) : 6,
                    },
                  },
                  { ...used, [spec.wall]: { ...used[spec.wall], ...unitTile } },
                ),
              )
            : grout;
          return {
            capture: await blob64(blob),
            input: await blob64(await lib.prepareFluxImage(blob)),
            grout: await blob64(await lib.prepareFluxImage(grout)),
            groutc: await blob64(await lib.prepareFluxImage(groutc)),
            groutCapture: await blob64(grout),
            groutu: await blob64(await lib.prepareFluxImage(groutu)),
            groutuCapture: await blob64(groutu),
            layout,
            size,
            grounding: { scene: grounding.scene, placed: grounding.placed },
            valid: lib.fluxSceneSchema.safeParse(grounding.scene).success,
            prompt: lib.buildFluxPrompt(grounding.scene),
            mask: { width: regions.width, height: regions.height, regions: regions.regions },
            maskData: base64(regions.data),
            outsideData: base64(regions.outside),
            perMm,
            inputPerMm,
            jointMm,
            room: built.room,
          };
        } finally {
          viewer.dispose();
        }
      },
      { spec, used, minJointPx: MIN_JOINT_PX, unitTile, unitJointPx: UNIT_JOINT_PX },
    );
    if (errors.length) throw new Error(errors.join('\n'));
    const dir = join((spec.holdout ? HOLDOUT : SCENES) as string, spec.id);
    mkdirSync(dir, { recursive: true });
    const buf = (b: string) => Buffer.from(b, 'base64');
    writeFileSync(join(dir, 'capture.png'), buf(r.capture));
    writeFileSync(join(dir, 'input.png'), buf(r.input));
    writeFileSync(join(dir, 'input-grout.png'), buf(r.grout));
    writeFileSync(join(dir, 'input-groutc.png'), buf(r.groutc));
    writeFileSync(join(dir, 'capture-grout.png'), buf(r.groutCapture));
    writeFileSync(join(dir, 'input-groutu.png'), buf(r.groutu));
    writeFileSync(join(dir, 'capture-groutu.png'), buf(r.groutuCapture));
    writeFileSync(join(dir, 'grounding.json'), JSON.stringify(r.grounding, null, 1));
    writeFileSync(join(dir, 'layout.json'), JSON.stringify({ layout: r.layout, size: r.size }));
    writeFileSync(join(dir, 'prompt-current.txt'), r.prompt);
    writeFileSync(join(dir, 'spec.json'), JSON.stringify(spec, null, 1));
    writeFileSync(join(dir, 'regions.json'), JSON.stringify(r.mask));
    await sharp(buf(r.maskData), { raw: { width: r.mask.width, height: r.mask.height, channels: 1 } })
      .png()
      .toFile(join(dir, 'mask.png'));
    // Where the capture showed nothing of the room (the app puts the plain backdrop back there).
    await sharp(buf(r.outsideData), { raw: { width: r.mask.width, height: r.mask.height, channels: 1 } })
      .png()
      .toFile(join(dir, 'mask-outside.png'));
    // T5: the capture at twice the model input, padded the same way.
    const { layout } = r;
    await sharp({
      create: { width: layout.width * 2, height: layout.height * 2, channels: 3, background: '#ffffff' },
    })
      .composite([
        {
          input: await sharp(buf(r.capture))
            .resize(Math.round(layout.contentWidth * 2), Math.round(layout.contentHeight * 2), {
              fit: 'fill',
            })
            .png()
            .toBuffer(),
          left: Math.round(layout.x * 2),
          top: Math.round(layout.y * 2),
        },
      ])
      .png()
      .toFile(join(dir, 'input-992.png'));
    // The numbers of the tile sentences.
    const surfaces = r.grounding.scene.surfaces;
    const wallSurface = surfaces.find((s) => s.faces.some((f) => f !== 'floor') && !s.box),
      floorSurface = surfaces.find((s) => s.faces.includes('floor') && !s.box);
    if (!wallSurface || !floorSurface) throw new Error(`${spec.id}: no wall or floor tile in the facts`);
    const layer = async (surface: typeof wallSurface, materialId: string): Promise<TileLayer> => ({
      tileMm: surface.tileMm,
      groutMm: surface.groutMm,
      pattern: surface.pattern,
      units: visibleUnits(await grey(materialId)),
    });
    const facts: TileFacts = {
      room: { widthMm: r.room.widthMm, depthMm: r.room.depthMm, heightMm: r.room.heightMm },
      wall: await layer(wallSurface, spec.wall),
      floor: await layer(floorSurface, spec.floor),
    };
    // T3: the wall tile laid flat, with its joints, at SAMPLE_PX_PER_MM.
    const sample = { width: 496, height: 336 };
    const tilePx = facts.wall.tileMm.map((value) => Math.max(8, Math.round(value * SAMPLE_PX_PER_MM)));
    const jointPx = Math.max(1, Math.round(facts.wall.groutMm * SAMPLE_PX_PER_MM));
    const tile = await sharp(texture(spec.wall))
      .resize(tilePx[0], tilePx[1], { fit: 'fill' })
      .png()
      .toBuffer();
    const placed: { input: Buffer; left: number; top: number }[] = [];
    for (let row = 0, top = 0; top < sample.height; row++, top += tilePx[1] + jointPx) {
      const shift = facts.wall.pattern === 'brick' && row % 2 ? -Math.round((tilePx[0] + jointPx) / 2) : 0;
      for (let left = shift; left < sample.width; left += tilePx[0] + jointPx)
        placed.push({ input: tile, left, top });
    }
    // sharp refuses an overlay that leaves the canvas: lay the tiles on a larger sheet and cut it.
    const pad = tilePx[0] + jointPx;
    await sharp({
      create: {
        width: sample.width + 2 * pad,
        height: sample.height + tilePx[1] + jointPx,
        channels: 3,
        background: wallSurface.groutColor,
      },
    })
      .composite(placed.map((p) => ({ ...p, left: p.left + pad })))
      .png()
      .toBuffer()
      .then((sheet) =>
        sharp(sheet)
          .extract({ left: pad, top: 0, width: sample.width, height: sample.height })
          .png()
          .toFile(join(dir, 'sample-wall.png')),
      );
    const jointInput = (surface: typeof wallSurface) => +(surface.groutMm * r.inputPerMm).toFixed(2);
    const tiles = {
      facts,
      sampleMm: [Math.round(sample.width / SAMPLE_PX_PER_MM), Math.round(sample.height / SAMPLE_PX_PER_MM)],
      /** Model-input pixels per millimetre on the back wall, and what a joint and a scored line take. */
      inputPerMm: +r.inputPerMm.toFixed(4),
      jointInputPx: { wall: jointInput(wallSurface), floor: jointInput(floorSurface) },
      wallTileInputPx: facts.wall.tileMm.map((value) => +(value * r.inputPerMm).toFixed(1)),
      widenedJointMm: r.jointMm,
    };
    writeFileSync(join(dir, 'tiles.json'), JSON.stringify(tiles, null, 1));
    summary[spec.id] = {
      holdout: !!spec.holdout,
      input: [layout.width, layout.height],
      valid: r.valid,
      prompt: r.prompt.length,
      wall: `${facts.wall.tileMm.join('×')} ${facts.wall.pattern} units ${facts.wall.units.cols}×${facts.wall.units.rows}`,
      floor: `${facts.floor.tileMm.join('×')} units ${facts.floor.units.cols}×${facts.floor.units.rows}`,
      inputPerMm: tiles.inputPerMm,
      jointInputPx: tiles.jointInputPx.wall,
      wallTileInputPx: tiles.wallTileInputPx,
      widenedJointMm: r.jointMm,
      regions: r.mask.regions.map((region) => region.key),
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
