/**
 * Render-realism capture: authored tile/fixture scenes through the real room viewer and compositor.
 * Writes images plus colour/timing metrics to test-results/render-realism/<label>/. Not AI inference.
 * Usage: node tests/run-browser-test.mjs tests/render-realism-browser.ts <label>
 */
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const label = process.argv[3] ?? 'baseline';
// Optional comma-separated scene names for quicker tuning runs; the full set is the default.
const only = process.argv[4]?.split(',').filter(Boolean) ?? [];
if (!/^[a-z0-9-]+$/.test(label)) throw new Error('label must be lowercase letters, digits or dashes');
const output = `test-results/render-realism/${label}`;
await mkdir(output, { recursive: true });

type Rgb = [number, number, number];
type SceneResult = {
  name: string;
  images: Record<string, string>;
  samples: Record<string, { rendered: Rgb; reference: Rgb }>;
  viewerMs: number[];
  compositorMs: number[];
  comparePanelMaxDifference: number;
  viewerPrepareMs: number;
  notices: string[];
};

// CIEDE2000 on sRGB 8-bit colours (D65).
function lab([r, g, b]: Rgb): Rgb {
  const linear = [r, g, b].map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const x = (0.4124564 * linear[0] + 0.3575761 * linear[1] + 0.1804375 * linear[2]) / 0.95047;
  const y = 0.2126729 * linear[0] + 0.7151522 * linear[1] + 0.072175 * linear[2];
  const z = (0.0193339 * linear[0] + 0.119192 * linear[1] + 0.9503041 * linear[2]) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 / 116) * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}
function deltaE2000(a: Rgb, b: Rgb): number {
  const [L1, a1, b1] = lab(a),
    [L2, a2, b2] = lab(b);
  const rad = Math.PI / 180;
  const C1 = Math.hypot(a1, b1),
    C2 = Math.hypot(a2, b2),
    Cm = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cm ** 7 / (Cm ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1,
    a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1),
    C2p = Math.hypot(a2p, b2);
  const h = (x: number, y: number) => {
    const angle = Math.atan2(y, x) / rad;
    return angle < 0 ? angle + 360 : angle;
  };
  const h1p = h(a1p, b1),
    h2p = h(a2p, b2);
  const dLp = L2 - L1,
    dCp = C2p - C1p;
  let dhp = h2p - h1p;
  if (C1p * C2p === 0) dhp = 0;
  else if (dhp > 180) dhp -= 360;
  else if (dhp < -180) dhp += 360;
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * rad);
  const Lm = (L1 + L2) / 2,
    Cmp = (C1p + C2p) / 2;
  let hm = h1p + h2p;
  if (C1p * C2p !== 0) hm = Math.abs(h1p - h2p) <= 180 ? hm / 2 : hm < 360 ? (hm + 360) / 2 : (hm - 360) / 2;
  const T =
    1 -
    0.17 * Math.cos((hm - 30) * rad) +
    0.24 * Math.cos(2 * hm * rad) +
    0.32 * Math.cos((3 * hm + 6) * rad) -
    0.2 * Math.cos((4 * hm - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hm - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cmp ** 7 / (Cmp ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lm - 50) ** 2) / Math.sqrt(20 + (Lm - 50) ** 2);
  const Sc = 1 + 0.045 * Cmp,
    Sh = 1 + 0.015 * Cmp * T;
  const Rt = -Math.sin(2 * dTheta * rad) * Rc;
  return Math.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh));
}

