/**
 * Export realism stage 1: the same authored bathroom as an orbit frame, in-room eye views,
 * accumulated exports and photo effects, side by side with metrics. No AI, no network.
 * Usage: node tests/run-browser-test.mjs tests/export-realism-browser.ts [label] [--gpu] [--headed]
 *   [--edges=1024,2048] [--samples=8,16] [--dir=export-realism-stage-1]
 * Writes test-results/<dir>/<label>/. The scene is tests/helpers/export-realism-scene.ts.
 */
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { deltaE2000 } from './helpers/delta-e';

const label = process.argv.slice(3).find((arg) => !arg.startsWith('--')) ?? 'stage-1';
if (!/^[a-z0-9-]+$/.test(label)) throw new Error('label must be lowercase letters, digits or dashes');
const gpu = process.argv.includes('--gpu');
const headed = process.argv.includes('--headed');
const option = (name: string) =>
  process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
// Accumulation matrix: SwiftShader keeps it small; the real GPU runs the full 1024–4096 × 8–64 table.
const edges = (option('edges') ?? (gpu ? '1024,2048,4096' : '1024,2048')).split(',').map(Number);
const sampleCounts = (option('samples') ?? (gpu ? '8,16,32,64' : '8,16')).split(',').map(Number);
// Stage 2 re-runs this measurement into its own folder: --dir=export-realism-stage-2.
const output = `test-results/${option('dir') ?? 'export-realism-stage-1'}/${label}`;
await mkdir(output, { recursive: true });
const power = (() => {
  try {
    return execFileSync(
      'powershell',
      ['-NoProfile', '-Command', '(Get-CimInstance Win32_Battery | Select-Object -First 1).BatteryStatus'],
      { encoding: 'utf8' },
    ).trim();
  } catch {
    return 'unknown';
  }
})();

