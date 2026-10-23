import { describe, expect, it } from 'vitest';
import {
  effectiveFacets,
  emptyFacets,
  facetOptions,
  facetValues,
  hasFacets,
  matchesFacets,
  PREFERRED_TILE_SIZES,
  sortFacetValues,
  type Facetable,
} from '../src/lib/catalog/facets';

const tile = (patch: Partial<Facetable> = {}): Facetable => ({
  category: 'tile',
  widthMm: 600,
  heightMm: 600,
  depthMm: 10,
  color: '그레이',
  finish: '무광',
  ...patch,
});

describe('material facets', () => {
  it('uses the face size for tiles and every positive dimension for products', () => {
    expect(facetValues(tile({ widthMm: 1200 }), 'size')).toEqual(['1200X600']);
    expect(
      facetValues({ ...tile(), category: 'basin', widthMm: 600, heightMm: 450, depthMm: 400 }, 'size'),
    ).toEqual(['600X450X400']);
    expect(facetValues({ ...tile(), category: 'basin', depthMm: 0 }, 'size')).toEqual(['600X600']);
    expect(facetValues(tile({ widthMm: 0, heightMm: 0 }), 'size')).toEqual([]);
  });

  it('splits multiple catalog options and ignores blanks', () => {
    expect(facetValues(tile({ color: '화이트 · 그레이 ·  ' }), 'color')).toEqual(['화이트', '그레이']);
    expect(facetValues(tile({ finish: '' }), 'finish')).toEqual([]);
  });

  it('collects unique options with the common tile sizes first, then largest first', () => {
    const options = facetOptions([
      tile({ widthMm: 1200, color: '화이트' }),
      tile({ widthMm: 300, color: '그레이 · 화이트', finish: '유광' }),
      tile({ widthMm: 600 }),
      tile({ widthMm: 300, heightMm: 300 }),
    ]);
    expect(options.size).toEqual(['1200X600', '600X600', '300X600', '300X300']);
    expect(options.color).toEqual(['그레이', '화이트']);
    expect(options.finish).toEqual(['무광', '유광']);
  });

  it('puts the common tile sizes first in their order, a size and its turned twin both early', () => {
    const sizes = [
      '1200X2400',
      '300X300',
      '400X250',
      '600X300',
      '1200X1200',
      '600X1200',
      '600X600',
      '300X600',
      '200X200',
      '1200X600',
    ];
    expect(sortFacetValues('size', sizes)).toEqual([
      ...PREFERRED_TILE_SIZES,
      '1200X2400',
      '1200X1200',
      '400X250',
      '200X200',
    ]);
    // Missing ones are skipped; the rest stays largest first (width, then height).
    expect(sortFacetValues('size', ['300X300', '800X800', '600X600', '800X400', '400X800'])).toEqual([
      '600X600',
      '300X300',
      '800X800',
      '800X400',
      '400X800',
    ]);
  });

  it('keeps product sizes (three dimensions) largest first, after the common tile sizes', () => {
    expect(sortFacetValues('size', ['600X450X400', '600X600', '700X800X400', '300X300'])).toEqual([
      '600X600',
      '300X300',
      '700X800X400',
      '600X450X400',
    ]);
  });

  it('matches any value within a group and every selected group', () => {
    const selection = { ...emptyFacets(), color: ['화이트', '그레이'], finish: ['무광'] };
    expect(matchesFacets(tile({ color: '화이트' }), selection)).toBe(true);
    expect(matchesFacets(tile({ color: '베이지 · 그레이' }), selection)).toBe(true);
    expect(matchesFacets(tile({ color: '베이지' }), selection)).toBe(false);
    expect(matchesFacets(tile({ finish: '유광' }), selection)).toBe(false);
    expect(matchesFacets(tile({ color: '' }), emptyFacets())).toBe(true);
  });

  it('ignores selections that the current scope does not offer', () => {
    const options = facetOptions([tile()]);
    const effective = effectiveFacets({ size: ['300X300'], color: ['그레이'], finish: [] }, options);
    expect(effective).toEqual({ size: [], color: ['그레이'], finish: [] });
    expect(hasFacets(effectiveFacets({ ...emptyFacets(), size: ['300X300'] }, options))).toBe(false);
  });
});
