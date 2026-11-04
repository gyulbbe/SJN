/**
 * The renderer probe's page (bundled by probe.ts; no AI call): one small room — three tiled walls, a
 * tiled floor, a ceiling with a light panel, a toilet and a basin made of simple shapes — seen from
 * the AI export's front orbit (20° lens, open front, white backdrop), drawn three ways:
 *   webgl   WebGLRenderer, one frame, a spot light with soft shadows (close to the app's single frame)
 *   ssgi    WebGPURenderer with three's screen-space GI + AO (SSGINode) and TRAA, 48 frames
 *   path    three-gpu-pathtracer's WebGPUPathTracer (0.0.27), up to 512 samples or 60 s
 * It is not the app's renderer: the probe only says whether these paths work on this PC and look
 * more like a photo than the single frame.
 */
import * as THREE_GL from 'three';
import * as THREE from 'three/webgpu';
import {
  add,
  colorToDirection,
  diffuseColor,
  directionToColor,
  mrt,
  normalView,
  output,
  pass,
  sample,
  vec4,
  velocity,
} from 'three/tsl';
import { ssgi } from 'three/examples/jsm/tsl/display/SSGINode.js';
import { traa } from 'three/examples/jsm/tsl/display/TRAANode.js';
import { WebGPUPathTracer } from 'three-gpu-pathtracer/webgpu';

const W = 992,
  H = 672;
type Lib = typeof THREE_GL | typeof THREE;

