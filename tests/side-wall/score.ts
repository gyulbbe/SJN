/**
 * Scores the side-wall trial's pictures against the 4× reference (no AI call,
 * docs/side-wall-tiles-20261115.md): per wall and floor (left / back / right by where the face sits
 * in the picture), the mean |difference| from the reference inside the face (break-up and joints) and
 * the ΔE2000 of the face's mean colour (how far its overall colour moved), for each variant, and the
 * change against `cur`. Faces are taken 3 px inside their mask edges.
 *
 *   node tests/run-browser-test.mjs tests/side-wall/score.ts --variants cur,jointphys,... [--gpu] [--front]
 * Output: the table on the console and test-results/side-wall-20261115/score[-gpu].json
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { deltaE2000, type Rgb } from '../helpers/delta-e';
import { OUT } from './paths.mjs';

const arg = (name: string, fallback = '') => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const suffix = process.argv.includes('--gpu') ? '-gpu' : '';
const variants = arg('variants', 'cur').split(',');
const scenes = arg('scenes', 'small,roman,scored,marble,patchwork,subway,beige').split(',');
const views = ['2d', '3d', 'orbit0', 'orbit30', 'orbit60'];
const RIM = 3;

const read = async (file: string) => {
  const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data };
};
type Face = { label: number; side: 'left' | 'back' | 'right' | 'floor'; where: number[] };
function faces(mask: { width: number; height: number; kinds: string[]; data: string }): Face[] {
  const labels = Buffer.from(mask.data, 'base64');
  const { width, height } = mask;
  const out: Face[] = [];
  for (let label = 1; label <= mask.kinds.length; label++) {
    const where: number[] = [];
    let sx = 0;
    for (let y = RIM; y < height - RIM; y++)
      for (let x = RIM; x < width - RIM; x++) {
        const i = y * width + x;
        if (labels[i] !== label) continue;
        if (
          labels[i - RIM] !== label ||
          labels[i + RIM] !== label ||
          labels[i - RIM * width] !== label ||
          labels[i + RIM * width] !== label
        )
          continue;
        where.push(i);
        sx += x;
      }
    if (where.length < 500) continue;
    const centre = sx / where.length / width;
    const side =
      mask.kinds[label - 1] === 'floor' ? 'floor' : centre < 0.38 ? 'left' : centre > 0.62 ? 'right' : 'back';
    out.push({ label, side, where });
  }
  return out;
}
const mean = (image: { data: Buffer }, where: number[]): Rgb => {
  const s = [0, 0, 0];
  for (const i of where) for (let c = 0; c < 3; c++) s[c] += image.data[i * 3 + c];
  return s.map((v) => v / where.length) as Rgb;
};
const diff = (a: { data: Buffer }, b: { data: Buffer }, where: number[]) => {
  let s = 0;
  for (const i of where) for (let c = 0; c < 3; c++) s += Math.abs(a.data[i * 3 + c] - b.data[i * 3 + c]);
  return s / where.length / 3;
};

type Row = { scene: string; view: string; side: string; variant: string; err: number; dE: number };
const rows: Row[] = [];
for (const scene of scenes)
  for (const view of views) {
    const maskFile = join(OUT as string, 'masks', `${scene}-${view}.json`);
    const refFile = join(OUT as string, 'ref' + suffix, `${scene}-${view}.png`);
    if (!existsSync(maskFile) || !existsSync(refFile)) continue;
    const list = faces(JSON.parse(readFileSync(maskFile, 'utf8')));
    const ref = await read(refFile);
    for (const variant of variants) {
      const file = join(OUT as string, variant + suffix, `${scene}-${view}.png`);
      if (!existsSync(file)) continue;
      const image = await read(file);
      if (image.width !== ref.width || image.height !== ref.height)
        throw new Error(`${file}: ${image.width}×${image.height}, reference ${ref.width}×${ref.height}`);
      for (const face of list)
        rows.push({
          scene,
          view,
          side: face.side,
          variant,
          err: +diff(image, ref, face.where).toFixed(2),
          dE: +deltaE2000(mean(image, face.where), mean(ref, face.where)).toFixed(2),
        });
    }
  }
// Side walls: the left and right walls (foreshortened in every view here); front: the back wall.
const group = (row: Row) =>
  row.side === 'left' || row.side === 'right' ? 'side' : row.side === 'back' ? 'front' : 'floor';
const table: Record<string, Record<string, string>> = {};
for (const variant of variants)
  for (const g of ['side', 'front', 'floor']) {
    const mine = rows.filter((r) => r.variant === variant && group(r) === g);
    if (!mine.length) continue;
    const avg = (f: 'err' | 'dE') => mine.reduce((s, r) => s + r[f], 0) / mine.length;
    (table[variant] ??= {})[`${g} err`] = avg('err').toFixed(2);
    table[variant][`${g} ΔE`] = avg('dE').toFixed(2);
  }
console.table(table);
// Per scene, side walls only.
const perScene: Record<string, Record<string, string>> = {};
for (const scene of scenes)
  for (const variant of variants) {
    const mine = rows.filter((r) => r.scene === scene && r.variant === variant && group(r) === 'side');
    if (!mine.length) continue;
    (perScene[scene] ??= {})[variant] =
      `${(mine.reduce((s, r) => s + r.err, 0) / mine.length).toFixed(1)} / ${(mine.reduce((s, r) => s + r.dE, 0) / mine.length).toFixed(1)}`;
  }
console.log('side walls per scene (err / ΔE):');
console.table(perScene);
writeFileSync(join(OUT as string, `score${suffix}.json`), JSON.stringify(rows, null, 1));
