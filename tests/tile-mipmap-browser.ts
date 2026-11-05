/**
 * Tile texture mipmaps (docs/tile-mipmap-results-20261105.md): synthetic tiles drawn by the 2D
 * compositor and the 3D room renderer at editor size (1200 × 800), and at 3× scaled down in linear
 * light as a reference. Textures are drawn on canvases here, so nothing is downloaded. No AI call.
 *
 *   node tests/run-browser-test.mjs tests/tile-mipmap-browser.ts <label> [--gpu]
 *
 * `baseline` (run on the code before the change) writes the reference to
 * test-results/tile-mipmap/baseline[-gpu]/. Any other label writes test-results/tile-mipmap/<label>[-gpu]/
 * and fails when, against that baseline:
 *  - aliasing (mean |editor size − 3× reduced| inside wall faces) of a striped tile is not at most half;
 *  - a tile without grout (single colour, smooth periodic gradient) shows a line: a second difference
 *    inside the faces over 2/255, or over the baseline's where its light and rounding already give more;
 *  - a four-variant atlas (small tiles, so blurred levels are read) mixes variant colours: more 2D
 *    pixels away from all four colours than before, or any 3D wall pixel over 3/255 from the baseline
 *    (solid variants look the same at every level unless a neighbouring cell leaks in);
 *  - a plain tile's face mean colour moves more than ΔE2000 1.0;
 *  - any pixel outside the tile faces (their region mask grown by 2 px) differs at all.
 * Other paths (brick, rotation, offset, a region, SMC ceiling, a standard fixture with its shadow,
 * wall features and a ledge, a photo project with shading, the 3D multi-sample export and both AI
 * inputs) must draw without errors and keep their outside pixels.
 * --gpu uses ANGLE D3D11 (this PC's GPU) instead of SwiftShader.
 */
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { deltaE2000, type Rgb } from './helpers/delta-e';

const label = process.argv[3] ?? 'current';
const gpu = process.argv.includes('--gpu');
if (!/^[a-z0-9-]+$/.test(label)) throw new Error('label must be lowercase letters, digits or dashes');
const root = 'test-results/tile-mipmap';
const suffix = gpu ? '-gpu' : '';
const output = `${root}/${label}${suffix}`;
const baselineDir = `${root}/baseline${suffix}`;
await mkdir(output, { recursive: true });

type CaseResult = {
  images: Record<string, string>;
  masks: Record<string, string>;
  errors: string[];
};
type PageResult = {
  cases: Record<string, CaseResult>;
  perf: Record<string, number | string>;
  gpuName: string;
};

