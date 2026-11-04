/**
 * Round 4's after-steps on the app's answers (no AI call), each against what the app shows now:
 *   light   ⓐ walls and floor keep the render's pattern and colour; only the model's light comes in:
 *           per face, the render times the ratio of the model's blurred lightness to the render's
 *           (blur radius 12 px at 992 px, ratio 0.35–1.8). Fixtures and the backdrop stay the app's.
 *   local   ⓑ the app's face-mean correction made local: each face pixel's a*, b* moved to the render's
 *           blurred local a*, b*, and its L* by the app's rule (±8 kept, 90% of the rest back) against
 *           the render's blurred local L*. Texture and shading inside stay the model's.
 *   upscale ⓒ Swin2SR x2 of what the app shows (the browser model, lab.ts).
 * Only where the framing held (the app's own check); a reframed answer is left as it is.
 *
 * Usage: node tests/run-browser-test.mjs tests/export-photoreal/post-variants.ts --scenes a,b --seeds 424242
 *          [--steps light,local,upscale] [--holdout]
 * Output: results/<light|local|upscale>/<scene>-<seed>.app.png (+ .json)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FIXTURE_REGION,
  labToRgb,
  LIGHTNESS_BAND,
  LIGHTNESS_RETURN,
  projectCapture,
  projectMask,
  rgbToLab,
  shiftMask,
  type Pixels,
} from '../../src/lib/ai-export/color';
import { fluxInputLayout } from '../../src/lib/ai-export/contract';
import { loadScene, readPng, resultBase, writePng } from './io';
import { openLab } from './lab';

const arg = (name: string, fallback = '') => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const scenes = arg('scenes').split(',').filter(Boolean);
const seeds = arg('seeds', '424242').split(',').map(Number);
const steps = arg('steps', 'light,local,upscale').split(',');
const SOURCE = 'current';

/** Box blur of one channel, three passes (about a Gaussian), only over `inside` pixels. */
function blur(values: Float32Array, inside: Uint8Array, width: number, height: number, radius: number) {
  let v = Float32Array.from(values, (x, i) => (inside[i] ? x : 0));
  let w = Float32Array.from(inside);
  const pass = (src: Float32Array, horizontal: boolean) => {
    const out = new Float32Array(src.length);
    const [n, m] = horizontal ? [width, height] : [height, width];
    for (let j = 0; j < m; j++) {
      let sum = 0;
      const at = (i: number) => (horizontal ? j * width + i : i * width + j);
      for (let i = -radius; i <= radius; i++) if (i >= 0 && i < n) sum += src[at(i)];
      for (let i = 0; i < n; i++) {
        out[at(i)] = sum;
        const add = i + radius + 1,
          drop = i - radius;
        if (add < n) sum += src[at(add)];
        if (drop >= 0) sum -= src[at(drop)];
      }
    }
    return out;
  };
  for (let k = 0; k < 3; k++) {
    v = pass(pass(v, true), false);
    w = pass(pass(w, true), false);
  }
  return Float32Array.from(v, (x, i) => (w[i] > 1e-6 ? x / w[i] : 0));
}

type Prepared = { result: Pixels; reference: Pixels; faces: Uint8Array; labels: number[] };
/** The app's answer, the render at its size and framing, and each pixel's face (0: not a face). */
async function prepare(scene: string, seed: number): Promise<Prepared | undefined> {
  const base = resultBase(SOURCE, scene, seed);
  const post = JSON.parse(readFileSync(`${base}.post.json`, 'utf8')) as {
    framing: { dx: number; dy: number; aligned: boolean };
  };
  if (!post.framing.aligned) return;
  const payload = await loadScene(scene);
  const result = await readPng(`${base}.app.png`);
  const layout = fluxInputLayout(payload.capture.width, payload.capture.height);
  const size = { width: result.width, height: result.height };
  const reference = projectCapture(payload.capture, layout, size);
  const mask = shiftMask(projectMask(payload.mask, layout, size), post.framing.dx, post.framing.dy);
  // The render moved by the model's shift, so a result pixel meets the render pixel it shows.
  const moved = new Uint8ClampedArray(reference.data.length).fill(255);
  const { dx, dy } = post.framing;
  for (let y = 0; y < size.height; y++)
    for (let x = 0; x < size.width; x++) {
      const sx = x - dx,
        sy = y - dy;
      if (sx < 0 || sy < 0 || sx >= size.width || sy >= size.height) continue;
      for (let c = 0; c < 4; c++)
        moved[(y * size.width + x) * 4 + c] = reference.data[(sy * size.width + sx) * 4 + c];
    }
  const faces = Uint8Array.from(mask.data, (label) => (label && label !== FIXTURE_REGION ? label : 0));
  const labels = [...new Set(faces)].filter(Boolean);
  return { result, reference: { ...size, data: moved }, faces, labels };
}

