import { MAX_IMAGE_BYTES } from './images';

/** The image types every upload in the app accepts; `importImage` still checks the actual bytes. */
export const IMAGE_UPLOAD_ACCEPT = 'image/jpeg,image/png,image/webp';
const IMAGE_TYPES = new Set(IMAGE_UPLOAD_ACCEPT.split(','));
const IMAGE_EXTENSION = /\.(jpe?g|png|webp)$/i;

export interface ImagePick {
  files: File[];
  /** Nothing was accepted; show this instead. */
  error?: string;
  /** Some files were accepted and some were left out. */
  notice?: string;
}

/** 은/는 after the last Hangul syllable (개 → 는, 장 → 은). */
function topicParticle(text: string) {
  const code = text.charCodeAt(text.length - 1) - 0xac00;
  return code >= 0 && code < 11172 && code % 28 ? '은' : '는';
}

/** Some systems hand over dropped files without a MIME type, so the extension decides then. */
export function isUploadableImage(file: Pick<File, 'name' | 'type'>) {
  return file.type ? IMAGE_TYPES.has(file.type) : IMAGE_EXTENSION.test(file.name);
}

/**
 * The same rules for clicking and dropping. A single-photo slot takes exactly one image and never
 * silently picks one of several; a multi-photo slot takes every usable image up to `max` in total.
 */
export function pickImageFiles(
  files: ArrayLike<File>,
  { multiple, max = Infinity, current = 0 }: { multiple: boolean; max?: number; current?: number },
): ImagePick {
  const all = Array.from(files);
  if (!all.length) return { files: [] };
  if (!multiple) {
    if (all.length > 1)
      return { files: [], error: '사진은 한 장만 올릴 수 있어요. 한 장만 골라 끌어 놓아 주세요.' };
    const [file] = all;
    if (!isUploadableImage(file)) return { files: [], error: 'JPG·PNG·WebP 이미지만 올릴 수 있어요.' };
    if (file.size > MAX_IMAGE_BYTES) return { files: [], error: '사진은 25MB 이하로 선택해 주세요.' };
    return { files: [file] };
  }
  const images = all.filter(isUploadableImage);
  const usable = images.filter((file) => file.size <= MAX_IMAGE_BYTES);
  const skipped = [
    all.length - images.length && `이미지가 아닌 파일 ${all.length - images.length}개`,
    images.length - usable.length && `25MB가 넘는 사진 ${images.length - usable.length}장`,
  ].filter(Boolean);
  if (!usable.length)
    return {
      files: [],
      error: images.length
        ? '사진은 한 장에 25MB 이하로 올려 주세요.'
        : 'JPG·PNG·WebP 이미지만 올릴 수 있어요.',
    };
  if (current + usable.length > max)
    return {
      files: [],
      error: `최대 ${max}장까지 올릴 수 있어요. 지금 ${current}장이라 ${Math.max(0, max - current)}장 더 올릴 수 있어요.`,
    };
  if (!skipped.length) return { files: usable };
  const list = skipped.join(', ');
  return { files: usable, notice: `${list}${topicParticle(list)} 빼고 올렸어요.` };
}
