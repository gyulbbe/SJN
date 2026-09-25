/**
 * Browser half of the path-tracing spike (stage 0–1): bundled into an IIFE by
 * tests/pathtracer-spike-browser.ts. The only place that imports three-gpu-pathtracer.
 * One neutral DEFAULT_ROOM with a standard toilet, traced with the export camera. No AI, no network.
 */
import {
  Color,
  DoubleSide,
  Group,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  NeutralToneMapping,
  NoBlending,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  SphereGeometry,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
  type Material,
  type Object3D,
  type Side,
} from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import {
  DenoiseMaterial,
  GradientEquirectTexture,
  ProceduralEquirectTexture,
  WebGLPathTracer,
} from 'three-gpu-pathtracer';
// @ts-expect-error exported at runtime (deprecated) but missing from the package typings
import { PhysicalPathTracingMaterial } from 'three-gpu-pathtracer/src/materials/pathtracing/PhysicalPathTracingMaterial.js';
// @ts-expect-error untyped deep import: the library's own device check is not re-exported from its index
import { CompatibilityDetector } from 'three-gpu-pathtracer/src/detectors/CompatibilityDetector.js';
import { RoomViewerRenderer } from '../src/lib/room-viewer/renderer';
import { defaultRoomView } from '../src/lib/room-viewer/view-state';
import { createRoomSurfaces, DEFAULT_ROOM } from '../src/lib/room-geometry';
import type { FixtureInstance, MaterialVersion, RenderSnapshot, Scene as SjnScene } from '../src/lib/types';

export { WebGLRenderer, WebGLPathTracer };

type Rect = [number, number, number, number];
type Lighting = 'A' | 'B';
type Frame = ReturnType<RoomViewerRenderer['exportFrame']>;

const LONG_EDGE = 1024;
const BOUNCES = 5;
/** Flat regions of the default front view (normalised, y down), as in render-realism-browser. */
export const REGIONS: Record<string, Rect> = {
  backWall: [0.42, 0.3, 0.58, 0.44],
  floor: [0.42, 0.84, 0.58, 0.92],
};
// Same box as createInteriorEnvironment: pale walls, darker floor, bright open front (+z), ceiling panel.
const ENVIRONMENT_INTENSITY = 0.58;

const state: {
  viewer?: RoomViewerRenderer;
  frame?: Frame;
  raster?: ImageData;
  renderer?: WebGLRenderer;
  tracer?: WebGLPathTracer;
  owned: { dispose(): void }[];
  captures: Map<number, ImageData>;
  contextEvents: string[];
} = { owned: [], captures: new Map(), contextEvents: [] };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- capabilities

export type Capabilities = {
  webgl2: boolean;
  colorBufferFloat: boolean;
  textureFloatLinear: boolean;
  floatBlend: boolean;
  maxTextureSize: number;
  maxArrayTextureLayers: number;
  renderer: string;
  vendor: string;
};

/** Fallback rule draft: when this says no, the export keeps the existing raster viewer.export(). */
export function pathTraceSupport(info: Capabilities, detector?: { pass: boolean; message: string }) {
  const no = (reason: string) => ({ supported: false, reason });
  if (!info.webgl2) return no('WebGL2 없음');
  if (!info.colorBufferFloat) return no('float 렌더 타깃(EXT_color_buffer_float) 없음');
  if (info.maxTextureSize < 4096) return no(`MAX_TEXTURE_SIZE ${info.maxTextureSize} < 4096`);
  if (/swiftshader|llvmpipe|basic render|software/i.test(info.renderer))
    return no(`소프트웨어 렌더러(${info.renderer})`);
  if (detector && !detector.pass) return no(`라이브러리 검사 실패: ${detector.message}`);
  return { supported: true, reason: '' };
}

export async function capabilities() {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2');
  let info: Capabilities = {
    webgl2: false,
    colorBufferFloat: false,
    textureFloatLinear: false,
    floatBlend: false,
    maxTextureSize: 0,
    maxArrayTextureLayers: 0,
    renderer: '',
    vendor: '',
  };
  if (gl) {
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    info = {
      webgl2: true,
      colorBufferFloat: !!gl.getExtension('EXT_color_buffer_float'),
      textureFloatLinear: !!gl.getExtension('OES_texture_float_linear'),
      floatBlend: !!gl.getExtension('EXT_float_blend'),
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      maxArrayTextureLayers: gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS),
      renderer: gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER),
      vendor: gl.getParameter(debug ? debug.UNMASKED_VENDOR_WEBGL : gl.VENDOR),
    };
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
  let detector: { pass: boolean; message: string } | undefined;
  let detectorMs = 0;
  if (gl) {
    const renderer = new WebGLRenderer();
    const material = new PhysicalPathTracingMaterial();
    const start = performance.now();
    try {
      const result = new CompatibilityDetector(renderer, material).detect();
      detector = { pass: !!result.pass, message: String(result.message ?? '') };
    } finally {
      detectorMs = performance.now() - start;
      material.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    }
  }
  return { ...info, detector, detectorMs, support: pathTraceSupport(info, detector) };
}

// ---------------------------------------------------------------- scene

