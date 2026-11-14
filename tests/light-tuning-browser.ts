/**
 * The light-tuning measurement (docs/light-tuning-results-20261114.md; no AI call): public tiles of the
 * 2026-11-02 snapshot drawn by the app's own renderers, and how readable their joints and printed lines
 * are. Each scene is drawn three ways:
 *   - capture: the AI input (3D, outside orbit from the front, white backdrop, 1024 px)
 *   - inside: the 3D viewer's default in-room view (1200 × 800), as a room with wall features shows it
 *   - editor / download: the 2D compositor at editor size (1200 × 800) and at the scene's own size,
 *     as a plain room is edited and downloaded
 * Per wall and floor: `detail` (mean |luminance − its 3 px-scale blur|: what joints and lines add),
 * `spread` (p95 − p5 of the broad light), `clip` (share of pixels at 254+) and the median colour.
 *
 * A variant changes constants of the app's sources while bundling (the app files stay as they are);
 * see VARIANTS. The candidates were written against the code before the 2026-11-14 change (704337e);
 * after it, `app` draws the code as it is and the candidates' texts are no longer found. `--variants base,L1,…` draws each into test-results/light-tuning/<variant>/.
 *
 * Usage: node tests/run-browser-test.mjs tests/light-tuning-browser.ts --variants base,L1 [--gpu]
 *          [--only scored,subway] [--views capture,inside,editor,download]
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { build, type Plugin } from 'esbuild';
import sharp from 'sharp';
import type { PublicRecord } from './export-photoreal/scene-builder';
import { ROOT, SNAPSHOT } from './tile-ai/paths.mjs';
import { SPECS, TILES, type TileSpec } from './tile-ai/specs';

const arg = (name: string, fallback = '') => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const gpu = process.argv.includes('--gpu');
const only = arg('only').split(',').filter(Boolean);
const views = arg('views', 'capture,inside,editor,download').split(',').filter(Boolean);
const OUT = join(ROOT as string, 'test-results', 'light-tuning');

type Patch = [file: string, from: string, to: string];
const LIGHT = 'src/lib/render/realistic-lighting.ts',
  SURFACES = 'src/lib/room-viewer/surfaces.ts',
  COMPOSITOR = 'src/lib/render/compositor.ts';
/** Each candidate as exact source replacements (a missing text stops the run). */
export const VARIANTS: Record<string, Patch[]> = {
  base: [],
  // L1: the environment's bright camera side and ceiling panel, which glossy tiles mirror.
  L1: [
    [LIGHT, 'new Color(1, 1, 1).multiplyScalar(2.15)', 'new Color(1, 1, 1).multiplyScalar(1.3)'],
    [LIGHT, 'new Color(1, 1, 1).multiplyScalar(3) })', 'new Color(1, 1, 1).multiplyScalar(2) })'],
  ],
  // L1b: glossy tiles' reflections weaker still (0.6 → 0.35).
  L1b: [
    [
      SURFACES,
      'reflectedLight.directSpecular*=.6;reflectedLight.indirectSpecular*=.6;',
      'reflectedLight.directSpecular*=.35;reflectedLight.indirectSpecular*=.35;',
    ],
  ],
  // L2: less of the ceiling downlight, more even bounce (the floor centre stays near its level).
  L2: [
    [LIGHT, 'const CEILING_LIGHT = 0.44;', 'const CEILING_LIGHT = 0.32;'],
    [LIGHT, 'const BOUNCE = 0.58;', 'const BOUNCE = 0.66;'],
  ],
  // L3: the tone curve starts compressing at 0.88 instead of 0.76 (Khronos Neutral, same shape).
  L3: [
    [
      LIGHT,
      'if(peak<.76)return color;\n  float mapped=1.-.0576/(peak-.52);',
      'if(peak<.88)return color;\n  float mapped=1.-.0144/(peak-.76);',
    ],
  ],
  // L3b: all light 9% lower, so white sits below the compression.
  L3b: [
    [LIGHT, 'const CEILING_LIGHT = 0.44;', 'const CEILING_LIGHT = 0.4;'],
    [LIGHT, 'const BOUNCE = 0.58;', 'const BOUNCE = 0.53;'],
  ],
  // D1: the 2D photo light's bright end 1.6 → 1.25.
  D1: [
    [
      COMPOSITOR,
      'float light=clamp(luminance/max(meanLuminance,.015),.18,1.6);',
      'float light=clamp(luminance/max(meanLuminance,.015),.18,1.25);',
    ],
  ],
  // D1b: a soft shoulder above linear 0.8 in 2D, so white tiles do not clip at 255.
  D1b: [
    [
      COMPOSITOR,
      'result=adjustColor(result,adjustment);\n  gl_FragColor=vec4(mix(background.rgb,result,amount),1.);',
      'result=adjustColor(result,adjustment);\n  result=mix(result,.8+.2*(1.-exp(-(result-.8)/.2)),step(.8,result));\n  gl_FragColor=vec4(mix(background.rgb,result,amount),1.);',
    ],
  ],
  // D2: the 2D glossy sheen 0.25 → 0.1.
  D2: [
    [
      COMPOSITOR,
      'result+=vec3(gloss*shading*.25*max(0.,light-1.));',
      'result+=vec3(gloss*shading*.1*max(0.,light-1.));',
    ],
  ],
  // J1: a joint is drawn at least 0.8 px wide where a tile is 6 px or more (3–6 px: fading in).
  J1: [
    [
      SURFACES,
      'vec2 coverage=clamp((sjnGrout*.5-d+aa*.5)/aa,0.,1.)-clamp((-sjnGrout*.5-d+aa*.5)/aa,0.,1.);',
      'vec2 sjnShown=max(vec2(sjnGrout),.8*aa*clamp((sjnTile/aa-3.)/3.,0.,1.));vec2 coverage=clamp((sjnShown*.5-d+aa*.5)/aa,0.,1.)-clamp((-sjnShown*.5-d+aa*.5)/aa,0.,1.);',
    ],
    [
      COMPOSITOR,
      'vec2 seamCoverage=clamp((groutWidth*.5-seamDistance+aa*.5)/aa,0.,1.)-clamp((-groutWidth*.5-seamDistance+aa*.5)/aa,0.,1.);',
      'vec2 shownWidth=max(vec2(groutWidth),.8*aa*clamp((tileSize/aa-3.)/3.,0.,1.));vec2 seamCoverage=clamp((shownWidth*.5-seamDistance+aa*.5)/aa,0.,1.)-clamp((-shownWidth*.5-seamDistance+aa*.5)/aa,0.,1.);',
    ],
  ],
};
// app: the app's sources as they are now (after the change); `base` is the code before it (2026-11-14).
VARIANTS.app = [];
// J1b: as J1 at 1 px.
VARIANTS.J1b = VARIANTS.J1.map(([file, from, to]) => [file, from, to.replace('.8*aa', '1.*aa')]);
/** `A+B` joins variants. */
const patchesOf = (variant: string): Patch[] =>
  variant.split('+').flatMap((part) => {
    const patches = VARIANTS[part];
    if (!patches) throw new Error(`unknown variant ${part}`);
    return patches;
  });
