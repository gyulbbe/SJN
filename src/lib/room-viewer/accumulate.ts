import {
  HalfFloatType,
  LinearFilter,
  LinearSRGBColorSpace,
  Mesh,
  NormalBlending,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  WebGLRenderTarget,
  type PerspectiveCamera,
  type Texture,
  type WebGLRenderer,
} from 'three';

/** Radical inverse (Halton) in [0, 1): a fixed, well spread sequence, so exports are reproducible. */
export function halton(index: number, base: number) {
  let fraction = 1,
    result = 0,
    i = index;
  while (i > 0) {
    fraction /= base;
    result += fraction * (i % base);
    i = Math.floor(i / base);
  }
  return result;
}

/** Ceiling panel the light position moves within (matches the visible 600×600 panel). */
export const EXPORT_LIGHT_PANEL_MM = 600;

/**
 * Offsets for export sample k (0-based): a sub-pixel camera shift in pixels and a light position
 * inside the panel, both in [-0.5, 0.5). Sample 0 is the unshifted frame; later samples follow
 * Halton sequences whose separate prime bases keep camera and light decorrelated.
 */
export function exportJitter(k: number) {
  if (k === 0) return { camera: [0, 0] as const, light: [0, 0] as const };
  return {
    camera: [halton(k, 2) - 0.5, halton(k, 3) - 0.5] as const,
    light: [halton(k, 5) - 0.5, halton(k, 7) - 0.5] as const,
  };
}

/**
 * Shifts the image by (dx, dy) pixels of a width×height viewport without moving the camera: the
 * projection's third column translates NDC. Applied after setViewOffset / depth clipping.
 */
export function jitterProjection(
  camera: PerspectiveCamera,
  dx: number,
  dy: number,
  width: number,
  height: number,
) {
  const e = camera.projectionMatrix.elements;
  // clip.w = −z_view, so the third column enters NDC with a minus sign.
  e[8] -= (2 * dx) / width;
  e[9] -= (2 * dy) / height;
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
}

/**
 * Running mean of export samples in half-float targets (one per Before/After side): sample k is
 * blended over the mean with weight 1/(k+1). Owned by one export and disposed right after it.
 */
export class ExportAccumulator {
  private readonly scene = new Scene();
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly geometry = new PlaneGeometry(2, 2);
  private readonly material: ShaderMaterial;
  /** Created on a side's first sample, so an After-only export holds one target. */
  private readonly targets = new Map<number, WebGLRenderTarget>();
  /** One 8-bit pixel read back after each sample (readable on every WebGL implementation). */
  private readonly probe = new WebGLRenderTarget(1, 1, { depthBuffer: false, stencilBuffer: false });
  private readonly pixel = new Uint8Array(4);

  constructor(
    private readonly width: number,
    private readonly height: number,
  ) {
    this.material = new ShaderMaterial({
      uniforms: { sjnSample: { value: null }, sjnWeight: { value: 1 } },
      vertexShader: 'varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0.,1.);}',
      fragmentShader:
        'varying vec2 vUv;uniform sampler2D sjnSample;uniform float sjnWeight;void main(){gl_FragColor=vec4(texture2D(sjnSample,vUv).rgb,sjnWeight);}',
      transparent: true,
      blending: NormalBlending,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.scene.add(new Mesh(this.geometry, this.material));
  }

  texture(side: number): Texture | undefined {
    return this.targets.get(side)?.texture;
  }

  /** Folds sample k of one side into its mean. */
  add(renderer: WebGLRenderer, side: number, sample: Texture, k: number) {
    let target = this.targets.get(side);
    if (!target) {
      target = new WebGLRenderTarget(this.width, this.height, {
        type: HalfFloatType,
        depthBuffer: false,
        stencilBuffer: false,
        minFilter: LinearFilter,
        magFilter: LinearFilter,
      });
      target.texture.colorSpace = LinearSRGBColorSpace;
      this.targets.set(side, target);
    }
    this.material.uniforms.sjnSample.value = sample;
    this.material.uniforms.sjnWeight.value = 1 / (k + 1);
    const previous = renderer.getRenderTarget(),
      autoClear = renderer.autoClear;
    renderer.setRenderTarget(target);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, target.width, target.height);
    // The mean lives in the target: only the first sample may clear it.
    renderer.autoClear = false;
    if (k === 0) renderer.clear();
    renderer.render(this.scene, this.camera);
    renderer.autoClear = autoClear;
    renderer.setRenderTarget(previous);
  }

  /**
   * Blocks until the GPU has finished every sample so far. WebGL calls return before the work is
   * done, so without this, progress and the time budget would count submissions, and a cancel
   * would wait behind queued samples on software rendering.
   */
  finish(renderer: WebGLRenderer, side: number) {
    const texture = this.texture(side);
    if (!texture) return;
    this.material.uniforms.sjnSample.value = texture;
    this.material.uniforms.sjnWeight.value = 1;
    const previous = renderer.getRenderTarget();
    renderer.setRenderTarget(this.probe);
    renderer.setViewport(0, 0, 1, 1);
    renderer.render(this.scene, this.camera);
    renderer.readRenderTargetPixels(this.probe, 0, 0, 1, 1, this.pixel);
    renderer.setRenderTarget(previous);
  }

  dispose() {
    for (const target of this.targets.values()) target.dispose();
    this.targets.clear();
    this.probe.dispose();
    this.material.dispose();
    this.geometry.dispose();
    this.scene.clear();
  }
}