function snapshotScene(): RenderSnapshot {
  const room = structuredClone(DEFAULT_ROOM);
  const color = { exposure: 0, contrast: 1, saturation: 1, warmth: 0 };
  const toilet: FixtureInstance = {
    id: 'toilet',
    name: 'toilet',
    materialVersionId: 'standard',
    viewIndex: 0,
    position: { x: 0.5, y: 0.5 },
    width: 0.2,
    height: 0.4,
    rotation: 0,
    anchor: { x: 0.5, y: 1 },
    locked: false,
    shadow: { x: 0, y: 0, opacity: 0, blur: 0.01, scale: 1 },
    occlusion: { polygon: [], strokes: [] },
    color: { ...color },
    roomPlacement: {
      face: 'floor',
      u: 0.72,
      v: 0.28,
      scale: 1,
      widthMm: 400,
      heightMm: 750,
      imageAspect: 400 / 750,
      contentBounds: { left: 0, right: 1, top: 0, bottom: 1 },
    },
    reconstruction: {
      version: 2,
      kind: 'toilet',
      color: '#efefea',
      widthMm: 400,
      heightMm: 750,
      depthMm: 680,
      baseHeightMm: 0,
      yawDegrees: 0,
      toiletLidState: 'closed',
    },
  };
  // Neutral faces: no tile material, so the viewer uses VIEWER_FACE_COLORS.
  const scene: SjnScene = {
    room,
    originalAssetId: 'none',
    previewAssetId: 'none',
    imageWidth: 3600,
    imageHeight: 2400,
    surfaces: createRoomSurfaces(room, 1.5),
    fixtures: [toilet],
    protection: { polygon: [], strokes: [] },
    color: { ...color },
  };
  const standard = {
    id: 'standard',
    materialId: 'standard',
    version: 1,
    name: 'standard',
    brand: '',
    code: '',
    category: 'toilet',
    scope: 'personal',
    description: '',
    color: '#efefea',
    finish: '',
    widthMm: 400,
    heightMm: 750,
    depthMm: 680,
    usage: 'both',
    installation: 'floor',
    textureAssetIds: [],
    views: [],
    defaultGroutWidth: 2,
    defaultGroutColor: '#ffffff',
    defaultPattern: 'grid',
    createdAt: '2026-09-25',
  } as MaterialVersion;
  return { scene, beforeScene: structuredClone(scene), materials: { standard } };
}

const pixelsOf = (source: CanvasImageSource, width: number, height: number) => {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(source, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height);
};
const toPng = (image: ImageData) => {
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  canvas.getContext('2d')!.putImageData(image, 0, 0);
  return canvas.toDataURL('image/png');
};
const pixelRect = (image: ImageData, r: Rect) => ({
  x0: Math.round(r[0] * image.width),
  y0: Math.round(r[1] * image.height),
  x1: Math.round(r[2] * image.width),
  y1: Math.round(r[3] * image.height),
});

export async function prepare() {
  const snapshot = snapshotScene();
  const viewer = new RoomViewerRenderer();
  state.viewer = viewer;
  const start = performance.now();
  await viewer.setSnapshot(snapshot, async () => undefined);
  const prepareMs = performance.now() - start;
  const view = defaultRoomView();
  const exportStart = performance.now();
  const blob = await viewer.export(view, { format: 'png', mode: 'after', longEdge: LONG_EDGE });
  const exportMs = performance.now() - exportStart;
  const bitmap = await createImageBitmap(blob);
  state.raster = pixelsOf(bitmap, bitmap.width, bitmap.height);
  bitmap.close();
  const frame = viewer.exportFrame(view, LONG_EDGE);
  state.frame = frame;
  const fixtureBounds = viewer.fixtureBounds(frame.width, frame.height, view);
  // Project the toilet's mesh boxes with the frame camera: must equal fixtureBounds, whose camera
  // render() and export() share.
  const xs: number[] = [],
    ys: number[] = [];
  frame.world.traverseVisible((node) => {
    const mesh = node as Mesh;
    let owner: Object3D | null = node;
    while (owner && owner.userData.fixtureId !== 'toilet') owner = owner.parent;
    if (!mesh.isMesh || !owner) return;
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    const box = mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld);
    for (const x of [box.min.x, box.max.x])
      for (const y of [box.min.y, box.max.y])
        for (const z of [box.min.z, box.max.z]) {
          const p = new Vector3(x, y, z).project(frame.camera);
          xs.push((p.x + 1) / 2);
          ys.push(1 - (p.y + 1) / 2);
        }
  });
  const projected: Rect = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  const reference = fixtureBounds.toilet;
  return {
    rasterPng: toPng(state.raster),
    width: frame.width,
    height: frame.height,
    rasterSize: [state.raster.width, state.raster.height],
    viewport: frame.viewport,
    prepareMs,
    exportMs,
    fixtureBounds,
    cameraCheck: {
      projectedToiletBox: projected,
      maxDifferenceToFixtureBounds: reference
        ? Math.max(...projected.map((v, i) => Math.abs(v - reference[i])))
        : null,
    },
    regionsClearOfToilet: Object.fromEntries(
      Object.entries(REGIONS).map(([name, r]) => [
        name,
        !reference ||
          r[2] <= reference[0] ||
          r[0] >= reference[2] ||
          r[3] <= reference[1] ||
          r[1] >= reference[3],
      ]),
    ),
    notices: viewer.notices.map((n) => `${n.severity}:${n.name}:${n.message}`),
    diagnostics: viewer.diagnostics(),
  };
}