const patching = (patches: Patch[]): Plugin => ({
  name: 'light-variant',
  setup(builder) {
    const files = [...new Set(patches.map(([file]) => resolve(file).toLowerCase()))];
    builder.onLoad({ filter: /\.ts$/ }, (args) => {
      if (!files.includes(resolve(args.path).toLowerCase())) return undefined;
      let contents = readFileSync(args.path, 'utf8').replace(/\r\n/g, '\n');
      for (const [file, from, to] of patches) {
        if (resolve(file).toLowerCase() !== resolve(args.path).toLowerCase()) continue;
        if (!contents.includes(from)) throw new Error(`${file}: text not found: ${from.slice(0, 60)}`);
        contents = contents.replace(from, to);
      }
      return { contents, loader: 'ts' };
    });
  },
});

const catalog = JSON.parse(readFileSync(join(SNAPSHOT as string, 'catalog.json'), 'utf8')) as {
  placements: (PublicRecord & { materialId: string; textureAssetIds: string[] })[];
};
const records = Object.fromEntries(catalog.placements.map((p) => [p.materialId, p]));
const imageFiles = Object.fromEntries(
  readdirSync(join(SNAPSHOT as string, 'images')).map((f) => [f.replace(/\.[a-z]+$/, ''), f]),
);
/** The scenes: the tile trial's (the held-out two too) and a plain white matte room. */
const scenes: TileSpec[] = [
  ...SPECS.filter((spec) =>
    ['scored', 'subway', 'beige', 'marble', 'charcoal', 'accent', 'roman'].includes(spec.id),
  ),
  {
    ...SPECS.find((spec) => spec.id === 'beige')!,
    id: 'white',
    label: '흰 무광 600 × 300',
    wall: TILES.white,
  },
].filter((spec) => !only.length || only.includes(spec.id));
/** A tile's own average colour (sRGB), the reference of the median colour. */
const textureMean = async (materialId: string) => {
  const file = join(SNAPSHOT as string, 'images', imageFiles[records[materialId].textureAssetIds[0]]);
  const { channels } = await sharp(file).removeAlpha().stats();
  return channels.slice(0, 3).map((c) => Math.round(c.mean)) as [number, number, number];
};

