import type { Mask, Scene, Surface } from './types';
import type { RoomSegmentation } from './segmentation';
import { binaryMaskToMask } from './render/auto-surfaces';
import { maskContains } from './render/mask';

/** Remove protection only on confident floor interiors; the one-pixel boundary stays protected. */
export function refineFloorProtection(protection: Mask, segmentation: RoomSegmentation): Mask {
  const { width, height, floor } = segmentation;
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      if (!maskContains(protection, { x: (x + 0.5) / width, y: (y + 0.5) / height }, width / height))
        continue;
      let interior = x > 0 && y > 0 && x < width - 1 && y < height - 1;
      for (let dy = -1; dy <= 1 && interior; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (!floor[(y + dy) * width + x + dx]) {
            interior = false;
            break;
          }
        }
      if (!interior) data[y * width + x] = 255;
    }
  return binaryMaskToMask({ width, height, data });
}

function center(surface: Surface) {
  return {
    x: surface.quad.reduce((sum, p) => sum + p.x, 0) / 4,
    y: surface.quad.reduce((sum, p) => sum + p.y, 0) / 4,
  };
}

/** Explicit refit replaces floor geometry, retaining the closest floor's material and appearance. */
export function refitFloorScene(
  scene: Scene,
  detected: Surface[],
  segmentation: RoomSegmentation,
  refineProtection: boolean,
): Scene {
  const candidates = detected.filter((surface) => surface.kind === 'floor');
  if (!candidates.length) throw new Error('새 바닥 경계를 찾지 못했어요. 현재 작업은 그대로 유지했어요.');
  const previous = scene.surfaces.filter((surface) => surface.kind === 'floor');
  const others = scene.surfaces.filter((surface) => surface.kind !== 'floor');
  if (others.length + candidates.length > 100)
    throw new Error('면 개수가 많아 바닥 경계를 새로 추가하지 못했어요.');
  const usedIds = new Set<string>();
  const floors = candidates.map((candidate) => {
    const position = center(candidate);
    const old = [...previous].sort((a, b) => {
      const ca = center(a),
        cb = center(b);
      return (
        Math.hypot(ca.x - position.x, ca.y - position.y) - Math.hypot(cb.x - position.x, cb.y - position.y)
      );
    })[0];
    if (!old) return structuredClone(candidate);
    const id = usedIds.has(old.id) ? candidate.id : old.id;
    usedIds.add(id);
    return {
      ...structuredClone(old),
      id,
      mask: structuredClone(candidate.mask),
      quad: structuredClone(candidate.quad),
      calibrated: false,
    };
  });
  return {
    ...scene,
    surfaces: [...others, ...floors],
    protection: refineProtection ? refineFloorProtection(scene.protection, segmentation) : scene.protection,
  };
}