const bundle = await build({
  stdin: {
    contents: `export * from './src/lib/room-viewer/renderer';export * from './src/lib/room-viewer/view-state';export {PhotoCompositor} from './src/lib/render/compositor';export {renderRoomBackground} from './src/lib/room-background';export {createRoomSurfaces,DEFAULT_ROOM} from './src/lib/room-geometry';export {applyRoomSurfaceRegion} from './src/lib/room-surface-regions';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
  globalName: 'MipmapTest',
  logLevel: 'error',
});
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: gpu
    ? ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--enable-gpu']
    : ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
let result: PageResult;
const pageErrors: string[] = [];
try {
  const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (e) => {
    if (e.type() === 'error') pageErrors.push(e.text());
  });
  const ceiling = await readFile('public/ceiling/smc-ceiling.webp');
  await page.route('http://127.0.0.1:43241/**', (route) =>
    route.request().url().endsWith('/ceiling/smc-ceiling.webp')
      ? route.fulfill({ contentType: 'image/webp', body: ceiling })
      : route.fulfill({ contentType: 'text/html', body: '<html><body style="margin:0"></body></html>' }),
  );
  await page.goto('http://127.0.0.1:43241/');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  result = await page.evaluate(async (): Promise<PageResult> => {
    type Lib = typeof import('../src/lib/room-viewer/renderer') &
      typeof import('../src/lib/room-viewer/view-state') &
      typeof import('../src/lib/render/compositor') &
      typeof import('../src/lib/room-background') &
      typeof import('../src/lib/room-geometry') &
      typeof import('../src/lib/room-surface-regions');
    type MaterialVersion = import('../src/lib/types').MaterialVersion;
    type Scene = import('../src/lib/types').Scene;
    type Surface = import('../src/lib/types').Surface;
    type AssetRecord = import('../src/lib/types').AssetRecord;
    type FixtureInstance = import('../src/lib/types').FixtureInstance;
    type RoomViewState = import('../src/lib/room-viewer/view-state').RoomViewState;
    const lib = (window as unknown as { MipmapTest: Lib }).MipmapTest;
    const room = structuredClone(lib.DEFAULT_ROOM);
    const color = { exposure: 0, contrast: 1, saturation: 1, warmth: 0 };
    const empty = () => ({ polygon: [], strokes: [] });
    const assets: Record<string, AssetRecord> = {};
    const blobOf = (canvas: HTMLCanvasElement) =>
      new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), 'image/png'));
    const addAsset = async (id: string, canvas: HTMLCanvasElement, kind: AssetRecord['kind'] = 'texture') => {
      const blob = await blobOf(canvas);
      assets[id] = {
        id,
        ownerId: 'test',
        name: id,
        mime: 'image/png',
        size: blob.size,
        width: canvas.width,
        height: canvas.height,
        kind,
        blob,
        createdAt: '2026-11-05',
      } as AssetRecord;
    };
    const texture = async (
      id: string,
      size: number,
      draw: (c: CanvasRenderingContext2D, s: number) => void,
    ) => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      draw(canvas.getContext('2d')!, size);
      await addAsset(id, canvas);
    };
    const stripes =
      (period: number, vertical: boolean, light: string, dark: string) =>
      (c: CanvasRenderingContext2D, s: number) => {
        c.fillStyle = light;
        c.fillRect(0, 0, s, s);
        c.fillStyle = dark;
        for (let i = 0; i < s; i += period)
          if (vertical) c.fillRect(i, 0, period / 2, s);
          else c.fillRect(0, i, s, period / 2);
      };
    // Fine ribs like DWJ 9881/9922 (3, 5 and 8 px periods on a 1024 px photo), vertical ribs, and
    // black/white bands for the gamma check (512 px, so the 2D preview cell needs no resampling).
    await texture('h3', 1024, stripes(3, false, '#e6e1d8', '#8a8378'));
    await texture('h5', 1024, stripes(5, false, '#e6e1d8', '#8a8378'));
    await texture('h8', 1024, stripes(8, false, '#e6e1d8', '#8a8378'));
    await texture('v5', 1024, stripes(5, true, '#dcdcd8', '#7c7c78'));
    await texture('bw8', 512, stripes(8, false, '#ffffff', '#000000'));
    // A sheet of six bricks with light gaps, as ROMAN OLVIE-G is registered.
    await texture('bricks', 1024, (c, s) => {
      c.fillStyle = '#e4e1d8';
      c.fillRect(0, 0, s, s);
      for (let row = 0; row < 6; row++) {
        c.fillStyle = row % 2 ? '#5b6040' : '#646a47';
        c.fillRect(10, row * (s / 6) + 10, s - 20, s / 6 - 20);
        c.strokeStyle = '#8c9268';
        c.lineWidth = 3;
        c.strokeRect(14, row * (s / 6) + 14, s - 28, s / 6 - 28);
      }
    });
    await texture('solid', 256, (c, s) => {
      c.fillStyle = '#c9c2b6';
      c.fillRect(0, 0, s, s);
    });
    // A plain tile with a faint grain (like DWJ 9819), deterministic.
    await texture('plain', 1024, (c, s) => {
      const image = c.createImageData(s, s);
      let seed = 12345;
      for (let i = 0; i < s * s; i++) {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        const n = ((seed >> 16) % 13) - 6;
        image.data[i * 4] = 233 + n;
        image.data[i * 4 + 1] = 230 + n;
        image.data[i * 4 + 2] = 225 + n;
        image.data[i * 4 + 3] = 255;
      }
      c.putImageData(image, 0, 0);
    });
    // A smooth gradient that is periodic over the tile, so a line at a tile edge is an artefact.
    await texture('gradient', 512, (c, s) => {
      const image = c.createImageData(s, s);
      for (let y = 0; y < s; y++)
        for (let x = 0; x < s; x++) {
          const t =
            0.5 +
            0.25 * Math.cos((2 * Math.PI * (x + 0.5)) / s) +
            0.25 * Math.cos((2 * Math.PI * (y + 0.5)) / s);
          const i = (y * s + x) * 4;
          image.data[i] = 196 + 24 * t;
          image.data[i + 1] = 200 + 16 * t;
          image.data[i + 2] = 206 - 8 * t;
          image.data[i + 3] = 255;
        }
      c.putImageData(image, 0, 0);
    });
    const VARIANTS = ['#d23c32', '#3ca046', '#3250c8', '#d2b432'];
    for (const [i, fill] of VARIANTS.entries())
      await texture('variant-' + i, 256, (c, s) => {
        c.fillStyle = fill;
        c.fillRect(0, 0, s, s);
      });
    await texture('floor', 256, (c, s) => {
      c.fillStyle = '#b9b6b0';
      c.fillRect(0, 0, s, s);
    });
    const background = await lib.renderRoomBackground(room, { width: 3600, height: 2400 });
    assets.bg = {
      id: 'bg',
      ownerId: 'test',
      name: 'bg',
      mime: 'image/png',
      size: background.blob.size,
      width: background.width,
      height: background.height,
      kind: 'original',
      blob: background.blob,
      createdAt: '2026-11-05',
    } as AssetRecord;
    // A photo for the photo project: a lit wall over a floor, with a soft light gradient.
    {
      const canvas = document.createElement('canvas');
      canvas.width = 1500;
      canvas.height = 1000;
      const c = canvas.getContext('2d')!;
      const g = c.createLinearGradient(0, 0, 1500, 1000);
      g.addColorStop(0, '#d8d4cc');
      g.addColorStop(1, '#8a8780');
      c.fillStyle = g;
      c.fillRect(0, 0, 1500, 1000);
      await addAsset('photo', canvas, 'original');
    }
    const material = (
      id: string,
      textures: string[],
      widthMm: number,
      heightMm: number,
      extra: Partial<MaterialVersion> = {},
    ): MaterialVersion => ({
      id,
      materialId: id,
      version: 1,
      name: id,
      brand: '',
      code: '',
      category: 'tile',
      scope: 'personal',
      description: '',
      color: '#d0ccc4',
      finish: '무광',
      widthMm,
      heightMm,
      depthMm: 9,
      usage: 'both',
      installation: 'wall',
      textureAssetIds: textures,
      views: [],
      defaultGroutWidth: 2,
      defaultGroutColor: '#d5d1c9',
      defaultPattern: 'grid',
      createdAt: '2026-11-05',
      ...extra,
    });
    type Case = { name: string; textures: string[]; w: number; h: number; grout: number };
    const cases: Case[] = [
      { name: 'h3', textures: ['h3'], w: 600, h: 300, grout: 2 },
      { name: 'h5', textures: ['h5'], w: 600, h: 300, grout: 2 },
      { name: 'h8', textures: ['h8'], w: 600, h: 300, grout: 2 },
      { name: 'v5', textures: ['v5'], w: 300, h: 600, grout: 2 },
      { name: 'bw8', textures: ['bw8'], w: 600, h: 600, grout: 0 },
      { name: 'bricks', textures: ['bricks'], w: 198, h: 288, grout: 2 },
      { name: 'solid', textures: ['solid'], w: 600, h: 300, grout: 0 },
      { name: 'plain', textures: ['plain'], w: 600, h: 300, grout: 2 },
      { name: 'gradient', textures: ['gradient'], w: 600, h: 600, grout: 0 },
      { name: 'variants', textures: VARIANTS.map((_, i) => 'variant-' + i), w: 60, h: 60, grout: 0 },
    ];
    const materials: Record<string, MaterialVersion> = {
      floor: material('floor', ['floor'], 600, 600, { defaultGroutColor: '#9a978f' }),
      standard: material('standard', ['floor'], 400, 750, { category: 'toilet' }),
    };
    for (const c of cases) materials[c.name] = material(c.name, c.textures, c.w, c.h);
    const roomScene = (wall: string, grout: number, tweak?: (s: Surface, i: number) => Surface): Scene => ({
      room: structuredClone(room),
      originalAssetId: 'bg',
      previewAssetId: 'bg',
      imageWidth: 3600,
      imageHeight: 2400,
      surfaces: lib.createRoomSurfaces(room, 1.5).map((s, i) => {
        const floor = s.roomFace === 'floor';
        const surface: Surface = {
          ...s,
          materialVersionId: floor ? 'floor' : wall,
          tile: {
            ...s.tile,
            groutWidth: floor ? 2 : grout,
            groutColor: floor ? '#9a978f' : '#d5d1c9',
            pattern: 'grid',
            shading: 0,
            seed: 11,
          },
        };
        return tweak ? tweak(surface, i) : surface;
      }),
      fixtures: [],
      protection: empty(),
      color: { ...color },
    });
    const toilet = (): FixtureInstance => ({
      id: 'toilet',
      name: 'toilet',
      materialVersionId: 'standard',
      viewIndex: 0,
      position: { x: 0.5, y: 0.5 },
      width: 0.2,
      height: 0.4,
      rotation: 0,
      anchor: { x: 0.5, y: 1 },
      locked: false,
      shadow: { x: 0, y: 0.01, opacity: 0.45, blur: 0.02, scale: 1 },
      occlusion: empty(),
      color: { ...color },
      roomPlacement: {
        face: 'floor',
        u: 0.62,
        v: 0.3,
        scale: 1,
        widthMm: 400,
        heightMm: 750,
        imageAspect: 400 / 750,
        contentBounds: { left: 0, right: 1, top: 0, bottom: 1 },
      },
      reconstruction: {
        version: 2,
        kind: 'toilet',
        color: '#f2f1ec',
        widthMm: 400,
        heightMm: 750,
        depthMm: 680,
        baseHeightMm: 0,
        yawDegrees: 0,
      },
    });
    const reader = async (id: string) => assets[id];
    const readPixels = (source: CanvasImageSource & { width: number; height: number }) => {
      const copy = document.createElement('canvas');
      copy.width = source.width;
      copy.height = source.height;
      const ctx = copy.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(source, 0, 0);
      return ctx.getImageData(0, 0, copy.width, copy.height);
    };
    const toUrl = (image: ImageData) => {
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      canvas.getContext('2d')!.putImageData(image, 0, 0);
      return canvas.toDataURL('image/png');
    };
    const linear = Float32Array.from({ length: 256 }, (_, v) => {
      const c = v / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    const encode = (v: number) =>
      Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055));
    /** A 3× render box-filtered in linear light: what the editor-size image should look like. */
    const reduce3 = (big: ImageData) => {
      const width = Math.floor(big.width / 3),
        height = Math.floor(big.height / 3);
      const out = new ImageData(width, height);
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++)
          for (let c = 0; c < 3; c++) {
            let sum = 0;
            for (let dy = 0; dy < 3; dy++)
              for (let dx = 0; dx < 3; dx++)
                sum += linear[big.data[((y * 3 + dy) * big.width + x * 3 + dx) * 4 + c]];
            out.data[(y * width + x) * 4 + c] = encode(sum / 9);
            out.data[(y * width + x) * 4 + 3] = 255;
          }
      return out;
    };
    /** Labels as `WxH:<wall labels>:<base64>`; label n is `regions[n - 1]`, 255 a fixture. */
    const maskUrl = (mask: {
      width: number;
      height: number;
      data: Uint8Array;
      regions: { kind: string }[];
    }) => {
      let binary = '';
      for (let i = 0; i < mask.data.length; i += 0x8000)
        binary += String.fromCharCode(...mask.data.subarray(i, i + 0x8000));
      const walls = mask.regions.flatMap((r, i) => (r.kind === 'wall' ? [i + 1] : []));
      return `${mask.width}x${mask.height}:${walls.join(',')}:` + btoa(binary);
    };
    const blobImage = async (blob: Blob) => {
      const bitmap = await createImageBitmap(blob);
      try {
        return readPixels(bitmap);
      } finally {
        bitmap.close();
      }
    };
    const out: Record<string, CaseResult> = {};
    const view = lib.defaultRoomView();
    const caught = (errors: string[]) => (e: unknown) => {
      errors.push(e instanceof Error ? e.message : String(e));
    };

    /** 2D: the editor stage, a 3× export as reference and the AI input's region mask. */
    const draw2d = async (name: string, scene: Scene, entry: CaseResult, big = true) => {
      const snapshot = { scene, beforeScene: structuredClone(scene), materials };
      const compositor = new lib.PhotoCompositor();
      try {
        await compositor.setSnapshot(snapshot, reader);
        entry.images[name + '-2d'] = toUrl(readPixels(compositor.render(1200, 800, 'after')));
        if (big)
          entry.images[name + '-2d-ref'] = toUrl(
            reduce3(await blobImage(await compositor.exportImage(snapshot, 3600, 2400, 'image/png', false))),
          );
        let mask: Parameters<typeof maskUrl>[0] | undefined;
        const ai = await compositor.exportImage(snapshot, 1200, 800, 'image/png', false, (m) => (mask = m));
        entry.images[name + '-2d-ai'] = toUrl(await blobImage(ai));
        if (mask) entry.masks[name + '-2d'] = maskUrl(mask);
      } finally {
        compositor.dispose();
      }
    };
    /** 3D: the editor stage (orbit view), 3× as reference, the face mask and the AI input. */
    const draw3d = async (
      name: string,
      scene: Scene,
      entry: CaseResult,
      big = true,
      views: [string, RoomViewState][] = [['', view]],
    ) => {
      const viewer = new lib.RoomViewerRenderer();
      document.body.append(viewer.canvas);
      try {
        await viewer.setSnapshot({ scene, beforeScene: structuredClone(scene), materials }, reader);
        for (const notice of viewer.notices)
          if (notice.severity === 'error') entry.errors.push(notice.name + ': ' + notice.message);
        for (const [suffix, v] of views) {
          const key = name + '-3d' + suffix;
          entry.images[key] = toUrl(readPixels(viewer.render(1200, 800, v, 'after')));
          if (big)
            entry.images[key + '-ref'] = toUrl(reduce3(readPixels(viewer.render(3600, 2400, v, 'after'))));
          const mask = viewer.regionMask(1200, 800, v);
          entry.masks[key] = maskUrl(mask);
        }
        // The AI input is one synchronous frame without quality.
        entry.images[name + '-3d-ai'] = toUrl(
          await blobImage(await viewer.export(view, { format: 'png', mode: 'after', longEdge: 1200 })),
        );
      } finally {
        viewer.dispose();
        viewer.canvas.remove();
      }
    };

    for (const c of cases) {
      const entry: CaseResult = { images: {}, masks: {}, errors: [] };
      out[c.name] = entry;
      const scene = roomScene(c.name, c.grout);
      await draw2d(c.name, scene, entry).catch(caught(entry.errors));
      await draw3d(c.name, scene, entry).catch(caught(entry.errors));
    }

    // Other paths through the same shaders: brick, 45° and 90°, an offset, a region with another tile,
    // the SMC ceiling, a standard fixture and its shadow.
    {
      const entry: CaseResult = { images: {}, masks: {}, errors: [] };
      out.paths = entry;
      const scene = roomScene('h5', 2, (s, i) => {
        if (s.roomFace === 'back')
          return { ...s, tile: { ...s.tile, pattern: 'brick', offsetX: 37, offsetY: -21 } };
        if (s.roomFace === 'left') return { ...s, tile: { ...s.tile, rotation: 45 } };
        if (s.roomFace === 'right')
          return { ...s, materialVersionId: 'bricks', tile: { ...s.tile, rotation: 90 } };
        return { ...s, tile: { ...s.tile, seed: 11 + i } };
      });
      const back = scene.surfaces.find((s) => s.roomFace === 'back')!;
      scene.surfaces.push({
        ...lib.applyRoomSurfaceRegion(
          { ...structuredClone(back), id: '20000000-0000-4000-8000-000000000001', name: '부분 1' },
          { leftMm: 600, topMm: 900, widthMm: 900, heightMm: 600 },
        ),
        materialVersionId: 'v5',
        tile: { ...back.tile, pattern: 'grid', offsetX: 0, offsetY: 0 },
      });
      scene.ceiling = { kind: 'smc', light: true };
      scene.fixtures = [toilet()];
      await draw2d('paths', scene, entry, false).catch(caught(entry.errors));
      await draw3d('paths', scene, entry, false, [
        ['', view],
        ['-right', lib.rotateRoomView(view, 'right')],
        ['-down', lib.rotateRoomView(view, 'down')],
      ]).catch(caught(entry.errors));
      // The photo download: several jittered samples averaged (3D only).
      const viewer = new lib.RoomViewerRenderer();
      document.body.append(viewer.canvas);
      try {
        await viewer.setSnapshot({ scene, beforeScene: structuredClone(scene), materials }, reader);
        entry.images['paths-3d-export'] = toUrl(
          await blobImage(
            await viewer.export(view, {
              format: 'png',
              mode: 'after',
              longEdge: 1200,
              quality: { samples: 4 },
            }),
          ),
        );
        entry.masks['paths-3d-export'] = entry.masks['paths-3d'];
      } catch (e) {
        caught(entry.errors)(e);
      } finally {
        viewer.dispose();
        viewer.canvas.remove();
      }
    }
    // Wall features: a niche and a ledge with ribbed tiles (the editor's 3D stage).
    {
      const entry: CaseResult = { images: {}, masks: {}, errors: [] };
      out.features = entry;
      const scene = roomScene('h5', 2);
      scene.wallFeatures = [
        {
          version: 1,
          id: '30000000-0000-4000-8000-000000000001',
          kind: 'closed-niche',
          face: 'back',
          leftMm: 1300,
          topMm: 900,
          widthMm: 600,
          heightMm: 400,
          depthMm: 150,
          source: 'user',
        },
        {
          version: 1,
          id: '30000000-0000-4000-8000-000000000002',
          kind: 'ledge',
          face: 'back',
          leftMm: 0,
          bottomMm: 0,
          widthMm: 900,
          heightMm: 1000,
          depthMm: 200,
          source: 'user',
        },
      ];
      await draw3d('features', scene, entry, false, [
        ['', view],
        ['-right', lib.rotateRoomView(view, 'right')],
      ]).catch(caught(entry.errors));
    }
    // A photo project: no room, a perspective wall and floor with the photo's light kept (2D only).
    {
      const entry: CaseResult = { images: {}, masks: {}, errors: [] };
      out.photo = entry;
      const quad = (points: [number, number][]) => points.map(([x, y]) => ({ x, y })) as Surface['quad'];
      const wallQuad = quad([
        [0.08, 0.06],
        [0.92, 0.12],
        [0.9, 0.7],
        [0.1, 0.66],
      ]);
      const floorQuad = quad([
        [0.1, 0.66],
        [0.9, 0.7],
        [1, 1],
        [0, 1],
      ]);
      const surface = (
        id: string,
        kind: 'wall' | 'floor',
        q: Surface['quad'],
        materialVersionId: string,
      ): Surface => ({
        id,
        name: id,
        kind,
        mask: { polygon: q.map((p) => ({ ...p })), strokes: [] },
        quad: q,
        widthMm: kind === 'wall' ? 2400 : 2400,
        heightMm: kind === 'wall' ? 2100 : 1500,
        calibrated: true,
        materialVersionId,
        tile: {
          groutWidth: 2,
          groutColor: '#d5d1c9',
          pattern: 'grid',
          rotation: 0,
          offsetX: 0,
          offsetY: 0,
          seed: 5,
          shading: 0.7,
        } as Surface['tile'],
        color: { ...color },
      });
      const scene: Scene = {
        originalAssetId: 'photo',
        previewAssetId: 'photo',
        imageWidth: 1500,
        imageHeight: 1000,
        surfaces: [
          surface('40000000-0000-4000-8000-000000000001', 'wall', wallQuad, 'h5'),
          surface('40000000-0000-4000-8000-000000000002', 'floor', floorQuad, 'plain'),
        ],
        fixtures: [],
        protection: empty(),
        color: { ...color },
      } as Scene;
      await draw2d('photo', scene, entry, false).catch(caught(entry.errors));
    }

    // Frame time at editor size (median of 15, a 1 px read waits for the GPU) and preparation time.
    const perf: Record<string, number | string> = {};
    const median = (values: number[]) => values.sort((a, b) => a - b)[values.length >> 1];
    const sync = new Uint8Array(4);
    const wait = (canvas: HTMLCanvasElement) =>
      (canvas.getContext('webgl2') as WebGL2RenderingContext).readPixels(
        0,
        0,
        1,
        1,
        WebGL2RenderingContext.RGBA,
        WebGL2RenderingContext.UNSIGNED_BYTE,
        sync,
      );
    type AtlasTexture = { anisotropy: number; needsUpdate: boolean };
    const setAnisotropy = (textures: AtlasTexture[], value: number) => {
      for (const t of textures) {
        t.anisotropy = value;
        t.needsUpdate = true;
      }
    };
    for (const name of ['h5', 'plain']) {
      const scene = roomScene(name, 2);
      const snapshot = { scene, beforeScene: structuredClone(scene), materials };
      const compositor = new lib.PhotoCompositor();
      try {
        let start = performance.now();
        await compositor.setSnapshot(snapshot, reader);
        perf[`2d-${name}-prepareMs`] = performance.now() - start;
        // The first frame uploads the atlas (and builds its mipmaps).
        start = performance.now();
        compositor.render(1200, 800, 'after');
        wait(compositor.canvas);
        perf[`2d-${name}-firstFrameMs`] = performance.now() - start;
        const frame = () => {
          const times: number[] = [];
          for (let i = 0; i < 15; i++) {
            start = performance.now();
            compositor.render(1200, 800, 'after');
            wait(compositor.canvas);
            times.push(performance.now() - start);
          }
          return median(times);
        };
        perf[`2d-${name}-frameMs`] = frame();
        const atlases = [
          ...(
            compositor as unknown as { atlases: Map<string, Promise<{ texture: AtlasTexture }>> }
          ).atlases.values(),
        ];
        const textures = (await Promise.all(atlases)).map((a) => a.texture);
        const anisotropy = Math.max(...textures.map((t) => t.anisotropy ?? 1));
        perf[`2d-${name}-anisotropy`] = anisotropy;
        if (anisotropy > 1) {
          setAnisotropy(textures, 1);
          compositor.render(1200, 800, 'after');
          wait(compositor.canvas);
          perf[`2d-${name}-frameMsNoAnisotropy`] = frame();
          setAnisotropy(textures, anisotropy);
        }
      } finally {
        compositor.dispose();
      }
      const viewer = new lib.RoomViewerRenderer();
      document.body.append(viewer.canvas);
      try {
        let start = performance.now();
        await viewer.setSnapshot(snapshot, reader);
        perf[`3d-${name}-prepareMs`] = performance.now() - start;
        start = performance.now();
        viewer.render(1200, 800, view, 'after');
        wait(viewer.canvas);
        perf[`3d-${name}-firstFrameMs`] = performance.now() - start;
        const frame = () => {
          const times: number[] = [];
          for (let i = 0; i < 15; i++) {
            start = performance.now();
            viewer.render(1200, 800, view, 'after');
            wait(viewer.canvas);
            times.push(performance.now() - start);
          }
          return median(times);
        };
        perf[`3d-${name}-frameMs`] = frame();
        const cache = (
          viewer as unknown as { tiles: { atlases: Map<string, Promise<{ texture: AtlasTexture }>> } }
        ).tiles;
        const textures = (await Promise.all([...cache.atlases.values()])).map((a) => a.texture);
        const anisotropy = Math.max(...textures.map((t) => t.anisotropy ?? 1));
        perf[`3d-${name}-anisotropy`] = anisotropy;
        if (anisotropy > 1) {
          setAnisotropy(textures, 1);
          viewer.render(1200, 800, view, 'after');
          wait(viewer.canvas);
          perf[`3d-${name}-frameMsNoAnisotropy`] = frame();
          setAnisotropy(textures, anisotropy);
        }
      } finally {
        viewer.dispose();
        viewer.canvas.remove();
      }
    }
    const probe = document.createElement('canvas').getContext('webgl2')!;
    const info = probe.getExtension('WEBGL_debug_renderer_info');
    const gpuName = info ? String(probe.getParameter(info.UNMASKED_RENDERER_WEBGL)) : 'unknown';
    const aniso = probe.getExtension('EXT_texture_filter_anisotropic');
    perf.maxAnisotropy = aniso ? Number(probe.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)) : 1;
    return { cases: out, perf, gpuName };
  });
} finally {
  await browser.close();
}

// ---- Node: write the images, measure, compare with the baseline. ----
type Raw = { width: number; height: number; data: Buffer };
const decode = async (url: string): Promise<Raw> => {
  const { data, info } = await sharp(Buffer.from(url.split(',')[1], 'base64'))
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data };
};
type Mask = { width: number; height: number; walls: Set<number>; data: Uint8Array };
const decodeMask = (value: string): Mask => {
  const [size, walls, data] = value.split(':');
  const [width, height] = size.split('x').map(Number);
  return {
    width,
    height,
    walls: new Set(walls ? walls.split(',').map(Number) : []),
    data: new Uint8Array(Buffer.from(data, 'base64')),
  };
};
/** Grows a 0/1 mask by a square of r pixels. */
const grow = (mask: Uint8Array, width: number, height: number, r: number) => {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx,
            yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < width && yy < height) out[yy * width + xx] = 1;
        }
    }
  return out;
};
const linear = (v: number) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const encode = (v: number) => Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055));
/** Mean colour (averaged in linear light) and mean linear luminance over a mask. */
const meanColor = (image: Raw, mask: Uint8Array) => {
  const sum = [0, 0, 0];
  let n = 0;
  for (let i = 0; i < mask.length; i++)
    if (mask[i]) {
      for (let c = 0; c < 3; c++) sum[c] += linear(image.data[i * 3 + c]);
      n++;
    }
  const lin = sum.map((s) => s / Math.max(1, n));
  return {
    rgb: lin.map(encode) as Rgb,
    luminance: 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2],
    pixels: n,
  };
};
const meanAbs = (a: Raw, b: Raw, mask: Uint8Array) => {
  let sum = 0,
    n = 0;
  for (let i = 0; i < mask.length; i++)
    if (mask[i]) {
      for (let c = 0; c < 3; c++) sum += Math.abs(a.data[i * 3 + c] - b.data[i * 3 + c]);
      n += 3;
    }
  return sum / Math.max(1, n);
};
/** The largest |2p − p₋ − p₊| along x and y where all three pixels are inside the mask. */
const secondDifference = (image: Raw, mask: Uint8Array) => {
  let max = 0;
  const { width, height, data } = image;
  for (let y = 1; y < height - 1; y++)
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      if (!mask[i]) continue;
      for (const step of [1, width])
        if (mask[i - step] && mask[i + step])
          for (let c = 0; c < 3; c++)
            max = Math.max(
              max,
              Math.abs(2 * data[i * 3 + c] - data[(i - step) * 3 + c] - data[(i + step) * 3 + c]),
            );
    }
  return max;
};
const VARIANTS: Rgb[] = [
  [0xd2, 0x3c, 0x32],
  [0x3c, 0xa0, 0x46],
  [0x32, 0x50, 0xc8],
  [0xd2, 0xb4, 0x32],
];
/** 2D wall pixels farther than ΔE2000 2 from all four variant colours (the tile is drawn unlit). */
const mixedVariants = (image: Raw, mask: Uint8Array) => {
  let mixed = 0,
    total = 0;
  for (let i = 0; i < mask.length; i++)
    if (mask[i]) {
      total++;
      const p: Rgb = [image.data[i * 3], image.data[i * 3 + 1], image.data[i * 3 + 2]];
      if (Math.min(...VARIANTS.map((v) => deltaE2000(p, v))) > 2) mixed++;
    }
  return { mixed, total };
};
/** Wall pixels whose whole (2r+1)² neighbourhood is the same wall: no corner, edge or other face. */
const wallInterior = (mask: Mask, r: number) => {
  const { width, height, data, walls } = mask;
  const out = new Uint8Array(data.length);
  for (let y = r; y < height - r; y++)
    for (let x = r; x < width - r; x++) {
      const label = data[y * width + x];
      if (!walls.has(label)) continue;
      let same = true;
      for (let dy = -r; dy <= r && same; dy++)
        for (let dx = -r; dx <= r; dx++)
          if (data[(y + dy) * width + x + dx] !== label) {
            same = false;
            break;
          }
      out[y * width + x] = same ? 1 : 0;
    }
  return out;
};

const STRIPED = new Set(['h3', 'h5', 'h8', 'v5', 'bw8', 'bricks']);
const SEAMLESS = new Set(['solid', 'gradient']);
const PLAIN = new Set(['solid', 'plain']);
type Metrics = Record<string, Record<string, number>>;
const metrics: Metrics = {};
const errors = [...pageErrors];
for (const [name, entry] of Object.entries(result.cases)) {
  errors.push(...entry.errors.map((e) => `${name}: ${e}`));
  for (const [key, url] of Object.entries(entry.images))
    await writeFile(`${output}/${key}.png`, Buffer.from(url.split(',')[1], 'base64'));
  for (const [key, value] of Object.entries(entry.masks)) {
    const mask = decodeMask(value);
    await sharp(Buffer.from(mask.data), { raw: { width: mask.width, height: mask.height, channels: 1 } })
      .png()
      .toFile(`${output}/${key}-mask.png`);
  }
}
// The tile measurements use the editor-size image and its 3× reference, inside wall faces shrunk by
// 3 px (the face edge and the reduction's border are not the texture).
for (const [name, entry] of Object.entries(result.cases)) {
  for (const renderer of ['2d', '3d']) {
    const key = `${name}-${renderer}`;
    if (!entry.images[key] || !entry.images[key + '-ref'] || !entry.masks[key]) continue;
    const small = await decode(entry.images[key]);
    const ref = await decode(entry.images[key + '-ref']);
    const mask = decodeMask(entry.masks[key]);
    const inside = wallInterior(mask, 3);
    const m: Record<string, number> = {
      aliasing: meanAbs(small, ref, inside),
      meanLuminance: meanColor(small, inside).luminance,
      refLuminance: meanColor(ref, inside).luminance,
      pixels: meanColor(small, inside).pixels,
    };
    const mean = meanColor(small, inside).rgb;
    [m.meanR, m.meanG, m.meanB] = mean;
    if (SEAMLESS.has(name)) m.secondDifference = secondDifference(small, inside);
    if (name === 'variants' && renderer === '2d') {
      const v = mixedVariants(small, inside);
      m.variantMixed = v.mixed;
      m.variantTotal = v.total;
    }
    metrics[key] = m;
  }
}
await writeFile(
  `${output}/metrics.json`,
  JSON.stringify({ label, gpu, gpuName: result.gpuName, perf: result.perf, metrics }, null, 2),
);

const rows: string[] = [];
const failures: string[] = [];
if (label !== 'baseline') {
  if (!existsSync(`${baselineDir}/metrics.json`)) throw new Error(`기준이 없어요: ${baselineDir}`);
  const base = JSON.parse(await readFile(`${baselineDir}/metrics.json`, 'utf8')) as {
    metrics: Metrics;
    perf: Record<string, number>;
  };
  for (const [key, m] of Object.entries(metrics)) {
    const b = base.metrics[key];
    if (!b) continue;
    const name = key.split('-')[0];
    const notes: string[] = [];
    if (STRIPED.has(name)) {
      const ok = m.aliasing <= b.aliasing * 0.5;
      notes.push(`aliasing ${b.aliasing.toFixed(2)} → ${m.aliasing.toFixed(2)}${ok ? '' : ' FAIL'}`);
      if (!ok) failures.push(`${key}: 깨짐이 절반 이하로 줄지 않음`);
    }
    if (SEAMLESS.has(name)) {
      // 3D light and 8-bit rounding alone give up to 3 on the old code, which has no seam lines.
      const ok = m.secondDifference <= Math.max(2, b.secondDifference);
      notes.push(`second difference ${b.secondDifference} → ${m.secondDifference}${ok ? '' : ' FAIL'}`);
      if (!ok) failures.push(`${key}: 이음매 줄(2차 차분 ${m.secondDifference})`);
    }
    if (PLAIN.has(name)) {
      const d = deltaE2000([b.meanR, b.meanG, b.meanB], [m.meanR, m.meanG, m.meanB]);
      notes.push(`face mean ΔE2000 ${d.toFixed(2)}${d <= 1 ? '' : ' FAIL'}`);
      if (d > 1) failures.push(`${key}: 무늬 없는 타일의 면 평균 ΔE ${d.toFixed(2)}`);
    }
    if (name === 'variants' && key.endsWith('2d')) {
      const ok = m.variantMixed <= b.variantMixed;
      notes.push(
        `pixels off the four colours ${b.variantMixed} → ${m.variantMixed} of ${m.variantTotal}${ok ? '' : ' FAIL'}`,
      );
      if (!ok) failures.push(`${key}: 변형 색 섞임 ${b.variantMixed} → ${m.variantMixed}`);
    }
    if (name === 'variants') {
      const mask = decodeMask(result.cases.variants.masks[key]);
      const inside = wallInterior(mask, 3);
      const now = await decode(result.cases.variants.images[key]);
      const { data } = await sharp(`${baselineDir}/${key}.png`)
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      let over = 0;
      for (let i = 0; i < inside.length; i++)
        if (inside[i] && [0, 1, 2].some((c) => Math.abs(now.data[i * 3 + c] - data[i * 3 + c]) > 3)) over++;
      notes.push(`pixels over 3/255 from the baseline ${over}${over ? ' FAIL' : ''}`);
      if (over) failures.push(`${key}: 변형 색이 기준과 다른 픽셀 ${over}개(이웃 칸 섞임)`);
    }
    notes.push(
      `luminance ${b.meanLuminance.toFixed(4)} → ${m.meanLuminance.toFixed(4)} (3× reference ${m.refLuminance.toFixed(4)})`,
    );
    rows.push(`${key.padEnd(16)} ${notes.join('; ')}`);
  }
  // Outside the tile faces nothing may change: every image with a mask, against the baseline's.
  for (const [name, entry] of Object.entries(result.cases))
    for (const key of Object.keys(entry.images)) {
      const maskKey = key.endsWith('-ai') ? key.replace(/-ai$/, '') : key.endsWith('-ref') ? undefined : key;
      if (!maskKey || !entry.masks[maskKey]) continue;
      const baseFile = `${baselineDir}/${key}.png`;
      if (!existsSync(baseFile)) {
        rows.push(`${key.padEnd(16)} no baseline image`);
        continue;
      }
      const mask = decodeMask(entry.masks[maskKey]);
      const now = await decode(entry.images[key]);
      const { data, info } = await sharp(baseFile).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      if (info.width !== now.width || info.height !== now.height || mask.width !== now.width) {
        failures.push(`${key}: 크기가 다름`);
        continue;
      }
      const tiles = grow(
        Uint8Array.from(mask.data, (l) => (l > 0 && l < 255 ? 1 : 0)),
        mask.width,
        mask.height,
        2,
      );
      let changed = 0,
        outside = 0,
        maxInside = 0;
      for (let i = 0; i < tiles.length; i++) {
        let diff = 0;
        for (let c = 0; c < 3; c++) diff = Math.max(diff, Math.abs(now.data[i * 3 + c] - data[i * 3 + c]));
        if (tiles[i]) maxInside = Math.max(maxInside, diff);
        else {
          outside++;
          if (diff) changed++;
        }
      }
      rows.push(`${key.padEnd(16)} outside ${outside} px, changed ${changed}; inside max diff ${maxInside}`);
      if (changed) failures.push(`${key}: 타일 밖 픽셀 ${changed}개가 바뀜`);
      void name;
    }
  for (const key of Object.keys(result.perf))
    if (key in base.perf)
      rows.push(
        `perf ${key.padEnd(28)} ${Number(base.perf[key]).toFixed(2)} → ${Number(result.perf[key]).toFixed(2)}`,
      );
}
console.log(rows.join('\n'));
console.log(JSON.stringify({ output, gpuName: result.gpuName, perf: result.perf }, null, 2));
if (errors.length) throw new Error('렌더 오류:\n' + errors.join('\n'));
if (failures.length) throw new Error('실패:\n' + failures.join('\n'));
console.log(label === 'baseline' ? `기준을 ${output}에 저장했어요.` : '모두 통과했어요.');
