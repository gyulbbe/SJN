import { canvasBlob, readImageHeader } from '../images';
import type { SceneUnderstanding } from './pipeline-contract';

export const CLOUD_FIXTURE_CROP_CONTRACT = 'cloud-fixture-id-crops-v1';
export const CLOUD_FIXTURE_CROP_PROMPT =
  "Visual ID reference: Image 1 is the unchanged full photograph for room context. Image 2 is a contact sheet of padded crops from that same photograph. Each tile is labeled with exactly one provided candidate ID. The cyan rectangle in each tile marks that candidate's exact original box; the surrounding crop is context. For each provided ID, visually inspect its labeled tile and the original full photograph together, then classify the object inside its cyan rectangle. Use the full photograph to judge physical versus reflected context. The tiles carry IDs only, no prior classes or answers. Return the same provided IDs and the same required output schema.";

type ImageSize = { width: number; height: number };
type Candidate = Pick<SceneUnderstanding['candidates'][number], 'id' | 'bounds'>;
const MAX_BYTES = 8 * 1024 * 1024;
function fail(): never {
  throw new Error('설비 형태 crop board와 원본 사진·후보 영역 기록이 일치하지 않아요.');
}
function checkSize(image: ImageSize, limit: number) {
  if (![image.width, image.height].every((v) => Number.isInteger(v) && v > 0 && v <= limit)) fail();
}
export function cloudFixtureCropLayout(candidates: readonly Candidate[], sourceImage: ImageSize) {
  checkSize(sourceImage, 1024);
  if (
    candidates.length < 1 ||
    candidates.length > 24 ||
    new Set(candidates.map((c) => c.id)).size !== candidates.length
  )
    fail();
  const boxes = candidates.map(({ id, bounds }) => {
    if (typeof id !== 'string' || !id.length || id.length > 100 || /[\u0000-\u001f]/.test(id)) fail();
    const { left, top, right, bottom } = bounds;
    if (
      ![left, top, right, bottom].every((v) => Number.isFinite(v) && v >= 0 && v <= 1) ||
      left >= right ||
      top >= bottom
    )
      fail();
    return { id, bounds: { left, top, right, bottom } };
  });
  const boardImage = candidates.length <= 6 ? { width: 1020, height: 1024 } : { width: 1536, height: 1536 };
  const columns = candidates.length <= 3 ? candidates.length : Math.ceil(Math.sqrt(candidates.length));
  const rows = Math.ceil(candidates.length / columns);
  const tileWidth = Math.floor(boardImage.width / columns),
    tileHeight = Math.floor(boardImage.height / rows);
  const labelHeight = 48,
    margin = 12,
    fontSize = 28,
    outlineWidth = 2;
  const tiles = boxes.map(({ id, bounds }, index) => {
    const column = index % columns,
      row = Math.floor(index / columns);
    const original = {
      left: bounds.left * sourceImage.width,
      top: bounds.top * sourceImage.height,
      right: bounds.right * sourceImage.width,
      bottom: bounds.bottom * sourceImage.height,
    };
    const paddingX = Math.max(
      (original.right - original.left) * 0.1,
      Math.min(sourceImage.width, sourceImage.height) * 0.02,
    );
    const paddingY = Math.max(
      (original.bottom - original.top) * 0.1,
      Math.min(sourceImage.width, sourceImage.height) * 0.02,
    );
    const left = Math.max(0, Math.floor(original.left - paddingX)),
      top = Math.max(0, Math.floor(original.top - paddingY));
    const right = Math.min(sourceImage.width, Math.ceil(original.right + paddingX)),
      bottom = Math.min(sourceImage.height, Math.ceil(original.bottom + paddingY));
    const crop = { left, top, width: right - left, height: bottom - top };
    const scale = Math.min(
      (tileWidth - margin * 2) / crop.width,
      (tileHeight - labelHeight - margin * 2) / crop.height,
    );
    const width = Math.max(1, Math.round(crop.width * scale)),
      height = Math.max(1, Math.round(crop.height * scale));
    const destination = {
      left: column * tileWidth + Math.round((tileWidth - width) / 2),
      top: row * tileHeight + labelHeight + Math.round((tileHeight - labelHeight - height) / 2),
      width,
      height,
    };
    const target = {
      left: destination.left + ((original.left - left) * width) / crop.width,
      top: destination.top + ((original.top - top) * height) / crop.height,
      width: ((original.right - original.left) * width) / crop.width,
      height: ((original.bottom - original.top) * height) / crop.height,
    };
    return { id, bounds, column, row, paddingX, paddingY, crop, destination, target };
  });
  return {
    contract: CLOUD_FIXTURE_CROP_CONTRACT,
    sourceImage: { ...sourceImage },
    boardImage,
    columns,
    rows,
    tileWidth,
    tileHeight,
    labelHeight,
    margin,
    fontSize,
    outlineWidth,
    tiles,
  };
}
export type CloudFixtureCropLayout = ReturnType<typeof cloudFixtureCropLayout>;
export type CloudFixtureCropReceipt = {
  contract: typeof CLOUD_FIXTURE_CROP_CONTRACT;
  sourcePhotoSha256: string;
  boardSha256: string;
  layoutSha256: string;
  layout: CloudFixtureCropLayout;
};
export async function cloudFixtureCropSha256(value: Uint8Array | string) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value);
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('');
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => JSON.stringify(key) + ':' + canonical(child))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
export async function createCloudFixtureCropReceipt(
  photoBytes: Uint8Array,
  boardBytes: Uint8Array,
  candidates: readonly Candidate[],
): Promise<CloudFixtureCropReceipt> {
  if (
    !photoBytes.length ||
    !boardBytes.length ||
    photoBytes.length > MAX_BYTES ||
    boardBytes.length > MAX_BYTES
  )
    fail();
  const source = readImageHeader(photoBytes),
    board = readImageHeader(boardBytes);
  if (source.mime !== 'image/jpeg' || board.mime !== 'image/jpeg') fail();
  const layout = cloudFixtureCropLayout(candidates, { width: source.width, height: source.height });
  if (board.width !== layout.boardImage.width || board.height !== layout.boardImage.height) fail();
  return {
    contract: CLOUD_FIXTURE_CROP_CONTRACT,
    sourcePhotoSha256: await cloudFixtureCropSha256(photoBytes),
    boardSha256: await cloudFixtureCropSha256(boardBytes),
    layoutSha256: await cloudFixtureCropSha256(canonical(layout)),
    layout,
  };
}
/** Validates byte hashes and deterministic metadata, not a server-side pixel re-render. */
export async function validateCloudFixtureCropReceipt(
  receipt: unknown,
  photoBytes: Uint8Array,
  boardBytes: Uint8Array,
  candidates: readonly Candidate[],
) {
  const expected = await createCloudFixtureCropReceipt(photoBytes, boardBytes, candidates);
  if (canonical(receipt) !== canonical(expected)) fail();
  return expected;
}
function aborted(signal: AbortSignal) {
  if (signal.aborted) throw new DOMException('설비 형태 분석을 취소했어요.', 'AbortError');
}
/** Called only by an explicit Cloudflare appearance analysis; no work occurs at import time. */
export async function buildCloudFixtureCropBoard(
  photo: Blob,
  candidates: readonly Candidate[],
  signal: AbortSignal,
) {
  aborted(signal);
  const photoBytes = new Uint8Array(await photo.arrayBuffer());
  const header = readImageHeader(photoBytes);
  if (photoBytes.length > MAX_BYTES || header.mime !== 'image/jpeg') fail();
  const layout = cloudFixtureCropLayout(candidates, { width: header.width, height: header.height });
  aborted(signal);
  const bitmap = await createImageBitmap(photo);
  let canvas: HTMLCanvasElement | undefined;
  try {
    aborted(signal);
    if (bitmap.width !== header.width || bitmap.height !== header.height) fail();
    canvas = document.createElement('canvas');
    canvas.width = layout.boardImage.width;
    canvas.height = layout.boardImage.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) fail();
    ctx.fillStyle = '#ededed';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (const tile of layout.tiles) {
      aborted(signal);
      const c = tile.crop,
        d = tile.destination,
        target = tile.target;
      ctx.drawImage(bitmap, c.left, c.top, c.width, c.height, d.left, d.top, d.width, d.height);
      ctx.fillStyle = '#fff';
      ctx.fillRect(
        tile.column * layout.tileWidth,
        tile.row * layout.tileHeight,
        layout.tileWidth,
        layout.labelHeight,
      );
      ctx.font = `${layout.fontSize}px Arial,sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = '#111';
      ctx.fillText(
        tile.id,
        tile.column * layout.tileWidth + layout.tileWidth / 2,
        tile.row * layout.tileHeight + 34,
        layout.tileWidth - layout.margin * 2,
      );
      ctx.strokeStyle = '#00ffff';
      ctx.lineWidth = layout.outlineWidth;
      ctx.strokeRect(target.left, target.top, target.width, target.height);
      ctx.strokeStyle = '#999';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(tile.column * layout.tileWidth, 0);
      ctx.lineTo(tile.column * layout.tileWidth, canvas.height);
      ctx.stroke();
    }
    const board = await canvasBlob(canvas, 'image/jpeg', 0.92);
    aborted(signal);
    const receipt = await createCloudFixtureCropReceipt(
      photoBytes,
      new Uint8Array(await board.arrayBuffer()),
      layout.tiles,
    );
    aborted(signal);
    return { board, receipt };
  } finally {
    bitmap.close();
    if (canvas) canvas.width = canvas.height = 1;
  }
}
