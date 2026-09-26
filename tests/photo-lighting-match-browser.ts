/**
 * Photo lighting match (stage 3-3a): for each captured comparison project, estimate the photo's
 * light (several methods), then render with the 2D compositor
 *   (1) the Before as it is now,
 *   (2) the Before with its photo-derived colours delit and the light put back,
 *   (3) an After with white/grey catalogue tiles, light off, (4) the same, light on,
 * and compare Before regions (walls, floor, fixtures) against the photo (ΔE2000 of region means).
 * The 2D compositor has no tone mapping, so multiplying its linear output equals the planned
 * in-shader light. No AI call; nothing leaves the page.
 *
 * Usage: node tests/run-browser-test.mjs tests/photo-lighting-match-browser.ts [--method=mixed]
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import sharp from 'sharp';
import { deltaE2000, type Rgb as Rgb8 } from './helpers/delta-e';

const root = 'test-results/photo-lighting-match';
const app = process.argv.includes('--app');
// --app reads projects made by the app with the photo light (capture with SJN_PHOTO_LIGHTING_DIR=projects-app).
const chosen = app ? 'app' : (process.argv.find((a) => a.startsWith('--method='))?.slice(9) ?? 'mixed');
const projectDir = app ? 'projects-app' : 'projects';
const projects = (await readdir(`${root}/${projectDir}`)).sort();
const inputs = [];
for (const name of projects) {
  const dir = `${root}/${projectDir}/${name}`;
  const assets = JSON.parse(await readFile(`${dir}/assets.json`, 'utf8')) as Record<string, { mime: string }>;
  const bytes: Record<string, string> = {};
  for (const id of Object.keys(assets))
    bytes[id] = (await readFile(`${dir}/assets/${id}`)).toString('base64');
  inputs.push({
    name,
    app,
    project: JSON.parse(await readFile(`${dir}/project.json`, 'utf8')),
    materials: JSON.parse(await readFile(`${dir}/materials.json`, 'utf8')),
    assets,
    bytes,
  });
}
const bundle = await build({
  stdin: {
    contents: `export {PhotoCompositor} from './src/lib/render/compositor';export * from './src/lib/reconstruction/photo-lighting';export {fixtureImageBox} from './src/lib/ai-export/scene';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
  globalName: 'Lighting',
});
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--enable-gpu'],
});
type Region = { label: string; photo: number[]; renders: number[][] };
const hexRgb = (hex: string): Rgb8 => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb8;
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('http://127.0.0.1:43215/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' }),
  );
  await page.goto('http://127.0.0.1:43215/');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const results = [];
  for (const input of inputs) {
    const result = await page.evaluate(
      async ({ input, chosen }) => {
        // (input.app marks projects made by the app with the photo light.)
        type Lib = typeof import('../src/lib/render/compositor') &
          typeof import('../src/lib/reconstruction/photo-lighting') &
          typeof import('../src/lib/ai-export/scene');
        type Rgb = import('../src/lib/reconstruction/photo-lighting').Rgb;
        type Scene = import('../src/lib/types').Scene;
        type MaterialVersion = import('../src/lib/types').MaterialVersion;
        type AssetRecord = import('../src/lib/types').AssetRecord;
        type Quad = import('../src/lib/types').Quad;
        const lib = (window as unknown as { Lighting: Lib }).Lighting;
        // createReconstructionTile's grout when the photo showed none.
        const DEFAULT_GROUT = '#bcb9b1';
        const project = input.project as import('../src/lib/types').ProjectDocument;
        const comparison = project.shared.comparison!;
        const review = comparison.review!;
        const before = comparison.before;
        const decode = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const assets: Record<string, AssetRecord> = {};
        for (const [id, meta] of Object.entries(input.assets))
          assets[id] = {
            ...(meta as AssetRecord),
            blob: new Blob([decode(input.bytes[id])], { type: meta.mime }),
          };
        const materials: Record<string, MaterialVersion> = Object.fromEntries(
          (input.materials as MaterialVersion[]).map((m) => [m.id, m]),
        );
        // The photo at the analysis scale for sampling, full size for the sheet.
        const photoBitmap = await createImageBitmap(assets[comparison.referenceOriginalAssetId].blob);
        const W = 640,
          H = Math.round((640 * photoBitmap.height) / photoBitmap.width);
        type Img = { data: Uint8ClampedArray; w: number; h: number };
        const toPixels = (source: CanvasImageSource, w: number, h: number): Img => {
          const c = document.createElement('canvas');
          c.width = w;
          c.height = h;
          const ctx = c.getContext('2d', { willReadFrequently: true })!;
          ctx.drawImage(source, 0, 0, w, h);
          return { data: ctx.getImageData(0, 0, w, h).data, w, h };
        };
        const photoImage = toPixels(photoBitmap, W, H);
        const photo = photoImage.data;
        // Renders keep their own (room image) aspect; regions are compared in normalised coordinates.
        const RW = 640,
          RH = Math.round((640 * before.imageHeight) / before.imageWidth);
        const lin = (d: Uint8ClampedArray, i: number): Rgb => [
          lib.srgbToLinear(d[i]),
          lib.srgbToLinear(d[i + 1]),
          lib.srgbToLinear(d[i + 2]),
        ];
        const inside = (quad: Quad, x: number, y: number) => {
          let hit = false;
          for (let i = 0, j = 3; i < 4; j = i++) {
            const a = quad[i],
              b = quad[j];
            if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
          }
          return hit;
        };
        type Box = { left: number; top: number; right: number; bottom: number };
        const inBox = (b: Box, x: number, y: number) =>
          x >= b.left && x <= b.right && y >= b.top && y <= b.bottom;
        const shrink = (b: Box, k: number): Box => {
          const w = (b.right - b.left) * k,
            h = (b.bottom - b.top) * k;
          return { left: b.left + w, right: b.right - w, top: b.top + h, bottom: b.bottom - h };
        };
        const candidates = review.candidates.filter((c) => c.status !== 'ignored');
        const boxes = candidates.map((c) => c.bounds);
        // The same sampling as the app (faces without fixture boxes, the largest white sanitaryware).
        const samples = lib.samplePhotoLighting(photo, W, H, review);
        const methods = ['gray-world', 'achromatic', 'ceramic', 'mixed'] as const;
        const estimates = Object.fromEntries(methods.map((m) => [m, lib.estimatePhotoLighting(samples, m)]));
        // --app: the project was made by the app, so its colours are delit already and it carries the
        // stored light; renders take that light through the shader (RenderSnapshot.lighting).
        const stored = input.app ? comparison.photoLighting : undefined;
        const estimate = input.app
          ? {
              ...(stored ?? { exposureEv: 0, gains: [1, 1, 1] as Rgb }),
              method: stored?.method ?? 'neutral',
              evidence: estimates.mixed.evidence,
            }
          : estimates[chosen as (typeof methods)[number]];
        const appLight = lib.photoLightingMultiplier(stored);
        // Delit copies of the photo-derived colours.
        const extraAssets: Record<string, AssetRecord> = {};
        const solid = async (id: string, hex: string) => {
          const c = document.createElement('canvas');
          c.width = c.height = 16;
          const ctx = c.getContext('2d')!;
          ctx.fillStyle = hex;
          ctx.fillRect(0, 0, 16, 16);
          const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/png'));
          extraAssets[id] = {
            id,
            ownerId: 'test',
            name: id,
            mime: 'image/png',
            size: blob.size,
            width: 16,
            height: 16,
            kind: 'texture',
            blob,
            createdAt: '2026-09-27',
          };
        };
        const delitMaterials: Record<string, MaterialVersion> = { ...materials };
        const tileColors: { face: string; photo: string; delit: string }[] = [];
        for (const surface of before.surfaces) {
          const m = surface.materialVersionId ? materials[surface.materialVersionId] : undefined;
          if (!m || m.category !== 'tile' || delitMaterials[m.id + ':delit']) continue;
          const delit = lib.delightColor(m.color, estimate);
          await solid(m.id + ':delit-texture', delit);
          delitMaterials[m.id + ':delit'] = {
            ...m,
            id: m.id + ':delit',
            color: delit,
            textureAssetIds: [m.id + ':delit-texture'],
          };
          tileColors.push({ face: surface.roomFace ?? surface.kind, photo: m.color, delit });
        }
        const delitScene = (scene: Scene): Scene => ({
          ...structuredClone(scene),
          surfaces: scene.surfaces.map((s) => ({
            ...structuredClone(s),
            materialVersionId:
              s.materialVersionId && delitMaterials[s.materialVersionId + ':delit']
                ? s.materialVersionId + ':delit'
                : s.materialVersionId,
            // The default grout was never measured in the photo: it is a material colour already.
            tile: {
              ...s.tile,
              groutColor:
                s.tile.groutColor.toLowerCase() === DEFAULT_GROUT
                  ? s.tile.groutColor
                  : lib.delightColor(s.tile.groutColor, estimate),
            },
          })),
          fixtures: scene.fixtures.map((f) => {
            const copy = structuredClone(f);
            if (copy.reconstruction && /^#[0-9a-f]{6}$/i.test(copy.reconstruction.color))
              copy.reconstruction.color = lib.delightColor(copy.reconstruction.color, estimate);
            return copy;
          }),
        });
        // After: white wall and grey floor catalogue tiles, the delit fixtures.
        await solid('catalog-white', '#f1f0ec');
        await solid('catalog-grey', '#8d8c89');
        const catalog = (id: string, color: string, size: number): MaterialVersion => ({
          ...Object.values(materials).find((m) => m.category === 'tile')!,
          id,
          materialId: id,
          name: id,
          color,
          widthMm: size,
          heightMm: size === 300 ? 600 : size,
          textureAssetIds: [id],
          reconstruction: undefined,
        });
        delitMaterials['catalog-white'] = catalog('catalog-white', '#f1f0ec', 300);
        delitMaterials['catalog-grey'] = catalog('catalog-grey', '#8d8c89', 600);
        const after = delitScene(before);
        after.surfaces = after.surfaces.map((s) => ({
          ...s,
          materialVersionId: s.kind === 'floor' ? 'catalog-grey' : 'catalog-white',
          tile: { ...s.tile, groutColor: s.kind === 'floor' ? '#b8b6b1' : '#e2e0da', groutWidth: 2 },
        }));
        const reader = async (id: string) => extraAssets[id] ?? assets[id];
        const compositor = new lib.PhotoCompositor();
        const render = async (scene: Scene, mats: Record<string, MaterialVersion>, lighting?: Rgb) => {
          const snapshot = { scene, beforeScene: scene, materials: mats, ...(lighting ? { lighting } : {}) };
          await compositor.setSnapshot(snapshot, reader);
          const blob = await compositor.exportImage(snapshot, 1280, 1280, 'image/png', false);
          const bitmap = await createImageBitmap(blob);
          const image = toPixels(bitmap, RW, RH);
          bitmap.close();
          return image;
        };
        const multiply = (image: Img, m: Rgb): Img => {
          const out = new Uint8ClampedArray(image.data);
          for (let i = 0; i < out.length; i += 4)
            for (let c = 0; c < 3; c++)
              out[i + c] = lib.linearToSrgb(lib.srgbToLinear(image.data[i + c]) * m[c]);
          return { ...image, data: out };
        };
        // The app's Before as shown, and an After with the light off and on, all in the shader.
        const appImages = async (): Promise<Record<string, Img>> => {
          const appAfter = structuredClone(after);
          appAfter.fixtures = structuredClone(before.fixtures);
          const shown = await render(structuredClone(before), materials, appLight);
          return {
            current: shown,
            delit: shown,
            delitOff: await render(structuredClone(before), materials),
            afterOff: await render(appAfter, delitMaterials),
            afterOn: await render(appAfter, delitMaterials, appLight),
          };
        };
        // The measurement: today's Before, delit colours relit on the CPU, the After off and on.
        const measuredImages = async (): Promise<Record<string, Img>> => {
          const current = await render(structuredClone(before), materials);
          const delitOff = await render(delitScene(before), delitMaterials);
          const afterOff = await render(after, delitMaterials);
          const m = lib.lightingMultiplier(estimate);
          return {
            current,
            delit: multiply(delitOff, m),
            delitOff,
            afterOff,
            afterOn: multiply(afterOff, m),
          };
        };
        let images: Record<string, Img>;
        try {
          images = input.app ? await appImages() : await measuredImages();
        } finally {
          compositor.dispose();
        }
        // Region means: the photo's plane / candidate box against the render's face / fixture box.
        const aspect = before.imageWidth / before.imageHeight;
        const mean = (image: Img, keep: (u: number, v: number) => boolean) => {
          const sum = [0, 0, 0];
          let n = 0;
          for (let y = 0; y < image.h; y++)
            for (let x = 0; x < image.w; x++) {
              const u = (x + 0.5) / image.w,
                v = (y + 0.5) / image.h;
              if (!keep(u, v)) continue;
              const c = lin(image.data, (y * image.w + x) * 4);
              sum[0] += c[0];
              sum[1] += c[1];
              sum[2] += c[2];
              n++;
            }
          return n ? sum.map((s) => lib.linearToSrgb(s / n)) : undefined;
        };
        const fixtureBoxes = before.fixtures
          .map((f) => lib.fixtureImageBox(f, aspect))
          .filter((b): b is [number, number, number, number] => !!b)
          .map(([left, top, right, bottom]) => ({ left, top, right, bottom }));
        const regions: { label: string; photo: number[]; renders: number[][] }[] = [];
        for (const plane of review.planes) {
          const surfacesOfFace = before.surfaces.filter((s) => s.roomFace === plane.face);
          if (!surfacesOfFace.length) continue;
          const p = mean(
            photoImage,
            (u, v) => inside(plane.quad, u, v) && !boxes.some((b) => inBox(b, u, v)),
          );
          const renders = ['current', 'delit', 'afterOff', 'afterOn'].map((k) =>
            mean(
              images[k],
              (u, v) =>
                surfacesOfFace.some((s) => inside(s.quad, u, v)) && !fixtureBoxes.some((b) => inBox(b, u, v)),
            ),
          );
          if (p && renders.every(Boolean))
            regions.push({ label: plane.face, photo: p, renders: renders as number[][] });
        }
        for (const candidate of candidates) {
          const fixture = before.fixtures.find((f) => f.id === candidate.fixtureId);
          const box = fixture && lib.fixtureImageBox(fixture, aspect);
          if (!box) continue;
          const renderBox = shrink({ left: box[0], top: box[1], right: box[2], bottom: box[3] }, 0.25);
          const p = mean(photoImage, (u, v) => inBox(shrink(candidate.bounds, 0.25), u, v));
          const renders = ['current', 'delit', 'afterOff', 'afterOn'].map((k) =>
            mean(images[k], (u, v) => inBox(renderBox, u, v)),
          );
          if (p && renders.every(Boolean))
            regions.push({ label: candidate.kind, photo: p, renders: renders as number[][] });
        }
        const panel = (image: Img) => {
          const c = document.createElement('canvas');
          c.width = image.w;
          c.height = image.h;
          c.getContext('2d')!.putImageData(
            new ImageData(new Uint8ClampedArray(image.data), image.w, image.h),
            0,
            0,
          );
          return c.toDataURL('image/png');
        };
        // After's white wall against the photo's white sanitaryware (how the same white reads).
        const whiteWall = (image: Img) =>
          mean(
            image,
            (u, v) =>
              after.surfaces.some((s) => s.kind === 'wall' && inside(s.quad, u, v)) &&
              !fixtureBoxes.some((b) => inBox(b, u, v)),
          );
        return {
          ceramic: samples.ceramics.map((c) => ({ color: lib.linearToHex(c) })),
          afterWhite: { off: whiteWall(images.afterOff), on: whiteWall(images.afterOn) },
          estimates,
          chosen: estimate,
          evidence: estimate.evidence,
          tileColors,
          regions,
          panels: {
            photo: panel(photoImage),
            current: panel(images.current),
            delit: panel(images.delit),
            afterOff: panel(images.afterOff),
            afterOn: panel(images.afterOn),
          },
        };
      },
      { input, chosen },
    );
    results.push({ name: input.name, ...result });
  }
  if (errors.length) throw new Error(errors.join('\n'));
  const summary = [];
  for (const r of results) {
    const png = (url: string) => Buffer.from(url.split(',')[1], 'base64');
    const order = ['photo', 'current', 'delit', 'afterOff', 'afterOn'] as const;
    const labels = ['사진', '지금 Before', '새 Before', 'After 끔', 'After 켬'];
    const cells = [];
    let left = 0;
    for (const [i, key] of order.entries()) {
      const cell = await sharp(png(r.panels[key])).resize({ height: 300 }).png().toBuffer();
      const width = (await sharp(cell).metadata()).width!;
      cells.push({ input: cell, left, top: 26 });
      cells.push({
        input: Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="24"><text x="4" y="18" font-family="sans-serif" font-size="15">${labels[i]}</text></svg>`,
        ),
        left,
        top: 0,
      });
      left += width + 6;
    }
    await sharp({ create: { width: left, height: 26 + 300, channels: 4, background: '#ffffff' } })
      .composite(cells)
      .png()
      .toFile(`${root}/sheet-${r.name}-${chosen}.png`);
    const dE = (index: number) => {
      const values = (r.regions as Region[]).map((g) =>
        deltaE2000(g.photo as Rgb8, g.renders[index] as Rgb8),
      );
      return +(values.reduce((a, b) => a + b, 0) / Math.max(1, values.length)).toFixed(2);
    };
    const light = (rgb: number[]) => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
    summary.push({
      photo: r.name,
      method: chosen,
      chosen: {
        method: r.chosen.method,
        exposureEv: +r.chosen.exposureEv.toFixed(2),
        gains: r.chosen.gains.map((g: number) => +g.toFixed(3)),
      },
      estimates: Object.fromEntries(
        Object.entries(r.estimates).map(([k, e]) => [
          k,
          {
            method: (e as { method: string }).method,
            ev: +(e as { exposureEv: number }).exposureEv.toFixed(2),
            gains: (e as { gains: number[] }).gains.map((g) => +g.toFixed(3)),
          },
        ]),
      ),
      evidence: r.evidence,
      ceramic: r.ceramic,
      afterWhite: r.afterWhite,
      afterWhiteVsCeramic: r.ceramic.length
        ? {
            off: +deltaE2000(r.afterWhite.off as Rgb8, hexRgb(r.ceramic[0].color)).toFixed(2),
            on: +deltaE2000(r.afterWhite.on as Rgb8, hexRgb(r.ceramic[0].color)).toFixed(2),
          }
        : null,
      tileColors: r.tileColors,
      meanDeltaE: { current: dE(0), delit: dE(1), afterOff: dE(2), afterOn: dE(3) },
      regions: (r.regions as Region[]).map((g) => ({
        label: g.label,
        photo: g.photo,
        current: +deltaE2000(g.photo as Rgb8, g.renders[0] as Rgb8).toFixed(2),
        delit: +deltaE2000(g.photo as Rgb8, g.renders[1] as Rgb8).toFixed(2),
        afterOff: +deltaE2000(g.photo as Rgb8, g.renders[2] as Rgb8).toFixed(2),
        afterOn: +deltaE2000(g.photo as Rgb8, g.renders[3] as Rgb8).toFixed(2),
        lightDiff: {
          current: Math.round(light(g.renders[0]) - light(g.photo)),
          delit: Math.round(light(g.renders[1]) - light(g.photo)),
        },
      })),
    });
  }
  await mkdir(root, { recursive: true });
  await writeFile(`${root}/summary-${chosen}.json`, JSON.stringify(summary, null, 2));
  console.log(
    JSON.stringify(
      summary.map((s) => ({ photo: s.photo, chosen: s.chosen, dE: s.meanDeltaE, tiles: s.tileColors })),
      null,
      1,
    ),
  );
} finally {
  await browser.close();
}
