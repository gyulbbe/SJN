/**
 * Export realism stage 2: live editor frames with fixture shadows, low-sample shadow noise and
 * low-end export responsiveness (longest main-thread block, cancel reaction). No AI, no network.
 * Usage: node tests/run-browser-test.mjs tests/export-realism-stage-2-browser.ts <label> [--gpu]
 *   [--edges=1024,2048,4096] [--baseline=<label>] [--sections=live,samples,responsiveness]
 * Writes test-results/export-realism-stage-2/<label>/. With --baseline, live frames are compared
 * with that label's: only darker pixels may differ, and tile regions away from fixtures keep
 * ΔE2000 ≤ 0.5.
 */
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { deltaE2000, type Rgb } from './helpers/delta-e';

const label = process.argv.slice(3).find((arg) => !arg.startsWith('--')) ?? 'stage-2';
if (!/^[a-z0-9-]+$/.test(label)) throw new Error('label must be lowercase letters, digits or dashes');
const gpu = process.argv.includes('--gpu');
const option = (name: string) =>
  process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const edges = (option('edges') ?? '1024,2048,4096').split(',').map(Number);
const baseline = option('baseline');
// live (frame time, live shadows) · samples (1/2/4/32-sample exports) · responsiveness (long tasks, cancel)
const sections = (option('sections') ?? 'live,samples,responsiveness').split(',');
const root = 'test-results/export-realism-stage-2';
const output = `${root}/${label}`;
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
    contents: `export * from './src/lib/room-viewer/renderer';export * from './src/lib/room-viewer/view-state';export {buildRealismScene,toImage} from './tests/helpers/export-realism-scene';`,
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
  headless: true,
  args: gpu
    ? ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--enable-gpu']
    : ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
