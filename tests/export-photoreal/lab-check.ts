/**
 * Round 1 (no AI call): the browser models on pictures whose answer is known before the new calls.
 *   CLIP     the scenes' renders (one frame and 32 samples with the photo look) against the earlier
 *            real FLUX results (flux-lightness/final, flux-composite/real): a usable realism score
 *            puts every render below the FLUX results.
 *   Swin2SR  one earlier 992 × 672 result: time and that it runs.
 *   BiRefNet the white scene's toilet close-up (its 3D silhouette is known).
 *   WebGPU   the adapter, so a silent fall back to software is visible.
 *
 * Usage: node tests/run-browser-test.mjs tests/export-photoreal/lab-check.ts [--gpu]
 * Output: test-results/export-photoreal/lab-check.json
 */
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import type { ProductCrop } from '../../src/lib/ai-export/refine';
import { loadTyped } from './io';
import { openLab } from './lab';
import { INPUTS, OUT, SCENES } from './paths.mjs';

const gpu = process.argv.includes('--gpu');
const lab = await openLab({ gpu });
try {
  const adapter = await lab.adapter();
  const scenes = readdirSync(SCENES as string);
  const renders = scenes.map((s) => join(SCENES as string, s, 'capture.png'));
  const render32 = scenes.map((s) => join(SCENES as string, s, 'render32.png'));
  const lightness = join(INPUTS as string, 'flux-lightness', 'final');
  const composite = join(INPUTS as string, 'flux-composite', 'real');
  const earlier = [
    ...readdirSync(lightness)
      .filter((f) => f.endsWith('-corrected.png') && !f.startsWith('composite-'))
      .map((f) => join(lightness, f)),
    ...readdirSync(composite)
      .filter((f) => f.endsWith('.jpg'))
      .map((f) => join(composite, f)),
  ];
  const started = Date.now();
  const [r1, r32, flux] = [
    await lab.clipReal(renders),
    await lab.clipReal(render32),
    await lab.clipReal(earlier),
  ];
  const clipMs = Date.now() - started;
  const stats = (v: number[]) => ({
    n: v.length,
    min: +Math.min(...v).toFixed(3),
    median: +[...v].sort((a, b) => a - b)[v.length >> 1].toFixed(3),
    max: +Math.max(...v).toFixed(3),
  });
  const separated = Math.max(...r1) < Math.min(...flux);
  const sample = earlier.find((f) => f.endsWith('.png'))!;
  const up = await lab.upscale(sample);
  const upMeta = await sharp(up.png).metadata();
  // Brought back to the input's size, a sound x2 model gives nearly the input again.
  const inMeta = await sharp(sample).metadata();
  const back = await sharp(up.png).resize(inMeta.width, inMeta.height).removeAlpha().raw().toBuffer();
  const orig = await sharp(sample).removeAlpha().raw().toBuffer();
  let diff = 0;
  for (let i = 0; i < orig.length; i++) diff += Math.abs(orig[i] - back[i]);
  const roundTrip = +(diff / orig.length).toFixed(2);
  // The toilet close-up of the white scene: its own 3D coverage against the cut-out of its picture.
  const crops = loadTyped<ProductCrop[]>(join(SCENES as string, 'white'), 'crops');
  const crop = crops.find((c) => c.id === 'toilet') ?? crops[0];
  const png = await sharp(Buffer.from(crop.data.buffer, crop.data.byteOffset, crop.data.byteLength), {
    raw: { width: crop.width, height: crop.height, channels: 4 },
  })
    .png()
    .toBuffer();
  const cut = await lab.cutout(png);
  const alpha = await sharp(cut)
    .resize(crop.width, crop.height, { fit: 'fill' })
    .ensureAlpha()
    .extractChannel(3)
    .raw()
    .toBuffer();
  let both = 0,
    either = 0;
  for (let i = 0; i < crop.coverage.length; i++) {
    const a = crop.coverage[i] >= 128,
      b = alpha[i] >= 128;
    if (a && b) both++;
    if (a || b) either++;
  }
  const report = {
    adapter,
    clip: {
      ms: clipMs,
      render: stats(r1),
      render32: stats(r32),
      earlierFlux: stats(flux),
      rendersAllBelowFlux: separated,
      byScene: Object.fromEntries(
        scenes.map((s, i) => [s, { render: +r1[i].toFixed(3), render32: +r32[i].toFixed(3) }]),
      ),
    },
    swin2sr: {
      input: sample.split(/[\\/]/).pop(),
      output: [upMeta.width, upMeta.height],
      ms: up.ms,
      roundTripMeanAbs: roundTrip,
    },
    birefnet: {
      crop: crop.id,
      size: [crop.width, crop.height],
      iou: +(both / Math.max(1, either)).toFixed(3),
    },
  };
  writeFileSync(join(OUT as string, 'lab-check.json'), JSON.stringify(report, null, 1));
  console.log(JSON.stringify(report, null, 1));
} finally {
  await lab.close();
}
