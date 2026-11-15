/**
 * The niche-look trial's stand-in for src/lib/room-viewer/niche-look.ts (docs/niche-look-20261115.md):
 * render.ts bundles the renderer with that module sent here, and SJN_NICHE_VARIANT (an esbuild define)
 * picks the values. `cur` is the app as it is.
 *   h1    fixed shades: top reveal (facing down) dark, side reveals medium, back slightly
 *   h2    the reveals cast the light's shadow onto the back, no fixed shade
 *   h12   both
 *   h12s  both, the shades stronger
 *   h3    reveals shaded, the back shaded from its top (dark) to its bottom, no shadow map
 *   h3s   the same, stronger
 */
import type { WallFeaturePiece } from '../../src/lib/room-viewer/wall-feature-geometry';

declare const SJN_NICHE_VARIANT: string;
const variant = SJN_NICHE_VARIANT;
type Shade = Partial<Record<WallFeaturePiece['role'], number>>;
const SHADES: Record<string, Shade> = {
  h1: { 'reveal-top': 0.62, 'reveal-left': 0.8, 'reveal-right': 0.8, rear: 0.92 },
  h12: { 'reveal-top': 0.62, 'reveal-left': 0.8, 'reveal-right': 0.8, rear: 0.92 },
  h12s: { 'reveal-top': 0.5, 'reveal-left': 0.7, 'reveal-right': 0.7, rear: 0.85 },
  h3: { 'reveal-top': 0.6, 'reveal-left': 0.8, 'reveal-right': 0.8, 'reveal-bottom': 1 },
  h3s: { 'reveal-top': 0.5, 'reveal-left': 0.72, 'reveal-right': 0.72, 'reveal-bottom': 1 },
};
const GRADIENTS: Record<string, { top: number; bottom: number }> = {
  h3: { top: 0.78, bottom: 0.97 },
  h3s: { top: 0.68, bottom: 0.95 },
};
export const NICHE_REAR_GRADIENT: { top: number; bottom: number } | undefined = GRADIENTS[variant];
export const NICHE_SHADE: Shade = SHADES[variant] ?? {};
export const NICHE_CASTS_SHADOW = variant === 'h2' || variant.startsWith('h12');
