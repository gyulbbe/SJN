import type { Scene, Surface } from './types';

function center(surface: Surface) {
  const points = surface.quad;
  return {
    x: points.reduce((sum, point) => sum + point.x, 0) / 4,
    y: points.reduce((sum, point) => sum + point.y, 0) / 4,
  };
}

/** Explicitly replace wall geometry while retaining materials; the rest of the scene is untouched. */
export function refitWallsScene(scene: Scene, detected: Surface[]): Scene {
  const candidates = detected.filter((surface) => surface.kind === 'wall');
  if (!candidates.length) throw new Error('새 벽 경계를 찾지 못했어요. 현재 작업은 그대로 유지했어요.');
  const previous = scene.surfaces.filter((surface) => surface.kind === 'wall');
  const others = scene.surfaces.filter((surface) => surface.kind !== 'wall');
  if (others.length + candidates.length > 100)
    throw new Error('면 개수가 많아 벽 경계를 새로 추가하지 못했어요.');
  const usedIds = new Set<string>();
  const walls = candidates.map((candidate) => {
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
      name: previous.length === 1 && candidates.length > 1 ? candidate.name : old.name,
      mask: structuredClone(candidate.mask),
      quad: structuredClone(candidate.quad),
      calibrated: false,
    };
  });
  return { ...scene, surfaces: [...others, ...walls] };
}