/** Box-projected equirect of createInteriorEnvironment's procedural bathroom (linear values). */
function interiorEquirect() {
  const texture = new ProceduralEquirectTexture(256, 128);
  const wall = new Color('#cccccc'),
    ceiling = new Color('#e6e6e6'),
    floor = new Color('#888888'),
    front = new Color(1, 1, 1).multiplyScalar(2.15),
    panel = new Color(1, 1, 1).multiplyScalar(3);
  texture.generationCallback = (polar, _uv, _coord, color) => {
    // The tracer's own equirect convention (util_functions equirectUvToDirection), not
    // Vector3.setFromSpherical, which swaps x and z.
    const s = Math.sin(polar.phi);
    const d = new Vector3(s * Math.cos(polar.theta), Math.cos(polar.phi), s * Math.sin(polar.theta));
    // BoxGeometry(10, 6, 10) seen from its centre.
    const tx = 5 / Math.abs(d.x),
      ty = 3 / Math.abs(d.y),
      tz = 5 / Math.abs(d.z);
    if (ty <= tx && ty <= tz) {
      const t = 2.95 / Math.abs(d.y);
      color.copy(d.y < 0 ? floor : Math.abs(d.x * t) < 1.1 && Math.abs(d.z * t) < 1.1 ? panel : ceiling);
    } else if (tz <= tx) color.copy(d.z > 0 ? front : wall);
    else color.copy(wall);
  };
  texture.update();
  return texture;
}

/** A path-traceable copy of the export world. Geometry and materials stay shared with the viewer. */
function traceScene(lighting: Lighting) {
  const frame = state.frame!;
  const scene = frame.world.clone() as Scene;
  const removed: Object3D[] = [];
  scene.traverse((node) => {
    if (node instanceof HemisphereLight) removed.push(node);
    const light = node as Object3D & { isSpotLight?: boolean; target?: Object3D };
    if (light.isSpotLight) light.target!.updateMatrixWorld(true);
  });
  for (const node of removed) node.removeFromParent();
  const environment = interiorEquirect();
  scene.environment = environment;
  scene.environmentIntensity = ENVIRONMENT_INTENSITY;
  const owned: { dispose(): void }[] = [environment];
  if (lighting === 'B') {
    const room = DEFAULT_ROOM;
    const geometry = new PlaneGeometry(room.widthMm, room.depthMm);
    // Double sided: the tracer skips back faces of single-sided materials, which would let sky in.
    const material = new MeshStandardMaterial({
      color: '#f0ede7',
      roughness: 0.83,
      metalness: 0,
      side: DoubleSide,
    });
    const ceiling = new Mesh(geometry, material);
    ceiling.name = 'spike-ceiling';
    ceiling.rotation.x = Math.PI / 2;
    ceiling.position.set(0, room.heightMm, room.depthMm / 2);
    scene.add(ceiling);
    owned.push(geometry, material);
  }
  scene.updateMatrixWorld(true);
  return { scene, owned };
}

