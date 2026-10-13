import {
  AmbientLight,
  DirectionalLight,
  DoubleSide,
  Mesh,
  MeshStandardMaterial,
  NoToneMapping,
  OrthographicCamera,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
  type Material,
} from 'three';
import { createTemplateModel, disposeTemplateModel } from '../reconstruction/templates';
import type { ReconstructionKind, ReconstructionStandardOptions } from '../reconstruction/types';
import type { ProductDirection } from '../product-direction';
import type { MaterialInput } from '../types';
import { canvasBlob } from '../images';
import {
  GUIDE_ELEVATION_DEGREES,
  guideCamera,
  guideSize,
  planeShare,
  projectGuidePoint,
  type Vec3,
} from './guide-geometry';
import { standsOnFloor, type DirectionPhotoCategory, type DirectionPhotoForm } from './contract';

export type GuideInput = {
  category: DirectionPhotoCategory;
  form: DirectionPhotoForm;
  /** Width × height × depth (mm). */
  sizeMm: [number, number, number];
  installation: MaterialInput['installation'];
};
export type DirectionGuide = {
  direction: ProductDirection;
  /** PNG on white, FLUX's input size (long side 496, 16 px steps). */
  blob: Blob;
  width: number;
  height: number;
  /** How large the room draws the product from a photo of this outline (planeShare). */
  share: number;
};

/** The standard model's options that make each shape. */
function modelOptions(form: DirectionPhotoForm): ReconstructionStandardOptions & { bathShape?: 'oval' } {
  switch (form) {
    case 'oval-freestanding':
      return { bathShape: 'oval' };
    case 'rectangular':
      return {};
    case 'lid-closed':
      return { toiletLidState: 'closed' };
    case 'lid-open':
      return { toiletLidState: 'open' };
    default: {
      const [variant, shape] = form.split('-') as ['wall' | 'pedestal', 'round' | 'rectangular'];
      return { basinVariant: variant, basinShape: shape, bowlCount: 1 };
    }
  }
}

/** Plain matte grey: the guide fixes the shape, never the material (that comes from the photos). */
function matteGrey(model: ReturnType<typeof createTemplateModel>) {
  const replaced = new Map<Material, MeshStandardMaterial>();
  model.traverse((node) => {
    if (!(node instanceof Mesh)) return;
    const swap = (material: Material) => {
      let grey = replaced.get(material);
      if (!grey) {
        const source = material as MeshStandardMaterial;
        const metal = (source.metalness ?? 0) >= 0.5;
        const level = metal
          ? 0.55
          : Math.min(0.9, Math.max(0.45, source.color?.getHSL({ h: 0, s: 0, l: 0 }).l ?? 0.8));
        grey = new MeshStandardMaterial({ roughness: metal ? 0.55 : 0.9, metalness: 0, side: DoubleSide });
        grey.color.setRGB(level, level, level * 1.01);
        replaced.set(material, grey);
      }
      return grey;
    };
    node.material = Array.isArray(node.material) ? node.material.map(swap) : swap(node.material);
  });
  for (const material of replaced.keys()) material.dispose();
}

/** Every vertex of the model on the picture plane (mm): its outline and its footprint. */
function outlineOf(
  model: ReturnType<typeof createTemplateModel>,
  direction: ProductDirection,
  elevation: number,
) {
  const camera = guideCamera(direction, elevation);
  const point = new Vector3();
  let left = Infinity,
    right = -Infinity,
    bottom = Infinity,
    top = -Infinity;
  const foot = { left: Infinity, right: -Infinity, low: Infinity };
  let floorY = Infinity;
  model.traverse((node) => {
    const mesh = node as Mesh;
    const positions = mesh.isMesh ? mesh.geometry.getAttribute('position') : undefined;
    if (positions) for (let i = 0; i < positions.count; i++) floorY = Math.min(floorY, positions.getY(i));
  });
  model.traverse((node) => {
    const mesh = node as Mesh;
    const positions = mesh.isMesh ? mesh.geometry.getAttribute('position') : undefined;
    if (!positions) return;
    for (let i = 0; i < positions.count; i++) {
      point.fromBufferAttribute(positions, i);
      const [x, y] = projectGuidePoint(camera, [point.x, point.y, point.z] as Vec3);
      left = Math.min(left, x);
      right = Math.max(right, x);
      bottom = Math.min(bottom, y);
      top = Math.max(top, y);
      if (point.y <= floorY + 1) {
        foot.left = Math.min(foot.left, x);
        foot.right = Math.max(foot.right, x);
        foot.low = Math.min(foot.low, y);
      }
    }
  });
  return { camera, left, right, bottom, top, foot };
}

