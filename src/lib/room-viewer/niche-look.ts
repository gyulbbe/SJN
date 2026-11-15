import type { WallFeaturePiece } from './wall-feature-geometry';

/**
 * How a recess in a wall (a closed niche) is drawn so that it reads as one
 * (docs/niche-look-20261115.md, chosen 2026-11-15). Seen straight on, its inner faces are thin slivers
 * and the room's one light reaches its back as it reaches the wall, so the niche showed as two thin
 * lines, which the AI export redrew as a rail, a frame or a pane. A ledge already takes a fixed shade
 * per face (surfaces.ts LEDGE_SHADE); a recess takes one too: its top reveal (facing down) dark, its
 * side reveals medium, its bottom reveal as the light has it, and its back shaded from its top edge to
 * its bottom.
 */
export const NICHE_SHADE: Partial<Record<WallFeaturePiece['role'], number>> = {
  'reveal-top': 0.5,
  'reveal-left': 0.72,
  'reveal-right': 0.72,
};
/**
 * The reveals casting the light's shadow onto the back: tried on 2026-11-15 and left off, the blurred
 * shadow map left a light gap under the top edge.
 */
export const NICHE_CASTS_SHADOW = false;
/** The back of a recess shaded from its top edge (factor `top`) to its bottom (`bottom`). */
export const NICHE_REAR_GRADIENT: { top: number; bottom: number } | undefined = { top: 0.68, bottom: 0.95 };
