import {
  HalfFloatType,
  LinearFilter,
  LinearSRGBColorSpace,
  Mesh,
  NoBlending,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  Vector2,
  WebGLRenderTarget,
  type Texture,
  type WebGLRenderer,
} from 'three';

/**
 * Photo look for downloads only (never for AI input or previews). Each strength is 0–1-ish; 0 turns
 * that effect off.
 * - bloom: glow around linear values above 1 (the ceiling lamp, strong highlights), nothing else.
 * - vignette: darkening outside the central 60% box only (radius ≥ 0.6 of the half diagonal).
 * - grain: fixed-seed noise, ±1.5/255 at mid tones, fading to 0 at black and white.
 * - toneCurve: a slight toe lift below 10% and shoulder roll-off above 85% (display values).
 */
export type PhotoEffects = { bloom: number; vignette: number; grain: number; toneCurve: number };
export const PHOTO_EFFECTS: PhotoEffects = { bloom: 0.35, vignette: 0.22, grain: 1, toneCurve: 1 };
/** Same grain on every export, so a download can be reproduced exactly. */
const GRAIN_SEED = 17.0;

const quadVertex = 'varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0.,1.);}';

/**
 * The room viewer's post shader with the photo look added: bloom and vignette in linear light,
 * then tone curve and grain on display values. Built from the post source so colour adjustment and
 * layout stay identical; the plain post program is never changed.
 */
export function photoPostFragment(postFragment: string) {
  const output = 'gl_FragColor=vec4(encodeSRGB(c),1.);';
  if (!postFragment.includes(output) || !postFragment.includes('void main(){'))
    throw new Error('사진 효과를 적용할 출력 셰이더를 찾지 못했습니다.');
  const functions = `
uniform sampler2D sjnBloomBefore;uniform sampler2D sjnBloomAfter;uniform vec4 sjnEffects;uniform float sjnGrainSeed;
vec3 sjnPhotoLinear(vec3 c,vec3 bloom,vec2 p){
 c+=bloom*sjnEffects.x;
 float r=length((p-.5)*2.)*.70710678;
 return c*(1.-sjnEffects.y*smoothstep(.6,1.05,r));
}
float sjnHash(vec2 p){vec3 q=fract(vec3(p.xyx)*.1031);q+=dot(q,q.yzx+33.33);return fract((q.x+q.y)*q.z);}
vec3 sjnPhotoDisplay(vec3 y){
 y=clamp(y,0.,1.);
 vec3 toe=max(1.-y/.1,0.);vec3 shoulder=max((y-.85)/.15,0.);
 y+=sjnEffects.w*(.012*toe*toe-.03*shoulder*shoulder);
 float l=dot(y,vec3(.2126,.7152,.0722));
 y+=(sjnHash(floor(gl_FragCoord.xy)+sjnGrainSeed)-.5)*(3./255.)*sjnEffects.z*4.*l*(1.-l);
 return y;
}
void main(){`;
  return postFragment
    .replace('void main(){', functions)
    .replace(
      output,
      'vec2 sjnP=(uv-sjnPhotoRect.xy)/sjnPhotoRect.zw;' +
        'c=sjnPhotoLinear(c,isBefore?texture2D(sjnBloomBefore,uv).rgb:texture2D(sjnBloomAfter,uv).rgb,sjnP);' +
        'gl_FragColor=vec4(sjnPhotoDisplay(encodeSRGB(c)),1.);',
    );
}

export function photoEffectUniforms(effects: PhotoEffects) {
  const strength = (value: number) => (Number.isFinite(value) ? Math.max(0, Math.min(2, value)) : 0);
  return {
    effects: [
      strength(effects.bloom),
      strength(effects.vignette),
      strength(effects.grain),
      strength(effects.toneCurve),
    ] as const,
    grainSeed: GRAIN_SEED,
  };
}

/**
 * Quarter-resolution glow of the parts above linear 1: a 4×4 box bright pass, then three widening
 * separable Gaussian passes. The glow radius scales with the image (about 2% of its width), so every
 * export size looks the same. Owned by one export and disposed after it.
 */
