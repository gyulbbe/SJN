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
  Vector2,
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
 * Rows [y, y + height) of a sample in the mean's pixels (from the bottom); `first` starts the
 * sample. The band's own texture holds those rows at its bottom.
 */
export type ExportBand = { y: number; height: number; first: boolean };

/**
 * Narrows a projection to rows [row, row + rows) of `totalRows`: those rows then fill the whole
 * viewport, so a tile renders into a target (and an MSAA resolve) no bigger than itself. Shifting
 * the viewport instead would keep the maths exact, but software rasterizers then pay for the whole
 * frame on every tile.
 */
export function cropProjectionRows(camera: PerspectiveCamera, row: number, rows: number, totalRows: number) {
  const low = -1 + (2 * row) / totalRows,
    high = -1 + (2 * (row + rows)) / totalRows;
  const scale = 2 / (high - low),
    centre = (high + low) / 2;
  // Clip-space y' = scale·(y − centre·w): row 1 of the matrix (column-major elements).
  const e = camera.projectionMatrix.elements;
  for (let column = 0; column < 4; column++)
    e[column * 4 + 1] = scale * e[column * 4 + 1] - scale * centre * e[column * 4 + 3];
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
}

/** A band should take about this long, so the page can paint and take a cancel in between. */
export const BAND_TARGET_MS = 120;
const MIN_BAND_ROWS = 8;
/** The first band of an export is a sixteenth of the image: software rendering can be that slow. */
const FIRST_BANDS = 16;

/**
 * Splits each sample into horizontal bands sized from the last band's measured time (per row), so
 * one band stays near BAND_TARGET_MS whether the GPU draws the whole image in 50 ms or a software
 * renderer needs seconds. Growth and shrink per step are capped at 4×.
 */
export class BandPlanner {
  private rows: number;

  constructor(
    private readonly totalRows: number,
    private readonly targetMs = BAND_TARGET_MS,
  ) {
    this.rows = Math.min(totalRows, Math.max(MIN_BAND_ROWS, Math.ceil(totalRows / FIRST_BANDS)));
  }

  /** Rows for the next band, never past the rows left. */
  next(remaining: number) {
    return Math.max(1, Math.min(remaining, this.rows));
  }

  record(rows: number, ms: number) {
    const scale = ms > 0 ? Math.min(4, Math.max(0.25, this.targetMs / ms)) : 4;
    this.rows = Math.min(this.totalRows, Math.max(MIN_BAND_ROWS, Math.round(rows * scale)));
  }
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
      uniforms: {
        sjnSample: { value: null },
        sjnWeight: { value: 1 },
        sjnBand: { value: new Vector2(0, 1) },
      },
      vertexShader: 'varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0.,1.);}',
      // sjnBand = (first row of the band, mean rows ÷ band texture rows), both along v.
      fragmentShader:
        'varying vec2 vUv;uniform sampler2D sjnSample;uniform float sjnWeight;uniform vec2 sjnBand;void main(){gl_FragColor=vec4(texture2D(sjnSample,vec2(vUv.x,(vUv.y-sjnBand.x)*sjnBand.y)).rgb,sjnWeight);}',
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

  /**
   * Allocates and clears a side's mean and waits for the GPU, so that cost (large on software
   * WebGL) is a step of its own instead of part of the first sample's first band.
   */
  prepare(renderer: WebGLRenderer, side: number) {
    const target = this.mean(side),
      previous = renderer.getRenderTarget();
    target.scissorTest = false;
    renderer.setRenderTarget(target);
    renderer.setScissorTest(false);
    renderer.clear();
    renderer.setRenderTarget(previous);
    this.finish(renderer, side);
  }

  private mean(side: number) {
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
    return target;
  }

  /**
   * Folds sample k of one side into its mean, or only the rows of one band of it (target pixels,
   * from the bottom). Sample 0 has weight 1, so it replaces whatever the rows held; the first band
   * of an unprepared mean clears it.
   */
  add(renderer: WebGLRenderer, side: number, sample: Texture, k: number, band?: ExportBand) {
    const fresh = !this.targets.has(side),
      target = this.mean(side);
    this.material.uniforms.sjnSample.value = sample;
    this.material.uniforms.sjnWeight.value = 1 / (k + 1);
    const sampleRows = (sample.image as { height: number }).height;
    this.material.uniforms.sjnBand.value.set(
      band ? band.y / this.height : 0,
      band ? this.height / sampleRows : 1,
    );
    const previous = renderer.getRenderTarget(),
      autoClear = renderer.autoClear;
    target.scissorTest = false;
    renderer.setRenderTarget(target);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, target.width, target.height);
    // The mean lives in the target: only a fresh one is cleared.
    renderer.autoClear = false;
    if (fresh) renderer.clear();
    if (band) {
      // Kept on the target too: three re-applies a target's own scissor when it rebinds it.
      target.scissor.set(0, band.y, target.width, band.height);
      target.scissorTest = true;
      renderer.setScissor(0, band.y, target.width, band.height);
      renderer.setScissorTest(true);
    }
    renderer.render(this.scene, this.camera);
    target.scissorTest = false;
    renderer.setScissorTest(false);
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
    this.material.uniforms.sjnBand.value.set(0, 1);
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
