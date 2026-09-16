import {
  BufferAttribute,
  BufferGeometry,
  Camera,
  CanvasTexture,
  Color,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  SRGBColorSpace,
  Vector3,
  Vector4,
  type Material,
  type Texture,
} from 'three';
import { roomFacePoint } from '../room-geometry';
import type { RoomPlacement, ProductBounds } from '../room-types';
import type { AssetRecord, ColorAdjust, FixtureInstance, MaterialVersion, Scene } from '../types';
import { decodeProductMesh } from '../product3d/codec';
import { validatePose } from '../product3d/pose';
import type { Product3dReference, ProductMesh } from '../product3d/state-types';
import { createTemplateModel, disposeTemplateModel } from '../reconstruction/templates';
import { orientationAngle, reconstructionModelTransform } from '../reconstruction/projection';
import { resolveBathRimFixture } from '../reconstruction/bath-rim';
import type { ReconstructionKind } from '../reconstruction/types';

export type ViewerFixtureNotice = {
  id: string;
  name: string;
  message: string;
  severity: 'limitation' | 'error';
};
export type ViewerAssetReader = (id: string) => Promise<AssetRecord | undefined>;
type DecodedImage = { texture: Texture; bounds: ProductBounds; aspect: number; canvas: HTMLCanvasElement };

/** One cache per viewer, shared by Before and every After. No asset writes, inference, or object URLs. */
export class ProductAssetCache {
  private assets = new Map<string, Promise<AssetRecord>>();
  private meshes = new Map<string, Promise<ProductMesh>>();
  private images = new Map<string, Promise<DecodedImage>>();
  private disposed = false;
  private pending = 0;
  constructor(private readonly reader: ViewerAssetReader) {}
  get diagnostics() {
    return {
      assets: this.assets.size,
      meshes: this.meshes.size,
      textures: this.images.size,
      pending: this.pending,
      disposed: this.disposed,
    };
  }
  private assertOpen() {
    if (this.disposed) throw new Error('공간 둘러보기가 닫혔어요.');
  }
  asset(id: string): Promise<AssetRecord> {
    this.assertOpen();
    let task = this.assets.get(id);
    if (!task) {
      this.pending++;
      task = this.reader(id)
        .then((asset) => {
          this.assertOpen();
          if (!asset) throw new Error(`제품 자산을 찾을 수 없어요 (${id}).`);
          return asset;
        })
        .finally(() => {
          this.pending--;
        });
      this.assets.set(id, task);
    }
    return task;
  }
  mesh(id: string): Promise<ProductMesh> {
    this.assertOpen();
    let task = this.meshes.get(id);
    if (!task) {
      task = this.asset(id).then(async (asset) => {
        if (asset.kind !== 'product-mesh') throw new Error('저장된 입체 자산의 종류가 올바르지 않아요.');
        const mesh = await decodeProductMesh(asset.blob);
        this.assertOpen();
        return mesh;
      });
      this.meshes.set(id, task);
    }
    return task;
  }
  image(id: string): Promise<DecodedImage> {
    this.assertOpen();
    let task = this.images.get(id);
    if (!task) {
      task = this.asset(id).then(async (asset) => {
        if (asset.kind === 'product-mesh') throw new Error('제품 사진 자산이 이미지가 아니에요.');
        const bitmap = await createImageBitmap(asset.blob);
        try {
          this.assertOpen();
          const factor = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(bitmap.width * factor));
          canvas.height = Math.max(1, Math.round(bitmap.height * factor));
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          if (!ctx) throw new Error('제품 이미지를 읽을 수 없어요.');
          ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
          const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
          let left = canvas.width,
            right = 0,
            top = canvas.height,
            bottom = 0;
          for (let y = 0; y < canvas.height; y++)
            for (let x = 0; x < canvas.width; x++) {
              if (data[(y * canvas.width + x) * 4 + 3] <= 8) continue;
              left = Math.min(left, x);
              right = Math.max(right, x + 1);
              top = Math.min(top, y);
              bottom = Math.max(bottom, y + 1);
            }
          if (!right || !bottom) throw new Error('제품 이미지가 모두 투명해요.');
          const texture = new CanvasTexture(canvas);
          texture.colorSpace = SRGBColorSpace;
          const image = {
            texture,
            canvas,
            aspect: bitmap.width / bitmap.height,
            bounds: {
              left: left / canvas.width,
              top: top / canvas.height,
              right: right / canvas.width,
              bottom: bottom / canvas.height,
            },
          };
          if (this.disposed) {
            texture.dispose();
            canvas.width = canvas.height = 0;
            this.assertOpen();
          }
          return image;
        } finally {
          bitmap.close();
        }
      });
      this.images.set(id, task);
    }
    return task;
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const task of this.images.values())
      void task.then(
        (image) => {
          image.texture.dispose();
          image.canvas.width = image.canvas.height = 0;
        },
        () => {},
      );
    this.images.clear();
    this.meshes.clear();
    this.assets.clear();
  }
}

