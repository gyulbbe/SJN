import { describe, expect, it, vi } from 'vitest';
import { resolveBackgroundRemovalInput } from '../src/lib/background-removal/source';
import type { AssetRecord } from '../src/lib/types';

const original: AssetRecord = {
  id: 'original',
  ownerId: 'local',
  name: 'product.png',
  mime: 'image/png',
  size: 3,
  width: 3200,
  height: 2400,
  kind: 'original',
  createdAt: '',
  blob: new Blob(['raw']),
};
const preview: AssetRecord = {
  ...original,
  id: 'preview',
  name: 'product.png · 편집용',
  kind: 'product',
  width: 2048,
  height: 1536,
  sourceAssetId: original.id,
  derivation: 'upload-preview',
};
function reader(selected: AssetRecord) {
  return {
    get: vi.fn(async (id: string) => {
      if (id === selected.id) return selected;
      if (id === original.id) return original;
      throw new Error('missing');
    }),
  };
}

describe('background removal source resolution', () => {
  it('uses the upload original rather than the 2048px editing preview', async () => {
    const assets = reader(preview);
    const result = await resolveBackgroundRemovalInput(preview.id, assets);
    expect(result.asset).toBe(original);
    expect(result.asset.width).toBe(3200);
    expect(assets.get).toHaveBeenCalledTimes(2);
  });
  it('recognizes legacy unedited previews by their exact original name', async () => {
    const legacy = { ...preview, derivation: undefined };
    expect((await resolveBackgroundRemovalInput(legacy.id, reader(legacy))).asset).toBe(original);
  });
  it('retains applied AI transparency and full resolution when rerun', async () => {
    const applied: AssetRecord = {
      ...original,
      id: 'ai-result',
      kind: 'product',
      sourceAssetId: preview.id,
      derivation: 'ai-alpha',
    };
    const assets = reader(applied);
    const result = await resolveBackgroundRemovalInput(applied.id, assets);
    expect(result.asset).toBe(applied);
    expect(result.sourceLabel).toBe('AI 배경 제거를 적용한 사진');
    expect(assets.get).toHaveBeenCalledTimes(1);
  });
  it('retains manual alpha even if a source original exists', async () => {
    const manual: AssetRecord = { ...preview, derivation: 'manual-alpha' };
    const assets = reader(manual);
    expect((await resolveBackgroundRemovalInput(manual.id, assets)).asset).toBe(manual);
    expect(assets.get).toHaveBeenCalledTimes(1);
  });
  it('retains legacy manual edits and unknown derived images', async () => {
    for (const name of ['수동 배경 제거 제품', 'custom']) {
      const manual = { ...preview, name, derivation: undefined };
      expect((await resolveBackgroundRemovalInput(manual.id, reader(manual))).asset).toBe(manual);
    }
  });
  it('fails explicitly when a known upload preview has lost its original', async () => {
    const missing = { ...preview, sourceAssetId: 'missing' };
    await expect(resolveBackgroundRemovalInput(missing.id, reader(missing))).rejects.toThrow('원본');
  });
  it('does not fail an unknown edited image just because its original is unavailable', async () => {
    const manual = { ...preview, name: 'manual', sourceAssetId: 'missing', derivation: undefined };
    expect((await resolveBackgroundRemovalInput(manual.id, reader(manual))).asset).toBe(manual);
  });
  it('accepts a direct original without rewriting or saving any asset', async () => {
    const assets = reader(original);
    expect((await resolveBackgroundRemovalInput(original.id, assets)).asset).toBe(original);
    expect(assets.get).toHaveBeenCalledTimes(1);
  });
});