async function tileTexture(
  lib: Lib,
  url: string,
  tileMm: [number, number],
  faceMm: [number, number],
  grout: string,
) {
  // The tile image repeated at its size with 2 mm joints, drawn once onto a canvas for the face.
  const image = await createImageBitmap(await (await fetch(url)).blob());
  const pxPerMm = 0.5;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(faceMm[0] * pxPerMm);
  canvas.height = Math.round(faceMm[1] * pxPerMm);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = grout;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const [tw, th] = tileMm.map((v) => v * pxPerMm);
  for (let y = 0; y < canvas.height; y += th)
    for (let x = 0; x < canvas.width; x += tw) ctx.drawImage(image, x + 1, y + 1, tw - 2, th - 2);
  const texture = new lib.CanvasTexture(canvas);
  texture.colorSpace = lib.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

async function buildScene(lib: Lib, wallUrl: string, floorUrl: string) {
  const scene = new lib.Scene();
  scene.background = new lib.Color('#ffffff');
  const size = 2.4;
  const wallTex = await tileTexture(lib, wallUrl, [600, 300], [2400, 2400], '#d5d1c9');
  const floorTex = await tileTexture(lib, floorUrl, [600, 600], [2400, 2400], '#d5d1c9');
  const wall = new lib.MeshStandardMaterial({ map: wallTex, roughness: 0.55 });
  const floor = new lib.MeshStandardMaterial({ map: floorTex, roughness: 0.6 });
  const plane = (
    material: THREE.Material,
    position: [number, number, number],
    rotation: [number, number, number],
  ) => {
    const mesh = new lib.Mesh(new lib.PlaneGeometry(size, size), material as never);
    mesh.position.set(...position);
    mesh.rotation.set(...rotation);
    mesh.receiveShadow = true;
    scene.add(mesh);
    return mesh;
  };
  plane(floor as never, [0, 0, -size / 2], [-Math.PI / 2, 0, 0]);
  plane(wall as never, [0, size / 2, -size], [0, 0, 0]);
  plane(wall as never, [-size / 2, size / 2, -size / 2], [0, Math.PI / 2, 0]);
  plane(wall as never, [size / 2, size / 2, -size / 2], [0, -Math.PI / 2, 0]);
  const ceiling = plane(
    new lib.MeshStandardMaterial({ color: '#f3f2ee', roughness: 0.9 }) as never,
    [0, size, -size / 2],
    [Math.PI / 2, 0, 0],
  );
  ceiling.receiveShadow = false;
  // The ceiling's flat light panel, 600 mm square.
  const panel = new lib.Mesh(
    new lib.PlaneGeometry(0.6, 0.6),
    new lib.MeshStandardMaterial({ color: '#ffffff', emissive: '#ffffff', emissiveIntensity: 40 }) as never,
  );
  panel.position.set(0, size - 0.005, -size / 2);
  panel.rotation.set(Math.PI / 2, 0, 0);
  scene.add(panel);
  // A toilet: bowl (lathe), seat ring, tank; and a wall basin on the left wall.
  const ceramic = new lib.MeshPhysicalMaterial({
    color: '#f2f1ec',
    roughness: 0.18,
    clearcoat: 0.8,
    clearcoatRoughness: 0.1,
  });
  const toilet = new lib.Group();
  const profile = [
    [0.0, 0.0],
    [0.13, 0.0],
    [0.15, 0.2],
    [0.19, 0.38],
    [0.2, 0.4],
    [0.16, 0.41],
    [0.0, 0.3],
  ].map(([x, y]) => new lib.Vector2(x, y));
  const bowl = new lib.Mesh(new lib.LatheGeometry(profile, 48), ceramic as never);
  bowl.scale.set(1, 1, 1.35);
  const tank = new lib.Mesh(new lib.BoxGeometry(0.38, 0.36, 0.17), ceramic as never);
  tank.position.set(0, 0.56, -0.24);
  toilet.add(bowl, tank);
  toilet.position.set(0.75, 0, -1.95);
  const basin = new lib.Mesh(new lib.BoxGeometry(0.42, 0.14, 0.5), ceramic as never);
  basin.position.set(-size / 2 + 0.22, 0.78, -1.5);
  scene.add(toilet, basin);
  scene.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  const camera = new lib.PerspectiveCamera(20, W / H, 0.1, 100);
  camera.position.set(0, 1.2, 7.2);
  camera.lookAt(0, 1.2, -1.2);
  return { scene, camera, panel };
}

const meanLuminance = (canvas: HTMLCanvasElement) => {
  const copy = document.createElement('canvas');
  copy.width = 64;
  copy.height = 44;
  const ctx = copy.getContext('2d')!;
  ctx.drawImage(canvas, 0, 0, 64, 44);
  const data = ctx.getImageData(0, 0, 64, 44).data;
  let sum = 0;
  for (let i = 0; i < data.length; i += 4)
    sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
  return sum / (data.length / 4);
};
const png = (canvas: HTMLCanvasElement) => canvas.toDataURL('image/png');
const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));

export async function adapter() {
  const gpu = (navigator as unknown as { gpu?: GPU }).gpu;
  const a = await gpu?.requestAdapter({ powerPreference: 'high-performance' });
  if (!a) return { available: false };
  const info = (a as unknown as { info: Record<string, string> }).info;
  return {
    available: true,
    vendor: info.vendor,
    architecture: info.architecture,
    device: info.device,
    description: info.description,
    isFallbackAdapter: (a as unknown as { isFallbackAdapter?: boolean }).isFallbackAdapter ?? false,
  };
}

