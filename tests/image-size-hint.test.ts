import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  RECOMMENDED_PHOTO_SIDE,
  SMALL_PHOTO_SIDE,
  readPhotoSize,
  smallPhotoNotice,
} from '../src/lib/image-size-hint';

const picture = (width: number, height: number, format: 'png' | 'jpeg' | 'webp') =>
  sharp({ create: { width, height, channels: 3, background: '#d0d0d0' } })
    [format]()
    .toBuffer()
    .then((bytes) => new Blob([new Uint8Array(bytes)]));

describe('small product photo hint', () => {
  it('reads the size of a photo from its header, whatever the format', async () => {
    for (const format of ['png', 'jpeg', 'webp'] as const)
      expect(await readPhotoSize(await picture(480, 360, format)), format).toEqual({
        width: 480,
        height: 360,
      });
  });

  it('gives nothing for a file it cannot read', async () => {
    expect(await readPhotoSize(new Blob([new Uint8Array([1, 2, 3, 4])]))).toBeUndefined();
    expect(await readPhotoSize(new Blob([]))).toBeUndefined();
  });

  it('warns below 512 px on the short side and says what to use instead', () => {
    expect(SMALL_PHOTO_SIDE).toBe(512);
    expect(RECOMMENDED_PHOTO_SIDE).toBe(1000);
    const notice = smallPhotoNotice([{ name: 'toilet.jpg', width: 480, height: 900 }]);
    expect(notice).toContain('작은 사진은 흐리게 입체화돼요. 1000px 이상을 권해요');
    expect(notice).toContain('toilet.jpg');
    expect(notice).toContain('480px');
  });

  it('does not warn at 512 px or more, and never blocks anything', () => {
    expect(smallPhotoNotice([{ name: 'a.png', width: 512, height: 512 }])).toBe('');
    expect(smallPhotoNotice([{ name: 'a.png', width: 4000, height: 1000 }])).toBe('');
    expect(smallPhotoNotice([])).toBe('');
  });

  it('judges the short side, wide or tall', () => {
    expect(smallPhotoNotice([{ name: 'wide.png', width: 3000, height: 400 }])).not.toBe('');
    expect(smallPhotoNotice([{ name: 'tall.png', width: 400, height: 3000 }])).not.toBe('');
  });

  it('names a few of several small photos and counts the rest', () => {
    const photos = ['a', 'b', 'c', 'd'].map((name) => ({ name: `${name}.jpg`, width: 300, height: 300 }));
    const notice = smallPhotoNotice([...photos, { name: 'big.jpg', width: 2000, height: 2000 }]);
    expect(notice).toContain('a.jpg');
    expect(notice).toContain('b.jpg');
    expect(notice).not.toContain('big.jpg');
    expect(notice).toContain('외 2장');
  });
});
