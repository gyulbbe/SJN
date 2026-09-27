/**
 * JPEG structure without decoding pixels: the marker segments of the first image up to its EOI,
 * entropy-coded scans included. Phone cameras append more after that EOI: a second JPEG with an
 * HDR gain map (Android Ultra HDR, Apple HDR; listed by an APP2 MPF segment) or a video (motion
 * photos). The app keeps only the first image, byte for byte. Shared by the browser import and
 * the server's upload check, so both read a file the same way.
 */
export class JpegStructureError extends Error {}

/** A marker segment from its 0xFF to the end of its length (a scan's entropy data is not included). */
export type JpegSegment = { marker: number; start: number; end: number };

export function scanJpeg(bytes: Uint8Array): { segments: JpegSegment[]; eoi: number } {
  const fail = () => new JpegStructureError('JPEG 구조가 올바르지 않아요.');
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw fail();
  const segments: JpegSegment[] = [];
  let offset = 2;
  for (;;) {
    if (bytes[offset] !== 0xff) throw fail();
    // Fill bytes (extra 0xFF) may precede a marker.
    while (bytes[offset] === 0xff) offset++;
    if (offset >= bytes.length) throw fail();
    const marker = bytes[offset++];
    if (marker === 0xd9) return { segments, eoi: offset - 2 };
    // A second SOI, stuffing or restart markers outside a scan, and TEM are not an ordinary image.
    if (marker === 0xd8 || marker <= 0x01 || (marker >= 0xd0 && marker <= 0xd7)) throw fail();
    if (offset + 2 > bytes.length) throw fail();
    const end = offset + ((bytes[offset] << 8) | bytes[offset + 1]);
    if (end < offset + 2 || end > bytes.length) throw fail();
    segments.push({ marker, start: offset - 2, end });
    offset = end;
    if (marker !== 0xda) continue;
    // Entropy-coded data runs to the next marker other than stuffing (FF00) and restarts (FFD0-7).
    // Progressive images go back to segments here for their next DHT/SOS.
    for (;;) {
      const at = bytes.indexOf(0xff, offset);
      if (at < 0 || at + 1 >= bytes.length) throw fail();
      const next = bytes[at + 1];
      if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) offset = at + 2;
      else if (next === 0xff) offset = at + 1;
      else {
        offset = at;
        break;
      }
    }
  }
}

const decoder = new TextDecoder();
const startsWith = (bytes: Uint8Array, at: number, text: string) =>
  at + text.length <= bytes.length && [...text].every((c, i) => bytes[at + i] === c.charCodeAt(0));
// XMP that describes items stored after the first image (Google container, Apple HDR, motion photos).
const APPENDED_XMP = /Container:Directory|MotionPhoto|MicroVideo|hdrgm:|HDRGainMap/;

/** Whether a segment only points at data stored after the first image. */
function describesAppendedData(bytes: Uint8Array, { marker, start, end }: JpegSegment) {
  const body = start + 4;
  if (marker === 0xe2)
    return startsWith(bytes, body, 'MPF\0') || startsWith(bytes, body, 'urn:iso:std:iso:ts:21496:-1\0');
  if (marker === 0xe1 && startsWith(bytes, body, 'http://ns.adobe.com/xap/1.0/\0'))
    return APPENDED_XMP.test(decoder.decode(bytes.subarray(body, end)));
  return false;
}

/**
 * The first image only: everything after its EOI is dropped, and so are the segments that point
 * at it (MPF, the ISO 21496-1 gain map marker, container XMP). The other bytes are copied as they
 * are (EXIF orientation, ICC profile, tables, scans), so the image decodes to the same pixels. A
 * JPEG with nothing to remove is returned unchanged.
 */
export function extractPrimaryJpeg(bytes: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const { segments, eoi } = scanJpeg(bytes);
  const end = eoi + 2;
  const removed = segments.filter((segment) => describesAppendedData(bytes, segment));
  if (!removed.length && end === bytes.length) return bytes;
  const output = new Uint8Array(end - removed.reduce((sum, s) => sum + s.end - s.start, 0));
  let written = 0,
    from = 0;
  for (const segment of removed) {
    output.set(bytes.subarray(from, segment.start), written);
    written += segment.start - from;
    from = segment.end;
  }
  output.set(bytes.subarray(from, end), written);
  return output;
}