/** Only exact, explicit horizontal direction labels are supported. Arbitrary angle names stay fixed. */
export function declaredProductDirection(direction: string): number | undefined {
  return (
    {
      정면: 0,
      front: 0,
      '왼쪽 측면': -90,
      left: -90,
      '오른쪽 측면': 90,
      right: 90,
      뒤에서: 180,
      후면: 180,
      back: 180,
    } as Record<string, number>
  )[direction.trim()];
}
const degrees = (radians: number) => (radians * 180) / Math.PI;
const angularDistance = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);
export function chooseDirectionalPhoto(
  views: MaterialVersion['views'],
  selected: number,
  localAzimuth: number,
  elevation: number,
): number {
  const base = declaredProductDirection(views[selected]?.direction ?? '');
  if (base === undefined || Math.abs(elevation) > 35) return selected;
  const target = base + localAzimuth;
  let index = selected,
    distance = Infinity;
  views.forEach((view, i) => {
    const angle = declaredProductDirection(view.direction);
    if (angle === undefined) return;
    const delta = angularDistance(angle, target);
    if (delta < distance && delta <= 25) {
      index = i;
      distance = delta;
    }
  });
  return index;
}

function checkPlacement(fixture: FixtureInstance): RoomPlacement {
  const p = fixture.roomPlacement;
  if (!p) throw new Error('공간 설치 위치가 없어요. 기존 정면 보기에서 확인해 주세요.');
  if (
    !['floor', 'left', 'back', 'right'].includes(p.face) ||
    ![p.u, p.v].every((n) => Number.isFinite(n) && n >= 0 && n <= 1) ||
    ![p.widthMm, p.heightMm].every((n) => Number.isFinite(n) && n > 0 && n <= 20000) ||
    !Number.isFinite(p.scale) ||
    p.scale <= 0 ||
    p.scale > 100
  )
    throw new Error('제품의 공간 위치·규격·배율이 올바르지 않아요.');
  if (![fixture.anchor.x, fixture.anchor.y, fixture.rotation].every(Number.isFinite))
    throw new Error('제품의 기준점·회전 정보가 올바르지 않아요.');
  return p;
}
function checkBounds(bounds: ProductBounds) {
  if (
    !bounds ||
    ![bounds.left, bounds.right, bounds.top, bounds.bottom].every(
      (n) => Number.isFinite(n) && n >= 0 && n <= 1,
    ) ||
    bounds.right <= bounds.left ||
    bounds.bottom <= bounds.top
  )
    throw new Error('제품 이미지의 기준 영역이 올바르지 않아요.');
}

