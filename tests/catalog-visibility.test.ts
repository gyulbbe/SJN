import { describe, expect, it } from 'vitest';
import { isBuiltInExampleMaterial } from '../src/lib/catalog-visibility';

const original = {
  material: { scope: 'shared' as const },
  version: {
    scope: 'shared' as const,
    category: 'tile' as const,
    version: 1,
    brand: '공간미리 예시',
    code: 'EXAMPLE-STONE-01',
    name: '라이트 스톤',
    description: '코드로 직접 제작한 테스트용 질감입니다. 실제 판매 상품이 아닙니다.',
  },
};

describe('catalog sample visibility', () => {
  it('recognizes all four unmodified bundled tiles', () => {
    const names = ['라이트 스톤', '웜 샌드', '차콜 스톤', '클라우드 화이트'];
    names.forEach((name, index) => {
      expect(
        isBuiltInExampleMaterial({
          material: original.material,
          version: { ...original.version, name, code: `EXAMPLE-STONE-0${index + 1}` },
        }),
      ).toBe(true);
    });
  });

  it('keeps a personal copy even if its sample name and identifiers are retained', () => {
    expect(
      isBuiltInExampleMaterial({
        material: { scope: 'personal' },
        version: { ...original.version, scope: 'personal' },
      }),
    ).toBe(false);
  });

  it('keeps real shared products and edited material versions', () => {
    for (const changed of [
      { brand: '등록한 브랜드' },
      { code: 'PRODUCT-01' },
      { name: '등록한 상품' },
      { description: '판매용 타일' },
      { version: 2 },
    ]) {
      expect(
        isBuiltInExampleMaterial({
          material: original.material,
          version: { ...original.version, ...changed },
        }),
      ).toBe(false);
    }
  });
});
