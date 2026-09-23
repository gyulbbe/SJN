import type { Scene, TileSettings } from './types';

/**
 * Installation settings copied by "시공 설정 전체 적용". `seed` is deliberately absent: it picks each
 * surface's tile-variant layout, so copying it would make every wall and floor repeat one pattern.
 */
export const SHARED_TILE_SETTINGS = [
  'pattern',
  'rotation',
  'offsetX',
  'offsetY',
  'groutColor',
  'groutWidth',
  'shading',
] as const satisfies readonly (keyof TileSettings)[];

/** Copies the source surface's installation settings to every wall and floor; tiles stay as chosen. */
export function applyTileSettingsToAllSurfaces(scene: Scene, sourceId: string): number {
  const source = scene.surfaces.find((surface) => surface.id === sourceId);
  if (!source) return 0;
  const shared = Object.fromEntries(SHARED_TILE_SETTINGS.map((key) => [key, source.tile[key]]));
  for (const surface of scene.surfaces) if (surface !== source) Object.assign(surface.tile, shared);
  return scene.surfaces.length;
}
