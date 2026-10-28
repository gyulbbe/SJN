import { describe, expect, it } from 'vitest';
import { categoryLabels, fixtureCategories, listedCategories } from '../src/lib/types';
import { editorTabQuery, parsePageSearchParams } from '../src/lib/catalog/paging';
import { materialInputSchema } from '../src/lib/storage/validation';
import { productNoun } from '../src/lib/product-photo-prompt';

/** The kinds people pick from (library, form, editor chips): 기타 added, 샤워 커튼·문·창 left out. */
describe('listed material kinds', () => {
  it('offers every kind but 샤워 커튼, 문 and 창, with 기타 last; the editor chips have no tiles', () => {
    for (const kind of ['showerCurtain', 'door', 'window'] as const)
      expect(listedCategories).not.toContain(kind);
    expect(listedCategories.at(-1)).toBe('other');
    expect(categoryLabels.other).toBe('기타');
    expect(listedCategories).toEqual(
      Object.keys(categoryLabels).filter((key) => !['showerCurtain', 'door', 'window'].includes(key)),
    );
    expect(fixtureCategories).toEqual(listedCategories.filter((key) => key !== 'tile'));
    // Still stored kinds (the photo-analysis standard model) with their names.
    expect(categoryLabels.showerCurtain).toBe('샤워 커튼');
    expect([categoryLabels.door, categoryLabels.window]).toEqual(['문', '창']);
  });

  it('narrows the 위생도기 tab to one kind; the tile tabs ignore a kind', () => {
    expect(editorTabQuery('fixtures')).toEqual({ category: 'fixtures' });
    expect(editorTabQuery('fixtures', 'basin')).toEqual({ category: 'basin' });
    expect(editorTabQuery('fixtures', 'other')).toEqual({ category: 'other' });
    expect(editorTabQuery('floor', 'basin')).toEqual({ category: 'tile', usage: 'floor' });
    expect(editorTabQuery('wall')).toEqual({ category: 'tile', usage: 'wall' });
    // The guest drawer's GET form reads the kind back.
    expect(parsePageSearchParams(new URLSearchParams('category=other')).category).toBe('other');
  });

  it('saves a 기타 product on the floor, a wall or built in, never hung like a curtain', () => {
    const id = crypto.randomUUID();
    const input = {
      name: '수건걸이',
      brand: '',
      code: '',
      category: 'other',
      scope: 'personal',
      description: '',
      color: '',
      finish: '',
      widthMm: 600,
      heightMm: 80,
      depthMm: 120,
      usage: 'both',
      installation: 'wall',
      textureAssetIds: [],
      views: [{ assetId: id, direction: '정면', anchor: { x: 0.5, y: 0.5 } }],
      defaultGroutWidth: 0,
      defaultGroutColor: '#000000',
      defaultPattern: 'grid',
    };
    for (const installation of ['floor', 'wall', 'embedded'])
      expect(materialInputSchema.safeParse({ ...input, installation }).success, installation).toBe(true);
    expect(materialInputSchema.safeParse({ ...input, installation: 'suspended' }).success).toBe(false);
    expect(productNoun('other')).toBe('bathroom product');
  });
});
