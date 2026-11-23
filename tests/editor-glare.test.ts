import { describe, expect, it } from 'vitest';
import type { MeshStandardMaterial } from 'three';
import { createRoomSurfaces, DEFAULT_ROOM } from '../src/lib/room-geometry';
import { buildViewerSurfaces, LIVE_DIRECT_ROUGHNESS, ViewerTileCache } from '../src/lib/room-viewer/surfaces';
import { DEFAULT_COLOR, EMPTY_MASK, type Scene } from '../src/lib/types';

// docs/editor-glare-20261123.md: live 3D frames spread the ceiling light's spot on walls; exports keep it.
const scene = (): Scene => ({
  room: structuredClone(DEFAULT_ROOM),
  originalAssetId: 'original',
  previewAssetId: 'preview',
  imageWidth: 1200,
  imageHeight: 800,
  surfaces: createRoomSurfaces(DEFAULT_ROOM),
  fixtures: [],
  protection: EMPTY_MASK(),
  color: { ...DEFAULT_COLOR },
});
type Compiled = {
  fragmentShader: string;
  vertexShader: string;
  uniforms: Record<string, { value: unknown }>;
};
function compile(material: MeshStandardMaterial): Compiled {
  const shader: Compiled = {
    fragmentShader: [
      '#include <aomap_fragment>',
      '#include <lights_fragment_begin>',
      '#include <lights_fragment_maps>',
      '#include <lights_fragment_end>',
      '#include <opaque_fragment>',
    ].join('\n'),
    vertexShader: '#include <project_vertex>',
    uniforms: {},
  };
  material.onBeforeCompile(shader as never, undefined as never);
  return shader;
}

describe('live look: the ceiling light on walls in the editor 3D', () => {
  it('is r50 of the trial', () => {
    expect(LIVE_DIRECT_ROUGHNESS).toBe(0.5);
  });

  it('gives the direct lights a rougher wall only, put back before the room reflection', async () => {
    const surfaces = await buildViewerSurfaces(scene(), {}, new ViewerTileCache(async () => undefined, 2048));
    try {
      const mesh = surfaces.group.children[0] as unknown as { material: MeshStandardMaterial };
      const shader = compile(mesh.material);
      const f = shader.fragmentShader;
      expect(f).toContain('uniform float sjnLiveDirectRoughness;');
      expect(f).toContain(
        'if(sjnFaceAxis.y<.5)material.roughness=max(sjnOwnRoughness,sjnLiveDirectRoughness);',
      );
      // Order: rougher for the direct lights, then its own roughness again before the environment.
      const begin = f.indexOf('#include <lights_fragment_begin>');
      expect(f.lastIndexOf('material.roughness=max(', begin)).toBeGreaterThan(-1);
      const restore = f.indexOf('material.roughness=sjnOwnRoughness;');
      expect(restore).toBeGreaterThan(begin);
      expect(restore).toBeLessThan(f.indexOf('#include <lights_fragment_maps>'));
      // Live by default; an export switches it off (max(roughness, 0) is the roughness itself).
      expect(shader.uniforms.sjnLiveDirectRoughness.value).toBe(LIVE_DIRECT_ROUGHNESS);
      surfaces.setLiveLook(false);
      expect(shader.uniforms.sjnLiveDirectRoughness.value).toBe(0);
      surfaces.setLiveLook(true);
      expect(shader.uniforms.sjnLiveDirectRoughness.value).toBe(LIVE_DIRECT_ROUGHNESS);
    } finally {
      surfaces.dispose();
    }
  });
});
