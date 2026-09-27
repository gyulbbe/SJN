import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { extractPrimaryJpeg, JpegStructureError, scanJpeg } from '../src/lib/jpeg-container';
import { validateD1Image } from '../src/lib/d1/images';

/**
 * Phone JPEGs (Ultra HDR, Apple HDR, motion photos) keep only their first image, byte for byte.
 * The repository's five real Android Ultra HDR photos are the main case; the other phone formats
 * have no real sample here, so they are built to their layout (first JPEG + marker segments +
 * appended data) from small sharp images.
 */
const PHOTOS =
  '.codex-remote-attachments/01a071fe-92b3-77b3-a261-8698b3d3f8e9/04c0e236-9188-46ed-9a61-a8ff283287f8';
const ascii = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0));
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};
const segment = (marker: number, payload: Uint8Array) =>
  concat(Uint8Array.of(0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff), payload);
/** SOI, then the given segments, then the rest of the JPEG. */
const withSegments = (jpeg: Uint8Array, ...segments: Uint8Array[]) =>
  concat(jpeg.subarray(0, 2), ...segments, jpeg.subarray(2));
const jpeg = async (options: Parameters<ReturnType<typeof sharp>['jpeg']>[0] = {}, color = '#667788') =>
  new Uint8Array(
    await sharp({ create: { width: 40, height: 24, channels: 3, background: color } })
      .jpeg(options)
      .toBuffer(),
  );
const pixels = async (bytes: Uint8Array) => sharp(bytes).rotate().raw().toBuffer();
const MPF = segment(0xe2, concat(ascii('MPF\0MM\0*\0\0\0\x08'), new Uint8Array(40)));
const ISO_GAIN_MAP = segment(0xe2, concat(ascii('urn:iso:std:iso:ts:21496:-1\0'), new Uint8Array(4)));
const xmp = (body: string) =>
  segment(0xe1, ascii(`http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>${body}</x:xmpmeta>`));
const CONTAINER_XMP = xmp(
  '<rdf:Description hdrgm:Version="1.0"><Container:Directory><rdf:Seq/></Container:Directory></rdf:Description>',
);
const MOTION_XMP = xmp('<rdf:Description GCamera:MotionPhoto="1" GCamera:MotionPhotoVersion="1"/>');
const PLAIN_XMP = xmp('<rdf:Description xmp:Rating="5"/>');
const MP4 = concat(Uint8Array.of(0, 0, 0, 24), ascii('ftypmp42\0\0\0\0mp42isom'), new Uint8Array(64).fill(7));

describe('JPEG structure scan', () => {
  it('reads baseline and progressive JPEGs to their EOI and leaves them unchanged', async () => {
    for (const bytes of [await jpeg(), await jpeg({ progressive: true })]) {
      const { eoi, segments } = scanJpeg(bytes);
      expect(eoi).toBe(bytes.length - 2);
      expect(segments.filter((s) => s.marker === 0xda).length).toBeGreaterThanOrEqual(1);
      expect(extractPrimaryJpeg(bytes)).toBe(bytes);
    }
    const progressive = await jpeg({ progressive: true });
    expect(scanJpeg(progressive).segments.filter((s) => s.marker === 0xda).length).toBeGreaterThan(1);
  });

  it('skips stuffing, restart markers and fill bytes inside scans, and tables between scans', () => {
    // Not decodable: sharp cannot write restart markers, so the marker structure is built by hand.
    const sof = segment(0xc0, Uint8Array.of(8, 0, 2, 0, 2, 1, 1, 0x11, 0));
    const sos = segment(0xda, Uint8Array.of(1, 1, 0, 0, 63, 0));
    const dht = segment(0xc4, Uint8Array.of(0, ...new Uint8Array(16)));
    const scan1 = Uint8Array.of(0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56, 0xff, 0xff, 0xd1, 0x78);
    const bytes = concat(
      Uint8Array.of(0xff, 0xd8),
      sof,
      sos,
      scan1,
      dht,
      sos,
      Uint8Array.of(0x9a, 0xff, 0xd9),
    );
    const { segments, eoi } = scanJpeg(bytes);
    expect(segments.map((s) => s.marker)).toEqual([0xc0, 0xda, 0xc4, 0xda]);
    expect(eoi).toBe(bytes.length - 2);
    expect(validateD1Image(bytes)).toEqual({ mime: 'image/jpeg', width: 2, height: 2 });
  });

  it('refuses a damaged JPEG instead of guessing', async () => {
    const bytes = await jpeg();
    const broken = [
      bytes.subarray(0, bytes.length - 2), // no EOI
      bytes.subarray(0, 200), // cut inside the file
      concat(bytes.subarray(0, 2), Uint8Array.of(0xff, 0xe1, 0xff, 0xf0), bytes.subarray(2)), // length past the end
      concat(bytes.subarray(0, 2), Uint8Array.of(0xff, 0xd8), bytes.subarray(2)), // a second SOI
      Uint8Array.of(0xff, 0xd8, 0x00, 0x00),
    ];
    for (const item of broken) {
      expect(() => scanJpeg(item)).toThrow(JpegStructureError);
      expect(() => extractPrimaryJpeg(item)).toThrow(JpegStructureError);
    }
  });
});

