import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { importImage } from '../src/lib/images';
import { extractPrimaryJpeg } from '../src/lib/jpeg-container';
import type { AssetRepository } from '../src/lib/repositories/contracts';

function png(width = 320, height = 200) {
  const bytes = new Uint8Array(32);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  bytes.set([73, 72, 68, 82], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function repository() {
  return {
    put: vi.fn<AssetRepository['put']>().mockResolvedValue(undefined),
    get: vi.fn<AssetRepository['get']>(),
    removeUnused: vi.fn<AssetRepository['removeUnused']>(),
  };
}

function selectedFile() {
  return new File([png()], '제품 사진.png', { type: 'image/png' });
}

describe('image import from a selected local file', () => {
  const close = vi.fn();
  const decode = vi.fn();
  const drawImage = vi.fn();

  beforeEach(() => {
    close.mockReset();
    decode.mockReset();
    drawImage.mockReset();
    decode.mockResolvedValue({ width: 320, height: 200, close });
    vi.stubGlobal('createImageBitmap', decode);
    vi.stubGlobal('document', {
      createElement: vi.fn((tag: string) => {
        expect(tag).toBe('canvas');
        return {
          width: 0,
          height: 0,
          getContext: () => ({ drawImage }),
          toBlob: (callback: BlobCallback, mime: string) => callback(new Blob([png()], { type: mime })),
        };
      }),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(['original', 'texture', 'product'] as const)(
    'captures %s bytes once and uses that snapshot for decoding and storage',
    async (kind) => {
      const bytes = png();
      // The read result is authoritative even when the selected file's backing changes afterward.
      const file = new File([new Uint8Array(bytes.length)], '제품 사진.png', { type: 'image/png' });
      const read = vi.spyOn(file, 'arrayBuffer').mockResolvedValueOnce(bytes.buffer);
      read.mockRejectedValue(new DOMException('The file is no longer readable.', 'NotReadableError'));
      const assets = repository();

      const { original, preview } = await importImage(file, kind, assets);

      expect(read).toHaveBeenCalledTimes(1);
      expect(decode).toHaveBeenCalledTimes(1);
      const decoded = decode.mock.calls[0][0] as Blob;
      expect(decoded).toBeInstanceOf(Blob);
      expect(decoded).not.toBe(file);
      expect(decoded.type).toBe('image/png');
      expect(new Uint8Array(await decoded.arrayBuffer())).toEqual(bytes);
      expect(original.blob).not.toBe(file);
      expect(new Uint8Array(await original.blob.arrayBuffer())).toEqual(bytes);
      expect(original).toMatchObject({
        name: file.name,
        mime: 'image/png',
        size: bytes.length,
        width: 320,
        height: 200,
        kind: 'original',
      });
      expect(preview).toMatchObject({
        kind: kind === 'original' ? 'preview' : kind,
        sourceAssetId: original.id,
        derivation: 'upload-preview',
      });
      expect(assets.put.mock.calls).toEqual([[original], [preview]]);
      expect(close).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['NotReadableError', 'SecurityError', 'NotFoundError'])(
    'explains how to recover from %s without decoding or saving an asset',
    async (name) => {
      const file = selectedFile();
      const read = vi
        .spyOn(file, 'arrayBuffer')
        .mockRejectedValue(new DOMException('The requested file could not be read.', name));
      const assets = repository();

      const error = await importImage(file, 'product', assets).catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).toMatch(/[가-힣]/);
      expect(message).toMatch(/다시/);
      expect(message).toMatch(/선택/);
      expect(message).not.toContain('The requested file');
      expect(read).toHaveBeenCalledTimes(1);
      expect(decode).not.toHaveBeenCalled();
      expect(assets.put).not.toHaveBeenCalled();
      expect(assets.get).not.toHaveBeenCalled();
      expect(assets.removeUnused).not.toHaveBeenCalled();
    },
  );

  it('keeps only the first image of an Android Ultra HDR JPEG, for decoding and storage', async () => {
    const photo = new Uint8Array(
      readFileSync(
        '.codex-remote-attachments/01a071fe-92b3-77b3-a261-8698b3d3f8e9/04c0e236-9188-46ed-9a61-a8ff283287f8/1-Photo-1.jpg',
      ),
    );
    const primary = extractPrimaryJpeg(photo);
    expect(primary.length).toBeLessThan(photo.length);
    const assets = repository();

    const { original } = await importImage(
      new File([photo], '1-Photo-1.jpg', { type: 'image/jpeg' }),
      'original',
      assets,
    );

    expect(new Uint8Array(await (decode.mock.calls[0][0] as Blob).arrayBuffer())).toEqual(primary);
    expect(new Uint8Array(await original.blob.arrayBuffer())).toEqual(primary);
    expect(original).toMatchObject({ mime: 'image/jpeg', size: primary.length });
  });

  it('refuses a JPEG cut before its end, before decoding or saving', async () => {
    const photo = readFileSync(
      '.codex-remote-attachments/01a071fe-92b3-77b3-a261-8698b3d3f8e9/04c0e236-9188-46ed-9a61-a8ff283287f8/2-Photo-2.jpg',
    );
    const assets = repository();
    const cut = new File([photo.subarray(0, 40000)], 'cut.jpg', { type: 'image/jpeg' });
    await expect(importImage(cut, 'product', assets)).rejects.toThrow('구조가 손상돼');
    expect(decode).not.toHaveBeenCalled();
    expect(assets.put).not.toHaveBeenCalled();
  });

  it('imports a newly selected copy after the original file becomes unreadable', async () => {
    const unreadable = selectedFile();
    vi.spyOn(unreadable, 'arrayBuffer').mockRejectedValue(new DOMException('', 'NotReadableError'));
    const assets = repository();
    await expect(importImage(unreadable, 'product', assets)).rejects.toThrow();
    expect(assets.put).not.toHaveBeenCalled();

    const reselected = selectedFile();
    const read = vi.spyOn(reselected, 'arrayBuffer');
    const { preview } = await importImage(reselected, 'product', assets);

    expect(read).toHaveBeenCalledTimes(1);
    expect(preview.kind).toBe('product');
    expect(assets.put).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
