/**
 * The guide variants of the direction-photo methods trial, drawn as the app draws its guide
 * (src/lib/direction-photo/guide-render.ts renderDirectionGuides: the same camera, light, grey, frame,
 * size and contact shadow) but from any model and at any elevation:
 *
 * - B0: the app's standard model (createTemplateModel with the form's options), for the equality check
 * - B2: a trial-only shape (shapes.ts)
 * - B4: another elevation (0° = a true side elevation)
 *
 * A copy, not an import, because the app's function builds its model inside; trial only. Browser only.
 */
import {
  AmbientLight,
  DirectionalLight,
  DoubleSide,
  type Group,
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
import { canvasBlob } from '../../src/lib/images';
import { createTemplateModel, disposeTemplateModel } from '../../src/lib/reconstruction/templates';
import type { ReconstructionKind, ReconstructionStandardOptions } from '../../src/lib/reconstruction/types';
import type { ProductDirection } from '../../src/lib/product-direction';
import {
  guideCamera,
  guideSize,
  projectGuidePoint,
  type Vec3,
} from '../../src/lib/direction-photo/guide-geometry';
import { standsOnFloor } from '../../src/lib/direction-photo/contract';
import type { GuideInput } from '../../src/lib/direction-photo/guide-render';
import { toiletGuideOptions } from '../../src/lib/direction-photo/categories/toilet';
import { createTrialShape } from './shapes';
import type { B2Shape } from './products';

export type Variant = { model: 'b0' } | { model: 'b2'; shape: B2Shape };

type GuideModelOptions = ReconstructionStandardOptions & {
  bathShape?: 'oval';
  toiletBody?: 'one-piece' | 'tankless';
  toiletSkirt?: 'skirted';
};
function modelOptions(input: GuideInput): GuideModelOptions {
  switch (input.form) {
    case 'oval-freestanding':
      return { bathShape: 'oval' };
    case 'rectangular':
      return {};
    case 'two-piece':
    case 'one-piece':
    case 'tankless':
      return toiletGuideOptions(input.form, input.lid ?? 'closed', input.skirt);
    default: {
      const [variant, shape] = input.form.split('-') as ['wall' | 'pedestal', 'round' | 'rectangular'];
      return { basinVariant: variant, basinShape: shape, bowlCount: 1 };
    }
  }
}

function matteGrey(model: Group) {
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

function outlineOf(model: Group, direction: ProductDirection, elevation: number) {
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

/** The guides of a product for a variant, as the app draws them (PNG on white, FLUX's input size). */
export async function renderVariantGuides(
  input: GuideInput,
  variant: Variant,
  directions: readonly ProductDirection[],
  elevation = 10,
): Promise<{ direction: ProductDirection; blob: Blob; width: number; height: number }[]> {
  const [widthMm, heightMm, depthMm] = input.sizeMm;
  const model =
    variant.model === 'b0'
      ? createTemplateModel({
          kind: input.category as ReconstructionKind,
          color: '#d6d6d6',
          widthMm,
          heightMm,
          depthMm,
          version: 2,
          face: standsOnFloor(input.installation) ? 'floor' : 'back',
          ...modelOptions(input),
        })
      : createTrialShape(variant.shape, input.sizeMm);
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
    const guides: { direction: ProductDirection; blob: Blob; width: number; height: number }[] = [];
    for (const direction of directions) {
      const outline = outlineOf(model, direction, elevation);
      const { camera: view } = outline;
      const extent = { width: outline.right - outline.left, height: outline.top - outline.bottom };
      const size = guideSize(extent);
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
      const canvas = document.createElement('canvas');
      canvas.width = size.width;
      canvas.height = size.height;
      const context = canvas.getContext('2d')!;
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
      guides.push({ direction, blob: await canvasBlob(canvas), width: size.width, height: size.height });
    }
    return guides;
  } finally {
    if (variant.model === 'b0') disposeTemplateModel(model);
    renderer?.dispose();
    renderer?.forceContextLoss();
  }
}
