/**
 * Same-pattern pairs of the catalog (round 0): two tiles are one pattern when their photos are near
 * identical — mean colour CIEDE2000 ≤ DE and DINOv2 cosine ≥ COS — pairwise, never chained (chains of
 * near pairs joined white and ivory). The strict score needs the exact tile; the pattern score
 * accepts the answer's pairs too (ARE-ALMOND 600 / 800: ΔE 0.7; ARE-BIANCO / ARE-CREAM: ΔE 3.3–3.6).
 *
 * Usage: node tests/run-browser-test.mjs tests/catalog-match/groups.ts
 * Output: test-results/catalog-match/features/catalog/groups.json
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cosineRow, loadCatalog, out } from './data';
import { patternNeighbours } from './score';
import { deltaE2000 } from './tile-features';

export const COS = 0.9,
  DE = 1.5;
const catalog = loadCatalog();
const m = catalog.matrix('dinov2-small-q4f16.single.pooled')!;
const pairs: [string, string][] = [];
const histogram = new Map<number, number>();
for (let i = 0; i < m.rows; i++) {
  const row = m.data.subarray(i * m.dims, (i + 1) * m.dims);
  for (let j = i + 1; j < m.rows; j++) {
    const cos = cosineRow(m, j, row);
    const bucket = Math.floor(cos * 100) / 100;
    if (cos >= 0.9) histogram.set(bucket, (histogram.get(bucket) ?? 0) + 1);
    if (cos < COS) continue;
    const de = deltaE2000(catalog.tiles[i].classic.colour.mean, catalog.tiles[j].classic.colour.mean);
    if (de <= DE) pairs.push([catalog.tiles[i].id, catalog.tiles[j].id]);
  }
}
const neighbours = patternNeighbours(
  catalog.tiles.map((t) => t.id),
  pairs,
);
const sizes = [...neighbours.values()].map((set) => set.size).filter((n) => n > 1);
console.log('pairs', pairs.length, 'tiles with a pair', sizes.length, 'largest', Math.max(...sizes));
const name = (id: string) => {
  const t = catalog.tiles.find((tile) => tile.id === id)!;
  return `${t.code || t.name} ${t.widthMm}x${t.heightMm}`;
};
console.log(
  'cos histogram ≥0.90',
  [...histogram.entries()]
    .sort()
    .map(([k, v]) => `${k.toFixed(2)}:${v}`)
    .join(' '),
);
for (const [a, b] of pairs.slice(0, 12)) console.log('  ', name(a), '|', name(b));
const almond = catalog.tiles.filter((t) => /ALMOND|BIANCO|CREAM/.test(t.code));
for (const t of almond) console.log('  ', name(t.id), '→', [...neighbours.get(t.id)!].map(name).join(' | '));
writeFileSync(
  join(out, 'features', 'catalog', 'groups.json'),
  JSON.stringify({ cos: COS, deltaE: DE, model: 'dinov2-small-q4f16.single.pooled', pairs }),
);
