// Contact sheets for the study (sharp): grid of labelled images.
// Usage as a module: import { sheet } from './sheet.mjs'
import sharp from 'sharp';
const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;');
/** cells: rows of { file, label }; every image is fitted into cellW x cellH on white. */
export async function sheet(rows, out, { cellW = 560, cellH = 380, title } = {}) {
  const header = 28;
  const pad = 8;
  const rowCount = rows.length;
  const colCount = Math.max(...rows.map((r) => r.length));
  const W = colCount * (cellW + pad) + pad;
  const top = title ? 36 : 0;
  const H = top + rowCount * (cellH + header + pad) + pad;
  const layers = [];
  if (title)
    layers.push({
      input: Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${top}"><text x="${pad}" y="26" font-size="22" font-family="sans-serif" font-weight="bold">${esc(title)}</text></svg>`,
      ),
      left: 0,
      top: 0,
    });
  for (const [r, row] of rows.entries())
    for (const [c, cell] of row.entries()) {
      const x = pad + c * (cellW + pad),
        y = top + pad + r * (cellH + header + pad);
      layers.push({
        input: Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="${cellW}" height="${header}"><text x="2" y="20" font-size="16" font-family="sans-serif">${esc(cell.label)}</text></svg>`,
        ),
        left: x,
        top: y,
      });
      if (!cell.file) continue;
      const img = await sharp(cell.file)
        .flatten({ background: '#ffffff' })
        .resize(cellW, cellH, { fit: 'contain', background: '#ffffff' })
        .png()
        .toBuffer();
      layers.push({ input: img, left: x, top: y + header });
    }
  await sharp({ create: { width: W, height: H, channels: 3, background: '#e8e8e8' } })
    .composite(layers)
    .png()
    .toFile(out);
  return out;
}
