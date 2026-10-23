import type { RoomDimensions } from './room-types';
import type { FixtureInstance, MaterialVersion } from './types';
import { viewDirectionAngle } from './product-direction';
import { findFreeSlot, type FreeSlot, type PlacedBox, type SlotBox } from './room-slot';

/**
 * A floor product against the wall behind it (docs/size-order-and-contact-results-20261024.md): the
 * back of its footprint on that wall's inner face. The wall behind is the one opposite the way the
 * product faces: its photo's angle name (정면 → the back wall, 오른쪽 → the left wall, 왼쪽 → the right
 * wall), a standard model's turn. A product facing 뒤 has its back to the open front: no wall.
 *
 * `roomPlacement.againstWall` keeps it there: the place across the wall (u or v) stays the user's,
 * the distance from the wall follows the product's depth, its angle and the room's size.
 */
export type WallSide = 'back' | 'left' | 'right';
/** Dragging a floor product's back within this of its wall (mm) puts it against the wall. */
export const WALL_SNAP_MM = 100;

type Depths = Record<string, Pick<MaterialVersion, 'depthMm' | 'views'> | undefined>;

/** The way a floor product faces (degrees from the room's front, +90 to the right), as drawn. */
function facingDegrees(fixture: FixtureInstance, materials: Depths): number {
  const model = fixture.reconstruction;
  if (model?.version === 2) return model.yawDegrees ?? 0;
  // A retired 위·아래 photo is drawn as the 정면 photo (see room-viewer/fixtures.ts).
  return viewDirectionAngle(materials[fixture.materialVersionId]?.views[fixture.viewIndex]?.direction) ?? 0;
}

/** The wall behind a floor product, or none (not on the floor, or its back to the open front). */
export function behindWall(fixture: FixtureInstance, materials: Depths): WallSide | undefined {
  if (fixture.roomPlacement?.face !== 'floor') return undefined;
  const quarter = (((Math.round(facingDegrees(fixture, materials) / 90) % 4) + 4) % 4) as 0 | 1 | 2 | 3;
  return quarter === 0 ? 'back' : quarter === 1 ? 'left' : quarter === 3 ? 'right' : undefined;
}

/**
 * The product's depth front to back (mm, with its scale): a standard model's own, else its material's
 * (half its width without one, as the free-place search measures it).
 */
export function productDepthMm(fixture: FixtureInstance, materials: Depths): number {
  const placement = fixture.roomPlacement!;
  const scale = Number.isFinite(placement.scale) && placement.scale > 0 ? placement.scale : 1;
  const model = fixture.reconstruction;
  if (model?.version === 2) return model.depthMm * scale;
  const depth = materials[fixture.materialVersionId]?.depthMm ?? 0;
  return (depth > 0 ? depth : placement.widthMm / 2) * scale;
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/**
 * Where a floor product stands with its back on `wall`: u or v moved (the other kept), or none when
 * it has no wall behind it. The footprint is centred on the place, as the 3D room stands it.
 */
export function wallContactPlace(
  room: RoomDimensions,
  fixture: FixtureInstance,
  materials: Depths,
  wall = behindWall(fixture, materials),
): { u: number; v: number } | undefined {
  const placement = fixture.roomPlacement;
  if (!placement || !wall) return undefined;
  // Exact, not rounded: a rounded place could put the footprint a hair into the wall.
  const half = productDepthMm(fixture, materials) / 2;
  if (wall === 'back') return { u: placement.u, v: clamp01(half / room.depthMm) };
  const u = clamp01(half / room.widthMm);
  return { u: wall === 'left' ? u : 1 - u, v: placement.v };
}

/** How far the back of a floor product's footprint is from the wall behind it (mm; none without one). */
export function wallDistanceMm(room: RoomDimensions, fixture: FixtureInstance, materials: Depths) {
  const placement = fixture.roomPlacement;
  const wall = behindWall(fixture, materials);
  if (!placement || !wall) return undefined;
  const half = productDepthMm(fixture, materials) / 2;
  if (wall === 'back') return placement.v * room.depthMm - half;
  const x = placement.u * room.widthMm;
  return wall === 'left' ? x - half : room.widthMm - x - half;
}

/**
 * Keeps a fixture marked `againstWall` there (after a room resize, a new angle or scale): writes its
 * u/v. Returns whether it moved. One with no wall behind it any more is left where it is.
 */
export function applyWallContact(room: RoomDimensions, fixture: FixtureInstance, materials: Depths): boolean {
  const placement = fixture.roomPlacement;
  // Without its material (not read yet) the depth is unknown: leave it until it is.
  if (!placement?.againstWall || (!materials[fixture.materialVersionId] && !fixture.reconstruction))
    return false;
  const place = wallContactPlace(room, fixture, materials);
  if (!place || (place.u === placement.u && place.v === placement.v)) return false;
  placement.u = place.u;
  placement.v = place.v;
  return true;
}

/**
 * A free place for a floor product against the wall behind it: from its wall place along that wall
 * only, 50 mm from every other product as anywhere (room-slot.ts). Undefined when it has no wall
 * behind it or the wall has no room left: then it goes where the ordinary search puts it.
 */
export function freeWallSlot(
  room: RoomDimensions,
  fixture: FixtureInstance,
  materials: Depths,
  box: SlotBox,
  obstacles: readonly PlacedBox[],
): FreeSlot | undefined {
  const wall = behindWall(fixture, materials);
  const start = wall && wallContactPlace(room, fixture, materials, wall);
  if (!start) return undefined;
  const slot = findFreeSlot(room, 'floor', box, obstacles, {
    defaultSlot: start,
    along: wall === 'back' ? 'u' : 'v',
  });
  return slot.status === 'crowded' ? undefined : slot;
}