const bundle = await build({
  stdin: {
    contents: `export * from './src/lib/room-viewer/renderer';export * from './src/lib/room-viewer/view-state';export {PhotoCompositor} from './src/lib/render/compositor';export {renderRoomBackground} from './src/lib/room-background';export {createRoomSurfaces,DEFAULT_ROOM} from './src/lib/room-geometry';`,
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
  args: [
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
  ],
});
try {
  const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (e) => {
    if (e.type() === 'error') errors.push(e.text());
  });
  await page.route('http://127.0.0.1:43199/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<html><body style="margin:0"></body></html>' }),
  );
  await page.goto('http://127.0.0.1:43199/');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const results = await page.evaluate(async (only: string[]): Promise<SceneResult[]> => {
    type MaterialVersion = import('../src/lib/types').MaterialVersion;
    type Scene = import('../src/lib/types').Scene;
    type AssetRecord = import('../src/lib/types').AssetRecord;
    type FixtureInstance = import('../src/lib/types').FixtureInstance;
    const lib = (
      window as unknown as {
        Realism: typeof import('../src/lib/room-viewer/renderer') &
          typeof import('../src/lib/room-viewer/view-state') &
          typeof import('../src/lib/render/compositor') &
          typeof import('../src/lib/room-background') &
          typeof import('../src/lib/room-geometry');
      }
    ).Realism;
    const room = structuredClone(lib.DEFAULT_ROOM);
    const color = { exposure: 0, contrast: 1, saturation: 1, warmth: 0 };
    const empty = () => ({ polygon: [], strokes: [] });
    const assets: Record<string, AssetRecord> = {};
    const hex = (value: string): [number, number, number] => [
      parseInt(value.slice(1, 3), 16),
      parseInt(value.slice(3, 5), 16),
      parseInt(value.slice(5, 7), 16),
    ];
    const flat = async (id: string, fill: string) => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 64;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = fill;
      ctx.fillRect(0, 0, 64, 64);
      const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!)));
      assets[id] = {
        id,
        ownerId: 'test',
        name: id,
        mime: 'image/png',
        size: blob.size,
        width: 64,
        height: 64,
        kind: 'texture',
        blob,
        createdAt: '2026-09-24',
      };
    };
    const tiles = {
      white: { fill: '#ecebe6', w: 300, h: 600, finish: '무광' },
      gray: { fill: '#8e8b85', w: 600, h: 600, finish: '무광' },
      navy: { fill: '#243a5a', w: 300, h: 600, finish: '유광' },
      cream: { fill: '#d8cbb5', w: 600, h: 600, finish: '폴리싱' },
      teal: { fill: '#5f8c95', w: 25, h: 25, finish: '유광' },
      charcoal: { fill: '#3d3d3f', w: 100, h: 100, finish: '무광' },
    } as const;
    const materials: Record<string, MaterialVersion> = {};
    for (const [id, tile] of Object.entries(tiles)) {
      await flat(id, tile.fill);
      materials[id] = {
        id,
        materialId: id,
        version: 1,
        name: id,
        brand: '',
        code: '',
        category: 'tile',
        scope: 'personal',
        description: '',
        color: tile.fill,
        finish: tile.finish,
        widthMm: tile.w,
        heightMm: tile.h,
        depthMm: 9,
        usage: 'both',
        installation: 'wall',
        textureAssetIds: [id],
        views: [],
        defaultGroutWidth: 2,
        defaultGroutColor: '#dddddd',
        defaultPattern: 'grid',
        createdAt: '2026-09-24',
      };
    }
    materials.standard = { ...materials.white, id: 'standard', materialId: 'standard', category: 'toilet' };
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
      createdAt: '2026-09-24',
    };
    type Finish = { id: keyof typeof tiles; grout: number; groutColor: string; pattern?: 'grid' | 'brick' };
    const fixture = (
      id: string,
      kind: string,
      face: 'floor' | 'back',
      u: number,
      v: number,
      w: number,
      h: number,
      d: number,
      base = 0,
    ): FixtureInstance => ({
      id,
      name: id,
      materialVersionId: 'standard',
      viewIndex: 0,
      position: { x: 0.5, y: 0.5 },
      width: 0.2,
      height: 0.4,
      rotation: 0,
      anchor: { x: 0.5, y: 1 },
      locked: false,
      shadow: { x: 0, y: 0, opacity: 0, blur: 0.01, scale: 1 },
      occlusion: empty(),
      color: { ...color },
      roomPlacement: {
        face,
        u,
        v,
        scale: 1,
        widthMm: w,
        heightMm: h,
        imageAspect: w / h,
        contentBounds: { left: 0, right: 1, top: 0, bottom: 1 },
      },
      reconstruction: {
        version: 2,
        kind,
        color: '#f2f1ec',
        widthMm: w,
        heightMm: h,
        depthMm: d,
        baseHeightMm: base,
        yawDegrees: 0,
      },
    });
    const scene = (
      wall: Finish,
      floor: Finish,
      extra: Partial<Pick<Scene, 'fixtures' | 'wallFeatures'>> = {},
    ): Scene => ({
      room: structuredClone(room),
      originalAssetId: 'bg',
      previewAssetId: 'bg',
      imageWidth: 3600,
      imageHeight: 2400,
      surfaces: lib.createRoomSurfaces(room, 1.5).map((s) => {
        const spec = s.roomFace === 'floor' ? floor : wall;
        return {
          ...s,
          materialVersionId: spec.id,
          tile: {
            ...s.tile,
            groutWidth: spec.grout,
            groutColor: spec.groutColor,
            pattern: spec.pattern ?? 'grid',
            seed: 11,
          },
        };
      }),
      fixtures: extra.fixtures ?? [],
      ...(extra.wallFeatures ? { wallFeatures: extra.wallFeatures } : {}),
      protection: empty(),
      color: { ...color },
    });
    const matteWall: Finish = { id: 'white', grout: 2, groutColor: '#d9d8d2' },
      matteFloor: Finish = { id: 'gray', grout: 3, groutColor: '#6f6c66' };
    const basin = fixture('basin', 'basin', 'back', 0.28, 0.62, 600, 220, 430, 800);
    basin.reconstruction!.basinVariant = 'wall';
    const scenes: {
      name: string;
      scene: Scene;
      samples: Record<string, [number, number, number, number]>;
    }[] = [
      {
        name: 'matte',
        scene: scene(matteWall, matteFloor),
        samples: { backWall: [0.42, 0.3, 0.58, 0.44], floor: [0.42, 0.84, 0.58, 0.92] },
      },
      {
        name: 'glossy',
        scene: scene(
          { id: 'navy', grout: 5, groutColor: '#f1f1ee', pattern: 'brick' },
          { id: 'cream', grout: 2, groutColor: '#cfc6b6' },
        ),
        samples: { backWall: [0.42, 0.3, 0.58, 0.44], floor: [0.42, 0.84, 0.58, 0.92] },
      },
      {
        name: 'mosaic',
        scene: scene(
          { id: 'teal', grout: 2, groutColor: '#f3f3f0' },
          { id: 'charcoal', grout: 3, groutColor: '#bdbdbd' },
        ),
        samples: {},
      },
      {
        name: 'fixtures',
        scene: scene(matteWall, matteFloor, {
          fixtures: [
            fixture('toilet', 'toilet', 'floor', 0.72, 0.28, 400, 750, 680),
            basin,
            fixture('mirror', 'mirror', 'back', 0.28, 0.25, 700, 550, 30, 1300),
            fixture('bath', 'bath', 'floor', 0.3, 0.3, 750, 520, 1500),
          ],
        }),
        samples: {},
      },
      {
        name: 'features',
        scene: scene(matteWall, matteFloor, {
          wallFeatures: [
            {
              version: 1,
              id: '6f1d2c3b-4a5e-4f60-8a71-92b3c4d5e6f7',
              kind: 'closed-niche',
              face: 'back',
              leftMm: 1300,
              topMm: 1000,
              widthMm: 600,
              heightMm: 400,
              depthMm: 150,
              source: 'user',
            },
          ],
        }),
        samples: {},
      },
    ];
    const reader = async (id: string) => assets[id];
    const median = (data: Uint8ClampedArray, width: number, height: number, r: number[]) => {
      const channels: number[][] = [[], [], []];
      for (let y = Math.round(r[1] * height); y < Math.round(r[3] * height); y++)
        for (let x = Math.round(r[0] * width); x < Math.round(r[2] * width); x++)
          for (let c = 0; c < 3; c++) channels[c].push(data[(y * width + x) * 4 + c]);
      return channels.map((values) => values.sort((a, b) => a - b)[values.length >> 1]) as [
        number,
        number,
        number,
      ];
    };
    const pixels = (canvas: HTMLCanvasElement) => {
      const copy = document.createElement('canvas');
      copy.width = canvas.width;
      copy.height = canvas.height;
      const ctx = copy.getContext('2d')!;
      ctx.drawImage(canvas, 0, 0);
      return ctx.getImageData(0, 0, copy.width, copy.height).data;
    };
    const detail = [0.36, 0.28, 0.64, 0.56];
    const crop = (source: HTMLCanvasElement | ImageBitmap, rect: number[]) => {
      const x = Math.round(rect[0] * source.width),
        y = Math.round(rect[1] * source.height);
      const copy = document.createElement('canvas');
      copy.width = Math.round((rect[2] - rect[0]) * source.width);
      copy.height = Math.round((rect[3] - rect[1]) * source.height);
      copy.getContext('2d')!.drawImage(source, x, y, copy.width, copy.height, 0, 0, copy.width, copy.height);
      return copy.toDataURL('image/png');
    };
    const out: SceneResult[] = [];
    for (const entry of scenes.filter((s) => !only.length || only.includes(s.name))) {
      const images: Record<string, string> = {};
      const samples: SceneResult['samples'] = {};
      const snapshot = { scene: entry.scene, beforeScene: structuredClone(entry.scene), materials };
      const prepareStart = performance.now();
      const viewer = new lib.RoomViewerRenderer();
      document.body.append(viewer.canvas);
      const viewerMs: number[] = [];
      let comparePanelMaxDifference = 0;
      let notices: string[] = [];
      let viewerPrepareMs = 0;
      try {
        await viewer.setSnapshot(snapshot, reader);
        viewerPrepareMs = performance.now() - prepareStart;
        notices = viewer.notices.filter((n) => n.severity === 'error').map((n) => n.name + ': ' + n.message);
        const base = lib.defaultRoomView();
        const views: [string, import('../src/lib/room-viewer/view-state').RoomViewState][] = [
          ['front', base],
          ['right', lib.rotateRoomView(base, 'right')],
          ['left', lib.rotateRoomView(base, 'left')],
          ['up', lib.rotateRoomView(base, 'up')],
          ['down', lib.rotateRoomView(base, 'down')],
        ];
        for (const [name, view] of views) {
          viewer.render(900, 600, view, 'after');
          images['viewer-' + name] = viewer.canvas.toDataURL('image/png');
          if (name === 'front') {
            const data = pixels(viewer.canvas);
            for (const [region, rect] of Object.entries(entry.samples)) {
              const surface = entry.scene.surfaces.find((s) =>
                region === 'floor' ? s.roomFace === 'floor' : s.roomFace === 'back',
              )!;
              samples['viewer-' + region] = {
                rendered: median(data, viewer.canvas.width, viewer.canvas.height, rect),
                reference: hex(materials[surface.materialVersionId!].color),
              };
            }
          }
        }
        const sync = new Uint8Array(4);
        for (let i = 0; i < 8; i++) {
          const start = performance.now();
          viewer.render(900, 600, base, 'after');
          // Reading a pixel waits for the GPU, so this is frame time rather than command submission.
          (viewer.canvas.getContext('webgl2') as WebGL2RenderingContext).readPixels(
            0,
            0,
            1,
            1,
            WebGL2RenderingContext.RGBA,
            WebGL2RenderingContext.UNSIGNED_BYTE,
            sync,
          );
          viewerMs.push(performance.now() - start);
        }
        viewer.render(1200, 400, base, 'compare');
        const data = pixels(viewer.canvas),
          width = viewer.canvas.width,
          half = width / 2;
        for (let y = 0; y < viewer.canvas.height; y++)
          for (let x = 0; x < half; x++)
            for (let c = 0; c < 3; c++)
              comparePanelMaxDifference = Math.max(
                comparePanelMaxDifference,
                Math.abs(data[(y * width + x) * 4 + c] - data[(y * width + x + half) * 4 + c]),
              );
        images['viewer-compare'] = viewer.canvas.toDataURL('image/png');
        // Export-size detail of the back wall: grout relief is sub-pixel at preview size by design.
        images['viewer-detail'] = crop(viewer.render(3600, 2400, base, 'after'), detail);
      } finally {
        viewer.dispose();
        viewer.canvas.remove();
      }
      const compositor = new lib.PhotoCompositor();
      const compositorMs: number[] = [];
      try {
        await compositor.setSnapshot(snapshot, reader);
        const exported = await createImageBitmap(
          await compositor.exportImage(snapshot, 3600, 2400, 'image/png', false),
        );
        images['compositor-detail'] = crop(exported, detail);
        exported.close();
        const canvas = compositor.render(1200, 800, 'after');
        images.compositor = canvas.toDataURL('image/png');
        const data = pixels(canvas);
        for (const [region, rect] of Object.entries(entry.samples)) {
          const surface = entry.scene.surfaces.find((s) =>
            region === 'floor' ? s.roomFace === 'floor' : s.roomFace === 'back',
          )!;
          samples['compositor-' + region] = {
            rendered: median(data, canvas.width, canvas.height, rect),
            reference: hex(materials[surface.materialVersionId!].color),
          };
        }
        const sync = new Uint8Array(4);
        for (let i = 0; i < 5; i++) {
          const start = performance.now();
          const frame = compositor.render(1200, 800, 'after');
          (frame.getContext('webgl2') as WebGL2RenderingContext).readPixels(
            0,
            0,
            1,
            1,
            WebGL2RenderingContext.RGBA,
            WebGL2RenderingContext.UNSIGNED_BYTE,
            sync,
          );
          compositorMs.push(performance.now() - start);
        }
      } finally {
        compositor.dispose();
      }
      out.push({
        name: entry.name,
        images,
        samples,
        viewerMs,
        compositorMs,
        comparePanelMaxDifference,
        viewerPrepareMs,
        notices,
      });
    }
    return out;
  }, only);
  assert.deepEqual(errors, [], errors.join('\n'));
  const summary: Record<string, unknown> = {};
  for (const scene of results) {
    for (const [name, url] of Object.entries(scene.images))
      await writeFile(`${output}/${scene.name}-${name}.png`, Buffer.from(url.split(',')[1], 'base64'));
    const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);
    summary[scene.name] = {
      deltaE2000: Object.fromEntries(
        Object.entries(scene.samples).map(([region, sample]) => [
          region,
          { ...sample, deltaE: Number(deltaE2000(sample.rendered, sample.reference).toFixed(2)) },
        ]),
      ),
      viewerRenderMs: { mean: Number(mean(scene.viewerMs).toFixed(1)), max: Math.max(...scene.viewerMs) },
      compositorRenderMs: {
        mean: Number(mean(scene.compositorMs).toFixed(1)),
        max: Math.max(...scene.compositorMs),
      },
      comparePanelMaxDifference: scene.comparePanelMaxDifference,
      viewerPrepareMs: Number(scene.viewerPrepareMs.toFixed(1)),
      errorNotices: scene.notices,
    };
  }
  const report = {
    label,
    conditions: 'Chrome headless, ANGLE SwiftShader; authored flat-colour tiles; DEFAULT_ROOM 2400mm cube',
    userAgent: await page.evaluate(() => navigator.userAgent),
    summary,
  };
  await writeFile(`${output}/metrics.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, summary }, null, 2));
} finally {
  await browser.close();
}
