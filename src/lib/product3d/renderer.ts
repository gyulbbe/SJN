import * as THREE from 'three';
import type { ProductMesh, ProductPose } from './state-types';
import { validatePose } from './pose';

export interface ProductCapture {
  blob: Blob;
  width: number;
  height: number;
  anchor: { x: number; y: number };
}
export interface ProjectedProductBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
  centerX: number;
  centerY: number;
}

function pngBlob(canvas: HTMLCanvasElement, signal: AbortSignal): Promise<Blob> {
  return new Promise((resolve, reject) => {
    let finished = false;
    const done = (blob: Blob | null, error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (error) reject(error);
      else if (blob) resolve(blob);
      else reject(new Error('투명 PNG를 만들지 못했습니다. 다시 시도해 주세요.'));
    };
    const abort = () => done(null, new DOMException('이미지 저장을 취소했습니다.', 'AbortError'));
    const timer = setTimeout(() => done(null, new Error('PNG 저장 시간이 초과되었습니다.')), 30_000);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    try {
      canvas.toBlob((blob) => done(blob), 'image/png');
    } catch (error) {
      done(null, error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/** Shared live/export scene. No lighting changes the model's already baked RGB appearance. */
export class ProductRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera: THREE.OrthographicCamera;
  readonly object: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  readonly scene = new THREE.Scene();
  private readonly geometry = new THREE.BufferGeometry();
  private readonly material = new THREE.MeshBasicMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  private readonly raycaster = new THREE.Raycaster();
  private readonly boxCorners: THREE.Vector3[] = [];
  private readonly abort = new AbortController();
  private readonly radius: number;
  private width = 1;
  private height = 1;
  private pixelRatio = 1;
  private disposed = false;
  private capturing = false;

  constructor(
    readonly canvas: HTMLCanvasElement,
    mesh: ProductMesh,
  ) {
    if (
      !mesh.positions.length ||
      mesh.positions.length % 3 ||
      mesh.colors.length !== mesh.positions.length ||
      !mesh.indices.length ||
      mesh.indices.length % 3
    ) {
      throw new Error('제품 형상의 좌표·면·색상 데이터가 올바르지 않습니다.');
    }
    if (mesh.positions.byteLength + mesh.colors.byteLength + mesh.indices.byteLength > 25 * 1024 * 1024)
      throw new Error('제품 입체 데이터가 25MB를 초과합니다.');
    for (const n of mesh.positions)
      if (!Number.isFinite(n)) throw new Error('제품 형상에 잘못된 좌표가 있습니다.');
    for (const n of mesh.indices)
      if (n >= mesh.positions.length / 3) throw new Error('제품 형상에 잘못된 면 정보가 있습니다.');
    const colors = new Float32Array(mesh.colors.length);
    const color = new THREE.Color();
    for (let i = 0; i < mesh.colors.length; i += 3) {
      const r = mesh.colors[i],
        g = mesh.colors[i + 1],
        b = mesh.colors[i + 2];
      if (![r, g, b].every((n) => Number.isFinite(n) && n >= 0 && n <= 1))
        throw new Error('제품 형상에 잘못된 색상이 있습니다.');
      color.setRGB(r, g, b, THREE.SRGBColorSpace);
      colors[i] = color.r;
      colors[i + 1] = color.g;
      colors[i + 2] = color.b;
    }
    this.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(mesh.positions), 3));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
    this.geometry.computeBoundingBox();
    const center = this.geometry.boundingBox!.getCenter(new THREE.Vector3());
    this.geometry.translate(-center.x, -center.y, -center.z);
    this.geometry.computeBoundingBox();
    this.geometry.computeBoundingSphere();
    this.radius = this.geometry.boundingSphere!.radius;
    if (!Number.isFinite(this.radius) || this.radius < 1e-5) {
      this.geometry.dispose();
      this.material.dispose();
      throw new Error('제품 형상의 크기가 너무 작습니다.');
    }
    const box = this.geometry.boundingBox!;
    for (const x of [box.min.x, box.max.x])
      for (const y of [box.min.y, box.max.y])
        for (const z of [box.min.z, box.max.z]) this.boxCorners.push(new THREE.Vector3(x, y, z));
    this.object = new THREE.Mesh(this.geometry, this.material);
    this.scene.add(this.object);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, this.radius * 0.01, this.radius * 12);
    try {
      this.renderer = new THREE.WebGLRenderer({
        canvas,
        alpha: true,
        antialias: true,
        preserveDrawingBuffer: true,
      });
      this.renderer.setClearColor(0, 0);
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      this.renderer.toneMapping = THREE.NoToneMapping;
    } catch {
      this.geometry.dispose();
      this.material.dispose();
      throw new Error(
        '이 브라우저에서 WebGL 입체 미리보기를 시작할 수 없습니다. 하드웨어 가속 설정을 확인해 주세요.',
      );
    }
  }

  setPose(input: ProductPose) {
    const pose = validatePose(input);
    this.object.quaternion.fromArray(pose.objectQuaternion);
    this.camera.quaternion.fromArray(pose.cameraQuaternion);
    this.camera.position.set(0, 0, this.radius * 4).applyQuaternion(this.camera.quaternion);
    this.camera.up.set(0, 1, 0).applyQuaternion(this.camera.quaternion);
    this.camera.zoom = pose.zoom;
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
    this.object.updateMatrixWorld();
  }

  getPose(): ProductPose {
    return validatePose({
      objectQuaternion: this.object.quaternion.toArray(),
      cameraQuaternion: this.camera.quaternion.toArray(),
      zoom: this.camera.zoom,
    });
  }

  resize(width: number, height: number, pixelRatio = 1) {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.pixelRatio = Math.min(2, Math.max(1, pixelRatio));
    const aspect = this.width / this.height;
    const half = this.radius * 1.12;
    this.camera.left = -half * Math.max(1, aspect);
    this.camera.right = -this.camera.left;
    this.camera.top = half * Math.max(1, 1 / aspect);
    this.camera.bottom = -this.camera.top;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(this.width, this.height, false);
  }

  render() {
    if (this.disposed) return;
    if (this.renderer.getContext().isContextLost())
      throw new Error('GPU 연결이 끊겼습니다. 창을 닫고 다시 열어 주세요.');
    this.renderer.render(this.scene, this.camera);
  }

  hitTest(x: number, y: number) {
    this.camera.updateMatrixWorld();
    this.object.updateMatrixWorld();
    this.raycaster.setFromCamera(
      new THREE.Vector2((x / this.width) * 2 - 1, 1 - (y / this.height) * 2),
      this.camera,
    );
    return this.raycaster.intersectObject(this.object, false).length > 0;
  }

  /** Eight bounds corners are enough for the overlay; export uses every vertex. */
  projectedBounds(): ProjectedProductBounds {
    this.camera.updateMatrixWorld();
    this.object.updateMatrixWorld();
    let left = Infinity,
      top = Infinity,
      right = -Infinity,
      bottom = -Infinity;
    for (const corner of this.boxCorners) {
      const point = corner.clone().applyMatrix4(this.object.matrixWorld).project(this.camera);
      const x = ((point.x + 1) * this.width) / 2,
        y = ((1 - point.y) * this.height) / 2;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
    return { left, top, right, bottom, centerX: this.width / 2, centerY: this.height / 2 };
  }

  async capture(): Promise<ProductCapture> {
    if (this.disposed) throw new Error('입체 편집기가 닫혔습니다.');
    if (this.capturing) throw new Error('이미지를 만드는 중입니다. 잠시 기다려 주세요.');
    if (this.renderer.capabilities.maxTextureSize < 1024)
      throw new Error('이 기기의 GPU가 1024px 출력을 지원하지 않습니다.');
    this.capturing = true;
    try {
      const camera = this.camera.clone();
      camera.zoom = 1;
      camera.updateMatrixWorld();
      this.object.updateMatrixWorld();
      const transform = new THREE.Matrix4().multiplyMatrices(
        camera.matrixWorldInverse,
        this.object.matrixWorld,
      );
      const position = this.geometry.getAttribute('position');
      const point = new THREE.Vector3();
      let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;
      for (let i = 0; i < position.count; i++) {
        point.fromBufferAttribute(position, i).applyMatrix4(transform);
        minX = Math.min(minX, point.x);
        maxX = Math.max(maxX, point.x);
        minY = Math.min(minY, point.y);
        maxY = Math.max(maxY, point.y);
      }
      const half = (Math.max(maxX - minX, maxY - minY) / 2) * 1.16; // 8% of object size on each edge.
      camera.position.add(
        new THREE.Vector3((minX + maxX) / 2, (minY + maxY) / 2, 0).applyQuaternion(camera.quaternion),
      );
      camera.left = -half;
      camera.right = half;
      camera.top = half;
      camera.bottom = -half;
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld();
      this.renderer.setPixelRatio(1);
      this.renderer.setSize(1024, 1024, false);
      let png: Promise<Blob>;
      try {
        this.renderer.render(this.scene, camera);
        if (this.renderer.getContext().isContextLost()) throw new Error('PNG 생성 중 GPU 연결이 끊겼습니다.');
        // toBlob snapshots the bitmap when called, so restore the live viewport immediately.
        png = pngBlob(this.canvas, this.abort.signal);
      } finally {
        if (!this.disposed) {
          this.renderer.setPixelRatio(this.pixelRatio);
          this.renderer.setSize(this.width, this.height, false);
          this.render();
        }
      }
      return {
        blob: await png!,
        width: 1024,
        height: 1024,
        anchor: { x: 0.5, y: 0.5 + (maxY - minY) / (4 * half) },
      };
    } finally {
      this.capturing = false;
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.abort.abort();
    this.geometry.dispose();
    this.material.dispose();
    this.scene.clear();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.canvas.width = 0;
    this.canvas.height = 0;
  }
}
