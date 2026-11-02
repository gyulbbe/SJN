/**
 * "No match" without AI (round 4): the colour of the middle of each product's cut-out against the
 * public products of its kind (all white, a few black or beige basins). A product whose colour is far
 * (CIEDE2000) from every candidate's photo colour is turned away. The threshold is reported for every
 * value, not tuned to the two known misfits.
 *
 * Usage: node tests/run-browser-test.mjs tests/catalog-match/colour-gate.ts
 */
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { out, readJson } from './data';
import { SNAPSHOT } from './paths.mjs';
import { deltaE2000, rgbToLab, type Lab } from './tile-features';

/** Mean Lab of the middle 40% of an image, leaving out near-white background pixels of a cut-out. */
async function middleLab(path: string, dropWhite: boolean): Promise<Lab> {
  const { data, info } = await sharp(path)
    .flatten({ background: '#ffffff' })
    .resize(96, 96, { fit: 'inside' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  let n = 0;
  const sum = [0, 0, 0];
  for (let y = Math.floor(info.height * 0.3); y < info.height * 0.7; y++)
    for (let x = Math.floor(info.width * 0.3); x < info.width * 0.7; x++) {
      const i = (y * info.width + x) * info.channels;
      const lab = rgbToLab(data[i], data[i + 1], data[i + 2]);
      if (dropWhite && lab[0] > 97 && Math.hypot(lab[1], lab[2]) < 3) continue;
      sum[0] += lab[0];
      sum[1] += lab[1];
      sum[2] += lab[2];
      n++;
    }
  return n ? [sum[0] / n, sum[1] / n, sum[2] / n] : [100, 0, 0];
}
const queries = readJson<{ id: string; photo: string; kind: string }[]>(
  join(out, 'features', 'products', 'queries.json'),
);
const top = readJson<Record<string, Record<string, { id: string }[]>>>(
  join(out, 'r4-products', 'top12.json'),
);
const snapshot = readJson<{
  placements: { materialId: string; category: string; views: { assetId: string; direction: string }[] }[];
}>(join(SNAPSHOT, 'catalog.json'));
const files = new Map(readdirSync(join(SNAPSHOT, 'images')).map((f) => [f.replace(/\.[a-z]+$/, ''), f]));
const catalogLab = new Map<string, Lab>();
for (const p of snapshot.placements.filter((x) => x.category !== 'tile')) {
  const view = p.views.find((v) => v.direction === '정면') ?? p.views[0];
  if (view)
    catalogLab.set(p.materialId, await middleLab(join(SNAPSHOT, 'images', files.get(view.assetId)!), true));
}
const misfits = new Set(['pc-04|toilet', 'remote-02|basin']);
const rows = [];
for (const q of queries) {
  const lab = await middleLab(join(out, 'crops', 'products', `${q.id.replace(/:/g, '-')}.jpg`), true);
  const candidates = (top[q.id]?.['dinov2.pooled.box'] ?? []).map((c) => c.id);
  const nearest = Math.min(...candidates.map((id) => deltaE2000(lab, catalogLab.get(id) ?? [100, 0, 0])));
  const group = misfits.has(`${q.photo}|${q.kind}`)
    ? 'misfit'
    : q.kind === 'toilet'
      ? 'white toilet'
      : q.kind;
  rows.push({ id: q.id, group, chroma: Math.hypot(lab[1], lab[2]), nearest });
}
const table: Record<string, Record<string, string>> = {};
for (const threshold of [10, 15, 20, 25, 30]) {
  const by: Record<string, { none: number; n: number }> = {};
  for (const r of rows) {
    const b = (by[r.group] ??= { none: 0, n: 0 });
    b.n++;
    if (r.nearest > threshold) b.none++;
  }
  table[`ΔE>${threshold}`] = Object.fromEntries(Object.entries(by).map(([g, b]) => [g, `${b.none}/${b.n}`]));
}
writeFileSync(join(out, 'r4-products', 'colour-gate.json'), JSON.stringify({ rows, table }, null, 1));
for (const [k, v] of Object.entries(table)) console.log(k.padEnd(8), JSON.stringify(v));
for (const r of rows.filter((x) => x.group === 'misfit'))
  console.log('misfit', r.id, 'chroma', r.chroma.toFixed(1), 'nearest ΔE', r.nearest.toFixed(1));