function createRenderer() {
  const frame = state.frame!;
  const renderer = new WebGLRenderer({ antialias: false, alpha: false, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(frame.width, frame.height, false);
  renderer.toneMapping = NeutralToneMapping;
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.domElement.addEventListener('webglcontextlost', () => state.contextEvents.push('lost'));
  renderer.domElement.addEventListener('webglcontextrestored', () => state.contextEvents.push('restored'));
  return renderer;
}

function createTracer(renderer: WebGLRenderer) {
  const tracer = new WebGLPathTracer(renderer);
  tracer.tiles.set(1, 1);
  tracer.bounces = BOUNCES;
  tracer.renderDelay = 0;
  tracer.minSamples = 1;
  tracer.fadeDuration = 0;
  tracer.dynamicLowRes = false;
  // Rasterising PBR materials here would bind three's global DFG LUT to this renderer (see lighting.ts).
  tracer.rasterizeScene = false;
  return tracer;
}

/** Runtime getter of WebGLPathTracer 0.0.24 that its d.ts omits. */
const compiling = (tracer: WebGLPathTracer) => (tracer as unknown as { isCompiling: boolean }).isCompiling;

async function settle(tracer: WebGLPathTracer, limitMs = 600_000) {
  const start = performance.now();
  while (compiling(tracer) && performance.now() - start < limitMs) await sleep(20);
}

/** Waits for GPU completion of everything submitted so far. */
function sync(renderer: WebGLRenderer) {
  const gl = renderer.getContext();
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
}

const tracerInternals = (tracer: WebGLPathTracer) =>
  (
    tracer as unknown as {
      _pathTracer: {
        material: { cameraWorldMatrix: { elements: number[] }; invProjectionMatrix: { elements: number[] } };
      };
    }
  )._pathTracer.material;

// ---------------------------------------------------------------- tracing

export async function trace(lighting: Lighting, checkpoints: number[], maxSeconds: number) {
  releaseTracer();
  const frame = state.frame!;
  const renderer = createRenderer();
  state.renderer = renderer;
  const { scene, owned } = traceScene(lighting);
  state.owned = owned;
  const tracer = createTracer(renderer);
  state.tracer = tracer;
  state.captures = new Map();
  let paused = 0;
  const begin = performance.now();
  const elapsed = () => (performance.now() - begin - paused) / 1000;
  tracer.setScene(scene, frame.camera);
  const setSceneMs = performance.now() - begin;
  const internals = tracerInternals(tracer);
  const matrixDifference = {
    cameraWorld: Math.max(
      ...frame.camera.matrixWorld.elements.map((v, i) =>
        Math.abs(v - internals.cameraWorldMatrix.elements[i]),
      ),
    ),
    inverseProjection: Math.max(
      ...frame.camera.projectionMatrixInverse.elements.map((v, i) =>
        Math.abs(v - internals.invProjectionMatrix.elements[i]),
      ),
    ),
  };
  const calls: number[] = [];
  let firstSampleSeconds = 0;
  const reached: {
    samples: number;
    seconds: number;
    sinceFirstSample: number;
    png: string;
    denoisedPng?: string;
  }[] = [];
  const pending = [...checkpoints].sort((a, b) => a - b);
  let compileWaits = 0;
  while (pending.length && elapsed() < maxSeconds) {
    const start = performance.now();
    tracer.renderSample();
    sync(renderer);
    if (compiling(tracer) || tracer.samples === 0) {
      // Parallel shader compilation settles on timers; let them run.
      compileWaits++;
      await sleep(5);
      continue;
    }
    calls.push(performance.now() - start);
    if (!firstSampleSeconds) firstSampleSeconds = elapsed();
    if (tracer.samples >= pending[0]) {
      const seconds = elapsed();
      const captureStart = performance.now();
      const image = pixelsOf(renderer.domElement, frame.width, frame.height);
      state.captures.set(pending[0], image);
      const entry: (typeof reached)[number] = {
        samples: tracer.samples,
        seconds,
        sinceFirstSample: seconds - firstSampleSeconds + calls[0] / 1000,
        png: toPng(image),
      };
      if (pending[0] === 64 || pending[0] === 256) entry.denoisedPng = denoised(renderer, tracer);
      reached.push(entry);
      pending.shift();
      paused += performance.now() - captureStart;
      await sleep(0);
    } else if (calls.length % 8 === 0) {
      const yieldStart = performance.now();
      await sleep(0);
      paused += performance.now() - yieldStart;
    }
  }
  // Never release a renderer while three's compileAsync is still polling it.
  await settle(tracer);
  const sorted = [...calls].sort((a, b) => a - b);
  return {
    lighting,
    settings: {
      bounces: tracer.bounces,
      tiles: [tracer.tiles.x, tracer.tiles.y],
      filterGlossyFactor: tracer.filterGlossyFactor,
      multipleImportanceSampling: tracer.multipleImportanceSampling,
      textureSize: [tracer.textureSize.x, tracer.textureSize.y],
      environmentIntensity: ENVIRONMENT_INTENSITY,
      size: [frame.width, frame.height],
    },
    setSceneMs,
    firstSampleSeconds,
    compileWaits,
    samples: tracer.samples,
    seconds: elapsed(),
    samplesPerSecond: calls.length / (calls.reduce((a, b) => a + b, 0) / 1000 || 1),
    callMs: {
      median: sorted[sorted.length >> 1] ?? null,
      p95: sorted[Math.floor(sorted.length * 0.95)] ?? null,
      max: sorted[sorted.length - 1] ?? null,
    },
    matrixDifference,
    toneCheck: toneCheck(renderer, tracer),
    checkpoints: reached,
    ...analyse(),
  };
}

/** The library's smart-denoise pass (tone mapping + sRGB included) over the current accumulation. */
function denoised(renderer: WebGLRenderer, tracer: WebGLPathTracer) {
  const material = new DenoiseMaterial({ map: tracer.target.texture, blending: NoBlending });
  const quad = new FullScreenQuad(material);
  try {
    renderer.setRenderTarget(null);
    quad.render(renderer);
    return toPng(pixelsOf(renderer.domElement, renderer.domElement.width, renderer.domElement.height));
  } finally {
    quad.dispose();
    material.dispose();
  }
}

/** three's NeutralToneMapping followed by sRGB encoding, per channel set. */
function neutralToSrgb(rgb: number[]) {
  let [r, g, b] = rgb;
  const x = Math.min(r, g, b);
  const offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  r -= offset;
  g -= offset;
  b -= offset;
  const peak = Math.max(r, g, b);
  if (peak >= 0.76) {
    const d = 1 - 0.76;
    const mapped = 1 - (d * d) / (peak + d - 0.76);
    [r, g, b] = [r, g, b].map((c) => (c * mapped) / peak);
    const t = 1 - 1 / (0.15 * (peak - mapped) + 1);
    [r, g, b] = [r, g, b].map((c) => c + (mapped - c) * t);
  }
  return [r, g, b].map((c) => {
    const v = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(Math.max(c, 0), 1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, v)) * 255);
  });
}

/** Reads accumulated linear radiance and compares Neutral+sRGB of it with the canvas bytes. */
function toneCheck(renderer: WebGLRenderer, tracer: WebGLPathTracer) {
  const frame = state.frame!;
  tracer.renderSample();
  sync(renderer);
  const canvas = pixelsOf(renderer.domElement, frame.width, frame.height);
  let maxDifference = 0,
    compared = 0;
  const linear = new Float32Array(4);
  for (const r of Object.values(REGIONS))
    for (let i = 0; i < 16; i++) {
      const px = Math.round((r[0] + ((r[2] - r[0]) * (i % 4)) / 4) * frame.width);
      const py = Math.round((r[1] + ((r[3] - r[1]) * (i >> 2)) / 4) * frame.height);
      // Render targets have a bottom-left origin; ImageData rows start at the top.
      renderer.readRenderTargetPixels(tracer.target, px, frame.height - 1 - py, 1, 1, linear);
      const expected = neutralToSrgb([linear[0], linear[1], linear[2]]);
      const offset = (py * frame.width + px) * 4;
      for (let c = 0; c < 3; c++)
        maxDifference = Math.max(maxDifference, Math.abs(expected[c] - canvas.data[offset + c]));
      compared++;
    }
  return {
    compared,
    maxDifference,
    toneMapping: renderer.toneMapping,
    outputColorSpace: renderer.outputColorSpace,
  };
}

