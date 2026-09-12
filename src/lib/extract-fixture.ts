import { getRepositories } from './repositories';
import type { Repositories } from './repositories/contracts';
import { MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS } from './images';
import {
  DEFAULT_COLOR,
  EMPTY_MASK,
  type AssetRecord,
  type FixtureInstance,
  type MaterialCategory,
  type Point,
} from './types';

type PixelImage = { width: number; height: number; data: Uint8ClampedArray };
export type FixtureCropGeometry = {
  bounds: { x: number; y: number; width: number; height: number };
  position: Point;
  width: number;
  height: number;
  anchor: { x: 0.5; y: 1 };
};
export type ExtractedFixture = FixtureCropGeometry & { blob: Blob };
export type ExtractedFixtureOptions = {
  name: string;
  category: MaterialCategory;
  sourceAssetId?: string;
  widthMm?: number;
  heightMm?: number;
  depthMm?: number;
};

/** RGB stays byte-identical to the source; only alpha is multiplied by the manual mask. */
export function extractFixturePixels(
  source: PixelImage,
  mask: PixelImage,
): FixtureCropGeometry & { pixels: Uint8ClampedArray } {
  const { width, height } = source;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width * height > MAX_IMAGE_PIXELS
  )
    throw new Error('제품을 분리할 사진 크기를 확인해 주세요.');
  if (
    mask.width !== width ||
    mask.height !== height ||
    source.data.length !== width * height * 4 ||
    mask.data.length !== source.data.length
  )
    throw new Error('제품 선택 영역과 사진의 크기가 같아야 해요.');
  let left = width,
    top = height,
    right = -1,
    bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = (y * width + x) * 4 + 3;
      if (Math.round((source.data[alpha] * mask.data[alpha]) / 255) === 0) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }
  if (right < left || bottom < top) throw new Error('분리할 제품 영역을 먼저 선택해 주세요.');
  const cropWidth = right - left + 1,
    cropHeight = bottom - top + 1;
  const pixels = new Uint8ClampedArray(cropWidth * cropHeight * 4);
  for (let y = 0; y < cropHeight; y++) {
    for (let x = 0; x < cropWidth; x++) {
      const from = ((top + y) * width + left + x) * 4;
      const to = (y * cropWidth + x) * 4;
      pixels[to] = source.data[from];
      pixels[to + 1] = source.data[from + 1];
      pixels[to + 2] = source.data[from + 2];
      pixels[to + 3] = Math.round((source.data[from + 3] * mask.data[from + 3]) / 255);
    }
  }
  return {
    pixels,
    bounds: { x: left, y: top, width: cropWidth, height: cropHeight },
    position: { x: (left + cropWidth / 2) / width, y: (top + cropHeight) / height },
    width: cropWidth / width,
    height: cropHeight / height,
    anchor: { x: 0.5, y: 1 },
  };
}

// Canvas PNG encoding can round unpremultiplied RGB at low alpha. Encode the copied
// RGBA bytes directly so even feathered edge pixels keep their original RGB values.
function pngChunk(type: string, data: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const chunk = new Uint8Array(data.length + 12);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) chunk[i + 4] = type.charCodeAt(i);
  chunk.set(data, 8);
  let crc = 0xffffffff;
  for (let i = 4; i < chunk.length - 4; i++) {
    crc ^= chunk[i];
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  view.setUint32(chunk.length - 4, (crc ^ 0xffffffff) >>> 0);
  return chunk;
}

