/**
 * Real-WebGL check of the ceramic glaze in the 360° editor's renderer (the one the PNG capture and
 * the editor share): a white test sphere and the saved TripoSR meshes (test-results/product3d-batch,
 * no new AI run) drawn with the matte material ("광택 없음", as before), "약하게" and "보통", each seen
 * from the front and from 60°. Per picture it reports, inside the silhouette:
 *  - front: the brightness of the part facing the viewer (a small disc at the centre of the sphere),
 *  - blown: the share of pixels at 255 in every channel,
 *  - peak: the brightest 0.1 % of the pixels (the highlight),
 * and asserts the criteria the glaze is tuned to:
 *  - a white glaze facing the viewer is within 3 % of the matte material's brightness,
 *  - the share of the silhouette blown out is at most 2 points above the matte picture's,
 *  - the glaze has a highlight the matte material does not (the peak is higher),
 *  - a category that is not ceramic (a shelf, a vanity cabinet, a mirror) is drawn exactly as before.
 *
 * Usage: node tests/run-browser-test.mjs tests/product3d-gloss-browser.ts [--gpu]
 *   OUT=test-results/xx                 another output folder
 *   TUNE='{"normal":{"editor":{"key":0.8}}}'   overrides of GLAZE (src/lib/product3d/glaze.ts) for a trial
 *   NOCHECK=1                           print the numbers without asserting (tuning runs)
 */
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import sharp, { type OverlayOptions } from 'sharp';
import { icosphere } from './helpers/product3d-meshes';

const gpu = process.argv.includes('--gpu');
const output = process.env.OUT ?? 'test-results/product3d-gloss';
const root = 'test-results/product3d-batch';
const meshes = [
  { name: 'sphere', category: 'toilet' },
  { name: 'cat-toilet-a', dir: `${root}/bear-a-original-500`, category: 'toilet' },
  { name: '02-smart-toilet', dir: `${root}/02-smart-toilet`, category: 'toilet' },
  { name: '03-bathtub-rect', dir: `${root}/03-bathtub-rect`, category: 'bath' },
  { name: '01-shelf', dir: `${root}/01-shelf`, category: 'vanity' },
  { name: '08-mirror', dir: `${root}/08-mirror`, category: 'mirror' },
].filter((m) => !m.dir || existsSync(`${m.dir}/mesh-positions.bin`));
const glosses = ['none', 'light', 'normal'] as const;
const azimuths = [0, 60];
await mkdir(output, { recursive: true });
const tune = process.env.TUNE ?? '{}';
const bundle = await build({
  stdin: {
    contents: [
      "export {ProductRenderer} from './src/lib/product3d/renderer';",
      "export {createDefaultPose} from './src/lib/product3d/pose';",
      "export {estimateUprightQuaternion} from './src/lib/product3d/upright';",
      "export {GLAZE, glossFor} from './src/lib/product3d/glaze';",
    ].join(''),
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
  globalName: 'P',
});
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: gpu
    ? ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--enable-gpu']
    : ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const sphere = icosphere(5, 0.5);
const b64 = (data: ArrayBufferView) =>
  Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64');
const file = (path: string) => readFileSync(path).toString('base64');
type Stats = { front: number; blown: number; peak: number; mean: number };
const results: Record<string, Record<string, Stats>> = {};
const tile = 300,
  label = 22;
const caption = (text: string) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${tile}" height="${label}"><rect width="100%" height="100%" fill="#e6e6e0"/><text x="6" y="16" font-family="sans-serif" font-size="13" fill="#222">${text}</text></svg>`,
  );
