// Contact sheet of a real direction-photo run (tests/direction-photo-real/run.mjs): the two photos and
// their cut-outs, the four guides, every answer by direction (from the ledger), and what went into the
// slots (cut-out on a checkerboard, the anchor as a red cross). Writes test-results/direction-photo-real/sheet.png.
// Usage: node tests/direction-photo-real/sheet.mjs
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';

const OUT = 'test-results/direction-photo-real';
const INPUT = 'test-results/product-representation/real/input';
const CELL = 300,
  LABEL = 26,
  GAP = 8;
const label = (text, width = CELL) =>
  sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${LABEL}"><rect width="100%" height="100%" fill="#222"/><text x="8" y="18" font-family="Malgun Gothic, sans-serif" font-size="15" fill="#fff">${text}</text></svg>`,
    ),
  )
    .png()
    .toBuffer();
const checker = (size) =>
  sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><defs><pattern id="c" width="20" height="20" patternUnits="userSpaceOnUse"><rect width="10" height="10" fill="#ddd"/><rect x="10" y="10" width="10" height="10" fill="#ddd"/></pattern></defs><rect width="100%" height="100%" fill="#fff"/><rect width="100%" height="100%" fill="url(#c)"/></svg>`,
    ),
  )
    .png()
    .toBuffer();
async function tile(file, text, anchor) {
  // A file that is not a picture (a slot read before its image loaded) is shown as such, not skipped.
  if (
    !(await sharp(file)
      .metadata()
      .then(
        () => true,
        () => false,
      ))
  )
    return sharp({ create: { width: CELL, height: CELL + LABEL, channels: 4, background: '#ffffff' } })
      .composite([{ input: await label(`${text} (그림을 읽지 못함)`), left: 0, top: 0 }])
      .png()
      .toBuffer();
  const fitted = await sharp(file)
    .resize(CELL - 8, CELL - 8, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 0 } })
    .png()
    .toBuffer({ resolveWithObject: true });
  const layers = [
    {
      input: fitted.data,
      left: 4 + Math.round((CELL - 8 - fitted.info.width) / 2),
      top: LABEL + 4 + Math.round((CELL - 8 - fitted.info.height) / 2),
    },
  ];
  if (anchor) {
    const x = layers[0].left + anchor[0] * fitted.info.width,
      y = layers[0].top + anchor[1] * fitted.info.height;
    layers.push({
      input: Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22"><path d="M11 0V22M0 11H22" stroke="#e00" stroke-width="3"/></svg>`,
      ),
      left: Math.round(x - 11),
      top: Math.round(y - 11),
    });
  }
  return sharp({ create: { width: CELL, height: CELL + LABEL, channels: 4, background: '#ffffff' } })
    .composite([
      ...(anchor ? [{ input: await checker(CELL), left: 0, top: LABEL }] : []),
      ...layers,
      { input: await label(text), left: 0, top: 0 },
    ])
    .png()
    .toBuffer();
}
const ledger = readFileSync(`${OUT}/ledger.jsonl`, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const answers = readdirSync(`${OUT}/answers`).sort();
const slots = existsSync(`${OUT}/slots.json`) ? JSON.parse(readFileSync(`${OUT}/slots.json`, 'utf8')) : [];
const rows = [
  [
    [`${INPUT}/61-bathtub-3q-white.png`, '사진 1(흰 배경)'],
    [`${INPUT}/55-bathtub-3q-top.webp`, '사진 2(연출 배경)'],
    [`${OUT}/ref-1-cutout-on-white.png`, '사진 1 배경 지움'],
    [`${OUT}/ref-2-cutout-on-white.png`, '사진 2 배경 지움'],
  ],
  ['정면', '왼쪽', '오른쪽', '뒤'].map((d) => [`${OUT}/guide-${d}.png`, `가이드 ${d}`]),
];
for (const direction of ['front', 'left', 'back']) {
  const files = answers.filter((name) => name.includes(`-${direction}-`));
  rows.push(
    files.map((name) => {
      const n = Number(name.slice(0, 2));
      const row = ledger.find((r) => r.n === n);
      return [
        `${OUT}/answers/${name}`,
        `#${n} ${direction} seed ${row?.seed} · ${(row?.ms / 1000).toFixed(1)}s`,
      ];
    }),
  );
}
const slotRow = slots.map((slot) => [
  `${OUT}/slot-${slot.direction}.png`,
  `칸 ${slot.direction} · 기준점 ${slot.anchorPercent.join(', ')}%`,
  [slot.anchorPercent[0] / 100, slot.anchorPercent[1] / 100],
]);
if (slotRow.length) rows.push(slotRow);
const columns = Math.max(...rows.map((row) => row.length));
const composites = [];
for (const [r, row] of rows.entries())
  for (const [c, [file, text, anchor]] of row.entries())
    composites.push({
      input: await tile(file, text, anchor),
      left: c * (CELL + GAP),
      top: r * (CELL + LABEL + GAP),
    });
const sheet = await sharp({
  create: {
    width: columns * (CELL + GAP),
    height: rows.length * (CELL + LABEL + GAP),
    channels: 3,
    background: '#bbbbbb',
  },
})
  .composite(composites)
  .png()
  .toBuffer();
writeFileSync(`${OUT}/sheet.png`, sheet);
console.log(`${OUT}/sheet.png`, rows.length, 'rows');