async function encodeRgbaPng(pixels: Uint8ClampedArray, width: number, height: number): Promise<Blob> {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8;
  header[9] = 6; // 8-bit RGBA, no palette or color transform.
  const stride = width * 4;
  const rows = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++)
    rows.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  const compressed = new Uint8Array(
    await new Response(new Blob([rows]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer(),
  );
  return new Blob(
    [
      new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
      pngChunk('IHDR', header),
      pngChunk('IDAT', compressed),
      pngChunk('IEND', new Uint8Array()),
    ],
    { type: 'image/png' },
  );
}

/** Source and mask are read synchronously before encoding; neither input canvas is changed. */
export async function extractFixture(
  source: HTMLCanvasElement,
  mask: HTMLCanvasElement,
): Promise<ExtractedFixture> {
  if (source.width !== mask.width || source.height !== mask.height)
    throw new Error('제품 선택 영역과 사진의 크기가 같아야 해요.');
  if (!source.width || !source.height || source.width * source.height > MAX_IMAGE_PIXELS)
    throw new Error('제품을 분리할 사진 크기를 확인해 주세요.');
  const sourceContext = source.getContext('2d'),
    maskContext = mask.getContext('2d');
  if (!sourceContext || !maskContext) throw new Error('제품 이미지를 읽을 수 없어요.');
  const { pixels, ...geometry } = extractFixturePixels(
    sourceContext.getImageData(0, 0, source.width, source.height),
    maskContext.getImageData(0, 0, mask.width, mask.height),
  );
  const blob = await encodeRgbaPng(pixels, geometry.bounds.width, geometry.bounds.height);
  if (blob.size > MAX_IMAGE_BYTES)
    throw new Error('분리한 제품 이미지가 25MB를 넘어요. 선택 영역을 줄여 주세요.');
  return { ...geometry, blob };
}

/** Saves a new personal material and returns a placement; scene/background changes belong to the caller. */
export async function registerExtractedFixture(
  source: HTMLCanvasElement,
  mask: HTMLCanvasElement,
  options: ExtractedFixtureOptions,
  repositories: Pick<Repositories, 'assets' | 'materials'> = getRepositories(),
): Promise<FixtureInstance> {
  const name = options.name.trim();
  if (!name || name.length > 200) throw new Error('제품 이름은 1~200자로 입력해 주세요.');
  if (!['toilet', 'basin', 'vanity', 'bath', 'shower', 'faucet'].includes(options.category))
    throw new Error('분리할 제품의 위생도기 종류를 선택해 주세요.');
  for (const key of ['widthMm', 'heightMm', 'depthMm'] as const) {
    const value = options[key];
    if (
      value !== undefined &&
      (!Number.isFinite(value) || value > 100000 || (key === 'depthMm' ? value < 0 : value <= 0))
    )
      throw new Error('제품 치수를 확인해 주세요.');
  }
  const extracted = await extractFixture(source, mask);
  const scale = 600 / Math.max(extracted.bounds.width, extracted.bounds.height);
  const widthMm = options.widthMm ?? Math.max(1, Math.round(extracted.bounds.width * scale));
  const heightMm = options.heightMm ?? Math.max(1, Math.round(extracted.bounds.height * scale));
  const asset: AssetRecord = {
    id: crypto.randomUUID(),
    ownerId: 'local',
    name: `${name}.png`,
    mime: 'image/png',
    size: extracted.blob.size,
    width: extracted.bounds.width,
    height: extracted.bounds.height,
    kind: 'product',
    sourceAssetId: options.sourceAssetId,
    createdAt: new Date().toISOString(),
    blob: extracted.blob,
  };
  await repositories.assets.put(asset);
  const material = await repositories.materials.create({
    name,
    brand: '',
    code: '',
    category: options.category,
    scope: 'personal',
    description:
      '사진의 수동 선택 영역에서 분리한 제품 이미지입니다. 선택 영역에 배경이 포함될 수 있습니다.' +
      (options.widthMm === undefined || options.heightMm === undefined
        ? ' 입력하지 않은 치수는 이미지 비율과 600mm 기준으로 정한 추정값이며 실측이 아닙니다.'
        : ''),
    color: '',
    finish: '',
    widthMm,
    heightMm,
    depthMm: options.depthMm ?? 0,
    usage: 'both',
    installation: 'floor',

    textureAssetIds: [],
    views: [{ assetId: asset.id, direction: '원본 사진 방향', anchor: { ...extracted.anchor } }],
    defaultGroutWidth: 2,
    defaultGroutColor: '#d5d1c9',
    defaultPattern: 'grid',
  });
  return {
    id: crypto.randomUUID(),
    name,
    materialVersionId: material.id,
    viewIndex: 0,
    position: extracted.position,
    width: extracted.width,
    height: extracted.height,
    rotation: 0,
    anchor: extracted.anchor,
    locked: false,
    shadow: { x: 0, y: 0.005, opacity: 0, blur: 0.015, scale: 0.7 },
    occlusion: EMPTY_MASK(),
    color: { ...DEFAULT_COLOR },
  };
}
