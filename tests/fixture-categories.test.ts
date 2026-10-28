import { describe, expect, it } from 'vitest';
import { categoryLabels, listedCategories, type MaterialVersion } from '../src/lib/types';
import {
  defaultKindRows,
  isManagedKind,
  kindBehavior,
  kindLabel,
  materialKindSchema,
  newKindCode,
  orderKinds,
} from '../src/lib/material-kinds';
import { pickableKinds } from '../src/lib/material-kinds-store';
import { defaultMaterialPricing } from '../src/lib/quote';
import { describeFixture } from '../src/lib/ai-export/scene';
import { editorTabQuery, parsePageSearchParams } from '../src/lib/catalog/paging';
import { materialInputSchema } from '../src/lib/storage/validation';
import { productNoun } from '../src/lib/product-photo-prompt';

/** The kinds people pick from (library, form, editor chips): 기타 added, 샤워 커튼·문·창 left out. */
describe('listed material kinds', () => {
  it('offers every kind but 샤워 커튼, 문 and 창, with 기타 last', () => {
    for (const kind of ['showerCurtain', 'door', 'window'] as const)
      expect(listedCategories).not.toContain(kind);
    expect(listedCategories.at(-1)).toBe('other');
    expect(categoryLabels.other).toBe('기타');
    expect(listedCategories).toEqual(
      Object.keys(categoryLabels).filter((key) => !['showerCurtain', 'door', 'window'].includes(key)),
    );
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

  it('an added kind behaves as 기타: name, AI words, price unit, AI export; codes are checked', () => {
    const code = newKindCode();
    expect(code).toMatch(/^k-[a-z0-9]{10}$/);
    expect(kindBehavior(code)).toBe('other');
    expect(kindBehavior('basin')).toBe('basin');
    expect(productNoun(kindBehavior(code))).toBe('bathroom product');
    expect(defaultMaterialPricing(code).unit).toBe(defaultMaterialPricing('other').unit);
    // Its name: the list's, else 기타 (an added kind this tab does not know yet).
    const rows = [
      ...defaultKindRows(),
      { code, name: '수건걸이', displayOrder: 2, active: true, builtin: false },
    ];
    expect(kindLabel(code, rows)).toBe('수건걸이');
    expect(kindLabel(code)).toBe('기타');
    expect(kindLabel('door')).toBe('문');
    // Order: 기타 last, then 표시 순서, then name.
    expect(orderKinds(rows).at(-1)!.code).toBe('other');
    expect(orderKinds(rows).findIndex((row) => row.code === code)).toBe(2);
    // The lists people pick from: tiles first, kinds in use; a saved kind stays in its own form.
    const hidden = rows.map((row) => (row.code === code ? { ...row, active: false } : row));
    expect(pickableKinds(hidden).some((row) => row.code === code)).toBe(false);
    expect(pickableKinds(hidden, code).some((row) => row.code === code)).toBe(true);
    expect(pickableKinds(hidden, 'door').at(-1)).toEqual({ code: 'door', name: '문' });
    expect(pickableKinds(rows)[0].code).toBe('tile');
    // Stored codes: built-in or 'k-' and ten letters or digits.
    for (const value of [code, 'basin', 'door'])
      expect(materialKindSchema.safeParse(value).success).toBe(true);
    for (const value of ['k-SHORT', 'k-abc', 'towel', 'k-abcdefghijk', ''])
      expect(materialKindSchema.safeParse(value).success, value).toBe(false);
    expect(
      isManagedKind(code) && isManagedKind('other') && !isManagedKind('door') && !isManagedKind('tile'),
    ).toBe(true);
    // The AI export has no word for it (the picture stays as rendered).
    const fixture = { id: 'f', materialVersionId: 'v' } as Parameters<typeof describeFixture>[0];
    const material = { category: code, installation: 'wall' } as MaterialVersion;
    expect(describeFixture(fixture, material, [0, 0, 1, 1])).toBeUndefined();
    expect(parsePageSearchParams(new URLSearchParams('category=' + code)).category).toBe(code);
  });
});
