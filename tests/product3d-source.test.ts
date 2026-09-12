import { describe, it, expect } from 'vitest';
import { resolveProductInput } from '../src/lib/product3d/source';
import type { ImageAssetRecord } from '../src/lib/types';
const make = (id: string, values: Partial<ImageAssetRecord> = {}): ImageAssetRecord => ({
  id,
  ownerId: 'local',
  name: id,
  mime: 'image/png',
  size: 1,
  width: 1,
  height: 1,
  kind: 'product',
  createdAt: new Date().toISOString(),
  blob: new Blob([id]),
  ...values,
});
const assets = (values: ImageAssetRecord[]) => ({
  get: async (id: string) => {
    const asset = values.find((v) => v.id === id);
    if (!asset) throw new Error('missing source');
    return asset;
  },
});
describe('360 source provenance', () => {
  it('resolves legacy generated PNG to exact removed-background input instead of reconstructing the output', async () => {
    const source = make('cutout', { derivation: 'ai-alpha', sourceAssetId: 'original' }),
      old = make('old', { derivation: 'ai-multiview', sourceAssetId: 'cutout' });
    const result = await resolveProductInput('old', undefined, undefined, assets([old, source]));
    expect(result.blob).toBe(source.blob);
    expect(result.existingAssetId).toBe('cutout');
  });
  it('keeps transient removed-background bytes with their source without saving anything', async () => {
    const blob = new Blob(['transparent']),
      source = make('photo');
    const result = await resolveProductInput('photo', undefined, blob, assets([source]));
    expect(result).toMatchObject({ blob, sourceAssetId: 'photo' });
    expect(result.existingAssetId).toBeUndefined();
  });
  it('rejects broken and cyclic historical generation chains', async () => {
    await expect(
      resolveProductInput('old', undefined, undefined, assets([make('old', { derivation: 'ai-multiview' })])),
    ).rejects.toThrow('원본');
    await expect(
      resolveProductInput(
        'a',
        undefined,
        undefined,
        assets([
          make('a', { derivation: 'ai-multiview', sourceAssetId: 'b' }),
          make('b', { derivation: 'ai-multiview', sourceAssetId: 'a' }),
        ]),
      ),
    ).rejects.toThrow('원본');
  });
});
