// Backlog item 6: light streaks and shadows the AI draws over a big fixture (the bath). For each answer of
// the big-fixture scenes (tests/side-tile-ai with SIDE_TILE_SPECS=big), the bath's pixels — the capture's
// fixture mask inside the bath's box (grounding.json), mapped onto the 2× result through layout.json —
// compared in L* with the render (the design):
//   dark    share of bath pixels more than 12 L* darker than the render (shadows drawn over it)
//   bright  share more than 12 L* lighter (reflections, light patches)
//   spread  standard deviation of (result − render) over the bath after its mean: uneven light over it
// for the AI's answer with the backdrop back ("original") and the app's finished picture ("refined").
// Also writes zoom-<id>.png: render | original | refined around the bath.
// Usage: SIDE_TILE_OUT=test-results/big-fixture-20261124 node tests/big-fixture/streaks.mjs [--rev app]
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { OUT } from '../side-tile-ai/paths.mjs';

const at = process.argv.indexOf('--rev');
const rev = at > 0 ? process.argv[at + 1] : 'app';
// --refined name: another finished folder (refine.ts --suffix), compared the same way.
const rAt = process.argv.indexOf('--refined');
const REFINED = rAt > 0 ? process.argv[rAt + 1] : 'refined';
const lin = (v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const lstar = (d, i) => {
  const Y = 0.2126 * lin(d[i]) + 0.7152 * lin(d[i + 1]) + 0.0722 * lin(d[i + 2]);
  return Y > 216 / 24389 ? 116 * Math.cbrt(Y) - 16 : (24389 / 27) * Y;
};
const rows = [];
const root = join(OUT, rev);
for (const file of readdirSync(join(root, REFINED))
  .filter((f) => f.endsWith('.png'))
  .sort()) {
  const id = file.slice(0, -4);
  const scene = id.replace(/-\d+$/, '');
  const dir = join(root, 'scenes', scene);
  const grounding = JSON.parse(readFileSync(join(dir, 'grounding.json'), 'utf8'));
  const bath = grounding.scene.fixtures.find((f) => f.kind === 'bath');
  if (!bath) continue;
  const saved = JSON.parse(readFileSync(join(dir, 'layout.json'), 'utf8'));
  const L = saved.layout ?? saved;
  const cap = await sharp(join(dir, 'capture.png')).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const mask = await sharp(join(dir, 'mask.png'))
    .extractChannel(0)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const cw = cap.info.width,
    ch = cap.info.height;
  // INNER=1: only the inner front face (away from the box edges by 10% of its width, below its top 35%,
  // above its bottom 8%), so a bath the model drew a little shifted or with another rim does not count.
  const [ox0, oy0, ox1, oy1] = bath.box;
  const inner = process.env.INNER === '1';
  const ix = inner ? 0.1 * (ox1 - ox0) : 0;
  const [bx0, by0, bx1, by1] = inner
    ? [ox0 + ix, oy0 + 0.35 * (oy1 - oy0), ox1 - ix, oy1 - 0.08 * (oy1 - oy0)]
    : [ox0, oy0, ox1, oy1];
  const measure = async (name) => {
    const img = await sharp(join(root, name, file))
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const { width: w, height: h } = img.info;
    const kx = L.width / w,
      ky = L.height / h;
    const d = [];
    for (let v = 0; v < h; v++) {
      const ny = ((v + 0.5) * ky - L.y) / L.contentHeight;
      if (ny < by0 || ny > by1) continue;
      const y = Math.floor(ny * ch);
      for (let u = 0; u < w; u++) {
        const nx = ((u + 0.5) * kx - L.x) / L.contentWidth;
        if (nx < bx0 || nx > bx1) continue;
        const x = Math.floor(nx * cw);
        if (x < 0 || y < 0 || x >= cw || y >= ch || mask.data[y * cw + x] !== 255) continue;
        d.push(lstar(img.data, (v * w + u) * 3) - lstar(cap.data, (y * cw + x) * 3));
      }
    }
    const mean = d.reduce((s, x) => s + x, 0) / d.length;
    const sd = Math.sqrt(d.reduce((s, x) => s + (x - mean) ** 2, 0) / d.length);
    return {
      n: d.length,
      mean: +mean.toFixed(1),
      dark: +((100 * d.filter((x) => x < -12).length) / d.length).toFixed(1),
      bright: +((100 * d.filter((x) => x > 12).length) / d.length).toFixed(1),
      spread: +sd.toFixed(1),
    };
  };
  const original = await measure('original'),
    refined = await measure(REFINED);
  rows.push({ id, original, refined });
  console.log(
    `${id.padEnd(24)} original dark ${String(original.dark).padStart(5)}% bright ${String(original.bright).padStart(5)}% spread ${String(original.spread).padStart(5)} | refined dark ${String(refined.dark).padStart(5)}% bright ${String(refined.bright).padStart(5)}% spread ${String(refined.spread).padStart(5)} (mean ${refined.mean})`,
  );
  // Zoom: the bath's box with a margin, render | original | refined, each 480 px wide.
  const pad = 0.04;
  const crop = async (f, w, h, toPx) => {
    const [x0, y0] = toPx(Math.max(0, bx0 - pad), Math.max(0, by0 - pad));
    const [x1, y1] = toPx(Math.min(1, bx1 + pad), Math.min(1, by1 + pad));
    return sharp(f)
      .extract({ left: x0, top: y0, width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0) })
      .resize({ width: 480 })
      .png()
      .toBuffer({ resolveWithObject: true });
  };
  const capPx = (nx, ny) => [Math.round(nx * cw), Math.round(ny * ch)];
  const resPx = (nx, ny) => [
    Math.round(((L.x + nx * L.contentWidth) / L.width) * 992),
    Math.round(((L.y + ny * L.contentHeight) / L.height) * 672),
  ];
  const tiles = [
    await crop(join(dir, 'capture.png'), cw, ch, capPx),
    await crop(join(root, 'original', file), 992, 672, resPx),
    await crop(join(root, REFINED, file), 992, 672, resPx),
  ];
  const th = Math.max(...tiles.map((t) => t.info.height));
  await sharp({ create: { width: 3 * 486, height: th, channels: 3, background: '#ffffff' } })
    .composite(tiles.map((t, i) => ({ input: t.data, left: i * 486, top: 0 })))
    .png()
    .toFile(join(OUT, `zoom-${REFINED}-${id}.png`));
}
writeFileSync(join(OUT, `streaks-${rev}-${REFINED}.json`), JSON.stringify(rows, null, 1));