function meanAbsoluteDifference(a: ImageData, b: ImageData, r: Rect = [0, 0, 1, 1]) {
  const { x0, y0, x1, y1 } = pixelRect(a, r);
  let sum = 0,
    count = 0;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++)
      for (let c = 0; c < 3; c++) {
        const i = (y * a.width + x) * 4 + c;
        sum += Math.abs(a.data[i] - b.data[i]);
        count++;
      }
  return sum / Math.max(1, count);
}

function median(image: ImageData, r: Rect): [number, number, number] {
  const { x0, y0, x1, y1 } = pixelRect(image, r);
  const channels: number[][] = [[], [], []];
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++)
      for (let c = 0; c < 3; c++) channels[c].push(image.data[(y * image.width + x) * 4 + c]);
  return channels.map((v) => v.sort((a, b) => a - b)[v.length >> 1]) as [number, number, number];
}

/** Convergence (k vs 2k), colour samples and the raster | 64 | 256 | 512 sheet. */
function analyse() {
  const raster = state.raster!;
  const keys = [...state.captures.keys()].sort((a, b) => a - b);
  const convergence = keys
    .filter((k) => state.captures.has(k * 2))
    .map((k) => ({
      k,
      whole: meanAbsoluteDifference(state.captures.get(k)!, state.captures.get(k * 2)!),
      backWall: meanAbsoluteDifference(state.captures.get(k)!, state.captures.get(k * 2)!, REGIONS.backWall),
    }));
  const last = keys.length ? state.captures.get(keys[keys.length - 1])! : undefined;
  const colour = Object.fromEntries(
    Object.entries(REGIONS).map(([name, r]) => [
      name,
      {
        raster: median(raster, r),
        traced: last ? median(last, r) : null,
        samples: keys[keys.length - 1] ?? 0,
      },
    ]),
  );
  const panels: [string, ImageData][] = [['raster', raster]];
  for (const k of [64, 256, 512]) {
    const image = state.captures.get(k) ?? (k === 512 && last ? last : undefined);
    if (image)
      panels.push([
        k === 512 && !state.captures.has(512) ? `${keys[keys.length - 1]} spp` : `${k} spp`,
        image,
      ]);
  }
  const scale = 0.5,
    w = Math.round(raster.width * scale),
    h = Math.round(raster.height * scale),
    label = 28;
  const sheet = document.createElement('canvas');
  sheet.width = w * panels.length;
  sheet.height = h + label;
  const ctx = sheet.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, sheet.width, sheet.height);
  ctx.font = '16px sans-serif';
  ctx.fillStyle = '#222222';
  panels.forEach(([name, image], i) => {
    const source = document.createElement('canvas');
    source.width = image.width;
    source.height = image.height;
    source.getContext('2d')!.putImageData(image, 0, 0);
    ctx.drawImage(source, i * w, label, w, h);
    ctx.fillText(name, i * w + 8, 20);
  });
  return { convergence, colour, comparePng: sheet.toDataURL('image/png') };
}

type TracerInternals = {
  _pathTracer: { material: { uniforms: Record<string, { value: unknown }>; dispose(): void } };
  _lowResPathTracer: { dispose(): void; material: { uniforms: Record<string, { value: unknown }> } };
  _colorBackground?: { dispose(): void };
};

/**
 * WebGLPathTracer.dispose() (0.0.24) frees its targets and quads but not the path-tracing
 * material's data textures (BVH, attributes, materials, env CDF, samplers), the low-res tracer's
 * Sobol target or the colour-background texture. Release those too.
 */
function deepDispose(tracer: WebGLPathTracer) {
  const internals = tracer as unknown as TracerInternals;
  const seen = new Set<unknown>();
  const release = (value: unknown, depth: number) => {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    const item = value as { isTexture?: boolean; dispose?: () => void };
    if (typeof item.dispose === 'function') item.dispose();
    if (item.isTexture || depth > 0) return;
    for (const nested of Object.values(value)) release(nested, depth + 1);
  };
  for (const material of [internals._pathTracer.material, internals._lowResPathTracer.material])
    for (const uniform of Object.values(material.uniforms)) release(uniform.value, 0);
  internals._lowResPathTracer.dispose();
  internals._colorBackground?.dispose();
  tracer.dispose();
  internals._pathTracer.material.dispose();
}

export function releaseTracer(full = true, deep = false) {
  if (state.tracer) {
    if (deep) deepDispose(state.tracer);
    else state.tracer.dispose();
  }
  state.tracer = undefined;
  for (const item of state.owned) item.dispose();
  state.owned = [];
  if (full && state.renderer) {
    state.renderer.dispose();
    state.renderer.forceContextLoss();
    state.renderer = undefined;
  }
}

type Variant = 'room' | 'minimal' | 'room-simple' | 'room-meters';
const ROOM_POINTS: Record<string, [number, number]> = {
  backWall: [0.5, 0.4],
  toilet: [0.58, 0.68],
  floor: [0.4, 0.88],
  outside: [0.05, 0.05],
};