/**
 * The guides of a product: its kind's standard model at its size and shape, plain grey, seen from
 * about 10° above in each direction (orthographic, so the outline is the product's own), centred
 * with an even margin on white, a faint contact shadow under a floor product. One model and one
 * WebGL context for all the directions. Browser only.
 */
export async function renderDirectionGuides(
  input: GuideInput,
  directions: readonly ProductDirection[],
  elevation = GUIDE_ELEVATION_DEGREES,
): Promise<DirectionGuide[]> {
  const [widthMm, heightMm, depthMm] = input.sizeMm;
  const model = createTemplateModel({
    kind: input.category as ReconstructionKind,
    color: '#d6d6d6',
    widthMm,
    heightMm,
    depthMm,
    version: 2,
    face: standsOnFloor(input.installation) ? 'floor' : 'back',
    ...modelOptions(input.form),
  });
  matteGrey(model);
  const scene = new Scene();
  scene.add(model, new AmbientLight('#ffffff', 1.6));
  let renderer: WebGLRenderer | undefined;
  try {
    renderer = new WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.toneMapping = NoToneMapping;
    renderer.setClearColor('#000000', 0);
    const guides: DirectionGuide[] = [];
    for (const direction of directions) {
      const outline = outlineOf(model, direction, elevation);
      const { camera: view } = outline;
      const extent = { width: outline.right - outline.left, height: outline.top - outline.bottom };
      const size = guideSize(extent);
      // An even margin of about 5% of the long side round the outline.
      const scale = Math.min((size.width * 0.9) / extent.width, (size.height * 0.9) / extent.height);
      const cx = (outline.left + outline.right) / 2,
        cy = (outline.top + outline.bottom) / 2;
      const halfW = size.width / 2 / scale,
        halfH = size.height / 2 / scale;
      const camera = new OrthographicCamera(-halfW, halfW, halfH, -halfH, 1, 100000);
      const along = (v: Vec3, k: number) => new Vector3(v[0] * k, v[1] * k, v[2] * k);
      const centre = along(view.right, cx).add(along(view.up, cy));
      camera.position.copy(centre.clone().add(along(view.toCamera, 20000)));
      camera.up.set(...view.up);
      camera.lookAt(centre);
      // The key light from the upper left, a little towards the camera; a weak fill from the right.
      const key = new DirectionalLight('#ffffff', 2.3);
      key.position.copy(
        along(view.right, -0.45)
          .add(along(view.up, 0.75))
          .add(along(view.toCamera, 0.5))
          .multiplyScalar(10000),
      );
      const fill = new DirectionalLight('#ffffff', 0.45);
      fill.position.copy(along(view.right, 0.8).add(along(view.toCamera, 0.6)).multiplyScalar(10000));
      scene.add(key, fill);
      renderer.setSize(size.width, size.height, false);
      renderer.render(scene, camera);
      scene.remove(key, fill);
      key.dispose();
      fill.dispose();
      if (renderer.getContext().isContextLost())
        throw new Error('가이드 그림을 그리는 중 그래픽 연결이 끊겼어요.');
      const canvas = document.createElement('canvas');
      canvas.width = size.width;
      canvas.height = size.height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('가이드 그림을 만들지 못했어요.');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, size.width, size.height);
      if (standsOnFloor(input.installation) && outline.foot.right > outline.foot.left) {
        const px = (x: number) => size.width / 2 + (x - cx) * scale,
          py = (y: number) => size.height / 2 - (y - cy) * scale;
        context.save();
        context.filter = `blur(${Math.max(1, 10 * scale).toFixed(1)}px)`;
        context.fillStyle = 'rgba(0, 0, 0, 0.13)';
        context.beginPath();
        context.ellipse(
          (px(outline.foot.left) + px(outline.foot.right)) / 2,
          py(outline.foot.low),
          (px(outline.foot.right) - px(outline.foot.left)) / 2,
          Math.max(2, 18 * scale),
          0,
          0,
          Math.PI * 2,
        );
        context.fill();
        context.restore();
      }
      context.drawImage(renderer.domElement, 0, 0);
      guides.push({
        direction,
        blob: await canvasBlob(canvas),
        width: size.width,
        height: size.height,
        share: planeShare(input.sizeMm, direction, extent),
      });
    }
    return guides;
  } finally {
    disposeTemplateModel(model);
    renderer?.dispose();
    renderer?.forceContextLoss();
  }
}
