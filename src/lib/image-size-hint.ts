import { readImageHeader } from './images';

/**
 * The 3D model looks at a product photo at 512 px: a photo whose short side is below that is
 * enlarged for it and comes out soft. Nothing is refused; the photo's owner is only told.
 */
export const SMALL_PHOTO_SIDE = 512;
/** The size to recommend. */
export const RECOMMENDED_PHOTO_SIDE = 1000;

export interface PhotoSize {
  name: string;
  width: number;
  height: number;
}

/** The pixel size from the head of an image file, without decoding it; undefined if it cannot be read. */
export async function readPhotoSize(file: Blob): Promise<{ width: number; height: number } | undefined> {
  try {
    const { width, height } = readImageHeader(new Uint8Array(await file.slice(0, 1 << 20).arrayBuffer()));
    return width > 0 && height > 0 ? { width, height } : undefined;
  } catch {
    return undefined;
  }
}

/** The sizes of several files, leaving out the ones that cannot be read. */
export async function readPhotoSizes(files: File[]): Promise<PhotoSize[]> {
  const sizes = await Promise.all(
    files.map(async (file) => ({ name: file.name, size: await readPhotoSize(file) })),
  );
  return sizes.flatMap(({ name, size }) => (size ? [{ name, ...size }] : []));
}

const shortSide = (photo: PhotoSize) => Math.min(photo.width, photo.height);

/** The hint for the small photos among `photos`; empty when none is small. */
export function smallPhotoNotice(photos: PhotoSize[]): string {
  const small = photos.filter((photo) => shortSide(photo) < SMALL_PHOTO_SIDE);
  if (!small.length) return '';
  const named = small.slice(0, 2).map((photo) => `‘${photo.name}’(${shortSide(photo)}px)`);
  const rest = small.length > 2 ? ` 외 ${small.length - 2}장` : '';
  return `사진 ${named.join(', ')}${rest}의 짧은 변이 ${SMALL_PHOTO_SIDE}px보다 작아요. 작은 사진은 흐리게 입체화돼요. ${RECOMMENDED_PHOTO_SIDE}px 이상을 권해요.`;
}
