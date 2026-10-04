// Compares two sets of AI-input captures (capture-views.mjs): the mean absolute difference per view, and a
// sheet with both sets and the difference. No AI call.
// Usage: node tests/product-representation/compare-views.mjs <label A> <label B> [view ...]
import sharp from 'sharp';
import { sheet } from './sheet.mjs';
import { ROOT } from './lib.mjs';
const [a, b, ...rest] = process.argv.slice(2);
const views = rest.length ? rest : ['정면', '오른쪽', '위에서'];
const rows = [[], [], []];
for (const view of views) {
  const left = await sharp(`${ROOT}/views/${a}-${view}.png`)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const right = await sharp(`${ROOT}/views/${b}-${view}.png`)
    .removeAlpha()
    .resize(left.info.width, left.info.height)
    .raw()
    .toBuffer();
  const diff = Buffer.alloc(left.data.length);
  let sum = 0,
    over = 0;
  for (let i = 0; i < left.data.length; i++) {
    const d = Math.abs(left.data[i] - right[i]);
    sum += d;
    if (d > 24) over++;
    diff[i] = 255 - Math.min(255, d * 4);
  }
  const mean = sum / left.data.length;
  console.log(
    `${view}: mean abs difference ${mean.toFixed(3)} / 255, ${((over / left.data.length) * 100).toFixed(2)}% of values differ by more than 24`,
  );
  const file = `${ROOT}/views/diff-${a}-${b}-${view}.png`;
  await sharp(diff, { raw: { width: left.info.width, height: left.info.height, channels: 3 } })
    .png()
    .toFile(file);
  rows[0].push({ file: `${ROOT}/views/${a}-${view}.png`, label: `${a} · ${view}` });
  rows[1].push({ file: `${ROOT}/views/${b}-${view}.png`, label: `${b} · ${view}` });
  rows[2].push({ file, label: `差 ${view} (평균 ${mean.toFixed(2)})`.replace('差', '차이') });
}
await sheet(rows, `${ROOT}/report/10-compare-${a}-${b}.png`, {
  cellW: 598,
  cellH: 399,
  title: `${a} 대 ${b}`,
});
