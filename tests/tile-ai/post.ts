/**
 * What happens to a result of the tile AI trial after the model (no AI call):
 *   - `<result>.fixed.png`: the result as the app shows it — the faces' colours moved back to the
 *     render's (reviewResultColors) and the plain backdrop put back (restoreBackdrop). The review uses
 *     these pictures.
 *   - with --restore, T6: a new result `<method>+restore/<scene>-<seed>.png`, where the faces whose
 *     joint score is under --threshold take the app picture's joints and pattern again (restore.ts),
 *     and its own .fixed.png.
 *
 * Usage: node tests/run-browser-test.mjs tests/tile-ai/post.ts --group cf --methods cur,grout
 *          --scenes scored,subway --seeds 424242,777001 [--restore] [--threshold 0.3] [--holdout]
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { restoreBackdrop } from '../../src/lib/ai-export/backdrop';
import {
  framing,
  projectCapture,
  projectMask,
  reviewResultColors,
  shiftMask,
  type Pixels,
} from '../../src/lib/ai-export/color';
import { measure, pixels, sceneParts } from './measure';
import { HOLDOUT, RESULTS, SCENES } from './paths.mjs';
import { restoreJoints } from './restore';

const arg = (name: string, fallback = '') => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const list = (name: string, fallback = '') => arg(name, fallback).split(',').filter(Boolean);
const group = arg('group', 'cf');
const holdout = process.argv.includes('--holdout');
const restore = process.argv.includes('--restore');
const threshold = Number(arg('threshold', '0.3'));

const save = (image: Pixels, file: string) =>
  sharp(Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength), {
    raw: { width: image.width, height: image.height, channels: 4 },
  })
    .removeAlpha()
    .png()
    .toFile(file);

/** The result as the app shows it. */
async function fixed(dir: string, file: string) {
  const { layout, mask, capture } = await sceneParts(dir);
  const result = await pixels(file);
  const review = reviewResultColors({ capture, mask, layout, result });
  const coloured = review.corrected ?? result;
  const shown = review.framing.aligned
    ? (restoreBackdrop({ result: coloured, capture, mask, layout, shift: review.framing }) ?? coloured)
    : coloured;
  await save(shown, file.replace(/\.png$/, '.fixed.png'));
  return { aligned: review.framing.aligned, corrected: !!review.corrected, warnings: review.warnings.length };
}

for (const scene of list('scenes')) {
  const dir = join((holdout ? HOLDOUT : SCENES) as string, scene);
  for (const method of list('methods'))
    for (const seed of list('seeds', '424242')) {
      const file = join(RESULTS as string, group, method, `${scene}-${seed}.png`);
      if (!existsSync(file)) continue;
      const shown = await fixed(dir, file);
      if (!restore) {
        console.log(method, scene, seed, JSON.stringify(shown));
        continue;
      }
      const scored = await measure(dir, file);
      const { layout, mask, capture } = await sceneParts(dir);
      const result = await pixels(file);
      const size = { width: result.width, height: result.height };
      const reference = projectCapture(capture, layout, size);
      const shift = framing(reference, result);
      const low = scored.faces.filter((face) => face.score < threshold);
      const labels = new Set(
        low.map((face) => mask.regions.findIndex((region) => region.key === face.key) + 1),
      );
      const target = join(RESULTS as string, group, `${method}+restore`, `${scene}-${seed}.png`);
      mkdirSync(join(target, '..'), { recursive: true });
      // A result that changed the framing, or whose faces all kept their joints, stays as it is.
      if (!shift.aligned || !labels.size) copyFileSync(file, target);
      else
        await save(
          restoreJoints(
            reference,
            result,
            shiftMask(projectMask(mask, layout, size), shift.dx, shift.dy),
            labels,
            shift,
          ),
          target,
        );
      writeFileSync(
        target.replace(/\.png$/, '.json'),
        JSON.stringify(
          {
            ...JSON.parse(readFileSync(file.replace(/\.png$/, '.json'), 'utf8')),
            restored: low.map((f) => f.key),
            threshold,
          },
          null,
          1,
        ),
      );
      await fixed(dir, target);
      console.log(
        `${method}+restore`,
        scene,
        seed,
        `faces ${low.length}/${scored.faces.length}`,
        JSON.stringify(shown),
      );
    }
}