describe('first image of a phone JPEG', () => {
  it('drops an Android Ultra HDR gain map: MPF, ISO 21496-1 marker, container XMP and the second JPEG', async () => {
    const base = await jpeg({}, '#8899aa');
    const gainMap = await jpeg({}, '#222222');
    const phone = concat(withSegments(base, CONTAINER_XMP, ISO_GAIN_MAP, MPF), gainMap);
    expect(() => validateD1Image(phone)).toThrow('HDR·움직이는 사진');
    const primary = extractPrimaryJpeg(phone);
    expect(primary).toEqual(base);
    expect(validateD1Image(primary)).toEqual({ mime: 'image/jpeg', width: 40, height: 24 });
  });

  it('drops an Apple-style MPF list and its second JPEG', async () => {
    const base = await jpeg();
    const iphone = concat(withSegments(base, MPF), await jpeg({}, '#000000'));
    expect(extractPrimaryJpeg(iphone)).toEqual(base);
  });

  it('drops a motion photo video after the image (Google container XMP, Samsung tail)', async () => {
    const base = await jpeg();
    const google = concat(withSegments(base, MOTION_XMP), MP4);
    expect(() => validateD1Image(google)).toThrow();
    expect(extractPrimaryJpeg(google)).toEqual(base);
    const samsung = concat(base, ascii('MotionPhoto_Data'), MP4, ascii('SEFH\0\0\0\0SEFT'));
    expect(() => validateD1Image(samsung)).toThrow('HDR·움직이는 사진');
    expect(extractPrimaryJpeg(samsung)).toEqual(base);
  });

  it('keeps EXIF orientation, the ICC profile and ordinary XMP, and the same pixels', async () => {
    const base = new Uint8Array(
      await sharp({ create: { width: 30, height: 20, channels: 3, background: '#b0a090' } })
        .withIccProfile('p3')
        .withMetadata({ orientation: 6 })
        .jpeg()
        .toBuffer(),
    );
    const kept = withSegments(base, PLAIN_XMP);
    const primary = extractPrimaryJpeg(concat(withSegments(kept, MPF), await jpeg()));
    expect(primary).toEqual(kept);
    const [before, after] = await Promise.all([sharp(kept).metadata(), sharp(primary).metadata()]);
    expect(after.orientation).toBe(6);
    expect(after.icc).toEqual(before.icc);
    expect(validateD1Image(primary)).toEqual({ mime: 'image/jpeg', width: 20, height: 30 });
  });

  it('turns the five real Ultra HDR photos into single JPEGs that decode to the same pixels', async () => {
    const files = readdirSync(PHOTOS).filter((name) => name.endsWith('.jpg'));
    expect(files).toHaveLength(5);
    for (const name of files) {
      const original = new Uint8Array(readFileSync(`${PHOTOS}/${name}`));
      // As uploaded today: refused by the server check.
      expect(() => validateD1Image(original)).toThrow();
      const primary = extractPrimaryJpeg(original);
      const { eoi, segments } = scanJpeg(original);
      const removed = segments.filter(
        (s) =>
          (s.marker === 0xe2 && s.end - s.start === 90) || // MPF
          (s.marker === 0xe2 && s.end - s.start === 36) || // ISO 21496-1 marker
          (s.marker === 0xe1 && s.end - s.start === 926), // container XMP
      );
      expect(removed).toHaveLength(3);
      expect(primary.length).toBe(eoi + 2 - removed.reduce((n, s) => n + s.end - s.start, 0));
      expect(validateD1Image(primary)).toEqual({ mime: 'image/jpeg', width: 960, height: 1280 });
      expect(extractPrimaryJpeg(primary)).toBe(primary);
      const [before, after] = await Promise.all([sharp(original).metadata(), sharp(primary).metadata()]);
      expect([after.width, after.height, after.orientation]).toEqual([
        before.width,
        before.height,
        before.orientation,
      ]);
      expect(after.icc).toEqual(before.icc);
      expect(Buffer.compare(await pixels(original), await pixels(primary))).toBe(0);
    }
  });

  it('scans a 25MB-class JPEG quickly enough for the upload check', async () => {
    const big = new Uint8Array(
      await sharp({
        create: {
          width: 3300,
          height: 2500,
          channels: 3,
          background: '#808080',
          noise: { type: 'gaussian', mean: 128, sigma: 90 },
        },
      })
        .jpeg({ quality: 100, chromaSubsampling: '4:4:4' })
        .toBuffer(),
    );
    const started = performance.now();
    validateD1Image(big);
    const ms = performance.now() - started;
    console.log(`validateD1Image ${(big.length / 1024 / 1024).toFixed(1)}MB: ${ms.toFixed(1)}ms`);
    expect(big.length).toBeGreaterThan(20 * 1024 * 1024);
    expect(ms).toBeLessThan(1000);
  }, 60000);
});
