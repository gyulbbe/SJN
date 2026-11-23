import { describe, expect, it } from 'vitest';
import {
  CORNER_OCCLUSION_GLSL,
  cornerOcclusion,
  WALL_CORNER_OCCLUSION,
  WALL_CORNER_RADIUS_MM,
} from '../src/lib/render/realistic-lighting';
import { DESIGN_RENDER_REVISION } from '../src/lib/render/design-preview-cache';

// docs/room-depth-20261123.md: the viewer's walls get more shade into their vertical corners.
describe('wall–wall corner shade (3D viewer and AI input)', () => {
  it('is c6 of the room-depth trial: 0.5 at the corner, over 650 mm', () => {
    expect(WALL_CORNER_OCCLUSION).toBe(0.5);
    expect(WALL_CORNER_RADIUS_MM).toBe(650);
    expect(CORNER_OCCLUSION_GLSL).toContain(
      'float sjnWallCornerTerm(float distance){return sjnFaceAxis.y<.5?1.-0.500*exp(-max(distance,0.)/650.0):1.;}',
    );
  });

  it('shades walls only, on both wall–wall terms, never the floor or the ceiling term', () => {
    const lines = CORNER_OCCLUSION_GLSL.split('\n');
    const x = lines.find((l) => l.includes('if(sjnFaceAxis.x<.5)'))!;
    const z = lines.find((l) => l.includes('if(sjnFaceAxis.z<.5)'))!;
    const y = lines.find((l) => l.includes('if(sjnFaceAxis.y<.5)'))!;
    expect(x).toContain('sjnWallCornerTerm(sjnRoom.x*.5-abs(p.x))');
    expect(z).toContain('sjnWallCornerTerm(p.z)');
    // The y line (floor and ceiling distance) keeps the plain corner term.
    expect(y).not.toContain('sjnWallCornerTerm');
    // The wall term itself is 1 on a floor or ceiling face (normal along y).
    expect(CORNER_OCCLUSION_GLSL).toMatch(/sjnWallCornerTerm\(float distance\)\{return sjnFaceAxis\.y<\.5\?/);
  });

  it('leaves the 2D background shade (a saved PNG) as it was', () => {
    const room = { widthMm: 2400, depthMm: 2400, heightMm: 2400 };
    // Back wall (normal z) at the left corner, mid height: only the side-wall term, 1 − 0.45.
    expect(cornerOcclusion({ x: -1200, y: 1200, z: 0.001 }, room, 'z')).toBeCloseTo(
      (1 - 0.45) * (1 - 0.45 * Math.exp(-1200 / 260)) * (1 - 0.25 * Math.exp(-1200 / 260)),
      6,
    );
  });

  it('draws browser previews anew', () => {
    expect(DESIGN_RENDER_REVISION).toBe(12);
  });
});
