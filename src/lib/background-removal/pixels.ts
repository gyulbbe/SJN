/** Model preprocessing and matte composition are pure to test independently of GPU/browser APIs. */
export function normalizeRgbNchw(rgba: Uint8ClampedArray, width: number, height: number) {
  if (rgba.length !== width * height * 4 || width < 1 || height < 1)
    throw new Error('분석 이미지의 크기가 맞지 않아요.');
  const pixels = width * height;
  const result = new Float32Array(pixels * 3);
  const mean = [0.485, 0.456, 0.406];
  const std = [0.229, 0.224, 0.225];
  for (let i = 0; i < pixels; i++) {
    const alpha = rgba[i * 4 + 3] / 255;
    for (let channel = 0; channel < 3; channel++) {
      // Analyze transparency over white; the original RGB and alpha are retained for output.
      const rgb = rgba[i * 4 + channel] * alpha + 255 * (1 - alpha);
      result[channel * pixels + i] = (rgb / 255 - mean[channel]) / std[channel];
    }
  }
  return result;
}

export function halfToNumber(value: number) {
  const sign = value & 0x8000 ? -1 : 1;
  const exponent = (value >>> 10) & 0x1f;
  const fraction = value & 0x3ff;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 31) return fraction ? NaN : sign * Infinity;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

/** IEEE-754 round-to-nearest, ties-to-even; ORT uses Uint16Array for float16 tensors. */
export function float32ToHalf(values: Float32Array) {
  const bits = new Uint32Array(values.buffer, values.byteOffset, values.length);
  const output = new Uint16Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const b = bits[i];
    const sign = (b >>> 16) & 0x8000;
    const exponent = ((b >>> 23) & 0xff) - 127 + 15;
    const mantissa = b & 0x7fffff;
    if (exponent >= 31) {
      output[i] = sign | 0x7c00 | (((b >>> 23) & 0xff) === 255 && mantissa ? 0x200 : 0);
    } else if (exponent <= 0) {
      if (exponent < -10) {
        output[i] = sign;
        continue;
      }
      const significant = mantissa | 0x800000;
      const shift = 14 - exponent;
      const round = (1 << (shift - 1)) - 1 + ((significant >>> shift) & 1);
      output[i] = sign | ((significant + round) >>> shift);
    } else {
      const rounded = mantissa + 0xfff + ((mantissa >>> 13) & 1);
      output[i] = sign | ((exponent << 10) + (rounded >>> 13));
    }
  }
  return output;
}

export function sigmoidMask(logits: Float32Array | Uint16Array, type: 'float32' | 'float16') {
  const mask = new Float32Array(logits.length);
  for (let i = 0; i < logits.length; i++) {
    const value = type === 'float16' ? halfToNumber(logits[i]) : logits[i];
    if (!Number.isFinite(value))
      throw new Error('AI 모델이 유효하지 않은 마스크를 반환했어요. 다시 시도해 주세요.');
    mask[i] = value >= 0 ? 1 / (1 + Math.exp(-value)) : Math.exp(value) / (1 + Math.exp(value));
  }
  return mask;
}

/** Half-pixel bilinear sampling (align_corners=false), matching the model's resize convention. */
export function applyMaskToOriginalAlpha(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  mask: Float32Array,
  maskWidth: number,
  maskHeight: number,
) {
  if (
    rgba.length !== width * height * 4 ||
    mask.length !== maskWidth * maskHeight ||
    ![width, height, maskWidth, maskHeight].every((value) => Number.isInteger(value) && value > 0)
  )
    throw new Error('출력 이미지와 마스크의 크기가 맞지 않아요.');
  const left = new Int32Array(width);
  const right = new Int32Array(width);
  const weights = new Float32Array(width);
  for (let x = 0; x < width; x++) {
    const mx = Math.max(0, Math.min(maskWidth - 1, ((x + 0.5) * maskWidth) / width - 0.5));
    left[x] = Math.floor(mx);
    right[x] = Math.min(maskWidth - 1, left[x] + 1);
    weights[x] = mx - left[x];
  }
  for (let y = 0; y < height; y++) {
    const my = Math.max(0, Math.min(maskHeight - 1, ((y + 0.5) * maskHeight) / height - 0.5));
    const y0 = Math.floor(my),
      y1 = Math.min(maskHeight - 1, y0 + 1),
      wy = my - y0;
    for (let x = 0; x < width; x++) {
      const a =
        mask[y0 * maskWidth + left[x]] * (1 - weights[x]) + mask[y0 * maskWidth + right[x]] * weights[x];
      const b =
        mask[y1 * maskWidth + left[x]] * (1 - weights[x]) + mask[y1 * maskWidth + right[x]] * weights[x];
      const alpha = Math.max(0, Math.min(1, a * (1 - wy) + b * wy));
      const offset = (y * width + x) * 4 + 3;
      rgba[offset] = Math.round(rgba[offset] * alpha);
    }
  }
  return rgba;
}
