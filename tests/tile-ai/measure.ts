/**
 * Measures results of the tile AI trial with the automatic joint score (score.ts; no AI call): each
 * result against its scene's capture with the joints drawn wide, face by face, after the same
 * whole-picture alignment the app uses for its colour check.
 *
 * Usage: node tests/run-browser-test.mjs tests/tile-ai/measure.ts --group local --methods cur,grout
 *          --scenes scored,subway --seeds 424242 [--suffix .fixed] [--holdout]
 * Output: a table, and <result>.score.json beside each result
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import {
  framing,
  projectCapture,
  projectMask,
  type Pixels,
  type RegionMask,
} from '../../src/lib/ai-export/color';
import type { FluxInputLayout } from '../../src/lib/ai-export/contract';
import { HOLDOUT, RESULTS, SCENES } from './paths.mjs';
import { faceScores, summary } from './score';

const arg = (name: string, fallback = '') => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const list = (name: string, fallback = '') => arg(name, fallback).split(',').filter(Boolean);
const group = arg('group', 'local');
const suffix = arg('suffix');
const holdout = process.argv.includes('--holdout');

export const pixels = async (file: string): Promise<Pixels> => {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8ClampedArray(data) };
};
export async function sceneParts(dir: string) {
  const { layout } = JSON.parse(readFileSync(join(dir, 'layout.json'), 'utf8')) as {
    layout: FluxInputLayout;
  };
  const regions = JSON.parse(readFileSync(join(dir, 'regions.json'), 'utf8')) as Omit<RegionMask, 'data'>;
  const mask: RegionMask = {
    ...regions,
    data: new Uint8Array(await sharp(join(dir, 'mask.png')).extractChannel(0).raw().toBuffer()),
    outside: new Uint8Array(await sharp(join(dir, 'mask-outside.png')).extractChannel(0).raw().toBuffer()),
  };
  return {
    layout,
    mask,
    capture: await pixels(join(dir, 'capture.png')),
    joints: await pixels(join(dir, 'capture-grout.png')),
  };
}
/** The joint score of a result picture of a scene. */
export async function measure(dir: string, file: string) {
  const { layout, mask, capture, joints } = await sceneParts(dir);
  const result = await pixels(file);
  const size = { width: result.width, height: result.height };
  const shift = framing(projectCapture(capture, layout, size), result);
  const faces = faceScores(
    projectCapture(joints, layout, size),
    result,
    projectMask(mask, layout, size),
    shift.dx,
    shift.dy,
  );
  return { framing: +shift.score.toFixed(2), aligned: shift.aligned, ...summary(faces), faces };
}

if (process.argv[2]?.endsWith('measure.ts')) {
  const table: Record<string, Record<string, string>> = {};
  for (const scene of list('scenes')) {
    const dir = join((holdout ? HOLDOUT : SCENES) as string, scene);
    for (const method of list('methods'))
      for (const seed of list('seeds', '424242')) {
        const file = join(RESULTS as string, group, method, `${scene}-${seed}${suffix}.png`);
        if (!existsSync(file)) continue;
        const scored = await measure(dir, file);
        writeFileSync(file.replace(/\.png$/, '.score.json'), JSON.stringify(scored, null, 1));
        (table[`${scene}-${seed}`] ??= {})[method] = `${scored.wall.toFixed(2)}/${scored.floor.toFixed(2)}`;
      }
  }
  console.log('joint score, walls/floor');
  console.table(table);
}
