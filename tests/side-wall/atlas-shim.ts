/**
 * The side-wall trial's stand-in for src/lib/render/tile-atlas.ts (docs/side-wall-tiles-20261115.md):
 * render.ts bundles the renderers with every import of tile-atlas sent here, and SJN_SIDE_VARIANT
 * (an esbuild define) picks what to change. Everything not overridden is the app's own.
 *   cur        the app as it is
 *   jointphys  joints at their real width (no 1 px minimum)
 *   aniso1     no anisotropic filtering
 *   aniso16    anisotropic filtering up to 16 (where the device allows)
 *   bias0      no mipmap level bias (−0.25 now)
 *   squash     J1: the 1 px joint minimum fades out on an axis the view squashes (a side wall seen
 *              at a slant): full up to SQUASH_KEEP, none from SQUASH_OFF (pixel size along that axis
 *              over the other axis's)
 *   squash2    the same, fading earlier (1.5 → 3)
 */
import { CanvasTexture } from 'three';
import * as app from '../../src/lib/render/tile-atlas';

declare const SJN_SIDE_VARIANT: string;
const variant = SJN_SIDE_VARIANT;

export * from '../../src/lib/render/tile-atlas';

export const TILE_JOINT_MIN_PX = variant === 'jointphys' ? 0 : app.TILE_JOINT_MIN_PX;
const SQUASH = variant === 'squash2' ? [1.5, 3] : [2.5, 4];
export const TILE_JOINT_WIDTH_GLSL =
  variant === 'jointphys'
    ? `
vec2 sjnJointWidth(float grout,vec2 tile,vec2 aa){return vec2(grout);}
`
    : variant.startsWith('squash')
      ? `
vec2 sjnJointWidth(float grout,vec2 tile,vec2 aa){
 vec2 grow=clamp((tile/aa-${app.TILE_JOINT_FADE_PX.toFixed(1)})/${(app.TILE_JOINT_FULL_PX - app.TILE_JOINT_FADE_PX).toFixed(1)},0.,1.);
 vec2 squash=aa/max(min(aa.x,aa.y),1e-6);
 grow*=clamp((${SQUASH[1].toFixed(1)}-squash)/${(SQUASH[1] - SQUASH[0]).toFixed(1)},0.,1.);
 return max(vec2(grout),${app.TILE_JOINT_MIN_PX.toFixed(1)}*aa*grow);
}
`
      : app.TILE_JOINT_WIDTH_GLSL;
export function tileJointWidth(groutMm: number, tileMm: number, pixelMm: number): number {
  return variant === 'jointphys' ? groutMm : app.tileJointWidth(groutMm, tileMm, pixelMm);
}
export function tileAtlasTexture(canvas: HTMLCanvasElement, maxAnisotropy: number): CanvasTexture {
  const texture = app.tileAtlasTexture(canvas, maxAnisotropy);
  if (variant === 'aniso1') texture.anisotropy = 1;
  if (variant === 'aniso16') texture.anisotropy = Math.max(1, Math.min(16, Math.floor(maxAnisotropy) || 1));
  return texture;
}
export function tileAtlasUniforms(layout: app.TileAtlasLayout) {
  const uniforms = app.tileAtlasUniforms(layout);
  if (variant === 'bias0') uniforms.lod = [0, uniforms.lod[1]];
  return uniforms;
}
