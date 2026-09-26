import { describe, expect, it } from 'vitest';
import { PHOTO_EFFECTS, photoEffectUniforms, photoPostFragment } from '../src/lib/room-viewer/photo-effects';

const post = `varying vec2 vUv;
uniform vec4 sjnPhotoRect;
vec3 encodeSRGB(vec3 c){return c;}
void main(){
 vec2 uv=vUv;bool isBefore=false;
 vec3 c=vec3(1.);
 gl_FragColor=vec4(encodeSRGB(c),1.);
}`;

describe('photo effects', () => {
  it('keeps strengths in range and the grain seed fixed', () => {
    expect(photoEffectUniforms(PHOTO_EFFECTS)).toEqual(photoEffectUniforms(PHOTO_EFFECTS));
    const { effects } = photoEffectUniforms({ bloom: -1, vignette: 9, grain: Number.NaN, toneCurve: 1 });
    expect(effects).toEqual([0, 2, 0, 1]);
    for (const value of photoEffectUniforms(PHOTO_EFFECTS).effects) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(2);
    }
  });

  it('only changes the output line of the post shader', () => {
    const photo = photoPostFragment(post);
    // Colour adjustment and layout stay as they were; only the final write gains the look.
    expect(photo).toContain('vec3 c=vec3(1.);');
    expect(photo).not.toContain('gl_FragColor=vec4(encodeSRGB(c),1.);');
    expect(photo).toContain('sjnPhotoDisplay(encodeSRGB(c))');
    // The vignette starts outside the central 60% (radius 0.6 of the half diagonal).
    expect(photo).toContain('smoothstep(.6,1.05,r)');
    expect(() => photoPostFragment('void main(){gl_FragColor=vec4(1.);}')).toThrow();
  });
});