type FaceMetric = {
  key: string;
  kind: 'wall' | 'floor';
  materialId?: string;
  pixels: number;
  detail: number;
  spread: number;
  clip: number;
  median: [number, number, number];
};
const variants = arg('variants', 'base').split(',').filter(Boolean);
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: gpu
    ? ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--enable-gpu']
    : ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const ORIGIN = 'http://127.0.0.1:43243';
try {
  for (const variant of variants) {
    const bundle = await build({
      stdin: {
        contents: [
          "export * from './src/lib/room-viewer/renderer';",
          "export { defaultRoomView } from './src/lib/room-viewer/view-state';",
          "export { PhotoCompositor } from './src/lib/render/compositor';",
          "export { buildSpecScene } from './tests/export-photoreal/scene-builder';",
          "export { fluxOrbitView, FLUX_BACKDROP } from './src/lib/ai-export/view';",
        ].join(''),
        resolveDir: process.cwd(),
      },
      bundle: true,
      write: false,
      platform: 'browser',
      format: 'iife',
      globalName: 'Lib',
      plugins: [patching(patchesOf(variant))],
    });
    const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route(`${ORIGIN}/**`, async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.startsWith('/images/'))
        return route.fulfill({
          body: readFileSync(join(SNAPSHOT as string, 'images', decodeURIComponent(path.slice(8)))),
        });
      return route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' });
    });
    await page.goto(`${ORIGIN}/`);
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.evaluate((files) => {
      (window as unknown as { IMAGE_FILES: Record<string, string> }).IMAGE_FILES = files;
    }, imageFiles);
    const dir = join(OUT, variant);
    mkdirSync(dir, { recursive: true });
    const summary: Record<string, Record<string, FaceMetric[]>> = {};
    for (const spec of scenes) {
      const needed = new Set([spec.wall, spec.floor, ...(spec.regions ?? []).map((r) => r.materialId)]);
      const used = Object.fromEntries(
        [...needed].map((m) => [
          m,
          m === spec.wall && spec.wallPattern
            ? { ...records[m], defaultPattern: spec.wallPattern }
            : records[m],
        ]),
      );
      const shots = await page.evaluate(
        async ({ spec, used, views }) => {
          type Lib = typeof import('../src/lib/room-viewer/renderer') &
            typeof import('../src/lib/room-viewer/view-state') &
            typeof import('../src/lib/render/compositor') &
            typeof import('./export-photoreal/scene-builder') &
            typeof import('../src/lib/ai-export/view');
          type Mask = {
            width: number;
            height: number;
            regions: { key: string; kind: 'wall' | 'floor' }[];
            data: Uint8Array;
          };
          const lib = (window as unknown as { Lib: Lib }).Lib;
          const built = await lib.buildSpecScene(spec, used);
          const reader = async (id: string) => built.assets[id];
          const pixelsOf = async (blob: Blob) => {
            const bitmap = await createImageBitmap(blob);
            const canvas = document.createElement('canvas');
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
            const context = canvas.getContext('2d')!;
            context.drawImage(bitmap, 0, 0);
            bitmap.close();
            return context.getImageData(0, 0, canvas.width, canvas.height);
          };
          /** Box blur of a luminance plane (two passes each way). */
          const blur = (value: Float32Array, width: number, height: number, radius: number) => {
            const pass = (source: Float32Array, horizontal: boolean) => {
              const out = new Float32Array(source.length);
              const lines = horizontal ? height : width,
                length = horizontal ? width : height,
                step = horizontal ? 1 : width;
              for (let line = 0; line < lines; line++) {
                const start = horizontal ? line * width : line;
                let sum = 0,
                  n = 0;
                for (let i = 0; i < Math.min(length, radius + 1); i++) {
                  sum += source[start + i * step];
                  n++;
                }
                for (let i = 0; i < length; i++) {
                  out[start + i * step] = sum / n;
                  const enter = i + radius + 1,
                    leave = i - radius;
                  if (enter < length) {
                    sum += source[start + enter * step];
                    n++;
                  }
                  if (leave >= 0) {
                    sum -= source[start + leave * step];
                    n--;
                  }
                }
              }
              return out;
            };
            return pass(pass(pass(pass(value, true), false), true), false);
          };
          /** Per face: detail, broad-light spread, clipping and median colour, inside an eroded mask. */
          const measure = (image: ImageData, mask: Mask) => {
            const { width, height, data } = image;
            const lum = new Float32Array(width * height);
            for (let i = 0; i < lum.length; i++)
              lum[i] = 0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2];
            const fine = Math.max(1, Math.round(width / 340)),
              broad = Math.max(4, Math.round(width / 30));
            const near = blur(lum, width, height, fine),
              far = blur(lum, width, height, broad);
            const at = (x: number, y: number) =>
              mask.data[
                Math.min(mask.height - 1, Math.floor((y * mask.height) / height)) * mask.width +
                  Math.min(mask.width - 1, Math.floor((x * mask.width) / width))
              ];
            const rim = fine * 3;
            return mask.regions.flatMap((region, index) => {
              const own = index + 1;
              let n = 0,
                detail = 0,
                clip = 0;
              const light: number[] = [],
                rgb: number[][] = [[], [], []];
              for (let y = rim; y < height - rim; y += 1)
                for (let x = rim; x < width - rim; x += 1) {
                  if (at(x, y) !== own) continue;
                  if (
                    at(x - rim, y) !== own ||
                    at(x + rim, y) !== own ||
                    at(x, y - rim) !== own ||
                    at(x, y + rim) !== own
                  )
                    continue;
                  const i = y * width + x;
                  n++;
                  detail += Math.abs(lum[i] - near[i]);
                  if (Math.max(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]) >= 254) clip++;
                  if ((x + y) % 3 === 0) {
                    light.push(far[i]);
                    for (let c = 0; c < 3; c++) rgb[c].push(data[i * 4 + c]);
                  }
                }
              if (n < 200) return [];
              light.sort((a, b) => a - b);
              const median = rgb.map((values) => values.sort((a, b) => a - b)[values.length >> 1]) as [
                number,
                number,
                number,
              ];
              return [
                {
                  key: region.key,
                  kind: region.kind,
                  pixels: n,
                  detail: +(detail / n).toFixed(3),
                  spread: +(
                    light[Math.floor(light.length * 0.95)] - light[Math.floor(light.length * 0.05)]
                  ).toFixed(1),
                  clip: +((clip / n) * 100).toFixed(2),
                  median,
                },
              ];
            });
          };
          const base64 = async (blob: Blob) => {
            const bytes = new Uint8Array(await blob.arrayBuffer());
            let text = '';
            for (let i = 0; i < bytes.length; i += 0x8000)
              text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
            return btoa(text);
          };
          const out: Record<
            string,
            { image: string; faces: ReturnType<typeof measure>; surfaces: Record<string, string> }
          > = {};
          const surfaces = Object.fromEntries(
            built.snapshot.scene.surfaces.map((s) => [`surface:${s.id}`, s.materialVersionId ?? '']),
          );
          const { imageWidth: width, imageHeight: height } = built.snapshot.scene;
          if (views.includes('capture') || views.includes('inside')) {
            const viewer = new lib.RoomViewerRenderer();
            try {
              await viewer.setSnapshot(built.snapshot, reader, { background: lib.FLUX_BACKDROP });
              if (views.includes('capture')) {
                const view = lib.fluxOrbitView({ azimuth: 0, elevation: 0 });
                const edge = Math.min(1024, Math.max(width, height));
                const blob = await viewer.export(view, { format: 'png', mode: 'after', longEdge: edge });
                const image = await pixelsOf(blob);
                const mask = viewer.regionMask(image.width, image.height, view) as Mask;
                out.capture = { image: await base64(blob), faces: measure(image, mask), surfaces };
              }
            } finally {
              viewer.dispose();
            }
          }
          if (views.includes('inside')) {
            const viewer = new lib.RoomViewerRenderer();
            try {
              await viewer.setSnapshot(built.snapshot, reader);
              const view = lib.defaultRoomView();
              const blob = await viewer.export(view, { format: 'png', mode: 'after', longEdge: 1200 });
              const image = await pixelsOf(blob);
              const mask = viewer.regionMask(image.width, image.height, view) as Mask;
              out.inside = { image: await base64(blob), faces: measure(image, mask), surfaces };
            } finally {
              viewer.dispose();
            }
          }
          for (const [name, size] of [
            ['editor', [1200, 800]],
            ['download', [width, height]],
          ] as const) {
            if (!views.includes(name)) continue;
            const compositor = new lib.PhotoCompositor();
            try {
              await compositor.setSnapshot(built.snapshot, reader);
              let mask: Mask | undefined;
              const blob = await compositor.exportImage(
                built.snapshot,
                size[0],
                size[1],
                'image/png',
                false,
                (m) => {
                  mask = m as Mask;
                },
              );
              const image = await pixelsOf(blob);
              out[name] = { image: await base64(blob), faces: mask ? measure(image, mask) : [], surfaces };
            } finally {
              compositor.dispose();
            }
          }
          return out;
        },
        { spec, used, views },
      );
      if (errors.length) throw new Error(errors.join('\n'));
      summary[spec.id] = {};
      for (const [view, shot] of Object.entries(shots)) {
        writeFileSync(join(dir, `${spec.id}-${view}.png`), Buffer.from(shot.image, 'base64'));
        summary[spec.id][view] = shot.faces.map((face) => ({
          ...face,
          materialId: shot.surfaces[face.key] || undefined,
        }));
      }
      console.log(variant, spec.id, Object.keys(shots).join(','));
    }
    // The median colours against each tile's own average colour.
    const means: Record<string, [number, number, number]> = {};
    for (const faces of Object.values(summary).flatMap((v) => Object.values(v)))
      for (const face of faces)
        if (face.materialId && !means[face.materialId])
          means[face.materialId] = await textureMean(face.materialId);
    writeFileSync(join(dir, 'metrics.json'), JSON.stringify({ variant, gpu, means, summary }, null, 1));
    await page.close();
  }
} finally {
  await browser.close();
}
