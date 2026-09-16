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
