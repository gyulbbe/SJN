import { describe, expect, it } from 'vitest';
import { isUploadableImage, pickImageFiles } from '../src/lib/file-drop';
import { MAX_IMAGE_BYTES } from '../src/lib/images';

const image = (name: string, type = 'image/png', size = 10) =>
  new File([new Uint8Array(size)], name, { type });

describe('file drop picking', () => {
  it('recognises JPG, PNG and WebP by type, or by extension when the type is missing', () => {
    expect(isUploadableImage(image('a.png'))).toBe(true);
    expect(isUploadableImage(image('a.jpg', 'image/jpeg'))).toBe(true);
    expect(isUploadableImage(image('a.webp', 'image/webp'))).toBe(true);
    expect(isUploadableImage(image('photo.JPEG', ''))).toBe(true);
    expect(isUploadableImage(image('a.gif', 'image/gif'))).toBe(false);
    expect(isUploadableImage(image('notes.txt', 'text/plain'))).toBe(false);
    expect(isUploadableImage(image('noext', ''))).toBe(false);
  });

  it('takes exactly one photo for a single slot and refuses several instead of picking one', () => {
    expect(pickImageFiles([image('a.png')], { multiple: false }).files.map((f) => f.name)).toEqual(['a.png']);
    const several = pickImageFiles([image('a.png'), image('b.png')], { multiple: false });
    expect(several.files).toEqual([]);
    expect(several.error).toContain('한 장만');
    expect(pickImageFiles([image('a.txt', 'text/plain')], { multiple: false }).error).toContain(
      'JPG·PNG·WebP',
    );
    expect(
      pickImageFiles([image('big.png', 'image/png', MAX_IMAGE_BYTES + 1)], { multiple: false }).error,
    ).toContain('25MB');
    expect(pickImageFiles([], { multiple: false })).toEqual({ files: [] });
  });

  it('keeps every usable image for a multi slot and says what was left out', () => {
    const mixed = pickImageFiles(
      [image('a.png'), image('notes.txt', 'text/plain'), image('b.jpg', 'image/jpeg')],
      {
        multiple: true,
      },
    );
    expect(mixed.files.map((f) => f.name)).toEqual(['a.png', 'b.jpg']);
    expect(mixed.notice).toBe('이미지가 아닌 파일 1개는 빼고 올렸어요.');
    const big = pickImageFiles([image('a.png'), image('big.png', 'image/png', MAX_IMAGE_BYTES + 1)], {
      multiple: true,
    });
    expect(big.files.map((f) => f.name)).toEqual(['a.png']);
    expect(big.notice).toBe('25MB가 넘는 사진 1장은 빼고 올렸어요.');
    expect(pickImageFiles([image('notes.txt', 'text/plain')], { multiple: true }).error).toContain(
      'JPG·PNG·WebP',
    );
  });

  it('refuses a multi drop that would pass the stored limit', () => {
    const over = pickImageFiles([image('a.png'), image('b.png')], { multiple: true, max: 100, current: 99 });
    expect(over.files).toEqual([]);
    expect(over.error).toBe('최대 100장까지 올릴 수 있어요. 지금 99장이라 1장 더 올릴 수 있어요.');
    expect(pickImageFiles([image('a.png')], { multiple: true, max: 100, current: 99 }).files).toHaveLength(1);
  });
});
