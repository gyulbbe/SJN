import {
  Color,
  Group,
  HalfFloatType,
  LinearFilter,
  LinearSRGBColorSpace,
  Mesh,
  Scene,
  Vector2,
  Vector4,
  WebGLRenderTarget,
  type Texture,
  type WebGLRenderer,
  type MeshStandardMaterial,
} from 'three';
import type { FixtureInstance } from '../types';
import type { RoomDefinition } from '../room-types';
import { createRoomCamera } from '../room-geometry';
import {
  createTemplateModel,
  disposeTemplateModel,
  TEMPLATE_RENDERER_REVISION,
} from '../reconstruction/templates';
import { reconstructionModelTransform } from '../reconstruction/projection';
import { createModelLights, TONE_MAPPING_GLSL } from './realistic-lighting';
import type { ReconstructionKind } from '../reconstruction/types';

export type StandardFixturePass = { fixture: FixtureInstance; occlusion: Texture; standardKey: string };
type Entry = {
  key: string;
  model: Group;
  adjustment: { value: Vector4 };
  occlusion: { value: Texture };
  resolution: { value: Vector2 };
};
/** A transparent, linear-colour depth pass on the compositor's existing WebGL renderer. */
export class StandardModelRenderer {
  private readonly scene = new Scene();
  private readonly entries = new Map<string, Entry>();
  private readonly target: WebGLRenderTarget;
  private attached: Group[] = [];
  constructor(private readonly renderer: WebGLRenderer) {
    this.target = new WebGLRenderTarget(1, 1, {
      depthBuffer: true,
      stencilBuffer: false,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      samples: Math.min(4, renderer.capabilities.maxSamples),
      ...(renderer.extensions.has('EXT_color_buffer_float') ? { type: HalfFloatType } : {}),
    });
    this.target.texture.colorSpace = LinearSRGBColorSpace;
    this.scene.add(...createModelLights());
  }
  private entry(pass: StandardFixturePass) {
    const reconstruction = pass.fixture.reconstruction!;
    const key = JSON.stringify([
      TEMPLATE_RENDERER_REVISION,
      reconstruction.kind,
      reconstruction.color,
      reconstruction.bathLiningColor,
      reconstruction.mirrorShape,
      reconstruction.vanityStyle,
      reconstruction.counterSupport,
      reconstruction.widthMm,
      reconstruction.heightMm,
      reconstruction.depthMm,
      reconstruction.basinVariant,
      reconstruction.basinShape,
      reconstruction.pedestalShape,
      reconstruction.bowlCount,
      reconstruction.toiletLidState,
      pass.fixture.roomPlacement?.face,
      reconstruction.hasFrame,
      reconstruction.opacity,
      reconstruction.doorCount,
      reconstruction.shelfStyle,
      reconstruction.support?.kind,
      reconstruction.support?.heightMm,
      reconstruction.support?.curb?.widthMm,
      reconstruction.support?.curb?.depthMm,
    ]);
    let entry = this.entries.get(pass.standardKey);
    if (entry?.key === key) return entry;
    if (entry) {
      this.scene.remove(entry.model);
      disposeTemplateModel(entry.model);
    }
    const model = createTemplateModel({
      ...reconstruction,
      face: pass.fixture.roomPlacement?.face,
      kind: reconstruction.kind as ReconstructionKind,
    });
    entry = {
      key,
      model,
      adjustment: { value: new Vector4() },
      occlusion: { value: pass.occlusion },
      resolution: { value: new Vector2() },
    };
    const uniforms = entry;
    const materials = new Set<MeshStandardMaterial>();
    model.traverse((node) => {
      if (node instanceof Mesh)
        for (const material of Array.isArray(node.material) ? node.material : [node.material])
          materials.add(material as MeshStandardMaterial);
    });
    for (const material of materials) {
      material.alphaToCoverage = false;
      material.onBeforeCompile = (shader) => {
        shader.uniforms.sjnAdjustment = uniforms.adjustment;
        shader.uniforms.sjnOcclusion = uniforms.occlusion;
        shader.uniforms.sjnResolution = uniforms.resolution;
        shader.fragmentShader =
          `uniform vec4 sjnAdjustment;
uniform sampler2D sjnOcclusion; uniform vec2 sjnResolution;
vec3 sjnAdjust(vec3 c) {
  c *= exp2(sjnAdjustment.x);
  c = (c - .18) * sjnAdjustment.y + .18;
  c = mix(vec3(dot(c, vec3(.2126,.7152,.0722))), c, sjnAdjustment.z);
  return max(vec3(0.), c * vec3(1.+sjnAdjustment.w*.18, 1., 1.-sjnAdjustment.w*.18));
}
` +
          TONE_MAPPING_GLSL +
          shader.fragmentShader;
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <opaque_fragment>',
          `
float sjnVisible = 1. - texture2D(sjnOcclusion, gl_FragCoord.xy / sjnResolution).a;
if (sjnVisible < .001) discard;
#ifdef OPAQUE
// Ordered coverage writes either full colour/depth or neither. Multiplying opaque alpha
// would hide the object behind it, and alpha-to-coverage would store coverage twice.
vec2 sjnP0 = mod(floor(gl_FragCoord.xy), 2.);
vec2 sjnP1 = mod(floor(gl_FragCoord.xy * .5), 2.);
float sjnA = 2. * mod(sjnP0.x + sjnP0.y, 2.) + sjnP0.y;
float sjnB = 2. * mod(sjnP1.x + sjnP1.y, 2.) + sjnP1.y;
if (sjnVisible <= (4. * sjnA + sjnB + .5) / 16.) discard;
#endif
outgoingLight = sjnToneMap(sjnAdjust(outgoingLight));
#include <opaque_fragment>
#ifndef OPAQUE
gl_FragColor.a *= sjnVisible;
#endif
`,
        );
      };
      material.customProgramCacheKey = () => 'sjn-standard-v3-colour-mask-2-tone';
    }
    this.entries.set(pass.standardKey, entry);
    return entry;
  }
  render(
    passes: StandardFixturePass[],
    room: RoomDefinition,
    aspect: number,
    width: number,
    height: number,
  ): Texture {
    for (const model of this.attached) this.scene.remove(model);
    this.attached = [];
    for (const pass of passes) {
      const entry = this.entry(pass),
        fixture = pass.fixture;
      const transform = reconstructionModelTransform(room, {
        ...fixture.reconstruction!,
        ...fixture.roomPlacement!,
      });
      entry.model.position.copy(transform.origin);
      entry.model.rotation.set(0, transform.angle, 0);
      entry.model.scale.setScalar(transform.scale);
      const c = fixture.color;
      entry.adjustment.value.set(c.exposure, c.contrast, c.saturation, c.warmth);
      entry.occlusion.value = pass.occlusion;
      entry.resolution.value.set(width, height);
      this.scene.add(entry.model);
      this.attached.push(entry.model);
    }
    this.target.setSize(width, height);
    const clear = this.renderer.getClearColor(new Color()),
      alpha = this.renderer.getClearAlpha();
    try {
      this.renderer.setClearColor(0, 0);
      this.renderer.setRenderTarget(this.target);
      this.renderer.render(this.scene, createRoomCamera(room, aspect));
      return this.target.texture;
    } finally {
      this.renderer.setClearColor(clear, alpha);
    }
  }
  retain(keys: Set<string>) {
    for (const [id, entry] of this.entries) {
      if (keys.has(id)) continue;
      this.scene.remove(entry.model);
      disposeTemplateModel(entry.model);
      this.entries.delete(id);
    }
  }
  dispose() {
    this.retain(new Set());
    this.attached = [];
    this.target.dispose();
  }
}