/** Same linear adjustment as the editor, without screen-space occlusion or a second output conversion. */
function applyColor(material: Material, color: ColorAdjust) {
  const adjustment = new Vector4(color.exposure, color.contrast, color.saturation, color.warmth);
  material.onBeforeCompile = (shader) => {
    shader.uniforms.sjnViewerFixtureColor = { value: adjustment };
    shader.fragmentShader = 'uniform vec4 sjnViewerFixtureColor;\n' + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <opaque_fragment>',
      `
outgoingLight *= exp2(sjnViewerFixtureColor.x);
outgoingLight = (outgoingLight - .18) * sjnViewerFixtureColor.y + .18;
outgoingLight = mix(vec3(dot(outgoingLight,vec3(.2126,.7152,.0722))),outgoingLight,sjnViewerFixtureColor.z);
outgoingLight = max(vec3(0.), outgoingLight * vec3(1.+sjnViewerFixtureColor.w*.18,1.,1.-sjnViewerFixtureColor.w*.18));
#include <opaque_fragment>`,
    );
  };
  material.customProgramCacheKey = () => 'room-viewer-fixture-linear-1';
}
function prepareModel(group: Group, fixture: FixtureInstance) {
  const materials = new Set<Material>();
  group.traverse((node) => {
    if (node instanceof Mesh) {
      node.castShadow = !(Array.isArray(node.material) ? node.material : [node.material]).some(
        (m) => m.transparent,
      );
      node.receiveShadow = true;
      for (const material of Array.isArray(node.material) ? node.material : [node.material])
        materials.add(material);
    }
  });
  for (const material of materials) applyColor(material, fixture.color);
  group.name = fixture.name;
  group.userData.fixtureId = fixture.id;
}

/** Uniformly fits the selected PNG pose into its W×H envelope; depth is the saved mesh ratio. */
export function createSavedProductGeometry(
  mesh: ProductMesh,
  reference: Product3dReference,
  fixture: FixtureInstance,
): BufferGeometry {
  const p = checkPlacement(fixture);
  checkBounds(p.contentBounds);
  const pose = validatePose(reference.pose);
  const orientation = new Quaternion(...pose.cameraQuaternion)
    .invert()
    .multiply(new Quaternion(...pose.objectQuaternion))
    .normalize();
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(mesh.positions), 3));
  geometry.setIndex(new BufferAttribute(new Uint32Array(mesh.indices), 1));
  geometry.computeBoundingBox();
  const center = geometry.boundingBox!.getCenter(new Vector3());
  geometry.translate(-center.x, -center.y, -center.z);
  geometry.applyQuaternion(orientation);
  geometry.computeBoundingBox();
  const box = geometry.boundingBox!,
    size = box.getSize(new Vector3());
  if (![size.x, size.y, size.z].every(Number.isFinite) || size.x < 1e-8 || size.y < 1e-8) {
    geometry.dispose();
    throw new Error('선택한 자세의 입체 형상 크기가 올바르지 않아요.');
  }
  const scale = Math.min(p.widthMm / size.x, p.heightMm / size.y) * p.scale;
  const bounds = p.contentBounds;
  const ax = (fixture.anchor.x - bounds.left) / (bounds.right - bounds.left);
  const ay = (fixture.anchor.y - bounds.top) / (bounds.bottom - bounds.top);
  geometry.translate(
    -box.min.x - size.x * ax,
    -box.max.y + size.y * ay,
    p.face === 'floor' ? -(box.min.z + box.max.z) / 2 : -box.min.z,
  );
  geometry.scale(scale, scale, scale);
  const colors = new Float32Array(mesh.colors.length),
    color = new Color();
  for (let i = 0; i < colors.length; i += 3) {
    color.setRGB(mesh.colors[i], mesh.colors[i + 1], mesh.colors[i + 2], SRGBColorSpace);
    colors[i] = color.r;
    colors[i + 1] = color.g;
    colors[i + 2] = color.b;
  }
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  return geometry;
}

function planeGeometry(
  fixture: FixtureInstance,
  image: DecodedImage,
  selected: boolean,
  anchor: { x: number; y: number },
) {
  const p = checkPlacement(fixture),
    bounds = selected ? p.contentBounds : image.bounds;
  checkBounds(bounds);
  const aspect = selected ? p.imageAspect : image.aspect;
  if (!Number.isFinite(aspect) || aspect <= 0) throw new Error('제품 이미지 비율이 올바르지 않아요.');
  const width =
    Math.min(p.widthMm / (bounds.right - bounds.left), (p.heightMm * aspect) / (bounds.bottom - bounds.top)) *
    p.scale;
  const height = width / aspect;
  return new PlaneGeometry(width, height).translate(
    (0.5 - anchor.x) * width,
    (anchor.y - 0.5) * height,
    p.face === 'floor' ? 0 : 1,
  );
}