/** Uniform white-ish sky: the library's own equirect texture type. */
function uniformEnvironment(level = 1) {
  const texture = new GradientEquirectTexture(64);
  texture.topColor.setRGB(level, level, level);
  texture.bottomColor.setRGB(level, level, level);
  texture.update();
  return texture;
}

/**
 * Scenes for narrowing a backend failure. 'minimal' is example-sized (metres, one sphere on a
 * floor, uniform sky, no lights); 'room-simple' keeps the room but single-sided rough materials and
 * no lights; 'room-meters' is the full room scaled to metres (light intensity scaled with d²).
 */
function diagnoseScene(variant: Variant) {
  const frame = state.frame!;
  if (variant === 'minimal') {
    const scene = new Scene();
    const sphereGeometry = new SphereGeometry(0.5, 48, 24),
      floorGeometry = new PlaneGeometry(4, 4);
    const sphereMaterial = new MeshStandardMaterial({ color: '#d0d0d0', roughness: 0.5 }),
      floorMaterial = new MeshStandardMaterial({ color: '#888888', roughness: 1 });
    const sphere = new Mesh(sphereGeometry, sphereMaterial);
    sphere.position.set(0, 0.5, 0);
    const floor = new Mesh(floorGeometry, floorMaterial);
    floor.rotation.x = -Math.PI / 2;
    const environment = uniformEnvironment(0.8);
    scene.add(sphere, floor);
    scene.environment = environment;
    scene.background = new Color('#e8e8e4');
    scene.updateMatrixWorld(true);
    const camera = new PerspectiveCamera(50, frame.width / frame.height, 0.01, 100);
    camera.position.set(0, 1.2, 3);
    camera.lookAt(0, 0.5, 0);
    camera.updateMatrixWorld(true);
    const at = (x: number, y: number, z: number): [number, number] => {
      const p = new Vector3(x, y, z).project(camera);
      return [(p.x + 1) / 2, (1 - p.y) / 2];
    };
    return {
      scene,
      camera,
      points: { sphere: at(0, 0.5, 0.5), floor: at(-1.2, 0, 1), outside: [0.05, 0.05] as [number, number] },
      owned: [sphereGeometry, floorGeometry, sphereMaterial, floorMaterial, environment],
    };
  }
  const { scene, owned } = traceScene('B');
  if (variant === 'room-simple') {
    const lights: Object3D[] = [];
    scene.traverse((node) => {
      if ((node as { isLight?: boolean }).isLight) lights.push(node);
      const mesh = node as Mesh;
      if (!mesh.isMesh) return;
      const source = (
        Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
      ) as MeshStandardMaterial;
      const material = new MeshStandardMaterial({
        color: source.color?.clone() ?? new Color(1, 1, 1),
        roughness: 1,
      });
      owned.push(material);
      mesh.material = material;
    });
    for (const light of lights) light.removeFromParent();
    scene.updateMatrixWorld(true);
    return { scene, camera: frame.camera, points: ROOM_POINTS, owned };
  }
  if (variant === 'room-meters') {
    const group = new Group();
    group.scale.setScalar(0.001);
    for (const child of [...scene.children]) group.add(child);
    scene.add(group);
    scene.traverse((node) => {
      const light = node as Object3D & { isSpotLight?: boolean; intensity?: number; target?: Object3D };
      if (!light.isSpotLight) return;
      light.intensity! *= 1e-6;
      light.target!.position.multiplyScalar(0.001);
      light.target!.updateMatrixWorld(true);
    });
    scene.updateMatrixWorld(true);
    const camera = frame.camera.clone();
    camera.position.multiplyScalar(0.001);
    camera.near *= 0.001;
    camera.far *= 0.001;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    return { scene, camera, points: ROOM_POINTS, owned };
  }
  return { scene, camera: frame.camera, points: ROOM_POINTS, owned };
}

type Classified = { value: number[] | string[]; kind: 'nan' | 'zero' | 'ok' };
function readPoints(
  renderer: WebGLRenderer,
  tracer: WebGLPathTracer,
  points: Record<string, [number, number]>,
) {
  const { width, height } = renderer.domElement;
  const linear = new Float32Array(4);
  const result: Record<string, Classified> = {};
  for (const [name, [x, y]] of Object.entries(points)) {
    const px = Math.min(width - 1, Math.round(x * width)),
      py = Math.min(height - 1, Math.round(y * height));
    renderer.readRenderTargetPixels(tracer.target, px, height - 1 - py, 1, 1, linear);
    const values = [...linear];
    result[name] = {
      value: values.some(Number.isNaN) ? values.map(String) : values.map((v) => +v.toFixed(5)),
      kind: values.some(Number.isNaN) ? 'nan' : values.every((v) => v === 0) ? 'zero' : 'ok',
    };
  }
  return result;
}

/**
 * Backend check: a few samples, then raw accumulated floats at known pixels (NaN vs exact zero
 * tells a numeric failure from an early-out) and the packed material flags. `debugMode` 1 makes
 * the shader output path depth instead of radiance. `patch` edits the tracer's fragment source:
 * 'no-matte' drops the matte early-out; 'show-material' writes (material index, matte, opacity)
 * of the first hit as the colour.
 */
