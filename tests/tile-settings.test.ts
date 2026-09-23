import { describe, expect, it } from 'vitest';
import { applyTileSettingsToAllSurfaces } from '../src/lib/tile-settings';
import { DEFAULT_COLOR, DEFAULT_TILE, EMPTY_MASK, type Scene, type Surface } from '../src/lib/types';

const surface = (id: string, kind: Surface['kind'], patch: Partial<Surface['tile']> = {}): Surface => ({
  id,
  name: id,
  kind,
  mask: EMPTY_MASK(),
  quad: [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ],
  widthMm: 3000,
  heightMm: 2400,
  calibrated: true,
  materialVersionId: 'tile-' + id,
  color: { ...DEFAULT_COLOR },
  tile: { ...DEFAULT_TILE, ...patch },
});
const scene = (surfaces: Surface[]) => ({ surfaces }) as unknown as Scene;

describe('tile installation settings for every surface', () => {
  it('copies installation settings to walls and floors but keeps each tile and its variant seed', () => {
    const source = surface('left', 'wall', {
      pattern: 'brick',
      rotation: 45,
      offsetX: 120,
      offsetY: -80,
      groutColor: '#333333',
      groutWidth: 4.5,
      shading: 0,
      seed: 7,
    });
    const target = scene([source, surface('back', 'wall', { seed: 21 }), surface('floor', 'floor', { seed: 34 })]);
    expect(applyTileSettingsToAllSurfaces(target, 'left')).toBe(3);
    for (const [index, item] of target.surfaces.entries()) {
      expect(item.tile).toEqual({ ...source.tile, seed: [7, 21, 34][index] });
      expect(item.materialVersionId).toBe('tile-' + item.id);
    }
    expect(target.surfaces.map((item) => [item.kind, item.widthMm])).toEqual([
      ['wall', 3000],
      ['wall', 3000],
      ['floor', 3000],
    ]);
  });

  it('does nothing for an unknown source surface', () => {
    const target = scene([surface('left', 'wall', { pattern: 'brick' }), surface('floor', 'floor')]);
    const before = structuredClone(target);
    expect(applyTileSettingsToAllSurfaces(target, 'missing')).toBe(0);
    expect(target).toEqual(before);
  });
});
