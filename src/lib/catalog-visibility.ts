import type { Material, MaterialVersion } from './types';

type CatalogEntry = {
  material: Pick<Material, 'scope'>;
  version: Pick<
    MaterialVersion,
    'scope' | 'category' | 'version' | 'brand' | 'code' | 'name' | 'description' | 'reconstruction'
  >;
};

const builtInNames: Record<string, string> = {
  'EXAMPLE-STONE-01': '라이트 스톤',
  'EXAMPLE-STONE-02': '웜 샌드',
  'EXAMPLE-STONE-03': '차콜 스톤',
  'EXAMPLE-STONE-04': '클라우드 화이트',
};

/** Hide only the original bundled samples from selection; keep their saved assets and versions. */
export function isBuiltInExampleMaterial({ material, version }: CatalogEntry): boolean {
  return (
    !!version.reconstruction ||
    (material.scope === 'shared' &&
      version.scope === 'shared' &&
      version.category === 'tile' &&
      version.version === 1 &&
      version.brand === '공간미리 예시' &&
      builtInNames[version.code] === version.name &&
      version.description === '코드로 직접 제작한 테스트용 질감입니다. 실제 판매 상품이 아닙니다.')
  );
}
