import {
  AmbientLight,
  Box3,
  BoxGeometry,
  Color,
  CylinderGeometry,
  DirectionalLight,
  Group,
  Mesh,
  MeshStandardMaterial,
  NoToneMapping,
  Scene,
  SphereGeometry,
  SRGBColorSpace,
  TorusGeometry,
  Vector3,
  Vector2,
  LatheGeometry,
  WebGLRenderer,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import type { Point } from '../types';
import { orientationAngle, reconstructionVolumeProjection, type FixtureOrientation } from './projection';
import type { RoomDefinition, RoomFace } from '../room-types';
import { createRoomCamera, roomFacePoint } from '../room-geometry';
import { canvasBlob } from '../images';
import type { ReconstructionKind } from './types';

export type TemplateOptions = {
  kind: ReconstructionKind;
  color: string;
  widthMm: number;
  heightMm: number;
  depthMm: number;
  room: RoomDefinition;
  face: RoomFace;
  u: number;
  v: number;
  aspect: number;
  orientation?: FixtureOrientation;
};
export const TEMPLATE_RENDERER_REVISION = 5;

/** Original sanitary silhouettes and cabinet joinery, normalized to an exact physical box. */
export function createTemplateModel({
  kind,
  color,
  widthMm: w,
  heightMm: h,
  depthMm: d,
}: Pick<TemplateOptions, 'kind' | 'color' | 'widthMm' | 'heightMm' | 'depthMm'>): Group {
  const group = new Group();
  const ceramic = new MeshStandardMaterial({ color, roughness: 0.32, metalness: 0.02 });
  const white = new MeshStandardMaterial({ color: '#eeefeb', roughness: 0.25, metalness: 0.02 });
  const shaded = new MeshStandardMaterial({ color: new Color(color).multiplyScalar(0.6), roughness: 0.58 });
  const chrome = new MeshStandardMaterial({ color: '#949c9e', roughness: 0.19, metalness: 0.7 });
  const part = (mesh: Mesh, x: number, y: number, z: number) => {
    mesh.position.set(x, y, z);
    group.add(mesh);
    return mesh;
  };
  const box = (
    x: number,
    y: number,
    z: number,
    sx: number,
    sy: number,
    sz: number,
    material = ceramic,
    rounded = false,
  ) =>
    part(
      new Mesh(
        rounded
          ? new RoundedBoxGeometry(sx, sy, sz, 3, Math.min(sx, sy, sz) * 0.13)
          : new BoxGeometry(sx, sy, sz),
        material,
      ),
      x,
      y,
      z,
    );
  const oval = (x: number, y: number, z: number, sx: number, sy: number, sz: number, material = ceramic) => {
    const mesh = part(new Mesh(new SphereGeometry(1, 48, 28), material), x, y, z);
    mesh.scale.set(sx / 2, sy / 2, sz / 2);
    return mesh;
  };
  const rim = (
    x: number,
    y: number,
    z: number,
    sx: number,
    sz: number,
    thickness: number,
    material = ceramic,
  ) => {
    const mesh = part(new Mesh(new TorusGeometry(1, 0.055, 16, 80), material), x, y, z);
    mesh.rotation.x = -Math.PI / 2;
    mesh.scale.set(sx / 2.11, sz / 2.11, thickness / 0.11);
    return mesh;
  };
  const bowl = (x: number, y: number, z: number, sx: number, sy: number, sz: number, material = ceramic) => {
    // Thick rim returns into a recessed basin, instead of painting a dark oval on a ball.
    const profile = [
      [0, 0],
      [0.12, 0],
      [0.27, 0.1],
      [0.43, 0.55],
      [0.49, 0.85],
      [0.5, 0.96],
      [0.48, 1],
      [0.44, 0.98],
      [0.42, 0.78],
      [0.34, 0.37],
      [0.14, 0.24],
      [0, 0.24],
    ].map(([r, v]) => new Vector2(r, v));
    const mesh = part(new Mesh(new LatheGeometry(profile, 64), material), x, y, z);
    mesh.scale.set(sx, sy, sz);
    return mesh;
  };
  const faucet = (x: number, y: number, z: number, size: number) => {
    const stem = part(
      new Mesh(new CylinderGeometry(size * 0.08, size * 0.09, size * 0.9, 20), chrome),
      x,
      y + size * 0.45,
      z,
    );
    stem.scale.z = 0.8;
    box(x, y + size * 0.86, z + size * 0.24, size * 0.14, size * 0.12, size * 0.62, chrome, true);
    box(x, y + size * 0.98, z - size * 0.03, size * 0.1, size * 0.035, size * 0.28, chrome, true);
  };
  if (kind === 'toilet') {
    // Foot, tapered siphon support, bowl, seat, cistern and flush handle are independent silhouettes.
    oval(0, h * 0.045, d * 0.1, w * 0.67, h * 0.09, d * 0.59);
    const foot = part(
      new Mesh(
        new LatheGeometry(
          [
            [0.27, 0],
            [0.29, 0.015],
            [0.285, 0.05],
            [0.25, 0.11],
            [0.195, 0.24],
            [0.19, 0.34],
            [0.22, 0.43],
            [0.24, 0.46],
          ].map(([radius, y]) => new Vector2(radius * w, y * h)),
          64,
        ),
        ceramic,
      ),
      0,
      0,
      d * 0.03,
    );
    foot.scale.z = (d / w) * 0.64;
    const seat = new MeshStandardMaterial({
      color: new Color(color).lerp(new Color('#ffffff'), 0.22),
      roughness: 0.22,
      metalness: 0.015,
    });
    bowl(0, h * 0.31, d * 0.13, w, h * 0.25, d * 0.73);
    oval(0, h * 0.397, d * 0.16, w * 0.44, h * 0.012, d * 0.39, shaded);
    rim(0, h * 0.568, d * 0.13, w * 1.01, d * 0.78, h * 0.033);
    rim(0, h * 0.596, d * 0.13, w * 0.99, d * 0.76, h * 0.025, seat);
    box(0, h * 0.765, -d * 0.32, w * 0.88, h * 0.43, d * 0.27, ceramic, true);
    box(0, h * 0.984, -d * 0.32, w * 0.94, h * 0.03, d * 0.31, ceramic, true);
    box(-w * 0.28, h * 0.874, -d * 0.172, w * 0.17, h * 0.028, d * 0.025, chrome, true);
  } else if (kind === 'basin') {
    const pedestal = part(
      new Mesh(new CylinderGeometry(w * 0.13, w * 0.16, h * 0.79, 40), ceramic),
      0,
      h * 0.395,
      -d * 0.09,
    );
    pedestal.scale.z = 0.8;
    bowl(0, h * 0.73, d * 0.03, w, h * 0.22, d);
    box(0, h * 0.91, -d * 0.35, w * 0.82, h * 0.04, d * 0.22, ceramic, true);
    faucet(0, h * 0.93, -d * 0.33, h * 0.12);
  } else if (kind === 'vanity') {
    const cabinet = new MeshStandardMaterial({ color, roughness: 0.64, metalness: 0 });
    const joinery = new MeshStandardMaterial({
      color: new Color(color).multiplyScalar(0.72),
      roughness: 0.72,
    });
    box(0, h * 0.055, -d * 0.03, w * 0.91, h * 0.11, d * 0.88, joinery);
    box(0, h * 0.49, -d * 0.015, w, h * 0.86, d * 0.96, cabinet);
    const count = w >= 1000 ? 2 : 1,
      moduleWidth = w / count;
    for (let n = 0; n < count; n++) {
      const x = (n - (count - 1) / 2) * moduleWidth;
      for (const side of [-1, 1]) {
        const cx = x + side * moduleWidth * 0.245;
        box(cx, h * 0.43, d * 0.483, moduleWidth * 0.472, h * 0.61, d * 0.023, cabinet, true);
        box(cx, h * 0.43, d * 0.497, moduleWidth * 0.385, h * 0.51, d * 0.012, joinery, true);
        box(cx, h * 0.43, d * 0.507, moduleWidth * 0.351, h * 0.48, d * 0.012, cabinet, true);
        box(
          x + side * moduleWidth * 0.055,
          h * 0.59,
          d * 0.523,
          moduleWidth * 0.022,
          h * 0.14,
          d * 0.034,
          chrome,
          true,
        );
      }
      // Recessed bowls surrounded by a ceramic top; the voids are not solid white slabs.
      const basinW = moduleWidth * 0.72,
        basinD = d * 0.69;
      box(x, h * 0.937, -d * 0.42, moduleWidth, h * 0.06, d * 0.15, white, true);
      box(x, h * 0.937, d * 0.43, moduleWidth, h * 0.06, d * 0.13, white, true);
      for (const side of [-1, 1])
        box(
          x + side * moduleWidth * 0.444,
          h * 0.937,
          0,
          moduleWidth * 0.112,
          h * 0.06,
          d * 0.72,
          white,
          true,
        );
      bowl(x, h * 0.82, d * 0.02, basinW, h * 0.12, basinD, white);
      faucet(x, h * 0.96, -d * 0.365, h * 0.12);
    }
  } else if (kind === 'bath') {
    box(0, h * 0.43, 0, w * 0.97, h * 0.86, d * 0.96, ceramic, true);
    box(0, h * 0.885, 0, w * 0.88, h * 0.025, d * 0.76, shaded, true);
    for (const z of [-1, 1]) box(0, h * 0.947, z * d * 0.46, w, h * 0.106, d * 0.08, ceramic, true);
    for (const x of [-1, 1]) box(x * w * 0.465, h * 0.947, 0, w * 0.07, h * 0.106, d * 0.85, ceramic, true);
    faucet(-w * 0.36, h * 0.96, -d * 0.405, h * 0.11);
  }
  const bounds = new Box3().setFromObject(group);
  const size = bounds.getSize(new Vector3());
  if (size.x > 0 && size.y > 0 && size.z > 0) {
    const scale = new Vector3(w / size.x, h / size.y, d / size.z);
    group.scale.copy(scale);
    group.position.set(
      -(bounds.min.x + bounds.max.x) * 0.5 * scale.x,
      -bounds.min.y * scale.y,
      -(bounds.min.z + bounds.max.z) * 0.5 * scale.z,
    );
  }
  group.updateMatrixWorld(true);
  for (const node of group.children) {
    const mesh = node as Mesh;
    mesh.geometry.applyMatrix4(mesh.matrixWorld);
    mesh.position.set(0, 0, 0);
    mesh.quaternion.identity();
    mesh.scale.set(1, 1, 1);
    mesh.updateMatrix();
  }
  group.position.set(0, 0, 0);
  group.scale.set(1, 1, 1);
  group.updateMatrixWorld(true);
  return group;
}

function disposeModel(model: Group) {
  const materials = new Set<MeshStandardMaterial>();
  model.traverse((node) => {
    if (!(node instanceof Mesh)) return;
    node.geometry.dispose();
    for (const material of Array.isArray(node.material) ? node.material : [node.material])
      materials.add(material as MeshStandardMaterial);
  });
  materials.forEach((material) => material.dispose());
}
function planarCanvas(kind: ReconstructionKind, color: string, widthMm: number, heightMm: number) {
  const canvas = document.createElement('canvas');
  const factor = 1024 / Math.max(widthMm, heightMm);
  canvas.width = Math.max(32, Math.round(widthMm * factor));
  canvas.height = Math.max(32, Math.round(heightMm * factor));
  const ctx = canvas.getContext('2d')!;
  const w = canvas.width,
    h = canvas.height,
    border = Math.max(4, Math.min(w, h) * 0.045);
  ctx.fillStyle = kind === 'door' ? '#9c9487' : '#adb6b8';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = color;
  ctx.fillRect(border, border, w - 2 * border, h - 2 * border);
  if (kind === 'door') {
    ctx.strokeStyle = '#00000026';
    ctx.lineWidth = 2;
    ctx.strokeRect(w * 0.17, h * 0.1, w * 0.66, h * 0.68);
    ctx.fillStyle = '#6d7272';
    ctx.fillRect(w * 0.82, h * 0.55, w * 0.1, h * 0.014);
  } else {
    const gradient = ctx.createLinearGradient(0, 0, w, h);
    gradient.addColorStop(0, '#ffffff88');
    gradient.addColorStop(0.48, '#ffffff00');
    gradient.addColorStop(1, '#52748144');
    ctx.fillStyle = gradient;
    ctx.fillRect(border, border, w - 2 * border, h - 2 * border);
    if (kind === 'window') {
      ctx.fillStyle = '#e1e4e2';
      ctx.fillRect(w * 0.49, 0, w * 0.025, h);
      ctx.fillRect(0, h * 0.49, w, h * 0.025);
    }
  }
  return canvas;
}
/** Transparent model image seen through the same room camera, then cropped to the model. */
export async function renderReconstructionTemplate(
  options: TemplateOptions,
): Promise<{ blob: Blob; anchor: Point }> {
  if (['mirror', 'door', 'window'].includes(options.kind))
    return {
      blob: await canvasBlob(planarCanvas(options.kind, options.color, options.widthMm, options.heightMm)),
      anchor: { x: 0.5, y: options.kind === 'door' ? 1 : 0.5 },
    };
  const scene = new Scene(),
    group = createTemplateModel(options);
  const origin = roomFacePoint(options.room, options.face, options.u, options.v);
  group.position.copy(origin);
  group.rotation.y = orientationAngle(options.orientation);
  scene.add(group, new AmbientLight('#ffffff', 1.6));
  const light = new DirectionalLight('#ffffff', 1.65);
  light.position.set(-1500, 4000, 6000);
  const fill = new DirectionalLight('#e8f0f5', 0.28);
  fill.position.set(3500, 2200, 2000);
  scene.add(light, fill);
  const camera = createRoomCamera(options.room, options.aspect);
  scene.updateMatrixWorld(true);
  const { left, right, top, bottom } = reconstructionVolumeProjection(options.room, options, options.aspect);
  const fullWidth = 1536,
    fullHeight = Math.round(fullWidth / options.aspect);
  const x = left * fullWidth,
    y = top * fullHeight;
  const cropWidth = (right - left) * fullWidth,
    cropHeight = (bottom - top) * fullHeight;
  if (cropWidth < 1 || cropHeight < 1 || cropWidth > 8192 || cropHeight > 8192) {
    disposeModel(group);
    throw new Error('기본 모형이 공간에 비해 너무 커요. 규격을 줄여 주세요.');
  }
  const factor = Math.min(4, 2048 / Math.max(cropWidth, cropHeight));
  let renderer: WebGLRenderer | undefined;
  try {
    renderer = new WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
    renderer.setSize(
      Math.max(1, Math.round(cropWidth * factor)),
      Math.max(1, Math.round(cropHeight * factor)),
      false,
    );
    renderer.setPixelRatio(1);
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.toneMapping = NoToneMapping;
    renderer.setClearColor('#000000', 0);
    camera.setViewOffset(fullWidth, fullHeight, x, y, cropWidth, cropHeight);
    renderer.render(scene, camera);
    if (renderer.getContext().isContextLost()) throw new Error('기본 모형 생성 중 그래픽 연결이 끊겼어요.');
    const base = origin.clone().project(createRoomCamera(options.room, options.aspect));
    return {
      blob: await canvasBlob(renderer.domElement),
      anchor: {
        x: Math.max(0, Math.min(1, (((base.x + 1) / 2) * fullWidth - x) / cropWidth)),
        y: Math.max(0, Math.min(1, (((1 - base.y) / 2) * fullHeight - y) / cropHeight)),
      },
    };
  } finally {
    disposeModel(group);
    renderer?.dispose();
    renderer?.forceContextLoss();
  }
}
