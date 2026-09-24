/** Alpha bounds in the original input coordinate system; never infer a missing background. */
export function foregroundBounds(data: Uint8ClampedArray, width: number, height: number) {
  let minX = width,
    minY = height,
    maxX = -1,
    maxY = -1,
    clear = 0;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const alpha = data[(y * width + x) * 4 + 3];
      if (alpha < 16) clear++;
      if (alpha > 32) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  if (maxX < minX || maxY < minY)
    throw new Error('제품이 보이지 않는 투명 이미지예요. 다른 사진을 선택해 주세요.');
  if (clear < width * height * 0.01)
    throw new Error('먼저 AI 배경 제거로 제품의 배경을 투명하게 만든 뒤 입체화 생성을 실행해 주세요.');
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}
/**
 * Cleans a cut-out edge before it is composited on the model's grey background: semi-transparent
 * border pixels take the colour of their solid neighbours (so no grey halo is baked into the
 * product colours), then the alpha shrinks by `radius` pixels to drop the leftover fringe.
 */
export function defringeAlpha(data: Uint8ClampedArray, width: number, height: number, radius = 1) {
  const out = new Uint8ClampedArray(data);
  const known = new Uint8Array(width * height);
  for (let i = 0; i < known.length; i++) known[i] = data[i * 4 + 3] >= 250 ? 1 : 0;
  for (let pass = 0; pass < 4; pass++) {
    const filled: number[] = [];
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (known[i] || !out[i * 4 + 3]) continue;
        let r = 0,
          g = 0,
          b = 0,
          count = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx,
              ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            const n = ny * width + nx;
            if (!known[n]) continue;
            r += out[n * 4];
            g += out[n * 4 + 1];
            b += out[n * 4 + 2];
            count++;
          }
        if (!count) continue;
        out[i * 4] = r / count;
        out[i * 4 + 1] = g / count;
        out[i * 4 + 2] = b / count;
        filled.push(i);
      }
    if (!filled.length) break;
    for (const i of filled) known[i] = 1;
  }
  if (radius > 0) {
    // Separable minimum filter on alpha: rows, then columns.
    const row = new Uint8ClampedArray(width * height);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        let min = 255;
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = Math.min(width - 1, Math.max(0, x + dx));
          min = Math.min(min, out[(y * width + nx) * 4 + 3]);
        }
        row[y * width + x] = min;
      }
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        let min = 255;
        for (let dy = -radius; dy <= radius; dy++) {
          const ny = Math.min(height - 1, Math.max(0, y + dy));
          min = Math.min(min, row[ny * width + x]);
        }
        out[(y * width + x) * 4 + 3] = min;
      }
  }
  return out;
}
export function rgbNchw(data: Uint8ClampedArray, width: number, height: number) {
  const n = width * height;
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) out[c * n + i] = data[i * 4 + c] / 255;
  return out;
}
/** ViT output [1,768,1025] -> transformer input [1,1025,768]. */
export function transposeTokens(data: Float32Array, channels = 768, tokens = 1025) {
  if (data.length !== channels * tokens) throw new Error('AI 이미지 특징의 크기가 모델과 맞지 않아요.');
  const out = new Float32Array(data.length);
  for (let c = 0; c < channels; c++)
    for (let t = 0; t < tokens; t++) out[t * channels + c] = data[c * tokens + t];
  return out;
}
