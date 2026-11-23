// Backlog item 2, step 09: small 3D-light candidates that tell the room's walls apart at their
// corners again (the supervisor's blind check, step 08: new light 0 / 9 / 1 for depth, the loss at the
// vertical wall–wall corners) while the same tile keeps one colour on every wall (item 1's check).
// Each is the 3037c8e renderer with source text swaps (as tests/fixture-haze/scenes.ts SCENES_PATCH),
// drawn by tests/side-tile-ai/capture.ts --rev <name>.
//
// The corner terms (render/realistic-lighting.ts CORNER_OCCLUSION_GLSL) darken bounce light near a
// perpendicular plane: for a wall, the x/z term is the wall–wall corner, the y terms floor and ceiling.
// `wallCorner(k, r)` multiplies the wall–wall terms of walls only (not the floor) by one more
// 1 − k·exp(−d / r): a deeper and/or wider shade into each vertical corner.
const OCC = '${OCCLUSION.toFixed(3)}';
const WALL_X = ' if(sjnFaceAxis.x<.5)o*=sjnCornerTerm(sjnRoom.x*.5-abs(p.x),' + OCC + ');';
const WALL_Z = ' if(sjnFaceAxis.z<.5)o*=sjnCornerTerm(p.z,' + OCC + ');';
const wallCorner = (k, r) => [
  [
    WALL_X,
    ` if(sjnFaceAxis.x<.5){o*=sjnCornerTerm(sjnRoom.x*.5-abs(p.x),${OCC});if(sjnFaceAxis.y<.5)o*=1.-${k.toFixed(3)}*exp(-max(sjnRoom.x*.5-abs(p.x),0.)/${r.toFixed(1)});}`,
  ],
  [
    WALL_Z,
    ` if(sjnFaceAxis.z<.5){o*=sjnCornerTerm(p.z,${OCC});if(sjnFaceAxis.y<.5)o*=1.-${k.toFixed(3)}*exp(-max(p.z,0.)/${r.toFixed(1)});}`,
  ],
];
// The environment's camera-side wall (+z, the 5th face) a little brighter than the other three.
const cameraSide = (gain) => [
  [
    "const faces = [wall, wall, '#e6e6e6', '#888888', wall, wall]",
    `const faces = [wall, wall, '#e6e6e6', '#888888', wall.clone().multiplyScalar(${gain}), wall]`,
  ],
];
// Walls seen at a slant get a little less diffuse light (k at a fully grazing view, 0 face-on), so a
// side wall reads a step darker than the wall the camera faces. Diffuse only, walls only (the floor is
// always seen at a slant): the colour of the tile stays, as with item 1's face-on reflection.
const END = String.raw`'#include <lights_fragment_end>\nreflectedLight.directSpecular*=.6;reflectedLight.indirectSpecular*=.6;'`;
const slantDiffuse = (k) => [
  [
    'const grazingSource = `geometryViewDir=',
    'const grazingSource = `float sjnFacing=abs(dot(geometryNormal,geometryViewDir));geometryViewDir=',
  ],
  [
    END,
    END.slice(0, -1) +
      `if(sjnFaceAxis.y<.5){float sjnSide=1.-${k.toFixed(3)}*(1.-sjnFacing);reflectedLight.directDiffuse*=sjnSide;reflectedLight.indirectDiffuse*=sjnSide;}'`,
  ],
];

export const CANDIDATES = {
  /** Deeper shade in the vertical corners, same reach. */
  c1: {
    base: '3037c8e',
    note: 'wall–wall corner shade +0.35, 500 mm',
    patch: { 'realistic-lighting.ts': wallCorner(0.35, 500) },
  },
  /** A wider, gentler gradient: the wall darkens towards the corner over most of a metre. */
  c2: {
    base: '3037c8e',
    note: 'wall–wall corner shade +0.3, 900 mm',
    patch: { 'realistic-lighting.ts': wallCorner(0.3, 900) },
  },
  /** No corner change: the environment's camera side 1.25 × the other walls (whole faces differ a little). */
  c3: {
    base: '3037c8e',
    note: 'environment camera side × 1.25',
    patch: { 'realistic-lighting.ts': cameraSide(1.25) },
  },
  /** Side walls a step darker: less diffuse light on walls seen at a slant (0.25 at grazing). */
  c4: {
    base: '3037c8e',
    note: 'slanted walls −25% diffuse at grazing',
    patch: { 'surfaces.ts': slantDiffuse(0.25) },
  },
  /** c1's corner shade and a little of c4. */
  c5: {
    base: '3037c8e',
    note: 'c1 + slanted walls −15% diffuse at grazing',
    patch: { 'realistic-lighting.ts': wallCorner(0.35, 500), 'surfaces.ts': slantDiffuse(0.15) },
  },
  /** Stronger and a little wider than c1. */
  c6: {
    base: '3037c8e',
    note: 'wall–wall corner shade +0.5, 650 mm',
    patch: { 'realistic-lighting.ts': wallCorner(0.5, 650) },
  },
  /** The app as checked out (c6 is in the app since 2026-11-23): its own renderer, no swap. */
  app: { base: 'HEAD', note: 'the app as checked out', patch: {} },
};