/** Builds only derived Three objects: never projects, fits, clamps, edits, or saves source fixtures. */
export async function buildViewerFixtures(
  scene: Scene,
  materials: Record<string, MaterialVersion>,
  reader: ViewerAssetReader,
  sharedCache?: ProductAssetCache,
) {
  const cache = sharedCache ?? new ProductAssetCache(reader);
  const group = new Group(),
    notices: ViewerFixtureNotice[] = [],
    update: ((camera: Camera) => void)[] = [];
  const notice = (
    fixture: FixtureInstance,
    message: string,
    severity: ViewerFixtureNotice['severity'] = 'limitation',
  ) => notices.push({ id: fixture.id, name: fixture.name, message, severity });
  const room = scene.room;
  for (const fixture of scene.fixtures) {
    let product: Group | undefined;
    try {
      if (!room) throw new Error('공간 크기와 설치면이 없어 3D 위치를 계산할 수 없어요.');
      const p = checkPlacement(fixture);
      if (
        !fixture.color ||
        ![
          fixture.color.exposure,
          fixture.color.contrast,
          fixture.color.saturation,
          fixture.color.warmth,
        ].every((value) => typeof value === 'number' && Number.isFinite(value))
      )
        throw new Error('제품의 색감 보정 값이 올바르지 않아요. 기존 편집에서 확인해 주세요.');
      if (fixture.reconstruction) {
        const r = fixture.reconstruction;
        if (
          ![
            'toilet',
            'basin',
            'vanity',
            'bath',
            'mirror',
            'door',
            'window',
            'glassPartition',
            'mirrorCabinet',
            'wallShelf',
            'shower',
            'wallCabinet',
            'lowPartition',
            'showerCurtain',
          ].includes(r.kind)
        )
          throw new Error('지원하지 않는 표준 모형 종류예요.');
        if (![r.widthMm, r.heightMm, r.depthMm].every((n) => Number.isFinite(n) && n > 0 && n <= 20000))
          throw new Error('표준 모형 규격이 올바르지 않아요.');
        const relation = resolveBathRimFixture(scene, fixture);
        if (relation.status === 'held') throw new Error(relation.reason);
        const placement =
          relation.status === 'attached' ? { ...p, ...r, ...relation.placement } : { ...r, ...p };
        product = createTemplateModel({ ...r, ...placement, kind: r.kind as ReconstructionKind });
        const transform = reconstructionModelTransform(room, placement);
        if (![...transform.origin.toArray(), transform.angle, transform.scale].every(Number.isFinite))
          throw new Error('표준 모형의 설치 높이·방향 정보가 올바르지 않아요.');
        product.position.copy(transform.origin);
        product.rotation.y = transform.angle;
        product.scale.setScalar(transform.scale);
        product.userData.representation = 'standard-model';
        if (r.appearanceAssetId)
          notice(fixture, '거울·창의 원사진 반사와 배경은 가져오지 않고 표준 표면으로 표시해요.');
      } else {
        const material = materials[fixture.materialVersionId];
        if (!material) throw new Error('사용 당시 자재 버전을 찾을 수 없어요.');
        const selected = material.views[fixture.viewIndex];
        if (!selected) throw new Error('선택했던 제품 사진을 찾을 수 없어요.');
        product = new Group();
        product.position.copy(roomFacePoint(room, p.face, p.u, p.v));
        product.rotation.y = p.face === 'floor' ? 0 : orientationAngle(p.face);
        const content = new Group();
        content.rotation.z = (-fixture.rotation * Math.PI) / 180;
        product.add(content);
        if (selected.product3d) {
          if (selected.product3d.version !== 1) throw new Error('지원하지 않는 제품 입체 데이터 버전이에요.');
          const mesh = await cache.mesh(selected.product3d.meshAssetId);
          const geometry = createSavedProductGeometry(mesh, selected.product3d, fixture);
          content.add(
            new Mesh(
              geometry,
              new MeshBasicMaterial({ vertexColors: true, side: DoubleSide, toneMapped: false }),
            ),
          );
          product.userData.representation = 'saved-product-mesh';
          notice(
            fixture,
            '저장된 입체 형상·선택 사진 자세를 사용해요. 폭·높이에 비율을 유지해 맞추며 깊이는 저장 형상의 비율이에요.',
          );
        } else {
          const base = declaredProductDirection(selected.direction);
          const choices = material.views
            .map((view, index) => ({ view, index }))
            .filter(
              ({ view, index }) =>
                index === fixture.viewIndex ||
                (base !== undefined &&
                  declaredProductDirection(view.direction) !== undefined &&
                  !view.product3d),
            );
          const planes = new Map<number, Mesh>();
          for (const { view, index } of choices) {
            try {
              const image = await cache.image(view.assetId);
              const plane = new Mesh(
                planeGeometry(
                  fixture,
                  image,
                  index === fixture.viewIndex,
                  index === fixture.viewIndex ? fixture.anchor : view.anchor,
                ),
                new MeshBasicMaterial({
                  map: image.texture,
                  side: DoubleSide,
                  alphaTest: 0.04,
                  transparent: false,
                  toneMapped: false,
                }),
              );
              plane.rotation.y =
                (((declaredProductDirection(view.direction) ?? base ?? 0) - (base ?? 0)) * Math.PI) / 180;
              plane.visible = index === fixture.viewIndex;
              plane.userData.viewIndex = index;
              planes.set(index, plane);
              content.add(plane);
            } catch (error) {
              if (index === fixture.viewIndex) throw error;
              notice(
                fixture,
                `방향 사진 일부를 읽지 못했어요: ${error instanceof Error ? error.message : String(error)}`,
                'error',
              );
            }
          }
          const target = product;
          update.push((camera) => {
            target.updateMatrixWorld(true);
            const point = camera.getWorldPosition(new Vector3());
            target.worldToLocal(point);
            const index = chooseDirectionalPhoto(
              material.views,
              fixture.viewIndex,
              degrees(Math.atan2(point.x, point.z)),
              degrees(Math.atan2(point.y, Math.hypot(point.x, point.z))),
            );
            const actual = planes.has(index) ? index : fixture.viewIndex;
            for (const [i, plane] of planes) plane.visible = i === actual;
          });
          product.userData.representation =
            planes.size > 1 ? 'directional-photo-planes' : 'fixed-photo-plane';
          notice(
            fixture,
            planes.size > 1
              ? '2D 제품·각도 표현 제한: 명시된 정면·측면·뒷면 사진만 설치 위치의 고정 평면으로 전환해요. 실제 입체가 아니며 위·아래나 없는 방향에서는 선택 사진을 유지해요.'
              : '2D 제품·각도 표현 제한: 선택 사진을 설치 위치의 고정 평면으로 표시해요. 옆에서는 얇게 보이고 뒷면은 같은 사진이라 실제 제품 뒷면이 아니에요.',
          );
        }
      }
      prepareModel(product, fixture);
      group.add(product);
      if (
        fixture.occlusion.polygon.length ||
        fixture.occlusion.polygons?.length ||
        fixture.occlusion.strokes.length ||
        fixture.occlusion.holes?.length
      )
        notice(fixture, '정면 사진의 가림 마스크는 새 방향에 적용하지 않으며 공간 깊이로 가림을 계산해요.');
      if (fixture.shadow.opacity > 0)
        notice(fixture, '정면 사진의 접지 그림자는 회전하지 않으며 공간 광원과 형상으로 그림자를 계산해요.');
    } catch (error) {
      if (product) disposeTemplateModel(product);
      notice(fixture, error instanceof Error ? error.message : String(error), 'error');
    }
  }
  group.updateMatrixWorld(true);
  let disposed = false;
  return {
    group,
    notices,
    updateView(camera: Camera) {
      if (!disposed) for (const fn of update) fn(camera);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      disposeTemplateModel(group);
      group.clear();
      update.length = 0;
      if (!sharedCache) cache.dispose();
    },
  };
}