export class PhotoBloom {
  private readonly scene = new Scene();
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly geometry = new PlaneGeometry(2, 2);
  private readonly mesh: Mesh;
  private readonly bright: ShaderMaterial;
  private readonly blur: ShaderMaterial;
  private readonly targets = new Map<number, [WebGLRenderTarget, WebGLRenderTarget]>();
  private readonly width: number;
  private readonly height: number;

  /** Size of the full-resolution side textures this glow reads. */
  constructor(
    private readonly sourceWidth: number,
    private readonly sourceHeight: number,
  ) {
    this.width = Math.max(1, Math.round(sourceWidth / 4));
    this.height = Math.max(1, Math.round(sourceHeight / 4));
    const common = { vertexShader: quadVertex, depthTest: false, depthWrite: false, blending: NoBlending };
    this.bright = new ShaderMaterial({
      ...common,
      uniforms: { sjnSource: { value: null }, sjnTexel: { value: new Vector2() } },
      fragmentShader: `varying vec2 vUv;uniform sampler2D sjnSource;uniform vec2 sjnTexel;
vec3 bright(vec2 uv){vec3 c=texture2D(sjnSource,uv).rgb;float l=dot(c,vec3(.2126,.7152,.0722));return c*max(l-1.,0.)/max(l,1e-4);}
void main(){vec2 o=sjnTexel;gl_FragColor=vec4(.25*(bright(vUv-o)+bright(vUv+vec2(o.x,-o.y))+bright(vUv+vec2(-o.x,o.y))+bright(vUv+o)),1.);}`,
    });
    this.blur = new ShaderMaterial({
      ...common,
      uniforms: { sjnSource: { value: null }, sjnStep: { value: new Vector2() } },
      fragmentShader: `varying vec2 vUv;uniform sampler2D sjnSource;uniform vec2 sjnStep;
void main(){vec3 s=texture2D(sjnSource,vUv).rgb*.2270270270;
s+=(texture2D(sjnSource,vUv+sjnStep*1.3846153846).rgb+texture2D(sjnSource,vUv-sjnStep*1.3846153846).rgb)*.3162162162;
s+=(texture2D(sjnSource,vUv+sjnStep*3.2307692308).rgb+texture2D(sjnSource,vUv-sjnStep*3.2307692308).rgb)*.0702702703;
gl_FragColor=vec4(s,1.);}`,
    });
    this.mesh = new Mesh(this.geometry, this.bright);
    this.scene.add(this.mesh);
  }

  private pass(renderer: WebGLRenderer, material: ShaderMaterial, target: WebGLRenderTarget) {
    this.mesh.material = material;
    renderer.setRenderTarget(target);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, this.width, this.height);
    renderer.render(this.scene, this.camera);
  }

  /** Glow texture of one side (full-resolution linear source), laid out like the source. */
  run(renderer: WebGLRenderer, side: number, source: Texture) {
    let pair = this.targets.get(side);
    if (!pair) {
      const target = () => {
        const t = new WebGLRenderTarget(this.width, this.height, {
          type: HalfFloatType,
          depthBuffer: false,
          stencilBuffer: false,
          minFilter: LinearFilter,
          magFilter: LinearFilter,
        });
        t.texture.colorSpace = LinearSRGBColorSpace;
        return t;
      };
      pair = [target(), target()];
      this.targets.set(side, pair);
    }
    const [a, b] = pair;
    const previous = renderer.getRenderTarget();
    this.bright.uniforms.sjnSource.value = source;
    this.bright.uniforms.sjnTexel.value.set(1 / this.sourceWidth, 1 / this.sourceHeight);
    this.pass(renderer, this.bright, a);
    const base = this.width / 400;
    for (const spread of [1, 2, 4]) {
      this.blur.uniforms.sjnSource.value = a.texture;
      this.blur.uniforms.sjnStep.value.set((base * spread) / this.width, 0);
      this.pass(renderer, this.blur, b);
      this.blur.uniforms.sjnSource.value = b.texture;
      this.blur.uniforms.sjnStep.value.set(0, (base * spread) / this.height);
      this.pass(renderer, this.blur, a);
    }
    renderer.setRenderTarget(previous);
    return a.texture;
  }

  dispose() {
    for (const pair of this.targets.values()) for (const target of pair) target.dispose();
    this.targets.clear();
    this.bright.dispose();
    this.blur.dispose();
    this.geometry.dispose();
    this.scene.clear();
  }
}