function lab(image: Pixels) {
  const n = image.width * image.height;
  const L = new Float32Array(n),
    A = new Float32Array(n),
    B = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const [l, a, b] = rgbToLab(image.data[i * 4], image.data[i * 4 + 1], image.data[i * 4 + 2]);
    L[i] = l;
    A[i] = a;
    B[i] = b;
  }
  return { L, A, B };
}

/** ⓐ the render's pattern and colour under the model's light. */
function lightOnly(p: Prepared): Pixels {
  const { width, height } = p.result;
  const out = new Uint8ClampedArray(p.result.data);
  const ours = lab(p.reference),
    theirs = lab(p.result);
  for (const label of p.labels) {
    const inside = Uint8Array.from(p.faces, (f) => (f === label ? 1 : 0));
    const a = blur(theirs.L, inside, width, height, 12),
      b = blur(ours.L, inside, width, height, 12);
    for (let i = 0; i < inside.length; i++) {
      if (!inside[i]) continue;
      const ratio = Math.max(0.35, Math.min(1.8, (a[i] + 1) / (b[i] + 1)));
      const [r, g, bl] = labToRgb(Math.min(100, ours.L[i] * ratio), ours.A[i], ours.B[i]);
      out[i * 4] = r;
      out[i * 4 + 1] = g;
      out[i * 4 + 2] = bl;
    }
  }
  return { width, height, data: out };
}

/** ⓑ the model's texture with the render's local colour (and lightness by the app's rule). */
function localColour(p: Prepared): Pixels {
  const { width, height } = p.result;
  const out = new Uint8ClampedArray(p.result.data);
  const ours = lab(p.reference),
    theirs = lab(p.result);
  for (const label of p.labels) {
    const inside = Uint8Array.from(p.faces, (f) => (f === label ? 1 : 0));
    const [oL, oA, oB] = [ours.L, ours.A, ours.B].map((c) => blur(c, inside, width, height, 24));
    const [tL, tA, tB] = [theirs.L, theirs.A, theirs.B].map((c) => blur(c, inside, width, height, 24));
    for (let i = 0; i < inside.length; i++) {
      if (!inside[i]) continue;
      const dl = tL[i] - oL[i];
      const back =
        Math.abs(dl) > LIGHTNESS_BAND ? (dl - Math.sign(dl) * LIGHTNESS_BAND) * LIGHTNESS_RETURN : 0;
      const [r, g, b] = labToRgb(
        theirs.L[i] - back,
        theirs.A[i] - (tA[i] - oA[i]),
        theirs.B[i] - (tB[i] - oB[i]),
      );
      out[i * 4] = r;
      out[i * 4 + 1] = g;
      out[i * 4 + 2] = b;
    }
  }
  return { width, height, data: out };
}

const lab2 = steps.includes('upscale') ? await openLab({ gpu: true }) : undefined;
try {
  for (const scene of scenes)
    for (const seed of seeds) {
      const source = resultBase(SOURCE, scene, seed);
      if (!existsSync(`${source}.app.png`)) continue;
      for (const step of steps) {
        const base = resultBase(step, scene, seed);
        if (existsSync(`${base}.app.png`)) continue;
        mkdirSync(join(base, '..'), { recursive: true });
        const started = Date.now();
        if (step === 'upscale') {
          const { png, ms } = await lab2!.upscale(`${source}.app.png`);
          writeFileSync(`${base}.app.png`, png);
          writeFileSync(`${base}.json`, JSON.stringify({ source: SOURCE, step, ms }));
          console.log(step, scene, seed, `${ms} ms`);
          continue;
        }
        const p = await prepare(scene, seed);
        if (!p) {
          writeFileSync(`${base}.json`, JSON.stringify({ source: SOURCE, step, skipped: 'framing changed' }));
          continue;
        }
        await writePng(`${base}.app.png`, step === 'light' ? lightOnly(p) : localColour(p));
        writeFileSync(`${base}.json`, JSON.stringify({ source: SOURCE, step, ms: Date.now() - started }));
        console.log(step, scene, seed, `${Date.now() - started} ms`);
      }
    }
} finally {
  await lab2?.close();
}
