// Per-product outcome numbers of experiment C from a run saved by ai-run.mjs, with no AI call: the outline
// overlap (IoU) and height ratio that refine-run.ts judges by. The app computes them from the 3D close-up's
// own silhouette and the background model's cut-out of the answer; the cut-outs are the app's real ones
// (ai-run.mjs keeps the worker's inputs and results), the silhouette is rebuilt from the close-up the
// model was sent (the product alone on white, so everything not connected to the border is product),
// stretched back onto the crop's grid. Expect it to agree with the app to about 0.02 (checked against the
// kept product whose overlap the dialog printed). Uses alignToSilhouette itself.
// Usage: node tests/product-representation/measure-refine.mjs <run label> <tag, e.g. 실험_C_제품별_다듬기-정면>
import { build } from 'esbuild';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';
const [label, tag] = process.argv.slice(2);
const dir = `test-results/product-representation/ai/${label}`;
const bundle = 'tmp/refine-bundle.mjs';
await build({
  stdin: {
    contents:
      "export { alignToSilhouette, cutoutAlpha, REFINE_MIN_IOU, REFINE_HEIGHT_RATIO } from './src/lib/ai-export/refine'; export { fluxInputLayout } from './src/lib/ai-export/contract';",
    resolveDir: process.cwd(),
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: bundle,
  logLevel: 'error',
});
const lib = await import(`file:///${process.cwd().replace(/\\/g, '/')}/${bundle}`);
const raw = async (file) => {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8ClampedArray(data), width: info.width, height: info.height };
};
const calls = JSON.parse(readFileSync(`${dir}/${tag}-calls.json`, 'utf8'));
const files = readdirSync(dir);
const products = [];
for (const c of calls.calls.filter((c) => c.url.endsWith('/product'))) {
  const base = `${dir}/${tag}-call${c.index}`;
  const fact = JSON.parse(readFileSync(`${base}-product.json`, 'utf8'));
  const input = await raw(`${base}-image.png`);
  products.push({ index: c.index, fact, input });
}
const cutIds = files
  .filter((f) => f.startsWith(`${tag}-bg`) && f.endsWith('-out.png'))
  .map((f) => Number(f.match(/-bg(\d+)-out/)[1]));
/** The 3D product's silhouette on the model's input grid: not-white and not connected to the white border. */
function silhouette(image) {
  const { data, width, height } = image;
  const white = (i) => data[i * 4] >= 250 && data[i * 4 + 1] >= 250 && data[i * 4 + 2] >= 250;
  const background = new Uint8Array(width * height);
  const stack = [];
  const push = (x, y) => {
    const i = y * width + x;
    if (x < 0 || y < 0 || x >= width || y >= height || background[i] || !white(i)) return;
    background[i] = 1;
    stack.push(i);
  };
  for (let x = 0; x < width; x++) {
    push(x, 0);
    push(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    push(0, y);
    push(width - 1, y);
  }
  while (stack.length) {
    const i = stack.pop();
    const x = i % width,
      y = Math.floor(i / width);
    push(x + 1, y);
    push(x - 1, y);
    push(x, y + 1);
    push(x, y - 1);
  }
  return Uint8Array.from(background, (b) => (b ? 0 : 255));
}
const rows = [];
for (const id of cutIds) {
  const cutIn = await raw(`${dir}/${tag}-bg${id}-in.png`);
  const cutOut = await raw(`${dir}/${tag}-bg${id}-out.png`);
  const W = cutIn.width,
    H = cutIn.height;
  const layout = lib.fluxInputLayout(W, H);
  const match = products.filter((p) => p.input.width === layout.width && p.input.height === layout.height);
  if (match.length !== 1) {
    rows.push({
      bg: id,
      error: `crop ${W}x${H} -> input ${layout.width}x${layout.height} matches ${match.length} products`,
    });
    continue;
  }
  const product = match[0];
  const mask = silhouette(product.input);
  // The crop's grid pixel (x, y) is the model input's (layout.x + x * scale, layout.y + y * scale).
  const coverage = new Uint8Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const mx = Math.min(
        product.input.width - 1,
        Math.max(0, Math.floor(layout.x + (x + 0.5) * layout.scale)),
      );
      const my = Math.min(
        product.input.height - 1,
        Math.max(0, Math.floor(layout.y + (y + 0.5) * layout.scale)),
      );
      coverage[y * W + x] = mask[my * product.input.width + mx];
    }
  const alpha = lib.cutoutAlpha(cutOut, { width: W, height: H });
  const result = lib.alignToSilhouette(alpha, coverage, W, H);
  const verdict =
    'failure' in result
      ? { failure: result.failure }
      : {
          iou: +result.iou.toFixed(3),
          plainIou: +result.plainIou.toFixed(3),
          ratio: +result.ratio.toFixed(3),
        };
  const row = {
    bg: id,
    call: product.index,
    kind: product.fact.kind,
    color: product.fact.color,
    sizeMm: product.fact.sizeMm,
    crop: `${W}x${H}`,
    ...verdict,
    status:
      'failure' in result
        ? `kept:${result.failure}`
        : result.iou >= lib.REFINE_MIN_IOU
          ? 'refined'
          : 'kept:shape',
  };
  rows.push(row);
}
writeFileSync(`${dir}/${tag}-measure.json`, JSON.stringify(rows, null, 1));
console.log(JSON.stringify(rows));