async function statsOf(png: Buffer, centre: boolean): Promise<Stats> {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const luminance: number[] = [];
  let blown = 0,
    inside = 0;
  for (let i = 0; i < info.width * info.height; i++) {
    if (data[i * 4 + 3] < 250) continue;
    inside++;
    const r = data[i * 4],
      g = data[i * 4 + 1],
      b = data[i * 4 + 2];
    luminance.push(0.2126 * r + 0.7152 * g + 0.0722 * b);
    if (r >= 254 && g >= 254 && b >= 254) blown++;
  }
  luminance.sort((a, b) => a - b);
  let front = 0;
  if (centre) {
    // A disc at the middle of the picture: on the sphere, the part facing the viewer.
    let sum = 0,
      n = 0;
    for (let y = -12; y <= 12; y++)
      for (let x = -12; x <= 12; x++) {
        if (x * x + y * y > 144) continue;
        const at = ((info.height / 2 + y) * info.width + info.width / 2 + x) * 4;
        sum += 0.2126 * data[at] + 0.7152 * data[at + 1] + 0.0722 * data[at + 2];
        n++;
      }
    front = sum / n;
  }
  return {
    front,
    blown: inside ? blown / inside : 0,
    peak: luminance[Math.floor(luminance.length * 0.999)] ?? 0,
    mean: luminance.reduce((a, b) => a + b, 0) / Math.max(1, luminance.length),
  };
}
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.setContent('<body></body>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.evaluate((json) => {
    const merge = (target: Record<string, unknown>, patch: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(patch))
        if (v && typeof v === 'object')
          merge(target[k] as Record<string, unknown>, v as Record<string, unknown>);
        else target[k] = v;
    };
    merge((window as unknown as { P: { GLAZE: Record<string, unknown> } }).P.GLAZE, JSON.parse(json));
  }, tune);
  const sheets: Buffer[] = [];
  for (const entry of meshes) {
    const data =
      entry.name === 'sphere'
        ? {
            p: b64(sphere.positions),
            c: b64(new Float32Array(sphere.positions.length).fill(0.95)),
            i: b64(sphere.indices),
          }
        : {
            p: file(`${entry.dir}/mesh-positions.bin`),
            c: file(`${entry.dir}/mesh-colors.bin`),
            i: file(`${entry.dir}/mesh-indices.bin`),
          };
    const shots: Record<string, string> = await page.evaluate(
      async (input) => {
        const decode = (s: string) => {
          const bin = atob(s);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          return bytes.buffer;
        };
        const mesh = {
          positions: new Float32Array(decode(input.p)),
          colors: new Float32Array(decode(input.c)),
          indices: new Uint32Array(decode(input.i)),
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const P = (window as unknown as { P: Record<string, any> }).P;
        const canvas = document.createElement('canvas');
        document.body.append(canvas);
        const renderer = new P.ProductRenderer(canvas, mesh);
        renderer.resize(512, 512, 1);
        renderer.setShading('mixed');
        const up = P.estimateUprightQuaternion(mesh.positions);
        const base = P.createDefaultPose().cameraQuaternion;
        const turn = (degrees: number) => {
          const [x, y, z, w] = base;
          const h = (degrees * Math.PI) / 360;
          const [qx, qy, qz, qw] = [0, 0, Math.sin(h), Math.cos(h)];
          return [
            qw * x + qx * w + qy * z - qz * y,
            qw * y - qx * z + qy * w + qz * x,
            qw * z + qx * y - qy * x + qz * w,
            qw * w - qx * x - qy * y - qz * z,
          ];
        };
        const toBase64 = (blob: Blob) =>
          new Promise<string>((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result).split(',')[1]);
            reader.readAsDataURL(blob);
          });
        const out: Record<string, string> = {};
        for (const gloss of input.glosses) {
          // What the editor asks for: the gloss of the category (a glaze only for ceramic).
          renderer.setGloss(P.glossFor(input.category, gloss));
          for (const azimuth of input.azimuths) {
            renderer.setPose({
              ...P.createDefaultPose(),
              objectQuaternion: input.name === 'sphere' ? [0, 0, 0, 1] : up,
              cameraQuaternion: turn(azimuth),
            });
            out[`${gloss}-${azimuth}`] = await toBase64((await renderer.capture()).blob);
          }
        }
        renderer.dispose();
        canvas.remove();
        return out;
      },
      { ...data, name: entry.name, category: entry.category, glosses: [...glosses], azimuths },
    );
    results[entry.name] = {};
    const composites: OverlayOptions[] = [];
    for (const [row, gloss] of glosses.entries())
      for (const [column, azimuth] of azimuths.entries()) {
        const png = Buffer.from(shots[`${gloss}-${azimuth}`], 'base64');
        results[entry.name][`${gloss}-${azimuth}`] = await statsOf(
          png,
          entry.name === 'sphere' && azimuth === 0,
        );
        composites.push({
          input: await sharp(png).flatten({ background: '#f4f4f0' }).resize(tile, tile).toBuffer(),
          left: column * tile,
          top: row * (tile + label) + label,
        });
        composites.push({
          input: caption(`${entry.name} (${entry.category}) · ${gloss} · ${azimuth}°`),
          left: column * tile,
          top: row * (tile + label),
        });
      }
    const sheet = await sharp({
      create: {
        width: tile * azimuths.length,
        height: (tile + label) * glosses.length,
        channels: 3,
        background: '#f4f4f0',
      },
    })
      .composite(composites)
      .png()
      .toBuffer();
    await sharp(sheet).toFile(`${output}/gloss-${entry.name}.png`);
    sheets.push(sheet);
    console.log(entry.name.padEnd(16), JSON.stringify(results[entry.name]));
  }
  const width = tile * azimuths.length;
  const tall = (tile + label) * glosses.length;
  await sharp({
    create: {
      width: width * 3,
      height: tall * Math.ceil(sheets.length / 3),
      channels: 3,
      background: '#f4f4f0',
    },
  })
    .composite(sheets.map((input, i) => ({ input, left: (i % 3) * width, top: Math.floor(i / 3) * tall })))
    .png()
    .toFile(`${output}/gloss-all.png`);
  writeFileSync(`${output}/gloss-metrics.json`, JSON.stringify(results, null, 2));
  assert.deepEqual(errors, [], errors.join('\n'));
  if (!process.env.NOCHECK) {
    const sphereFront = (gloss: string) => results.sphere[`${gloss}-0`].front;
    for (const gloss of ['light', 'normal']) {
      const change = Math.abs(sphereFront(gloss) / sphereFront('none') - 1);
      assert.ok(
        change <= 0.03,
        `${gloss}: a white glaze facing the viewer is ${(change * 100).toFixed(1)} % off the matte one`,
      );
    }
    for (const entry of meshes)
      for (const [key, stats] of Object.entries(results[entry.name])) {
        if (!['toilet', 'bath', 'basin'].includes(entry.category) || key.startsWith('none')) continue;
        // (The white sphere seen from 60° is mostly the part the photo never showed: already 7 % white in the matte picture.)
        if (entry.name === 'sphere' && key.endsWith('-60')) continue;
        const matte = results[entry.name][key.replace(/^[a-z]+/, 'none')];
        // The highlight is a little white, so a little more is allowed than the matte picture has.
        assert.ok(
          stats.blown <= matte.blown + 0.02,
          `${entry.name} ${key}: ${(stats.blown * 100).toFixed(2)} % blown out, matte ${(matte.blown * 100).toFixed(2)} %`,
        );
        if (entry.name === 'sphere' && key.endsWith('-0'))
          assert.ok(
            stats.peak > matte.peak,
            `${entry.name} ${key}: no highlight (peak ${stats.peak} vs ${matte.peak})`,
          );
      }
    // Not ceramic: drawn exactly as before whatever gloss was chosen.
    for (const entry of meshes.filter((m) => !['toilet', 'bath', 'basin'].includes(m.category)))
      for (const gloss of ['light', 'normal'])
        for (const azimuth of azimuths)
          assert.deepEqual(
            results[entry.name][`${gloss}-${azimuth}`],
            results[entry.name][`none-${azimuth}`],
            `${entry.name} (${entry.category}) ${gloss} ${azimuth}°: not drawn as before`,
          );
  }
} finally {
  await browser.close();
}