/** Live frames compared with the baseline, and the tile regions (image fractions) away from fixtures. */
const liveViews = ['orbit-front', 'eye-center', 'eye-left-corner'] as const;
const tileRegions: Record<(typeof liveViews)[number], Record<string, [number, number, number, number]>> = {
  'orbit-front': {
    leftWall: [0.23, 0.25, 0.31, 0.45],
    rightWall: [0.69, 0.25, 0.77, 0.45],
    backWallUpper: [0.55, 0.28, 0.64, 0.36],
    floorFront: [0.45, 0.88, 0.55, 0.93],
  },
  'eye-center': { backWallUpper: [0.55, 0.05, 0.8, 0.3], leftWall: [0.02, 0.1, 0.12, 0.4] },
  'eye-left-corner': { backWallUpper: [0.5, 0.05, 0.75, 0.3], rightWall: [0.88, 0.1, 0.98, 0.4] },
};
try {
  const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (e) => {
    if (e.type() === 'error') errors.push(e.text());
  });
  await page.route('http://127.0.0.1:43212/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<html><body style="margin:0"></body></html>' }),
  );
  await page.goto('http://127.0.0.1:43212/');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const result = await page.evaluate(
    async ({ edges, liveViews, sections }) => {
      type Lib = typeof import('../src/lib/room-viewer/renderer') &
        typeof import('../src/lib/room-viewer/view-state') &
        typeof import('./helpers/export-realism-scene');
      type RoomViewState = import('../src/lib/room-viewer/view-state').RoomViewState;
      type Image = { canvas: HTMLCanvasElement; data: Uint8ClampedArray };
      const lib = (window as unknown as { Realism: Lib }).Realism;
      const { room, assets, snapshot } = await lib.buildRealismScene();
      const viewer = new lib.RoomViewerRenderer();
      const images: Record<string, string> = {};
      const luminance = (d: Uint8ClampedArray, i: number) =>
        0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      const pixels = (canvas: HTMLCanvasElement): Image => {
        const copy = document.createElement('canvas');
        copy.width = canvas.width;
        copy.height = canvas.height;
        const ctx = copy.getContext('2d', { willReadFrequently: true })!;
        ctx.drawImage(canvas, 0, 0);
        return { canvas: copy, data: ctx.getImageData(0, 0, copy.width, copy.height).data };
      };
      /**
       * Floor across the toilet's cast shadow (orbit view, row 0.75, x 0.60–0.70): shadow depth (lit − darkest luminance)
       * and edge slope, the steepest luminance change per pixel of a 1024-wide image across the
       * shadow's outer edge. A softer shadow has a lower slope.
       */
      const shadowProfile = (image: Image) => {
        const { width, height } = image.canvas;
        const y = Math.round(0.75 * height);
        const values: number[] = [];
        for (let x = Math.round(0.6 * width); x < Math.round(0.7 * width); x++)
          values.push(luminance(image.data, (y * width + x) * 4));
        const darkest = values.indexOf(Math.min(...values)),
          high = Math.max(...values.slice(-Math.ceil(values.length / 4)));
        const step = Math.max(1, Math.round(width / 512));
        let slope = 0;
        for (let i = darkest; i + step < values.length; i++)
          slope = Math.max(slope, (values[i + step] - values[i]) / step);
        return {
          contrast: Number((high - values[darkest]).toFixed(1)),
          edgeSlope: Number(((slope * width) / 1024).toFixed(2)),
        };
      };
      /** Mean |luminance − its 3×3 mean| over the toilet shadow (orbit view): dither shows as noise. */
      const shadowNoise = (image: Image) => {
        const { width, height } = image.canvas;
        let total = 0,
          count = 0;
        for (let y = Math.round(0.72 * height); y < Math.round(0.82 * height); y++)
          for (let x = Math.round(0.58 * width); x < Math.round(0.72 * width); x++) {
            let sum = 0;
            for (let j = -1; j <= 1; j++)
              for (let i = -1; i <= 1; i++) sum += luminance(image.data, ((y + j) * width + x + i) * 4);
            total += Math.abs(luminance(image.data, (y * width + x) * 4) - sum / 9);
            count++;
          }
        return Number((total / count).toFixed(3));
      };
      try {
        await viewer.setSnapshot(snapshot, async (id) => assets[id]);
        const views: Record<string, RoomViewState> = {
          'orbit-front': lib.defaultRoomView(),
          'eye-center': lib.roomEyeView(room, 'center'),
          'eye-left-corner': lib.roomEyeView(room, 'left-corner'),
        };
        // Live editor frames: the GPU finishes each (one-pixel read) before the clock stops.
        const gl = viewer.canvas.getContext('webgl2')!;
        const pixel = new Uint8Array(4);
        const frame = (width: number, height: number, view: RoomViewState) => {
          const started = performance.now();
          viewer.render(width, height, view, 'after');
          gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
          return performance.now() - started;
        };
        const live: Record<string, { medianMs: number; p90Ms: number; frames: number }> = {};
        for (const [width, height] of [
          [1536, 1024],
          [1024, 683],
        ]) {
          const base = views['orbit-front'];
          for (let i = 0; i < 3; i++) frame(width, height, base);
          const times: number[] = [];
          // A drag nudges the camera every frame, as in the editor.
          for (let i = 0; i < 30; i++)
            times.push(frame(width, height, { ...base, zoom: 1 + (i % 2) * 0.02 }));
          times.sort((a, b) => a - b);
          live[`${width}x${height}`] = {
            medianMs: Number(times[15].toFixed(2)),
            p90Ms: Number(times[27].toFixed(2)),
            frames: times.length,
          };
        }
        const liveShadow: Record<string, unknown> = {};
        for (const name of liveViews) {
          frame(1536, 1024, views[name]);
          const image = pixels(viewer.canvas);
          images[`live-${name}`] = image.canvas.toDataURL('image/png');
          if (name === 'orbit-front')
            Object.assign(liveShadow, { profile: shadowProfile(image), noise: shadowNoise(image) });
        }
        // Few samples: the toilet shadow edge with 1, 2, 4 and the default 32 (orbit, 1024).
        const lowSamples: Record<string, unknown> = {};
        for (const samples of sections.includes('samples') ? [1, 2, 4, 32] : []) {
          const blob = await viewer.export(views['orbit-front'], {
            format: 'png',
            mode: 'after',
            longEdge: 1024,
            ...(samples > 1 ? { quality: { samples } } : {}),
          });
          const image = await lib.toImage(blob);
          images[`samples-${samples}`] = image.canvas.toDataURL('image/png');
          lowSamples[samples] = { profile: shadowProfile(image), noise: shadowNoise(image) };
        }
        // Responsiveness of the default download: longest task and a cancel 1.5 s in.
        const responsiveness: Record<string, unknown> = {};
        for (const edge of sections.includes('responsiveness') ? edges : []) {
          const tasks: { start: number; duration: number }[] = [];
          const observer = new PerformanceObserver((list) => {
            for (const entry of list.getEntries())
              tasks.push({ start: entry.startTime, duration: entry.duration });
          });
          observer.observe({ type: 'longtask', buffered: false });
          const within = (from: number, to: number) =>
            tasks
              .filter((t) => t.start >= from - 1 && t.start <= to)
              .reduce((m, t) => Math.max(m, t.duration), 0);
          const started = performance.now();
          await viewer.export(views['eye-center'], {
            format: 'png',
            mode: 'after',
            longEdge: edge,
            quality: lib.ROOM_PHOTO_EXPORT_QUALITY,
          });
          const done = performance.now();
          await new Promise((resolve) => setTimeout(resolve, 100));
          const full = {
            ms: Math.round(done - started),
            longestTaskMs: Math.round(within(started, done)),
            last: viewer.diagnostics().lastExport,
          };
          const controller = new AbortController();
          const cancelStart = performance.now(),
            abortAt = cancelStart + 1500;
          setTimeout(() => controller.abort(), 1500);
          let cancel: Record<string, unknown>;
          try {
            await viewer.export(views['eye-center'], {
              format: 'png',
              mode: 'after',
              longEdge: edge,
              quality: { samples: 32, budgetMs: 60_000 },
              signal: controller.signal,
            });
            cancel = { completedBeforeCancel: true, ms: Math.round(performance.now() - cancelStart) };
          } catch (error) {
            const stopped = performance.now();
            await new Promise((resolve) => setTimeout(resolve, 100));
            const d = viewer.diagnostics();
            cancel = {
              aborted: error instanceof DOMException && error.name === 'AbortError',
              reactionMs: Math.round(stopped - abortAt),
              longestTaskMs: Math.round(within(cancelStart, stopped)),
              textures: d.textures,
              geometries: d.geometries,
            };
          }
          observer.disconnect();
          responsiveness[edge] = { full, cancel };
        }
        const d = viewer.diagnostics();
        return {
          images,
          live,
          liveShadow,
          lowSamples,
          responsiveness,
          gpu: d.gpu,
          resources: { textures: d.textures, geometries: d.geometries, programs: d.programs },
        };
      } finally {
        viewer.dispose();
      }
    },
    { edges, liveViews: [...liveViews], sections },
  );
  for (const [name, url] of Object.entries(result.images))
    await writeFile(`${output}/${name}.png`, Buffer.from(url.split(',')[1], 'base64'));

  // Before/after live frames: only darker pixels may change; tile regions keep their colour.
  let comparison: Record<string, unknown> | undefined;
  if (baseline) {
    comparison = {};
    for (const name of liveViews) {
      const before = `${root}/${baseline}/live-${name}.png`;
      if (!existsSync(before)) continue;
      const a = await sharp(before).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      const b = await sharp(`${output}/live-${name}.png`)
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const { width, height } = a.info;
      let brighter = 0,
        darker = 0,
        maxDarkening = 0;
      const heat = Buffer.alloc(width * height * 3, 255);
      for (let i = 0; i < width * height; i++) {
        let up = 0,
          down = 0;
        for (let c = 0; c < 3; c++) {
          const delta = b.data[i * 3 + c] - a.data[i * 3 + c];
          up = Math.max(up, delta);
          down = Math.max(down, -delta);
        }
        // One level of rounding either way is not a change.
        if (up > 1) brighter++;
        if (down > 1) darker++;
        maxDarkening = Math.max(maxDarkening, down);
        const shade = Math.max(0, 255 - down * 4);
        heat[i * 3] = up > 1 ? 255 : shade;
        heat[i * 3 + 1] = up > 1 ? 0 : shade;
        heat[i * 3 + 2] = up > 1 ? 0 : 255;
      }
      const median = (data: Buffer, r: [number, number, number, number]): Rgb => {
        const channels: number[][] = [[], [], []];
        for (let y = Math.round(r[1] * height); y < Math.round(r[3] * height); y++)
          for (let x = Math.round(r[0] * width); x < Math.round(r[2] * width); x++)
            for (let c = 0; c < 3; c++) channels[c].push(data[(y * width + x) * 3 + c]);
        return channels.map((v) => v.sort((p, q) => p - q)[v.length >> 1]) as Rgb;
      };
      const regions = Object.fromEntries(
        Object.entries(tileRegions[name]).map(([region, r]) => [
          region,
          Number(deltaE2000(median(a.data, r), median(b.data, r)).toFixed(2)),
        ]),
      );
      comparison[name] = {
        brighterPixels: brighter,
        darkerShare: Number((darker / (width * height)).toFixed(4)),
        maxDarkening,
        tileRegionDeltaE2000: regions,
      };
      // before | after | darkening ×4 (blue), brightening (red)
      const panel = (input: Buffer) =>
        sharp(input, { raw: { width, height, channels: 3 } })
          .png()
          .toBuffer();
      await sharp({ create: { width: width * 3 + 20, height, channels: 3, background: '#ffffff' } })
        .composite([
          { input: await panel(a.data), left: 0, top: 0 },
          { input: await panel(b.data), left: width + 10, top: 0 },
          { input: await panel(heat), left: width * 2 + 20, top: 0 },
        ])
        .jpeg({ quality: 88 })
        .toFile(`${output}/compare-live-${name}.jpg`);
    }
    /**
     * Cast shadows alone: the darkening against a frame without them (the baseline's live frame,
     * or its one-sample export, which had none before stage 2), resized to 1024 wide. `depth` is
     * the mean darkening where it exceeds 2 levels; `edge` the mean darkening gradient there
     * (levels per pixel): a softer shadow has a lower edge. `grain` is the mean |darkening − its
     * 3×3 mean| there: a screen-space dither shows up as grain, a smooth penumbra hardly at all.
     */
    const shadowTerm = async (plain: string, shaded: string) => {
      if (!existsSync(plain) || !existsSync(shaded)) return null;
      const load = async (file: string) =>
        sharp(file).resize(1024).removeAlpha().greyscale().raw().toBuffer({ resolveWithObject: true });
      const a = await load(plain),
        b = await load(shaded);
      const { width, height } = a.info;
      const dark = new Float32Array(width * height);
      for (let i = 0; i < dark.length; i++) dark[i] = Math.max(0, a.data[i] - b.data[i]);
      let depth = 0,
        edge = 0,
        grain = 0,
        count = 0;
      for (let y = 1; y < height - 1; y++)
        for (let x = 1; x < width - 1; x++) {
          const i = y * width + x;
          if (dark[i] <= 2) continue;
          depth += dark[i];
          edge += Math.hypot(dark[i + 1] - dark[i - 1], dark[i + width] - dark[i - width]) / 2;
          let around = 0;
          for (let j = -1; j <= 1; j++) for (let k = -1; k <= 1; k++) around += dark[i + j * width + k];
          grain += Math.abs(dark[i] - around / 9);
          count++;
        }
      return count
        ? {
            pixels: count,
            depth: Number((depth / count).toFixed(2)),
            edge: Number((edge / count).toFixed(3)),
            grain: Number((grain / count).toFixed(3)),
          }
        : { pixels: 0, depth: 0, edge: 0, grain: 0 };
    };
    comparison.shadowTerms = {
      live: await shadowTerm(`${root}/${baseline}/live-orbit-front.png`, `${output}/live-orbit-front.png`),
      ...Object.fromEntries(
        await Promise.all(
          [1, 2, 4, 32].map(async (n) => [
            `samples-${n}`,
            await shadowTerm(`${root}/${baseline}/samples-1.png`, `${output}/samples-${n}.png`),
          ]),
        ),
      ),
      ...Object.fromEntries(
        await Promise.all(
          [2, 4, 32].map(async (n) => [
            `baselineSamples-${n}`,
            await shadowTerm(`${root}/${baseline}/samples-1.png`, `${root}/${baseline}/samples-${n}.png`),
          ]),
        ),
      ),
    };
  }
  const report = {
    label,
    gpu: result.gpu,
    power,
    live: result.live,
    liveShadow: result.liveShadow,
    lowSamples: result.lowSamples,
    responsiveness: result.responsiveness,
    resources: result.resources,
    ...(comparison ? { baseline, comparison } : {}),
    errors,
  };
  await writeFile(`${output}/metrics.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (errors.length) throw new Error(errors.join('\n'));
} finally {
  await browser.close();
}
