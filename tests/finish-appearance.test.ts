import { describe, expect, it } from 'vitest';
import { finishAppearance, MATTE_FINISH } from '../src/lib/render/finish';

describe('finishAppearance', () => {
  it('keeps the existing matte look for empty, unknown and matte finishes', () => {
    for (const finish of ['', '   ', undefined, '기타', '무광', '엠보', 'MATTE', '논슬립'])
      expect(finishAppearance(finish)).toEqual(MATTE_FINISH);
    expect(MATTE_FINISH.roughness).toBe(0.83);
  });

  it('maps catalog finishes from glossiest to roughest', () => {
    const polished = finishAppearance('폴리싱'),
      glossy = finishAppearance('유광'),
      semi = finishAppearance('반광');
    expect(polished.roughness).toBeLessThan(glossy.roughness);
    expect(glossy.roughness).toBeLessThan(semi.roughness);
    expect(semi.roughness).toBeLessThan(MATTE_FINISH.roughness);
    expect([polished.gloss, glossy.gloss, semi.gloss, MATTE_FINISH.gloss]).toEqual(
      [...[polished.gloss, glossy.gloss, semi.gloss, MATTE_FINISH.gloss]].sort((a, b) => b - a),
    );
    for (const dielectric of [polished, glossy, semi]) expect(dielectric.metalness).toBe(0);
  });

  it('treats chrome and brushed finishes as metallic, brushed rougher', () => {
    const chrome = finishAppearance('크롬'),
      brushed = finishAppearance('브러시드');
    expect(chrome.metalness).toBeGreaterThan(0.5);
    expect(brushed.metalness).toBeGreaterThan(0.5);
    expect(brushed.roughness).toBeGreaterThan(chrome.roughness);
  });

  it('normalises case, spacing and combined labels', () => {
    expect(finishAppearance('  Polished  ')).toEqual(finishAppearance('폴리싱'));
    expect(finishAppearance('High   Gloss')).toEqual(finishAppearance('폴리싱'));
    expect(finishAppearance('유광 폴리싱')).toEqual(finishAppearance('폴리싱'));
    expect(finishAppearance('Semi-gloss')).toEqual(finishAppearance('반광'));
  });
});
