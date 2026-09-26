import { MathUtils, Mesh, ShaderChunk, type Material, type Object3D, type SpotLight } from 'three';
import type { RoomDimensions } from '../room-types';
import { EXPORT_LIGHT_PANEL_MM } from './accumulate';

/**
 * One shadow rule for the ceiling light, used by live frames, previews and exports alike.
 *
 * three sets a SpotLight's shadow camera to fov = 2·angle·focus. The light's 90° cone (angle π/2)
 * with focus 1 gave a 180° frustum, which is degenerate: no fixture cast a shadow. The frustum is
 * fitted to the room instead: from the light it reaches the floor corners and the walls down to
 * fixture height, plus the half panel an export moves the light by, and no further, so the map's
 * texels land where shadows fall.
 */
export const ROOM_SHADOW_MAP = 1024;
/**
 * Blur radius in shadow-map texels. A single frame (live, previews, few-sample exports) blurs
 * widely to stand in for the 600 mm ceiling panel: 40 brings its shadow edge (mean darkening
 * gradient) near a 32-sample export's without visible tap copies. An export that moves the light
 * across the panel gets its softness from that, so it keeps a small blur (stage 1's 32-sample look).
 */
export const LIVE_SHADOW_RADIUS = 20;
export const MOVING_LIGHT_SHADOW_RADIUS = 5;
/** Walls stay inside the frustum from the floor up to this height (basins, tanks, bath rims). */
const COVER_HEIGHT_MM = 1200;
const MARGIN_DEGREES = 4;
const MIN_FOV = 60;
/** Beyond ~150° the perspective shadow map loses its resolution at the edges. */
const MAX_FOV = 150;

export function roomShadowFov(room: RoomDimensions, light: { y: number; z: number }) {
  const reach = Math.max(room.widthMm / 2, light.z, room.depthMm - light.z) + EXPORT_LIGHT_PANEL_MM / 2;
  const drop = Math.max(1, light.y - Math.min(COVER_HEIGHT_MM, room.heightMm * 0.5));
  const half = MathUtils.radToDeg(Math.atan(reach / drop)) + MARGIN_DEGREES;
  return MathUtils.clamp(2 * half, MIN_FOV, MAX_FOV);
}

export function applyRoomShadow(light: SpotLight, room: RoomDimensions) {
  const fov = roomShadowFov(room, light.position);
  light.castShadow = true;
  light.shadow.focus = fov / (2 * MathUtils.radToDeg(light.angle));
  light.shadow.mapSize.set(ROOM_SHADOW_MAP, ROOM_SHADOW_MAP);
  light.shadow.radius = LIVE_SHADOW_RADIUS;
  light.shadow.camera.near = Math.max(1, room.heightMm * 0.01);
  light.shadow.camera.far = Math.hypot(room.widthMm, room.heightMm, room.depthMm) * 1.5;
}

/**
 * three 0.185's PCF rotates five Vogel-disk taps per pixel with interleaved gradient noise, a
 * screen-space dither that shows as a dotted pattern, and averaging an export cannot remove it.
 * Here 32 taps on the same disk, unrotated: every pixel sees the same pattern, so the penumbra is a
 * smooth blend of 32 shifted hard shadows (like 32 light positions), each tap a hardware 2×2
 * comparison.
 */
export const SHADOW_TAPS = 32;
export function smoothShadowChunk(chunk: string) {
  const start = chunk.indexOf('float phi = interleavedGradientNoise( gl_FragCoord.xy ) * PI2;');
  const end = chunk.indexOf(') * 0.2;', start);
  if (start < 0 || end < 0) throw new Error('그림자 필터를 바꿀 셰이더 위치를 찾지 못했습니다.');
  return (
    chunk.slice(0, start) +
    `shadow = 0.0;
				for ( int i = 0; i < ${SHADOW_TAPS}; i ++ ) {
					shadow += texture( shadowMap, vec3( shadowCoord.xy + vogelDiskSample( i, ${SHADOW_TAPS}, 0.0 ) * radius, shadowCoord.z ) );
				}
				shadow *= ${(1 / SHADOW_TAPS).toFixed(6)};` +
    chunk.slice(end + ') * 0.2;'.length)
  );
}

const SHADOW_INCLUDE = '#include <shadowmap_pars_fragment>';
let smoothChunk: string | undefined;
const patched = new WeakSet<Material>();

/** Every lit material in a viewer world samples shadows through the smooth disk. */
export function bindRoomShadows(tree: Object3D) {
  tree.traverse((node) => {
    if (!(node instanceof Mesh)) return;
    const materials: Material[] = Array.isArray(node.material) ? node.material : [node.material];
    for (const material of materials) {
      if (patched.has(material)) continue;
      patched.add(material);
      const previous = material.onBeforeCompile,
        previousKey = material.customProgramCacheKey;
      material.onBeforeCompile = (shader, renderer) => {
        previous.call(material, shader, renderer);
        smoothChunk ??= smoothShadowChunk(ShaderChunk.shadowmap_pars_fragment);
        shader.fragmentShader = shader.fragmentShader.replace(SHADOW_INCLUDE, smoothChunk);
      };
      material.customProgramCacheKey = () => `${previousKey.call(material)}|sjn-disk-shadow-v1`;
    }
  });
}
