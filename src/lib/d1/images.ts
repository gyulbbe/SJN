import { invalid, MAX_ASSET_BYTES } from './http';

/** Container validation, not full pixel decoding. No native Node/sharp dependency. */
export function validateD1Image(bytes: Uint8Array): { mime: string; width: number; height: number } {
  if (!bytes.length || bytes.length > MAX_ASSET_BYTES) throw invalid('이미지는 25MB 이하여야 해요.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (offset: number, le = false) => view.getUint16(offset, le);
  const u32 = (offset: number, le = false) => view.getUint32(offset, le);
  const text = (offset: number, count: number) =>
    String.fromCharCode(...bytes.subarray(offset, offset + count));
  const fail = () =>
    invalid('손상된 이미지이거나 지원하지 않는 형식이에요. 정지 JPG·PNG·WebP를 사용해 주세요.');
  function orientation(start: number, end: number): number {
    if (text(start, 6) === 'Exif\0\0') start += 6;
    if (start + 8 > end) return 1;
    const le = text(start, 2) === 'II';
    if (!le && text(start, 2) !== 'MM') return 1;
    if (u16(start + 2, le) !== 42) throw fail();
    const directory = start + u32(start + 4, le);
    if (directory < start + 8 || directory + 2 > end) throw fail();
    const count = u16(directory, le);
    if (count > 1024 || directory + 2 + count * 12 > end) throw fail();
    for (let index = 0; index < count; index++) {
      const entry = directory + 2 + index * 12;
      if (u16(entry, le) === 0x112 && u16(entry + 2, le) === 3 && u32(entry + 4, le) === 1) {
        const value = u16(entry + 8, le);
        return value >= 1 && value <= 8 ? value : 1;
      }
    }
    return 1;
  }
  let width = 0,
    height = 0,
    rotation = 1,
    mime = '';
  if (bytes.length >= 33 && text(0, 8) === '\x89PNG\r\n\x1a\n') {
    mime = 'image/png';
    let offset = 8,
      header = false,
      data = false,
      end = false;
    while (offset + 12 <= bytes.length) {
      const length = u32(offset),
        kind = text(offset + 4, 4),
        body = offset + 8;
      if (length > bytes.length - offset - 12 || !/^[A-Za-z]{4}$/.test(kind)) throw fail();
      if (!header && kind !== 'IHDR') throw fail();
      if (['acTL', 'fcTL', 'fdAT'].includes(kind)) throw fail();
      if (kind === 'IHDR') {
        if (header || length !== 13) throw fail();
        width = u32(body);
        height = u32(body + 4);
        header = true;
        const depths: Record<number, number[]> = {
          0: [1, 2, 4, 8, 16],
          2: [8, 16],
          3: [1, 2, 4, 8],
          4: [8, 16],
          6: [8, 16],
        };
        if (
          !depths[bytes[body + 9]]?.includes(bytes[body + 8]) ||
          bytes[body + 10] !== 0 ||
          bytes[body + 11] !== 0 ||
          bytes[body + 12] > 1
        )
          throw fail();
      } else if (kind === 'IDAT') {
        if (!length) throw fail();
        data = true;
      } else if (kind === 'eXIf') rotation = orientation(body, body + length);
      else if (kind === 'IEND') {
        if (length || !data || offset + 12 !== bytes.length) throw fail();
        end = true;
        break;
      } else if (kind[0] === kind[0].toUpperCase() && kind !== 'PLTE') throw fail();
      offset += length + 12;
    }
    if (!header || !end) throw fail();
  } else if (bytes.length >= 12 && text(0, 4) === 'RIFF' && text(8, 4) === 'WEBP') {
    mime = 'image/webp';
    if (u32(4, true) + 8 !== bytes.length) throw fail();
    let offset = 12,
      frames = 0,
      canvasWidth = 0,
      canvasHeight = 0;
    const u24 = (pos: number) => bytes[pos] | (bytes[pos + 1] << 8) | (bytes[pos + 2] << 16);
    while (offset + 8 <= bytes.length) {
      const kind = text(offset, 4),
        length = u32(offset + 4, true),
        body = offset + 8;
      if (body + length + (length % 2) > bytes.length) throw fail();
      if (kind === 'ANIM' || kind === 'ANMF') throw fail();
      if (kind === 'VP8X') {
        if (offset !== 12 || length !== 10 || bytes[body] & 2) throw fail();
        canvasWidth = u24(body + 4) + 1;
        canvasHeight = u24(body + 7) + 1;
      } else if (kind === 'VP8 ') {
        if (length < 11 || bytes[body] & 1 || text(body + 3, 3) !== '\x9d\x01\x2a') throw fail();
        width = u16(body + 6, true) & 0x3fff;
        height = u16(body + 8, true) & 0x3fff;
        frames++;
      } else if (kind === 'VP8L') {
        if (length < 6 || bytes[body] !== 0x2f) throw fail();
        const packed = u32(body + 1, true);
        if (packed >>> 29) throw fail();
        width = (packed & 0x3fff) + 1;
        height = ((packed >>> 14) & 0x3fff) + 1;
        frames++;
      } else if (kind === 'EXIF') rotation = orientation(body, body + length);
      offset = body + length + (length % 2);
    }
    if (
      offset !== bytes.length ||
      frames !== 1 ||
      (canvasWidth && (canvasWidth !== width || canvasHeight !== height))
    )
      throw fail();
  } else if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    mime = 'image/jpeg';
    if (bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) throw fail();
    let offset = 2,
      scan = false;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 0xff) throw fail();
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xd9 || marker === 0xd8 || marker === 0 || (marker >= 0xd0 && marker <= 0xd7))
        throw fail();
      if (offset + 2 > bytes.length) throw fail();
      const length = u16(offset),
        end = offset + length;
      if (length < 2 || end > bytes.length - 2) throw fail();
      if (marker === 0xe1) rotation = orientation(offset + 2, end);
      if (marker === 0xe2 && text(offset + 2, 4) === 'MPF\0') throw fail();
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        if (length < 8 || width || bytes[offset + 2] !== 8) throw fail();
        height = u16(offset + 3);
        width = u16(offset + 5);
        if (length !== 8 + 3 * bytes[offset + 7]) throw fail();
      }
      if (marker === 0xda) {
        if (!width || end >= bytes.length - 2) throw fail();
        scan = true;
        break;
      }
      offset = end;
    }
    if (!scan) throw fail();
  } else throw fail();
  if (!width || !height || width * height > 40_000_000)
    throw invalid('이미지는 최대 4천만 화소까지 지원해요.');
  return { mime, width: rotation >= 5 ? height : width, height: rotation >= 5 ? width : height };
}
