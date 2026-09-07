import { describe, expect, it } from 'vitest';
import { MAX_IMAGE_PIXELS, previewDimensions, readImageHeader } from '../src/lib/images';

function png(width: number, height: number) {
  const bytes = new Uint8Array(32);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  bytes.set([73, 72, 68, 82], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width); view.setUint32(20, height);
  return bytes;
}

describe('image validation before browser decode', () => {
  it('reads PNG pixels and preserves portrait orientation for sizing', () => {
    expect(readImageHeader(png(3000, 4000))).toEqual({ mime: 'image/png', width: 3000, height: 4000 });
    expect(previewDimensions(3000, 4000)).toEqual({ width: 1536, height: 2048 });
  });
  it('rejects oversized compressed pixel dimensions before decoding', () => {
    expect(() => readImageHeader(png(MAX_IMAGE_PIXELS, 2))).toThrow('4,000만');
  });
  it('does not upscale a small texture', () => {
    expect(previewDimensions(300, 600)).toEqual({ width: 300, height: 600 });
  });
  it('rejects disguised SVG and corrupt or empty image headers', () => {
    expect(() => readImageHeader(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toThrow();
    expect(() => readImageHeader(new Uint8Array())).toThrow();
    expect(() => readImageHeader(png(0, 200))).toThrow();
  });
  it('reads progressive JPEG after an APP metadata segment', () => {
    const bytes = new Uint8Array([255, 216, 255, 225, 0, 4, 0, 0, 255, 194, 0, 7, 8, 3, 32, 4, 176, 255, 217]);
    expect(readImageHeader(bytes)).toEqual({ mime: 'image/jpeg', width: 1200, height: 800 });
  });
  it('rejects JPEG with a truncated metadata segment rather than reading out of bounds', () => {
    expect(() => readImageHeader(new Uint8Array([255, 216, 255, 225, 255, 255, 0, 0, 255, 194, 0, 7]))).toThrow();
  });
  it('reads extended WebP including its 24-bit pixel sizes', () => {
    const bytes = new Uint8Array(30);
    bytes.set(new TextEncoder().encode('RIFF'), 0); bytes.set(new TextEncoder().encode('WEBPVP8X'), 8);
    bytes[24] = 87; bytes[25] = 2; bytes[27] = 43; bytes[28] = 1;
    expect(readImageHeader(bytes)).toEqual({ mime: 'image/webp', width: 600, height: 300 });
  });
  it('reads lossless WebP without treating alpha or version bits as dimensions', () => {
    const bytes = new Uint8Array(30);
    bytes.set(new TextEncoder().encode('RIFF'), 0); bytes.set(new TextEncoder().encode('WEBPVP8L'), 8);
    bytes[20] = 47;
    const width = 321, height = 654;
    bytes[21] = (width - 1) & 255;
    bytes[22] = ((width - 1) >> 8) | (((height - 1) & 3) << 6);
    bytes[23] = ((height - 1) >> 2) & 255;
    bytes[24] = ((height - 1) >> 10) | 16;
    expect(readImageHeader(bytes)).toEqual({ mime: 'image/webp', width, height });
  });
});
