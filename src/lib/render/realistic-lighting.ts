import {
  BackSide,
  BoxGeometry,
  Color,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  PMREMGenerator,
  Scene,
  SpotLight,
  type Object3D,
  type Texture,
  type WebGLRenderer,
} from 'three';
import type { RoomDimensions } from '../room-types';
import { applyRoomShadow } from '../room-viewer/shadow';

/**
 * Khronos PBR Neutral tone mapping, the same curve as three's NeutralToneMapping. It keeps base
 * colours under unit illumination and only compresses highlights, so tile colours stay
 * recognisable while glossy reflections and the ceiling light no longer clip. The viewer and model
 * passes render into linear targets, where renderer.toneMapping is never applied, so lit materials
 * call this themselves. Unlit photo/original-colour materials must not.
 */
export const TONE_MAPPING_GLSL = `
vec3 sjnToneMap(vec3 color){
  float low=min(color.r,min(color.g,color.b));
  color-=low<.08?low-6.25*low*low:.04;
  float peak=max(color.r,max(color.g,color.b));
  if(peak<.76)return color;
  float mapped=1.-.0576/(peak-.52);
  color*=mapped/peak;
  return mix(color,vec3(mapped),1.-1./(.15*(peak-mapped)+1.));
}
`;

/**
 * Diffuse level the ceiling light gives the floor centre (a white surface lit to 1 = 1), and the
 * ambient bounce level (environment map or hemisphere fallback). 2026-11-14 (0.44/0.58 → 0.32/0.66,
 * docs/light-tuning-results-20261114.md): less of the downlight and more bounce, so a wall is lit
 * more evenly (no bright patch in its middle) while the walls' overall level stays.
 */
const CEILING_LIGHT = 0.32;
const BOUNCE = 0.66;
/** The 2D front-view model pass keeps its 2026-09-25 bounce: the 2D picture's light was not changed. */
const MODEL_BOUNCE = 0.58;
// Neutral white: any warm or cool cast would shift every tile colour the user compares.
const LIGHT_COLOR = '#ffffff';
/**
 * The environment's four walls (× white). Until 2026-11-21 only the camera side (+z, a doorway
 * behind a photographer) was 2.15 and the rest #cccccc, so a wall facing it got about 2.5 × the bounce
 * of the side walls and the same tile looked like two (docs/side-tile-20261121.md).
 */
const ENVIRONMENT_WALL = 2;

/**
 * Room-fixed interior lighting: one ceiling downlight casting soft shadows plus ambient bounce.
 * Positions follow the room's millimetre dimensions, so the view never drags the light along.
 */
export function createRoomLightRig(room: RoomDimensions, options: { environment: boolean }): Object3D[] {
  const { heightMm: height, depthMm: depth } = room;
  // A 90° cone with full penumbra falls off like a flat ceiling panel (≈cos), so the upper walls
  // fade softly instead of forming a bright band under the ceiling.
  const ceiling = new SpotLight(LIGHT_COLOR, 1, 0, Math.PI / 2, 1, 2);
  ceiling.position.set(0, height * 0.985, depth * 0.52);
  ceiling.target.position.set(0, 0, depth * 0.52);
  // Physically based falloff in millimetres: irradiance = intensity / distance², diffuse = irradiance / π.
  ceiling.intensity = CEILING_LIGHT * Math.PI * (height * 0.985) ** 2;
  ceiling.shadow.bias = -0.0004;
  ceiling.shadow.normalBias = 1.5;
  // Frustum, map and filter: one rule for live frames, previews and exports (room-viewer/shadow).
  applyRoomShadow(ceiling, room);
  const objects: Object3D[] = [ceiling, ceiling.target];
  // Without an environment map the hemisphere carries the same bounce level (low-end fallback).
  if (!options.environment) objects.push(new HemisphereLight('#f7f7f7', '#a8a8a8', BOUNCE * Math.PI));
  return objects;
}

/**
 * The front-view model pass has no environment map or shadow map. A soft key from the open front
 * and above plus hemisphere bounce keep white ceramic near its own colour, as in the viewer.
 */
export function createModelLights(): Object3D[] {
  const key = new DirectionalLight(LIGHT_COLOR, 2.2);
  key.position.set(-600, 2600, 4200);
  return [new HemisphereLight('#f7f7f7', '#c8c8c8', MODEL_BOUNCE * Math.PI), key];
}

/**
 * Soft darkening where room planes meet. A box room needs no screen-space AO pass: the distance in
 * millimetres to each perpendicular plane (side walls, back wall, floor, ceiling) is enough, and the
 * result is deterministic for every view. The open front of the room has no plane.
 */
const OCCLUSION_RADIUS_MM = 260;
const OCCLUSION = 0.45;
const CEILING_OCCLUSION = 0.25;
/**
 * More shade into the vertical wall–wall corners, on walls only (not the floor or ceiling), in the
 * viewer's surfaces (editor 3D and the AI input) — 1 − k·exp(−d / r) on top of the corner term.
 * 2026-11-23 (docs/room-depth-20261123.md): since every wall gets the same light (3037c8e,
 * docs/side-tile-20261121.md) walls were told apart only by the 260 mm shade, and the AI's pictures
 * read flat at the corners (blind 0 / 9 / 1); this (c6) beat it 8 / 0 / 2 with the same tile colour
 * on every wall. The 2D background (room-background.ts, a saved PNG) keeps cornerOcclusion as it was.
 */