export async function diagnose(
  samples: number,
  debugMode = 0,
  variant: Variant = 'room',
  patch: '' | 'no-matte' | 'show-material' = '',
) {
  releaseTracer();
  const renderer = createRenderer();
  state.renderer = renderer;
  const { scene, camera, points, owned } = diagnoseScene(variant);
  state.owned = owned;
  const tracer = createTracer(renderer);
  state.tracer = tracer;
  const internals = tracer as unknown as {
    _pathTracer: {
      material: {
        setDefine(name: string, value: number): void;
        uniforms: { materials: { value: { image: { data: Float32Array } } } };
        fragmentShader: string;
        needsUpdate: boolean;
      };
    };
  };
  if (debugMode) internals._pathTracer.material.setDefine('DEBUG_MODE', debugMode);
  if (patch) {
    const material = internals._pathTracer.material;
    const before = material.fragmentShader;
    material.fragmentShader =
      patch === 'no-matte'
        ? before.replace('if ( material.matte && state.firstRay ) {', 'if ( false ) {')
        : before.replace(
            'Material material = readMaterialInfo( materials, materialIndex );',
            'Material material = readMaterialInfo( materials, materialIndex );\n' +
              'if ( state.firstRay ) { gl_FragColor = vec4( float( materialIndex ), material.matte ? 1.0 : 0.0, material.opacity, 1.0 ); break; }',
          );
    if (material.fragmentShader === before) throw new Error(`shader patch ${patch} did not apply`);
    material.needsUpdate = true;
  }
  const start = performance.now();
  tracer.setScene(scene, camera);
  let firstSampleMs = 0;
  while (tracer.samples < samples) {
    tracer.renderSample();
    sync(renderer);
    if (!firstSampleMs && tracer.samples > 0) firstSampleMs = performance.now() - start;
    if (compiling(tracer) || tracer.samples === 0) await sleep(20);
  }
  const ms = performance.now() - start;
  const values = readPoints(renderer, tracer, points);
  // MATERIAL_PIXELS rows per material; row 14 holds matte, castShadow, vertexColors|flat, transparent.
  const data = internals._pathTracer.material.uniforms.materials.value.image.data;
  const materialPixels = 47;
  const flags: number[][] = [];
  for (let m = 0; m * materialPixels * 4 < data.length && m < 16; m++) {
    const base = (m * materialPixels + 14) * 4;
    if (base + 3 < data.length) flags.push([...data.slice(base, base + 4)]);
  }
  const png = toPng(pixelsOf(renderer.domElement, renderer.domElement.width, renderer.domElement.height));
  await settle(tracer);
  // Other library versions may not dispose cleanly; keep the measurement either way.
  let releaseError = '';
  try {
    releaseTracer();
  } catch (error) {
    releaseError = String(error);
    state.tracer = undefined;
    releaseTracer();
  }
  return { variant, patch, samples, debugMode, firstSampleMs, ms, values, flags, png, releaseError };
}

/**
 * Fallback self-test draft: 64×64, one white rough plane facing the camera under a uniform sky of
 * radiance 1. Its centre should come out near 1; zero, NaN or a wild value means "use the raster
 * export". It shares the tracer shader, so it also carries the first compile.
 */
