/**
 * Backlog item 9, step 38 (no AI call): for every view photo of the public catalogue's products that are
 * not tiles (catalog.mjs), the colour the app sends for a photo product next to the product's own colour.
 *   - app: scene.ts `averageColor` (the photo drawn into 48 × 48, alpha-weighted mean), said by prompt.ts
 *     `colorWords` (ceramics that are light but not "white" are said white since 2026-11-19);
 *   - product: the pixels left after taking off the photo's background (transparent pixels, and opaque
 *     pixels joined to the border within 18 of the border's colour), their median;
 *   - the background's share of the 48 × 48 weight, and the catalogue record's colour and finish words.
 * Usage: npx tsx tests/photo-colour/colours.ts
 * Output: test-results/photo-colour-20261126/colours.json and a table on stdout
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { colorWords, FLUX_CERAMIC_KINDS } from '../../src/lib/ai-export/prompt';
import type { FluxFixtureKind } from '../../src/lib/ai-export/scene-contract';

const OUT = join(process.cwd(), 'test-results', 'photo-colour-20261126');
const catalog = JSON.parse(readFileSync(join(OUT, 'catalog', 'catalog.json'), 'utf8')) as {
  placements: {
    materialId: string;
    name: string;
    category: string;
    color: string;
    finish: string;
    views: { assetId: string; direction: string }[];
    images: { id: string; kind: string }[];
  }[];
};
const files = readdirSync(join(OUT, 'catalog', 'images'));
const hex = (r: number, g: number, b: number) =>
  `#${[r, g, b]
    .map((v) =>
      Math.round(Math.max(0, Math.min(255, v)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;

async function measure(file: string) {
  // The app: drawImage into 48 × 48, then the alpha-weighted mean.
  const small = await sharp(file).ensureAlpha().resize(48, 48, { fit: 'fill' }).raw().toBuffer();
  let r = 0,
    g = 0,
    b = 0,
    w = 0;
  for (let i = 0; i < small.length; i += 4) {
    const a = small[i + 3] / 255;
    r += small[i] * a;
    g += small[i + 1] * a;
    b += small[i + 2] * a;
    w += a;
  }
  const app = hex(r / w, g / w, b / w);
  // The product: the full list image without its background.
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const at = (x: number, y: number) => (y * width + x) * 4;
  const border: number[][] = [];
  for (let x = 0; x < width; x++)
    for (const y of [0, height - 1]) border.push([...data.subarray(at(x, y), at(x, y) + 4)]);
  for (let y = 0; y < height; y++)
    for (const x of [0, width - 1]) border.push([...data.subarray(at(x, y), at(x, y) + 4)]);
  const opaqueBorder = border.filter((p) => p[3] > 200);
  const median = (v: number[]) => [...v].sort((p, q) => p - q)[v.length >> 1];
  const bg =
    opaqueBorder.length > border.length / 2
      ? [0, 1, 2].map((c) => median(opaqueBorder.map((p) => p[c])))
      : undefined;
  const background = new Uint8Array(width * height);
  if (bg) {
    const near = (i: number) => Math.max(...[0, 1, 2].map((c) => Math.abs(data[i * 4 + c] - bg[c]))) <= 18;
    const stack: number[] = [];
    for (let x = 0; x < width; x++) stack.push(x, (height - 1) * width + x);
    for (let y = 0; y < height; y++) stack.push(y * width, y * width + width - 1);
    while (stack.length) {
      const i = stack.pop()!;
      if (background[i] || data[i * 4 + 3] < 128 || !near(i)) continue;
      background[i] = 1;
      const x = i % width,
        y = (i / width) | 0;
      if (x > 0) stack.push(i - 1);
      if (x < width - 1) stack.push(i + 1);
      if (y > 0) stack.push(i - width);
      if (y < height - 1) stack.push(i + width);
    }
  }
  const fg: number[][] = [];
  let transparent = 0,
    bgWeight = 0,
    allWeight = 0;
  for (let i = 0; i < width * height; i++) {
    const a = data[i * 4 + 3] / 255;
    allWeight += a;
    if (a < 0.5) transparent++;
    if (background[i]) bgWeight += a;
    else if (a >= 0.5) fg.push([data[i * 4], data[i * 4 + 1], data[i * 4 + 2]]);
  }
  const product = hex(...([0, 1, 2].map((c) => median(fg.map((p) => p[c]))) as [number, number, number]));
  return {
    app,
    product,
    transparent: +((100 * transparent) / (width * height)).toFixed(1),
    background: bg ? hex(bg[0], bg[1], bg[2]) : undefined,
    backgroundShare: +((100 * bgWeight) / allWeight).toFixed(1),
  };
}

const said = (kind: string, color: string) =>
  FLUX_CERAMIC_KINDS.includes(kind as FluxFixtureKind) &&
  [1, 3, 5].every((k) => parseInt(color.slice(k, k + 2), 16) >= 0xb0) &&
  !colorWords(color).startsWith('white')
    ? 'white (ceramic rule)'
    : colorWords(color);
const rows = [];
for (const p of catalog.placements) {
  const photos = p.views.length
    ? p.views
    : p.images.filter((i) => i.kind === 'product').map((i) => ({ assetId: i.id, direction: '-' }));
  for (const view of photos) {
    const file = files.find((f) => f.startsWith(`${view.assetId}.`));
    if (!file) continue;
    const m = await measure(join(OUT, 'catalog', 'images', file));
    const row = {
      kind: p.category,
      name: p.name,
      record: `${p.color}/${p.finish}`,
      view: view.direction,
      ...m,
      sent: said(p.category, m.app),
      productWords: colorWords(m.product),
    };
    rows.push(row);
    console.log(
      `${p.category.padEnd(7)} ${p.name.slice(0, 22).padEnd(22)} ${view.direction.padEnd(3)} ${row.record.padEnd(8)} app ${m.app} → "${row.sent}" | product ${m.product} "${row.productWords}" | bg ${m.background ?? '-'} ${m.backgroundShare}% transp ${m.transparent}%`,
    );
  }
}
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'colours.json'), JSON.stringify(rows, null, 1));