const bundle = await build({
  stdin: {
    contents: `export * from './src/lib/room-viewer/renderer';export * from './src/lib/room-viewer/view-state';export {createRoomSurfaces,DEFAULT_ROOM} from './src/lib/room-geometry';export {PHOTO_EFFECTS} from './src/lib/room-viewer/photo-effects';export {buildRealismScene,toImage} from './tests/helpers/export-realism-scene';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
  globalName: 'Realism',
});
const browser = await chromium.launch({
  channel: 'chrome',
  headless: !headed,
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
  await page.route('http://127.0.0.1:43211/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<html><body style="margin:0"></body></html>' }),
  );
  await page.goto('http://127.0.0.1:43211/');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const result = await page.evaluate(async () => {
    type Lib = typeof import('../src/lib/room-viewer/renderer') &
      typeof import('../src/lib/room-viewer/view-state') &
      typeof import('../src/lib/room-geometry') &
      typeof import('./helpers/export-realism-scene');
    type RoomViewState = import('../src/lib/room-viewer/view-state').RoomViewState;
    const lib = (window as unknown as { Realism: Lib }).Realism;
    const { room, assets, materials, scene, snapshot } = await lib.buildRealismScene();
    const viewer = new lib.RoomViewerRenderer();
    const images: Record<string, string> = {};
    const metrics: Record<string, unknown> = {};
    const toImage = lib.toImage;
    // The viewer's clear colour outside the room (#e8e8e4); an in-room view must never show it.
    const backgroundRatio = (data: Uint8ClampedArray) => {
      let hits = 0;
      for (let i = 0; i < data.length; i += 4)
        if (
          Math.abs(data[i] - 232) <= 1 &&
          Math.abs(data[i + 1] - 232) <= 1 &&
          Math.abs(data[i + 2] - 228) <= 1
        )
          hits++;
      return hits / (data.length / 4);
    };
    try {
      await viewer.setSnapshot(snapshot, async (id) => assets[id]);
      const views: [string, RoomViewState][] = [
        ['orbit-front', lib.defaultRoomView()],
        ['eye-center', lib.roomEyeView(room, 'center')],
        ['eye-left-corner', lib.roomEyeView(room, 'left-corner')],
        ['eye-right-corner', lib.roomEyeView(room, 'right-corner')],
      ];
      for (const [name, view] of views) {
        const started = performance.now();
        const blob = await viewer.export(view, { format: 'png', mode: 'after', longEdge: 1536 });
        const ms = performance.now() - started;
        const { canvas, data } = await toImage(blob);
        images[name] = canvas.toDataURL('image/png');
        metrics[name] = {
          ms,
          width: canvas.width,
          height: canvas.height,
          backgroundRatio: backgroundRatio(data),
        };
        if (name.startsWith('eye')) {
          // fixtureBounds must follow the in-room camera: draw the boxes FLUX would receive.
          const boxes = viewer.fixtureBounds(canvas.width, canvas.height, view);
          const ctx = canvas.getContext('2d')!;
          ctx.strokeStyle = '#e0245e';
          ctx.lineWidth = 3;
          for (const [, [l, t, r, b]] of Object.entries(boxes))
            ctx.strokeRect(
              l * canvas.width,
              t * canvas.height,
              (r - l) * canvas.width,
              (b - t) * canvas.height,
            );
          images[`${name}-boxes`] = canvas.toDataURL('image/png');
          (metrics[name] as Record<string, unknown>).fixtureBoxes = Object.keys(boxes);
        }
      }
      // Probe: saturated walls, floor, fixtures and ceiling-free colours, so a pixel with the
      // background colour can only be background (white tiles and fixtures can match it by chance).
      const probeMaterials = structuredClone(materials);
      probeMaterials.wall.color = '#2050c0';
      probeMaterials.floor.color = '#20a040';
      for (const [id, fill] of [
        ['wall', '#2050c0'],
        ['floor', '#20a040'],
      ] as const) {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 64;
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = fill;
        ctx.fillRect(0, 0, 64, 64);
        assets[id + '-probe'] = {
          ...assets[id],
          id: id + '-probe',
          blob: await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!))),
        };
        probeMaterials[id].textureAssetIds = [id + '-probe'];
      }
      const probeScene = structuredClone(scene);
      for (const f of probeScene.fixtures) f.reconstruction!.color = '#c02020';
      const probe = new lib.RoomViewerRenderer();
      try {
        await probe.setSnapshot(
          { scene: probeScene, beforeScene: structuredClone(probeScene), materials: probeMaterials },
          async (id) => assets[id],
        );
        for (const [name, view] of views.filter(([name]) => name.startsWith('eye'))) {
          const { canvas, data } = await toImage(
            await probe.export(view, { format: 'png', mode: 'after', longEdge: 1024 }),
          );
          images[name + '-probe'] = canvas.toDataURL('image/png');
          (metrics[name] as Record<string, unknown>).probeBackgroundRatio = backgroundRatio(data);
        }
      } finally {
        probe.dispose();
      }
      const compare = await toImage(
        await viewer.export(lib.roomEyeView(room, 'center'), {
          format: 'png',
          mode: 'compare',
          longEdge: 2048,
        }),
      );
      images['eye-center-compare'] = compare.canvas.toDataURL('image/png');
      metrics['eye-center-compare'] = { backgroundRatio: backgroundRatio(compare.data) };
      const diagnostics = viewer.diagnostics();
      // Kept for the accumulation section below; disposed at the end of the run.
      Object.assign(window, { __xr: { viewer, views, toImage } });
      return { images, metrics, gpu: diagnostics.gpu };
    } catch (error) {
      viewer.dispose();
      throw error;
    }
  });
  const accumulation = await page.evaluate(
    async ({ edges, sampleCounts }) => {
      type Viewer = InstanceType<typeof import('../src/lib/room-viewer/renderer').RoomViewerRenderer>;
      type RoomViewState = import('../src/lib/room-viewer/view-state').RoomViewState;
      const { viewer, views, toImage } = (
        window as unknown as {
          __xr: {
            viewer: Viewer;
            views: [string, RoomViewState][];
            toImage: (blob: Blob) => Promise<{ canvas: HTMLCanvasElement; data: Uint8ClampedArray }>;
          };
        }
      ).__xr;
      const view = (name: string) => views.find(([n]) => n === name)![1];
      const images: Record<string, string> = {};
      const timings: {
        edge: number;
        samples: number;
        ms: number;
        averaged?: number;
        width: number;
        height: number;
        fallback?: string;
      }[] = [];
      const exportImage = async (name: string, edge: number, samples: number, progress?: number[]) => {
        const started = performance.now();
        const blob = await viewer.export(view(name), {
          format: 'png',
          mode: 'after',
          longEdge: edge,
          ...(samples > 1
            ? { quality: { samples }, onProgress: (done: number) => progress?.push(done) }
            : {}),
        });
        const ms = performance.now() - started;
        const last = viewer.diagnostics().lastExport;
        return { ...(await toImage(blob)), ms, last };
      };
      const luminance = (d: Uint8ClampedArray, i: number) =>
        0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      const median = (image: { canvas: HTMLCanvasElement; data: Uint8ClampedArray }, r: number[]) => {
        const { width, height } = image.canvas;
        const channels: number[][] = [[], [], []];
        for (let y = Math.round(r[1] * height); y < Math.round(r[3] * height); y++)
          for (let x = Math.round(r[0] * width); x < Math.round(r[2] * width); x++)
            for (let c = 0; c < 3; c++) channels[c].push(image.data[(y * width + x) * 4 + c]);
        return channels.map((v) => v.sort((a, b) => a - b)[v.length >> 1]) as [number, number, number];
      };
      type Image = { canvas: HTMLCanvasElement; data: Uint8ClampedArray };
      /**
       * Stair steps along a straight diagonal edge (orbit view floor/wall corner, given in image
       * fractions): per column, the sub-pixel crossing from the pixel coverage between the two flat
       * sides, then the RMS distance (px) of the crossings to their fitted line. 0 = perfectly smooth.
       */
      const staircase = (image: Image, from: [number, number], to: [number, number]) => {
        const { width, height } = image.canvas;
        const half = Math.max(6, Math.round(height * 0.012));
        const points: [number, number][] = [];
        const x0 = Math.round((from[0] + (to[0] - from[0]) * 0.15) * width),
          x1 = Math.round((from[0] + (to[0] - from[0]) * 0.85) * width);
        for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) {
          const t = (x / width - from[0]) / (to[0] - from[0]);
          const yp = Math.round((from[1] + (to[1] - from[1]) * t) * height);
          const column: number[] = [];
          for (let y = yp - half; y <= yp + half; y++)
            column.push(luminance(image.data, (y * width + x) * 4));
          const mid = (v: number[]) => v.sort((a, b) => a - b)[1];
          const above = mid(column.slice(0, 3)),
            below = mid(column.slice(-3));
          if (Math.abs(above - below) < 20) continue;
          let covered = 0;
          for (const v of column) covered += Math.max(0, Math.min(1, (v - below) / (above - below)));
          points.push([x, yp - half + covered]);
        }
        const n = points.length,
          mx = points.reduce((s, p) => s + p[0], 0) / n,
          my = points.reduce((s, p) => s + p[1], 0) / n;
        const slope =
          points.reduce((s, p) => s + (p[0] - mx) * (p[1] - my), 0) /
          points.reduce((s, p) => s + (p[0] - mx) ** 2, 0);
        // Tile grout meeting the corner makes a few outliers: drop the worst 10%.
        const residuals = points.map((p) => (p[1] - my - slope * (p[0] - mx)) ** 2).sort((a, b) => a - b);
        const kept = residuals.slice(0, Math.max(1, Math.floor(n * 0.9)));
        return {
          columns: n,
          rmsPx: Number(Math.sqrt(kept.reduce((s, r) => s + r, 0) / kept.length).toFixed(3)),
        };
      };
      /**
       * Floor luminance along a row from a fixture's base outwards: contrast of the cast shadow and
       * its 10–90% penumbra width in px (null when there is no shadow to measure).
       */
      const shadowProfile = (image: Image, row: number, x0: number, x1: number) => {
        const { width, height } = image.canvas;
        const y = Math.round(row * height);
        const values: number[] = [];
        for (let x = Math.round(x0 * width); x < Math.round(x1 * width); x++)
          values.push(luminance(image.data, (y * width + x) * 4));
        // Darkest floor point, then outwards until the lit floor at the far end of the row.
        const darkest = values.indexOf(Math.min(...values)),
          low = values[darkest],
          high = Math.max(...values.slice(-Math.ceil(values.length / 4)));
        const contrast = Number((high - low).toFixed(1));
        if (contrast < 4) return { contrast, penumbraPx: null };
        const reach = (level: number) =>
          values.findIndex((v, i) => i >= darkest && v >= low + (high - low) * level);
        return { contrast, penumbraPx: reach(0.9) - reach(0.1) };
      };
      // Timing table.
      for (const edge of edges)
        for (const samples of [1, ...sampleCounts]) {
          const result = await exportImage('eye-center', edge, samples);
          timings.push({
            edge,
            samples,
            ms: Math.round(result.ms),
            averaged: result.last?.samples,
            width: result.canvas.width,
            height: result.canvas.height,
            ...(result.last?.fallbackReason ? { fallback: result.last.fallbackReason } : {}),
          });
          if (edge === edges[0]) images[`accumulate-eye-${samples}`] = result.canvas.toDataURL('image/png');
        }
      // Quality at the first edge: one frame vs the largest sample count.
      const edge = edges[0],
        best = Math.max(...sampleCounts);
      const progress: number[] = [];
      const orbitSingle = await exportImage('orbit-front', edge, 1);
      const orbitAccumulated = await exportImage('orbit-front', edge, best, progress);
      images['accumulate-orbit-1'] = orbitSingle.canvas.toDataURL('image/png');
      images[`accumulate-orbit-${best}`] = orbitAccumulated.canvas.toDataURL('image/png');
      // The other sample counts, for the shadow banding comparison.
      const orbit: Record<number, Image & { ms: number }> = { 1: orbitSingle, [best]: orbitAccumulated };
      for (const samples of sampleCounts.filter((n) => n !== best)) {
        orbit[samples] = await exportImage('orbit-front', edge, samples);
        images[`accumulate-orbit-${samples}`] = orbit[samples].canvas.toDataURL('image/png');
      }
      // FLUX sees the 1024 capture reduced to about 496 px: how much of it would 8 samples change?
      const fluxInput = (() => {
        const eight = orbit[8];
        if (!eight || edge !== 1024) return null;
        const reduce = (image: Image) => {
          const canvas = document.createElement('canvas');
          canvas.width = 496;
          canvas.height = Math.round((496 * image.canvas.height) / image.canvas.width);
          const context = canvas.getContext('2d', { willReadFrequently: true })!;
          context.imageSmoothingQuality = 'high';
          context.drawImage(image.canvas, 0, 0, canvas.width, canvas.height);
          return context.getImageData(0, 0, canvas.width, canvas.height).data;
        };
        const a = reduce(orbitSingle),
          b = reduce(eight);
        let changed = 0,
          total = 0;
        for (let i = 0; i < a.length; i += 4) {
          const difference = Math.abs(luminance(a, i) - luminance(b, i));
          total += difference;
          if (difference > 6) changed++;
        }
        return {
          singleMs: Math.round(orbitSingle.ms),
          eightMs: Math.round(eight.ms),
          meanLuminanceDifference: Number((total / (a.length / 4)).toFixed(2)),
          changedShare: Number((changed / (a.length / 4)).toFixed(4)),
        };
      })();
      const regions = { backWall: [0.42, 0.3, 0.58, 0.44], floor: [0.42, 0.84, 0.58, 0.92] };
      const colour = Object.fromEntries(
        Object.entries(regions).map(([name, r]) => [
          name,
          { single: median(orbitSingle, r), accumulated: median(orbitAccumulated, r) },
        ]),
      );
      // Left and right floor/wall corners of the orbit frame run at about 45°.
      const corners: [[number, number], [number, number]][] = [
        [
          [0.339, 0.744],
          [0.207, 0.937],
        ],
        [
          [0.661, 0.744],
          [0.793, 0.937],
        ],
      ];
      const aliasing = {
        single: corners.map(([a, b]) => staircase(orbitSingle, a, b)),
        accumulated: corners.map(([a, b]) => staircase(orbitAccumulated, a, b)),
      };
      // Floor to the right of the toilet base, just behind its front.
      const shadow = {
        single: shadowProfile(orbitSingle, 0.775, 0.61, 0.72),
        accumulated: shadowProfile(orbitAccumulated, 0.775, 0.61, 0.72),
      };
      // Resources over three accumulated exports.
      const memory: { textures: number; geometries: number; programs: number }[] = [];
      for (let i = 0; i < 3; i++) {
        await exportImage('eye-center', edge, 8);
        const d = viewer.diagnostics();
        memory.push({ textures: d.textures, geometries: d.geometries, programs: d.programs });
      }
      // A cancelled export stops and the viewer still renders.
      const controller = new AbortController();
      let cancelled = false;
      try {
        await viewer.export(view('eye-center'), {
          format: 'png',
          mode: 'after',
          longEdge: edge,
          quality: { samples: 16 },
          signal: controller.signal,
          onProgress: (done) => {
            if (done === 3) controller.abort();
          },
        });
      } catch (error) {
        cancelled = error instanceof DOMException && error.name === 'AbortError';
      }
      const afterCancel = viewer.diagnostics();
      // A device too slow for the budget keeps the plain first sample and a still light.
      await viewer.export(view('eye-center'), {
        format: 'png',
        mode: 'after',
        longEdge: edge,
        quality: { samples: 32, budgetMs: 1 },
      });
      const budget = viewer.diagnostics().lastExport;
      return {
        budget,
        images,
        timings,
        colour,
        aliasing,
        fluxInput,
        shadow,
        progress,
        memory,
        cancelled,
        afterCancel: { textures: afterCancel.textures, geometries: afterCancel.geometries },
      };
    },
    { edges, sampleCounts },
  );
  // Photo effects (1-3): the same accumulated export with and without the photo look.
  const effects = await page.evaluate(
    async ({ edge }) => {
      type Viewer = InstanceType<typeof import('../src/lib/room-viewer/renderer').RoomViewerRenderer>;
      type RoomViewState = import('../src/lib/room-viewer/view-state').RoomViewState;
      type PhotoEffects = import('../src/lib/room-viewer/photo-effects').PhotoEffects;
      const { viewer, views, toImage } = (
        window as unknown as {
          __xr: {
            viewer: Viewer;
            views: [string, RoomViewState][];
            toImage: (blob: Blob) => Promise<{ canvas: HTMLCanvasElement; data: Uint8ClampedArray }>;
          };
        }
      ).__xr;
      const look = (window as unknown as { Realism: { PHOTO_EFFECTS: PhotoEffects } }).Realism.PHOTO_EFFECTS;
      const center = views.find(([n]) => n === 'eye-center')![1];
      // Looking up a little brings the ceiling lamp into the frame, where the glow shows.
      const scenes: [string, RoomViewState][] = [
        ['orbit', views.find(([n]) => n === 'orbit-front')![1]],
        ['eye', center],
        ['eye-up', { ...center, eye: { ...center.eye!, shift: 0.3 } }],
      ];
      const images: Record<string, string> = {};
      const tiles: Record<string, { off: number[][]; on: number[][] }> = {};
      const corners: Record<string, { off: number; on: number }> = {};
      const timing: Record<string, { off: number; on: number }> = {};
      const grid = 6;
      const tileMedians = (image: { canvas: HTMLCanvasElement; data: Uint8ClampedArray }) => {
        const { width, height } = image.canvas;
        const result: number[][] = [];
        for (let j = 0; j < grid; j++)
          for (let i = 0; i < grid; i++) {
            const x0 = Math.round((0.2 + (0.6 * i) / grid) * width),
              x1 = Math.round((0.2 + (0.6 * (i + 1)) / grid) * width),
              y0 = Math.round((0.2 + (0.6 * j) / grid) * height),
              y1 = Math.round((0.2 + (0.6 * (j + 1)) / grid) * height);
            const channels: number[][] = [[], [], []];
            for (let y = y0; y < y1; y++)
              for (let x = x0; x < x1; x++)
                for (let c = 0; c < 3; c++) channels[c].push(image.data[(y * width + x) * 4 + c]);
            result.push(channels.map((v) => v.sort((a, b) => a - b)[v.length >> 1]));
          }
        return result;
      };
      const cornerLuminance = (image: { canvas: HTMLCanvasElement; data: Uint8ClampedArray }) => {
        const { width, height } = image.canvas;
        let total = 0,
          count = 0;
        for (const [cx, cy] of [
          [0, 0],
          [1, 0],
          [0, 1],
          [1, 1],
        ])
          for (let y = 0; y < height * 0.06; y++)
            for (let x = 0; x < width * 0.06; x++) {
              const px = Math.round(cx ? width - 1 - x : x),
                py = Math.round(cy ? height - 1 - y : y);
              const i = (py * width + px) * 4;
              total += 0.2126 * image.data[i] + 0.7152 * image.data[i + 1] + 0.0722 * image.data[i + 2];
              count++;
            }
        return total / count;
      };
      const exportImage = async (view: RoomViewState, photo?: PhotoEffects) => {
        const started = performance.now();
        const blob = await viewer.export(view, {
          format: 'png',
          mode: 'after',
          longEdge: edge,
          quality: { samples: 16 },
          ...(photo ? { effects: photo } : {}),
        });
        return { ...(await toImage(blob)), ms: performance.now() - started };
      };
      for (const [name, view] of scenes) {
        const off = await exportImage(view),
          on = await exportImage(view, look);
        images[`effects-${name}-off`] = off.canvas.toDataURL('image/png');
        images[`effects-${name}-on`] = on.canvas.toDataURL('image/png');
        tiles[name] = { off: tileMedians(off), on: tileMedians(on) };
        corners[name] = { off: cornerLuminance(off), on: cornerLuminance(on) };
        timing[name] = { off: Math.round(off.ms), on: Math.round(on.ms) };
      }
      // Fixed grain seed: the same export twice is the same file.
      const first = await exportImage(center, look),
        second = await exportImage(center, look);
      let identical = first.data.length === second.data.length;
      for (let i = 0; identical && i < first.data.length; i++) identical = first.data[i] === second.data[i];
      // No growth once the photo program exists.
      const memory: { textures: number; geometries: number; programs: number }[] = [];
      for (let i = 0; i < 3; i++) {
        await exportImage(center, look);
        const d = viewer.diagnostics();
        memory.push({ textures: d.textures, geometries: d.geometries, programs: d.programs });
      }
      // One frame (no averaging) also takes the look, as used by the float-less fallback.
      const single = await viewer.export(center, {
        format: 'png',
        mode: 'after',
        longEdge: edge,
        effects: look,
      });
      const singleExport = viewer.diagnostics().lastExport;
      images['effects-eye-single-on'] = (await toImage(single)).canvas.toDataURL('image/png');
      return { images, tiles, corners, timing, identical, memory, singleExport };
    },
    { edge: edges.includes(2048) ? 2048 : edges[0] },
  );
  await page.evaluate(() =>
    (window as unknown as { __xr: { viewer: { dispose(): void } } }).__xr.viewer.dispose(),
  );
  assert.deepEqual(errors, [], errors.join('\n'));
  for (const [name, url] of Object.entries({
    ...result.images,
    ...accumulation.images,
    ...effects.images,
  }))
    await writeFile(`${output}/${name}.png`, Buffer.from(url.split(',')[1], 'base64'));
  // Zoomed crops (3×, nearest): toilet shadow and left floor corner, one frame | accumulated.
  {
    const sharp = (await import('sharp')).default;
    const best = Math.max(...sampleCounts);
    const single = `${output}/accumulate-orbit-1.png`,
      accumulated = `${output}/accumulate-orbit-${best}.png`;
    const { width = 1, height = 1 } = await sharp(single).metadata();
    const crop = (file: string, x: number, y: number, w: number, h: number) =>
      sharp(file)
        .extract({
          left: Math.round(x * width),
          top: Math.round(y * height),
          width: Math.round(w * width),
          height: Math.round(h * height),
        })
        .resize(Math.round(w * 1024) * 3, Math.round(h * 683) * 3, { kernel: 'nearest' })
        .png()
        .toBuffer();
    const toilet = [0.527, 0.703, 0.156, 0.117] as const,
      corner = [0.195, 0.732, 0.156, 0.22] as const;
    const tw = Math.round(toilet[2] * 1024) * 3,
      th = Math.round(toilet[3] * 683) * 3,
      ch = Math.round(corner[3] * 683) * 3;
    await sharp({ create: { width: tw * 2 + 8, height: th + ch + 8, channels: 3, background: '#ffffff' } })
      .composite([
        { input: await crop(single, ...toilet), left: 0, top: 0 },
        { input: await crop(accumulated, ...toilet), left: tw + 8, top: 0 },
        { input: await crop(single, ...corner), left: 0, top: th + 8 },
        { input: await crop(accumulated, ...corner), left: tw + 8, top: th + 8 },
      ])
      .png()
      .toFile(`${output}/accumulate-crops.png`);
    // Toilet shadow at 1, then each sample count, left to right.
    const counts = [1, ...sampleCounts];
    await sharp({
      create: { width: (tw + 8) * counts.length, height: th, channels: 3, background: '#ffffff' },
    })
      .composite(
        await Promise.all(
          counts.map(async (samples, i) => ({
            input: await crop(`${output}/accumulate-orbit-${samples}.png`, ...toilet),
            left: i * (tw + 8),
            top: 0,
          })),
        ),
      )
      .png()
      .toFile(`${output}/accumulate-shadow-steps.png`);
  }

  const accumulationReport = {
    ...accumulation,
    images: undefined,
    colour: Object.fromEntries(
      Object.entries(accumulation.colour).map(([name, c]) => [
        name,
        { ...c, deltaE2000: Number(deltaE2000(c.single, c.accumulated).toFixed(2)) },
      ]),
    ),
  };
  const report = {
    label,
    gpu: result.gpu,
    power,
    headed,
    metrics: result.metrics,
    accumulation: accumulationReport,
    effects: {
      centre: Object.fromEntries(
        Object.entries(effects.tiles).map(([name, { off, on }]) => {
          const differences = off.map((colour, i) =>
            deltaE2000(colour as [number, number, number], on[i] as [number, number, number]),
          );
          return [
            name,
            {
              tiles: differences.length,
              maxDeltaE2000: Number(Math.max(...differences).toFixed(2)),
              meanDeltaE2000: Number(
                (differences.reduce((a, b) => a + b, 0) / differences.length).toFixed(2),
              ),
            },
          ];
        }),
      ),
      cornerLuminance: effects.corners,
      timing: effects.timing,
      identical: effects.identical,
      memory: effects.memory,
      singleExport: effects.singleExport,
    },
  };
  await writeFile(`${output}/metrics.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  for (const [name, centre] of Object.entries(report.effects.centre))
    assert.ok(
      centre.maxDeltaE2000 <= 2,
      `${name}: photo look changes the centre by ΔE ${centre.maxDeltaE2000}`,
    );
  assert.ok(report.effects.identical, 'photo look is not reproducible');
  for (const [name, value] of Object.entries(result.metrics))
    if ('probeBackgroundRatio' in (value as object))
      assert.equal(
        (value as { probeBackgroundRatio: number }).probeBackgroundRatio,
        0,
        `${name} shows space outside the room`,
      );
} finally {
  await browser.close();
}
