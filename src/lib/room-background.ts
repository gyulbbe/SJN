import {
  BufferGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  Mesh,
  MeshBasicMaterial,
  NoToneMapping,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';
import { createRoomCamera, roomFacePoint, validateRoomDimensions } from './room-geometry';
import type { RoomDimensions, RoomFace } from './room-types';

export type RoomBackground = { blob: Blob; width: number; height: number };
type BackgroundSize = { width?: number; height?: number };
type BackgroundFace = RoomFace | 'ceiling';
const COLORS: Record<BackgroundFace, string> = {
  floor: '#d5d1c9',
  left: '#e9e6df',
  back: '#f0ede7',
  right: '#dcd8d0',
  ceiling: '#f6f4ef',
};

function makeFace(room: RoomDimensions, face: BackgroundFace): Mesh<BufferGeometry, MeshBasicMaterial> {
  const positions: number[] = [],
    colors: number[] = [],
    indices: number[] = [];
  const divisions = 20;
  const base = new Color(COLORS[face]);
  for (let row = 0; row <= divisions; row++) {
    for (let column = 0; column <= divisions; column++) {
      const u = column / divisions,
        v = row / divisions;
      const point =
        face === 'ceiling'
          ? new Vector3((u - 0.5) * room.widthMm, room.heightMm, v * room.depthMm)
          : roomFacePoint(room, face, u, v);
      positions.push(point.x, point.y, point.z);
      // Only broad neutral illumination; no photographed tile pattern is baked into the room.
      const edge = Math.pow(Math.abs(u - 0.5) * 2, 5);
      const light =
        face === 'floor'
          ? 0.88 + 0.12 * v - 0.025 * edge
          : face === 'ceiling'
            ? 0.97 + 0.03 * v
            : 1 - 0.07 * v * v - 0.025 * edge;
      colors.push(base.r * light, base.g * light, base.b * light);
      if (row < divisions && column < divisions) {
        const a = row * (divisions + 1) + column,
          b = a + 1,
          d = a + divisions + 1,
          c = d + 1;
        indices.push(a, b, c, a, c, d);
      }
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  return new Mesh(geometry, new MeshBasicMaterial({ vertexColors: true, side: DoubleSide }));
}

/** One transient WebGL context; the persisted PNG and overlay planes share the same camera. */
export async function renderRoomBackground(
  room: RoomDimensions,
  size: BackgroundSize = {},
): Promise<RoomBackground> {
  if (!validateRoomDimensions(room)) throw new Error('공간 크기가 허용 범위를 벗어났습니다.');
  const requestedWidth = size.width ?? 4096,
    requestedHeight = size.height ?? 2731;
  if (
    !Number.isFinite(requestedWidth) ||
    !Number.isFinite(requestedHeight) ||
    requestedWidth < 1 ||
    requestedHeight < 1
  )
    throw new Error('배경 이미지 크기가 올바르지 않습니다.');
  let renderer: WebGLRenderer | undefined;
  const meshes: Mesh<BufferGeometry, MeshBasicMaterial>[] = [];
  try {
    renderer = new WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
    const gl = renderer.getContext();
    const viewport = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array;
    const limit = Math.min(
      4096,
      renderer.capabilities.maxTextureSize,
      gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number,
      viewport[0],
      viewport[1],
    );
    const scale = Math.min(1, limit / Math.max(requestedWidth, requestedHeight));
    const width = Math.max(1, Math.round(requestedWidth * scale));
    const height = Math.max(1, Math.round(requestedHeight * scale));
    renderer.setPixelRatio(1);
    renderer.setSize(width, height, false);
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.toneMapping = NoToneMapping;
    renderer.setClearColor('#e8e8e4', 1);
    const scene = new Scene();
    for (const face of ['floor', 'left', 'back', 'right', 'ceiling'] as const) {
      const mesh = makeFace(room, face);
      meshes.push(mesh);
      scene.add(mesh);
    }
    renderer.render(scene, createRoomCamera(room, width / height));
    if (gl.isContextLost())
      throw new Error('공간 배경 생성 중 그래픽 연결이 끊겼습니다. 다시 시도해 주세요.');
    const canvas = renderer.domElement;
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (result) => (result ? resolve(result) : reject(new Error('공간 배경 이미지를 만들지 못했습니다.'))),
        'image/png',
      ),
    );
    return { blob, width, height };
  } catch (error) {
    if (error instanceof Error && error.message.includes('공간')) throw error;
    throw new Error(
      '이 브라우저에서 공간 배경을 생성하지 못했습니다. WebGL 설정을 확인하고 다시 시도해 주세요.',
    );
  } finally {
    for (const mesh of meshes) {
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
    if (renderer) {
      renderer.dispose();
      renderer.forceContextLoss();
    }
  }
}
