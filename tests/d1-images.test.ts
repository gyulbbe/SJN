import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { validateD1Image } from '../src/lib/d1/images';

describe('Worker image container validation', () => {
  it.each(['png', 'jpeg', 'webp'] as const)(
    'accepts real %s output and measures server dimensions',
    async (format) => {
      const bytes = new Uint8Array(
        await sharp({ create: { width: 17, height: 23, channels: 3, background: '#665544' } })
          [format]()
          .toBuffer(),
      );
      expect(validateD1Image(bytes)).toEqual({ mime: `image/${format}`, width: 17, height: 23 });
      expect(() => validateD1Image(bytes.slice(0, -10))).toThrow();
    },
  );
  it('applies JPEG EXIF orientation without decoding pixels', async () => {
    const bytes = new Uint8Array(
      await sharp({ create: { width: 17, height: 23, channels: 3, background: 'red' } })
        .withMetadata({ orientation: 6 })
        .jpeg()
        .toBuffer(),
    );
    expect(validateD1Image(bytes)).toEqual({ mime: 'image/jpeg', width: 23, height: 17 });
  });
  it('rejects excessive dimensions and forged image content', async () => {
    const bytes = new Uint8Array(
      await sharp({ create: { width: 1, height: 1, channels: 3, background: 'red' } })
        .png()
        .toBuffer(),
    );
    new DataView(bytes.buffer).setUint32(16, 40_000_001);
    expect(() => validateD1Image(bytes)).toThrow();
    expect(() => validateD1Image(new TextEncoder().encode('<svg><script>bad</script></svg>'))).toThrow();
  });
  it('accepts a progressive JPEG and reads through all of its scans', async () => {
    const bytes = new Uint8Array(
      await sharp({ create: { width: 33, height: 21, channels: 3, background: '#445566' } })
        .jpeg({ progressive: true })
        .toBuffer(),
    );
    expect(validateD1Image(bytes)).toEqual({ mime: 'image/jpeg', width: 33, height: 21 });
  });
  it('rejects anything after the first JPEG, even a second JPEG that ends the file with FFD9', async () => {
    const first = new Uint8Array(
      await sharp({ create: { width: 8, height: 8, channels: 3, background: 'red' } })
        .jpeg()
        .toBuffer(),
    );
    // Before 2026-09-27 the check stopped at the first scan and only looked at the last two bytes.
    const second = new Uint8Array(first.length * 2);
    second.set(first);
    second.set(first, first.length);
    expect(() => validateD1Image(second)).toThrow('HDR·움직이는 사진');
    const padded = new Uint8Array(first.length + 4);
    padded.set(first);
    expect(() => validateD1Image(padded)).toThrow('HDR·움직이는 사진');
    // A JPEG cut before its EOI stays a damaged image.
    expect(() => validateD1Image(first.subarray(0, first.length - 2))).toThrow('손상된 이미지');
  });
  it('rejects APNG animation chunks even when the initial frame is a valid PNG', async () => {
    const png = new Uint8Array(
      await sharp({ create: { width: 1, height: 1, channels: 3, background: 'red' } })
        .png()
        .toBuffer(),
    );
    const chunk = new Uint8Array(20);
    new DataView(chunk.buffer).setUint32(0, 8);
    chunk.set(new TextEncoder().encode('acTL'), 4);
    const bytes = new Uint8Array(png.length + chunk.length);
    bytes.set(png.subarray(0, 33));
    bytes.set(chunk, 33);
    bytes.set(png.subarray(33), 53);
    expect(() => validateD1Image(bytes)).toThrow();
  });
});
