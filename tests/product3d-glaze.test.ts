import { describe, expect, it } from 'vitest';
import { MeshPhysicalMaterial, MeshStandardMaterial } from 'three';
import {
  GLAZE,
  GLAZED_CATEGORIES,
  GLOSS_LABELS,
  PRODUCT_GLOSSES,
  canGlaze,
  glossFor,
  type ProductGloss,
} from '../src/lib/product3d/glaze';
import { litProductMaterial } from '../src/lib/room-viewer/fixtures';

describe('the glaze of ceramic', () => {
  it('is for the ceramic categories only, and anything unclear stays matte', () => {
    expect([...GLAZED_CATEGORIES].sort()).toEqual(['basin', 'bath', 'toilet']);
    for (const category of ['toilet', 'basin', 'bath']) {
      expect(canGlaze(category)).toBe(true);
      expect(glossFor(category, 'light')).toBe('light');
      expect(glossFor(category, 'normal')).toBe('normal');
    }
    // A vanity may be a wooden cabinet, a faucet is metal, a mirror is glass, tile is flat: all matte.
    for (const category of [
      'vanity',
      'faucet',
      'mirror',
      'tile',
      'shower',
      'door',
      'window',
      undefined,
      'unknown',
    ])
      expect(glossFor(category, 'normal')).toBe('none');
    // Nothing chosen (older saves) is no gloss, and so is a value this version does not know.
    expect(glossFor('toilet', undefined)).toBe('none');
    expect(glossFor('toilet', 'none')).toBe('none');
    expect(glossFor('toilet', 'mirror-finish' as ProductGloss)).toBe('none');
  });

  it('has three levels with names, and a stronger one is smoother and more coated', () => {
    expect(PRODUCT_GLOSSES).toEqual(['none', 'light', 'normal']);
    expect(Object.values(GLOSS_LABELS)).toEqual(['광택 없음', '약하게', '보통']);
    expect(GLAZE.normal.roughness).toBeLessThan(GLAZE.light.roughness);
    expect(GLAZE.normal.clearcoat).toBeGreaterThan(GLAZE.light.clearcoat);
    expect(GLAZE.normal.room.roughness).toBeLessThan(GLAZE.light.room.roughness);
    for (const glaze of Object.values(GLAZE)) {
      // Smoother than the matte material (0.55 in the editor, 0.5 in the room), within 0.25–0.35.
      expect(glaze.roughness).toBeGreaterThanOrEqual(0.25);
      expect(glaze.roughness).toBeLessThanOrEqual(0.35);
      expect(glaze.clearcoat).toBeGreaterThan(0);
      expect(glaze.clearcoat).toBeLessThanOrEqual(1);
      // The environment's reflection stays faint: a white product has little room before it blows out.
      expect(glaze.editor.environment).toBeLessThanOrEqual(0.2);
      expect(glaze.editor.specular).toBeLessThanOrEqual(1);
    }
  });
});

describe('the lit material of a saved product in the room', () => {
  it('is the matte one without a glaze and a physical one with it', () => {
    const matte = litProductMaterial('none');
    expect(matte).toBeInstanceOf(MeshStandardMaterial);
    expect(matte).not.toBeInstanceOf(MeshPhysicalMaterial);
    expect(matte.roughness).toBe(0.5);
    for (const gloss of ['light', 'normal'] as const) {
      const glazed = litProductMaterial(gloss);
      expect(glazed).toBeInstanceOf(MeshPhysicalMaterial);
      expect((glazed as MeshPhysicalMaterial).roughness).toBe(GLAZE[gloss].room.roughness);
      expect((glazed as MeshPhysicalMaterial).roughness).toBeLessThan(matte.roughness);
      expect((glazed as MeshPhysicalMaterial).clearcoat).toBe(GLAZE[gloss].room.clearcoat);
      expect(glazed.vertexColors).toBe(true);
      expect(glazed.metalness).toBe(0);
    }
  });
});