export async function selfTest(samples = 2) {
  const renderer = new WebGLRenderer({ antialias: false, alpha: false, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(64, 64, false);
  const scene = new Scene();
  const geometry = new PlaneGeometry(2, 2);
  const material = new MeshStandardMaterial({ color: '#ffffff', roughness: 1 });
  scene.add(new Mesh(geometry, material));
  const environment = uniformEnvironment(1);
  scene.environment = environment;
  scene.background = new Color(0, 0, 0);
  scene.updateMatrixWorld(true);
  const camera = new PerspectiveCamera(50, 1, 0.01, 10);
  camera.position.set(0, 0, 2);
  camera.updateMatrixWorld(true);
  const tracer = createTracer(renderer);
  const start = performance.now();
  let firstSampleMs = 0;
  try {
    tracer.setScene(scene, camera);
    while (tracer.samples < samples && performance.now() - start < 600_000) {
      tracer.renderSample();
      sync(renderer);
      if (!firstSampleMs && tracer.samples > 0) firstSampleMs = performance.now() - start;
      if (compiling(tracer) || tracer.samples === 0) await sleep(20);
    }
    const values = readPoints(renderer, tracer, {
      c1: [0.47, 0.47],
      c2: [0.53, 0.47],
      c3: [0.47, 0.53],
      c4: [0.53, 0.53],
    });
    // Single pixels are noisy at 2 samples (0.6–1.8 seen); judge the central 8×8 mean instead.
    const block = new Float32Array(8 * 8 * 4);
    renderer.readRenderTargetPixels(tracer.target, 28, 28, 8, 8, block);
    let sum = 0,
      alphaMin = 1,
      finite = true;
    for (let i = 0; i < block.length; i += 4) {
      finite &&= [0, 1, 2, 3].every((c) => Number.isFinite(block[i + c]));
      sum += (block[i] + block[i + 1] + block[i + 2]) / 3;
      alphaMin = Math.min(alphaMin, block[i + 3]);
    }
    const mean = sum / 64;
    const pass = finite && alphaMin > 0.99 && mean > 0.5 && mean < 2;
    await settle(tracer);
    return {
      pass,
      rule: 'central 8×8 mean radiance in (0.5, 2), finite, alpha 1',
      mean: +mean.toFixed(4),
      alphaMin,
      samples: tracer.samples,
      firstSampleMs,
      ms: performance.now() - start,
      values,
    };
  } finally {
    deepDispose(tracer);
    geometry.dispose();
    material.dispose();
    environment.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
  }
}

// ---------------------------------------------------------------- silhouette

function maskClone(world: Scene, material: (fixture: boolean, side: Side) => Material) {
  const scene = world.clone() as Scene;
  const lights: Object3D[] = [];
  const created: Material[] = [];
  scene.traverse((node) => {
    if ((node as { isLight?: boolean }).isLight) lights.push(node);
    const mesh = node as Mesh;
    if (!mesh.isMesh) return;
    let owner: Object3D | null = node;
    while (owner && typeof owner.userData.fixtureId !== 'string') owner = owner.parent;
    const source = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    const next = material(!!owner, source.side);
    created.push(next);
    mesh.material = next;
  });
  for (const light of lights) light.removeFromParent();
  scene.environment = null;
  scene.background = new Color(0x000000);
  scene.updateMatrixWorld(true);
  return { scene, dispose: () => created.forEach((m) => m.dispose()) };
}

/**
 * Toilet silhouette: raster pass with flat colours vs a path-traced emissive-only pass, same camera.
 * IoU inside the fixtureBounds box shows the tracer's rays follow the raster projection.
 */
export async function silhouette(samples: number) {
  releaseTracer();
  const frame = state.frame!;
  const renderer = createRenderer();
  state.renderer = renderer;
  const raster = maskClone(
    frame.world,
    (fixture, side) => new MeshBasicMaterial({ color: fixture ? 0xffffff : 0, side }),
  );
  renderer.render(raster.scene, frame.camera);
  sync(renderer);
  const rasterMask = pixelsOf(renderer.domElement, frame.width, frame.height);
  raster.dispose();
  const traced = maskClone(frame.world, (fixture, side) =>
    fixture
      ? new MeshStandardMaterial({
          color: 0x000000,
          emissive: 0xffffff,
          emissiveIntensity: 1,
          roughness: 1,
          side,
        })
      : new MeshPhysicalMaterial({ color: 0x000000, roughness: 1, specularIntensity: 0, side }),
  );
  const tracer = createTracer(renderer);
  state.tracer = tracer;
  tracer.setScene(traced.scene, frame.camera);
  while (tracer.samples < samples) {
    tracer.renderSample();
    sync(renderer);
    if (compiling(tracer) || tracer.samples === 0) await sleep(5);
  }
  const tracedMask = pixelsOf(renderer.domElement, frame.width, frame.height);
  await settle(tracer);
  traced.dispose();
  const box = state.viewer!.fixtureBounds(frame.width, frame.height, defaultRoomView()).toilet;
  const { x0, y0, x1, y1 } = pixelRect(rasterMask, box);
  let intersection = 0,
    union = 0,
    inside = 0,
    outside = 0;
  const on = (image: ImageData, i: number) => image.data[i] + image.data[i + 1] + image.data[i + 2] > 3 * 128;
  for (let y = 0; y < rasterMask.height; y++)
    for (let x = 0; x < rasterMask.width; x++) {
      const i = (y * rasterMask.width + x) * 4;
      const a = on(rasterMask, i),
        b = on(tracedMask, i);
      const inBox = x >= x0 && x < x1 && y >= y0 && y < y1;
      if (a && !inBox) outside++;
      if (a && inBox) inside++;
      if (!inBox) continue;
      if (a && b) intersection++;
      if (a || b) union++;
    }
  releaseTracer();
  return {
    samples,
    box,
    iou: intersection / Math.max(1, union),
    rasterPixelsInsideBox: inside,
    rasterPixelsOutsideBox: outside,
    rasterPng: toPng(rasterMask),
    tracedPng: toPng(tracedMask),
  };
}

// ---------------------------------------------------------------- resources

/**
 * One export-like cycle: tracer on B, a few samples, then release. 'shared' keeps one renderer
 * across cycles to expose leaks in WebGLPathTracer.dispose(); 'deep' keeps it too but also frees
 * what dispose() misses; 'fresh' disposes the renderer and forces context loss.
 */
export async function cycle(mode: 'shared' | 'deep' | 'fresh', samples: number) {
  const frame = state.frame!;
  if (!state.renderer) state.renderer = createRenderer();
  const renderer = state.renderer;
  const { scene, owned } = traceScene('B');
  state.owned = owned;
  const tracer = createTracer(renderer);
  state.tracer = tracer;
  const start = performance.now();
  tracer.setScene(scene, frame.camera);
  while (tracer.samples < samples) {
    tracer.renderSample();
    sync(renderer);
    if (compiling(tracer) || tracer.samples === 0) await sleep(5);
  }
  const ms = performance.now() - start;
  const thumbnailPng = toPng(
    pixelsOf(renderer.domElement, 256, Math.round((256 * frame.height) / frame.width)),
  );
  await settle(tracer);
  releaseTracer(false, mode === 'deep');
  const memory = { ...renderer.info.memory, programs: renderer.info.programs?.length ?? 0 };
  if (mode === 'fresh') releaseTracer(true);
  return {
    mode,
    samples,
    ms,
    memoryAfterRelease: memory,
    contextEvents: [...state.contextEvents],
    thumbnailPng,
  };
}

export function contextEvents() {
  return [...state.contextEvents];
}

export function close() {
  releaseTracer();
  state.viewer?.dispose();
  state.viewer = undefined;
  state.frame = undefined;
}
