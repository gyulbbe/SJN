// Backlog item 3: the bright spot high on the back wall of the editor's 3D view (user: "앱 그림에도
// 상단에 빛이 비치는 거야 왜?"). The AI's finished picture already drops it (docs/wall-glare-20261121.md);
// on 11-21 the user kept the editor 3D's gloss as it is rather than make every glossy tile rougher
// (0.45 / 0.6). These swap source text in the app's renderer (HEAD) to find the cause and to try fixes
// that keep the glossy look: tests/side-tile-ai/capture.ts --rev <name> draws them.
//
// In three's physical shader the direct lights (the ceiling spot) add their specular in
// lights_fragment_begin, the environment's reflection comes in lights_fragment_maps/_end; the app then
// keeps 0.6 of both (surfaces.ts). `walls` limits a change to wall faces (not the floor).
const END = String.raw`'#include <lights_fragment_end>\nreflectedLight.directSpecular*=.6;reflectedLight.indirectSpecular*=.6;'`;
const after = (glsl) => [[END, END.slice(0, -1) + glsl + "'"]];
const AO = "      .replace(\n        '#include <aomap_fragment>',";
/** The direct lights see a rougher wall (at least `r`); the environment's reflection keeps the tile's own. */
const directRoughness = (r) => [
  [
    AO,
    String.raw`      .replace(
        '#include <lights_fragment_begin>',
        'float sjnOwnRoughness=material.roughness;if(sjnFaceAxis.y<.5)material.roughness=max(sjnOwnRoughness,${r.toFixed(3)});\n#include <lights_fragment_begin>\nmaterial.roughness=sjnOwnRoughness;',
      )
` + AO,
  ],
];

export const GLARE_CANDIDATES = {
  /** Cause check: no specular from the direct lights on walls. */
  d0: {
    base: 'HEAD',
    note: 'walls: direct specular off',
    patch: { 'surfaces.ts': after('if(sjnFaceAxis.y<.5)reflectedLight.directSpecular*=0.;') },
  },
  /** Cause check: no environment reflection on walls. */
  i0: {
    base: 'HEAD',
    note: 'walls: environment reflection off',
    patch: { 'surfaces.ts': after('if(sjnFaceAxis.y<.5)reflectedLight.indirectSpecular*=0.;') },
  },
  /** The ceiling light's highlight spread wider and dimmer; the room's reflection stays sharp. */
  r35: {
    base: 'HEAD',
    note: 'walls: direct-light roughness at least 0.35',
    patch: { 'surfaces.ts': directRoughness(0.35) },
  },
  r50: {
    base: 'HEAD',
    note: 'walls: direct-light roughness at least 0.5',
    patch: { 'surfaces.ts': directRoughness(0.5) },
  },
  /** The ceiling light's highlight a third as strong. */
  s30: {
    base: 'HEAD',
    note: 'walls: direct specular × 0.3',
    patch: { 'surfaces.ts': after('if(sjnFaceAxis.y<.5)reflectedLight.directSpecular*=.3;') },
  },
};