export const WALL_CORNER_OCCLUSION = 0.5;
export const WALL_CORNER_RADIUS_MM = 650;

/** `axis` is the face normal's axis; planes parallel to the face do not occlude it. */
export function cornerOcclusion(
  point: { x: number; y: number; z: number },
  room: RoomDimensions,
  axis: 'x' | 'y' | 'z',
  scale = 1,
): number {
  const term = (distance: number, strength: number) =>
    1 - scale * strength * Math.exp(-Math.max(distance, 0) / OCCLUSION_RADIUS_MM);
  let occlusion = 1;
  if (axis !== 'x') occlusion *= term(room.widthMm / 2 - Math.abs(point.x), OCCLUSION);
  if (axis !== 'z') occlusion *= term(point.z, OCCLUSION);
  if (axis !== 'y') occlusion *= term(point.y, OCCLUSION) * term(room.heightMm - point.y, CEILING_OCCLUSION);
  return occlusion;
}

/** GLSL twin of cornerOcclusion for the viewer's surfaces (world position in millimetres). */
export const CORNER_OCCLUSION_GLSL = `
uniform vec3 sjnRoom;uniform vec3 sjnFaceAxis;varying vec3 sjnWorld;
float sjnCornerTerm(float distance,float strength){return 1.-strength*exp(-max(distance,0.)/${OCCLUSION_RADIUS_MM.toFixed(1)});}
float sjnWallCornerTerm(float distance){return sjnFaceAxis.y<.5?1.-${WALL_CORNER_OCCLUSION.toFixed(3)}*exp(-max(distance,0.)/${WALL_CORNER_RADIUS_MM.toFixed(1)}):1.;}
float sjnCornerOcclusion(){
 vec3 p=sjnWorld;
 // Recessed wall-feature pieces lie outside the room box; they keep plain bounce light.
 if(p.z<-1.||abs(p.x)>sjnRoom.x*.5+1.||p.y<-1.||p.y>sjnRoom.y+1.)return 1.;
 float o=1.;
 if(sjnFaceAxis.x<.5)o*=sjnCornerTerm(sjnRoom.x*.5-abs(p.x),${OCCLUSION.toFixed(3)})*sjnWallCornerTerm(sjnRoom.x*.5-abs(p.x));
 if(sjnFaceAxis.z<.5)o*=sjnCornerTerm(p.z,${OCCLUSION.toFixed(3)})*sjnWallCornerTerm(p.z);
 if(sjnFaceAxis.y<.5)o*=sjnCornerTerm(p.y,${OCCLUSION.toFixed(3)})*sjnCornerTerm(sjnRoom.y-p.y,${CEILING_OCCLUSION.toFixed(3)});
 return o;
}
`;

export type InteriorEnvironment = { texture: Texture; intensity: number; dispose(): void };

/**
 * A small procedural bathroom (pale walls, darker floor, bright ceiling panel) filtered by PMREM.
 * It gives soft directional bounce and plausible reflections on glossy tiles. One per WebGL
 * context; returns undefined where half-float colour targets are unavailable.
 */
export function createInteriorEnvironment(renderer: WebGLRenderer): InteriorEnvironment | undefined {
  if (
    !renderer.extensions.has('EXT_color_buffer_float') &&
    !renderer.extensions.has('EXT_color_buffer_half_float')
  )
    return undefined;
  const scene = new Scene();
  const geometries = [new BoxGeometry(10, 6, 10), new PlaneGeometry(2.2, 2.2)];
  // BoxGeometry groups: +x, -x, +y (ceiling), -y (floor), +z, -z. The four walls are equally bright
  // (ENVIRONMENT_WALL) so every room wall gets the same bounce whichever way it faces; the panel
  // mainly shows up as a reflection on glossy tiles.
  const wall = new Color(1, 1, 1).multiplyScalar(ENVIRONMENT_WALL);
  const faces = [wall, wall, '#e6e6e6', '#888888', wall, wall].map(
    (color) => new MeshBasicMaterial({ color, side: BackSide }),
  );
  const panel = new MeshBasicMaterial({ color: new Color(1, 1, 1).multiplyScalar(3) });
  const room = new Mesh(geometries[0], faces);
  const light = new Mesh(geometries[1], panel);
  light.rotation.x = Math.PI / 2;
  light.position.y = 2.95;
  scene.add(room, light);
  const generator = new PMREMGenerator(renderer);
  try {
    const target = generator.fromScene(scene, 0.035);
    return { texture: target.texture, intensity: BOUNCE, dispose: () => target.dispose() };
  } finally {
    generator.dispose();
    for (const geometry of geometries) geometry.dispose();
    for (const material of [...faces, panel]) material.dispose();
  }
}
