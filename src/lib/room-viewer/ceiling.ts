import {
  Color,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  Vector3,
} from 'three';
import { CORNER_OCCLUSION_GLSL, TONE_MAPPING_GLSL } from '../render/realistic-lighting';
import type { RoomDimensions } from '../room-types';

/** Neutral matte ceiling paint; no product, quote or selection is attached to it. */
export const VIEWER_CEILING_COLOR = '#f3f2ee';
/** A flat recessed LED panel where the room light already hangs (see createRoomLightRig). */
export const VIEWER_LAMP_SIZE_MM = 600;
/** Linear radiance above 1 so the panel reads as a light source (and later feeds bloom). */
const LAMP_RADIANCE = 3;
/** Fill for the light bounced up from walls and floor (keeps the ceiling near the upper walls). */
const CEILING_BOUNCE = 0.5;

/**
 * Closes the room from inside for in-room eye views: a ceiling plane and the visible light panel.
 * Kept out of the surface and fixture groups, so picking, fixture boxes, contact shadows and quotes
 * never see it. Hidden by default; the renderer shows it only for 'room-eye' views, because orbit
 * views look in from outside (the ceiling would cover them) and saved photo cameras must keep
 * rendering exactly as before.
 */
export function buildViewerCeiling(room: RoomDimensions) {
  const group = new Group();
  group.name = 'viewer-ceiling';
  group.visible = false;
  const ceilingGeometry = new PlaneGeometry(room.widthMm, room.depthMm);
  const ceilingMaterial = new MeshStandardMaterial({
    color: VIEWER_CEILING_COLOR,
    roughness: 0.9,
    metalness: 0,
    side: DoubleSide,
    // The environment map sees the dark floor from a downward face; a real ceiling is lit by the
    // bright walls and floor bouncing the downlight. A constant fill stands in for that bounce.
    emissive: VIEWER_CEILING_COLOR,
    emissiveIntensity: CEILING_BOUNCE,
  });
  ceilingMaterial.onBeforeCompile = (shader) => {
    // Same room-corner darkening and tone mapping as the walls (surfaces.ts), without tiles.
    shader.uniforms.sjnRoom = { value: new Vector3(room.widthMm, room.heightMm, room.depthMm) };
    shader.uniforms.sjnFaceAxis = { value: new Vector3(0, 1, 0) };
    shader.vertexShader = 'varying vec3 sjnWorld;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <project_vertex>',
      '#include <project_vertex>\nsjnWorld=(modelMatrix*vec4(transformed,1.)).xyz;',
    );
    shader.fragmentShader = TONE_MAPPING_GLSL + CORNER_OCCLUSION_GLSL + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <aomap_fragment>',
        '#include <aomap_fragment>\n{float sjnAo=sjnCornerOcclusion();reflectedLight.indirectDiffuse*=sjnAo;reflectedLight.indirectSpecular*=sjnAo;}',
      )
      .replace(
        '#include <opaque_fragment>',
        'outgoingLight=sjnToneMap(outgoingLight);\n#include <opaque_fragment>',
      );
  };
  ceilingMaterial.customProgramCacheKey = () => 'sjn-room-ceiling-v1';
  const ceiling = new Mesh(ceilingGeometry, ceilingMaterial);
  ceiling.name = 'viewer-ceiling:plane';
  // PlaneGeometry faces +z; a quarter turn about x makes it face the floor.
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.set(0, room.heightMm, room.depthMm / 2);
  ceiling.castShadow = false;
  ceiling.receiveShadow = false;

  const lampGeometry = new PlaneGeometry(VIEWER_LAMP_SIZE_MM, VIEWER_LAMP_SIZE_MM);
  const lampMaterial = new MeshBasicMaterial({
    color: new Color(1, 1, 1).multiplyScalar(LAMP_RADIANCE),
    side: DoubleSide,
    toneMapped: false,
  });
  const lamp = new Mesh(lampGeometry, lampMaterial);
  lamp.name = 'viewer-ceiling:lamp';
  lamp.rotation.x = Math.PI / 2;
  // Just under the ceiling, centred on the ceiling light (x 0, z 0.52 depth).
  lamp.position.set(0, room.heightMm - 2, room.depthMm * 0.52);
  lamp.castShadow = false;
  lamp.receiveShadow = false;
  group.add(ceiling, lamp);

  let disposed = false;
  return {
    group,
    setVisible(visible: boolean) {
      group.visible = visible;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      ceilingGeometry.dispose();
      ceilingMaterial.dispose();
      lampGeometry.dispose();
      lampMaterial.dispose();
      group.clear();
    },
  };
}
export type ViewerCeiling = ReturnType<typeof buildViewerCeiling>;