export async function webgl(wallUrl: string, floorUrl: string) {
  const started = performance.now();
  const canvas = document.createElement('canvas');
  const renderer = new THREE_GL.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(W, H, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE_GL.PCFSoftShadowMap;
  renderer.toneMapping = THREE_GL.NeutralToneMapping;
  const { scene, camera } = await buildScene(THREE_GL, wallUrl, floorUrl);
  const spot = new THREE_GL.SpotLight('#ffffff', 18, 0, Math.PI / 2.6, 0.6, 1.2);
  spot.position.set(0, 2.38, -1.2);
  spot.target.position.set(0, 0, -1.2);
  spot.castShadow = true;
  spot.shadow.mapSize.set(2048, 2048);
  scene.add(spot, spot.target, new THREE_GL.HemisphereLight('#ffffff', '#bbbbbb', 1.2));
  renderer.render(scene as never, camera as never);
  const out = {
    png: png(canvas),
    ms: Math.round(performance.now() - started),
    luminance: meanLuminance(canvas),
  };
  renderer.dispose();
  return out;
}

export async function screenSpace(wallUrl: string, floorUrl: string, frames = 48, temporal = true) {
  const started = performance.now();
  const canvas = document.createElement('canvas');
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: false });
  await renderer.init();
  renderer.setSize(W, H, false);
  renderer.shadowMap.enabled = true;
  renderer.toneMapping = THREE.NeutralToneMapping;
  const { scene, camera } = await buildScene(THREE, wallUrl, floorUrl);
  const spot = new THREE.SpotLight('#ffffff', 18, 0, Math.PI / 2.6, 0.6, 1.2);
  spot.position.set(0, 2.38, -1.2);
  spot.target.position.set(0, 0, -1.2);
  spot.castShadow = true;
  scene.add(spot, spot.target, new THREE.HemisphereLight('#ffffff', '#bbbbbb', 0.6));
  // three's SSGI example chain (webgpu_postprocessing_ssgi): MRT, GI + AO, then TRAA.
  const post = new THREE.PostProcessing(renderer);
  const scenePass = pass(scene, camera);
  scenePass.setMRT(mrt({ output, diffuseColor, normal: directionToColor(normalView), velocity }));
  const color = scenePass.getTextureNode('output');
  const diffuse = scenePass.getTextureNode('diffuseColor');
  const depth = scenePass.getTextureNode('depth');
  const normalTexture = scenePass.getTextureNode('normal');
  const normal = sample((uv) => colorToDirection(normalTexture.sample(uv)));
  const gi = ssgi(color, depth, normal, camera);
  gi.sliceCount.value = 2;
  gi.stepCount.value = 8;
  const composite = vec4(add(color.rgb.mul(gi.a), diffuse.rgb.mul(gi.rgb)), color.a);
  post.outputNode = temporal
    ? traa(composite, depth, scenePass.getTextureNode('velocity'), camera)
    : composite;
  for (let i = 0; i < frames; i++) {
    post.render();
    await frame();
  }
  await (renderer.backend as unknown as { device?: GPUDevice }).device?.queue.onSubmittedWorkDone();
  const out = {
    png: png(canvas),
    ms: Math.round(performance.now() - started),
    luminance: meanLuminance(canvas),
    frames,
  };
  renderer.dispose();
  return out;
}

export async function pathTraced(wallUrl: string, floorUrl: string, maxSamples = 2048, budgetMs = 60_000) {
  const started = performance.now();
  const canvas = document.createElement('canvas');
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: false });
  await renderer.init();
  renderer.setSize(W, H, false);
  renderer.toneMapping = THREE.NeutralToneMapping;
  const { scene, camera } = await buildScene(THREE, wallUrl, floorUrl);
  // No environment map: a plain DataTexture as one failed WGSL validation in 0.0.27 (2026-11-04);
  // the room is lit by its ceiling panel only.
  const tracer = new WebGPUPathTracer(renderer);
  tracer.maxSamples = maxSamples;
  tracer.setScene(scene, camera);
  let rounds = 0;
  while (performance.now() - started < budgetMs) {
    tracer.renderSample();
    rounds++;
    await frame();
    if (rounds % 16 === 0) {
      const counts = await tracer.getSampleCountsAsync?.();
      const min = Array.isArray(counts) ? Math.min(...counts) : (counts as { min?: number } | undefined)?.min;
      if (min !== undefined && min >= maxSamples) break;
    }
  }
  const out = {
    png: png(canvas),
    ms: Math.round(performance.now() - started),
    luminance: meanLuminance(canvas),
    rounds,
    samplesPerSecond: (tracer as unknown as { samplesPerSecond?: number }).samplesPerSecond,
  };
  tracer.dispose();
  renderer.dispose();
  return out;
}
