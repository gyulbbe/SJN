import {
  Box3,
  Camera,
  CanvasTexture,
  DataTexture,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PlaneGeometry,
  Quaternion,
  SRGBColorSpace,
  Vector3,
  Vector4,
  type Material,
  type Texture,
} from 'three';
import { roomFacePoint } from '../room-geometry';
import type { RoomDimensions } from '../room-types';
import { TONE_MAPPING_GLSL } from '../render/realistic-lighting';
import type { RoomFace, RoomPlacement, ProductBounds } from '../room-types';
import type { AssetRecord, ColorAdjust, FixtureInstance, MaterialVersion, Scene } from '../types';
import { createTemplateModel, disposeTemplateModel } from '../reconstruction/templates';
import { reconstructionModelTransform } from '../reconstruction/projection';
import {
  describeProductFacing,
  directionSuitsFace,
  viewDirection,
  viewDirectionAngle,
  type ProductDirection,
} from '../product-direction';
import { choosePhotoForView, viewPhotoNote } from './view-photo';
import { fitPhotoWidth, photoAcross } from '../product-photo-size';
import { cameraQuarterAzimuth, snapQuarter } from './view-state';
import { resolveBathRimFixture } from '../reconstruction/bath-rim';
import { behindWall, productDepthMm, wallContactPlace, type WallSide } from '../room-wall-contact';
import { FLOOR_SNAP_MM, FLOOR_SNAP_SHARE } from './floor-contact';
import type { ReconstructionKind } from '../reconstruction/types';

export type ViewerFixtureNotice = {
  id: string;
  name: string;
  message: string;
  severity: 'limitation' | 'error';
};
export type ViewerAssetReader = (id: string) => Promise<AssetRecord | undefined>;
type DecodedImage = {
  texture: Texture;
  bounds: ProductBounds;
  aspect: number;
  canvas: HTMLCanvasElement;
  /**
   * The lowest row (0–1 down) more than half opaque: where the product meets the floor. A soft
   * ground shadow or a background removal's faint edge below it counts in `bounds` but not here.
   */
  solidBottom?: number;
};
/** Alpha above this is the product itself (`solidBottom`); `bounds` counts anything above 8. */
const SOLID_ALPHA = 128;

/** One cache per viewer, shared by Before and every After. No asset writes, inference, or object URLs. */
export class ProductAssetCache {
  private assets = new Map<string, Promise<AssetRecord>>();
  private images = new Map<string, Promise<DecodedImage>>();
  private disposed = false;
  private pending = 0;
  constructor(private readonly reader: ViewerAssetReader) {}
  get diagnostics() {
    return {
      assets: this.assets.size,
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
            bottom = 0,
            solid = 0;
          for (let y = 0; y < canvas.height; y++)
            for (let x = 0; x < canvas.width; x++) {
              const alpha = data[(y * canvas.width + x) * 4 + 3];
              if (alpha <= 8) continue;
              left = Math.min(left, x);
              right = Math.max(right, x + 1);
              top = Math.min(top, y);
              bottom = Math.max(bottom, y + 1);
              if (alpha > SOLID_ALPHA) solid = Math.max(solid, y + 1);
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
            solidBottom: (solid || bottom) / canvas.height,
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
    this.assets.clear();
  }
}

/** The horizontal direction (degrees) a photo shows its product facing; none for a retired 위·아래 photo. */
export function declaredProductDirection(direction: string): number | undefined {
  return viewDirectionAngle(direction);
}

/** A photo's horizontal angle: its name's direction (none for a retired 위·아래 photo, which is not used). */
export function photoViewAngle(view: MaterialVersion['views'][number]): number | undefined {
  return declaredProductDirection(view.direction);
}
/**
 * The drawn picture of one product photo (mm, the whole image including its transparent margin), by
 * the rule the 2D editor shares (product-photo-size.ts): the visible area at the registered height,
 * across as the photo shows it. `across` says what that is (the width for 정면·뒤, the depth for
 * 옆); `estimated`, a side photo of a material without a depth.
 */
export type PhotoPlaneSize = { width: number; height: number; across: 'width' | 'depth'; estimated: boolean };
export function photoPlaneSize(
  placement: Pick<RoomPlacement, 'widthMm' | 'heightMm' | 'scale'>,
  depthMm: number | undefined,
  name: ProductDirection,
  bounds: ProductBounds,
  aspect: number,
): PhotoPlaneSize {
  const across = photoAcross(name, depthMm);
  const width = fitPhotoWidth(placement.heightMm, bounds, aspect) * placement.scale;
  return { width, height: width / aspect, across: across.across, estimated: across.estimated };
}

/** World bounds of what shows of a product (the visible meshes only), from their vertices. */
function visibleBounds(root: Object3D): Box3 {
  root.updateMatrixWorld(true);
  const box = new Box3();
  root.traverseVisible((node) => {
    if (node instanceof Mesh && !node.userData.groundShadow) box.union(new Box3().setFromObject(node, true));
  });
  return box;
}
let groundShadowTexture: DataTexture | undefined;
/**
 * A soft dark ellipse on the floor under a floor product's photo, the size of its footprint: a flat
 * photo casts no shadow under itself, so without it the product seems to hover. Not part of the
 * product's size or place (visibleBounds skips it).
 */
function groundShadow(widthMm: number, depthMm: number): Mesh {
  if (!groundShadowTexture) {
    // Black, darkest in the middle and gone at the edge (computed: no canvas needed).
    const size = 64,
      data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const r = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) / (size / 2);
        data[(y * size + x) * 4 + 3] = Math.round(255 * 0.5 * Math.max(0, 1 - r) ** 1.5);
      }
    groundShadowTexture = new DataTexture(data, size, size);
    groundShadowTexture.needsUpdate = true;
  }
  const mesh = new Mesh(
    // Within the footprint (it fades out at its edge), so it never reaches through a wall it stands at.
    new PlaneGeometry(widthMm * 1.1, depthMm).rotateX(-Math.PI / 2).translate(0, 0.5, 0),
    new MeshBasicMaterial({
      map: groundShadowTexture,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  mesh.userData.groundShadow = true;
  mesh.renderOrder = 1;
  return mesh;
}
/**
 * The opaque part of the photos shown (the planes' `contentBounds` down to their `solidBottom`, not
 * their transparent margin or a faint shadow), in world space: its lowest point and its height.
 * Undefined when no photo plane shows.
 */
function visibleContent(root: Object3D): { bottom: number; height: number } | undefined {
  root.updateMatrixWorld(true);
  let bottom = Infinity,
    top = -Infinity;
  root.traverseVisible((node) => {
    const bounds = node.userData.contentBounds as ProductBounds | undefined;
    if (!(node instanceof Mesh) || !bounds) return;
    // The product's own lowest row (a faint shadow under it is not the product).
    const solid = Math.min(bounds.bottom, (node.userData.solidBottom as number | undefined) ?? bounds.bottom);
    node.geometry.computeBoundingBox();
    const local = node.geometry.boundingBox!;
    const w = local.max.x - local.min.x,
      h = local.max.y - local.min.y;
    for (const x of [local.min.x + bounds.left * w, local.min.x + bounds.right * w])
      for (const down of [bounds.top, solid]) {
        const y = new Vector3(x, local.max.y - down * h, local.min.z).applyMatrix4(node.matrixWorld).y;
        bottom = Math.min(bottom, y);
        top = Math.max(top, y);
      }
  });
  return Number.isFinite(bottom) ? { bottom, height: top - bottom } : undefined;
}
/**
 * A floor product against its wall, seen from its front or back: the photo stands this share of half
 * its depth from the middle of its footprint towards the wall (0 the middle, 1 on the wall).
 */
export const WALL_PLANE_SHARE = 1;
/** The wall's inner face along its axis and the way into the room. */
function wallPlane(room: RoomDimensions, wall: WallSide) {
  return wall === 'back'
    ? { axis: 'z' as const, at: 0, inward: 1 }
    : {
        axis: 'x' as const,
        at: wall === 'left' ? -room.widthMm / 2 : room.widthMm / 2,
        inward: wall === 'left' ? 1 : -1,
      };
}
/** The opaque part of the photos shown, along one world axis (min and max). */
function contentAlong(root: Object3D, axis: 'x' | 'z') {
  root.updateMatrixWorld(true);
  let min = Infinity,
    max = -Infinity;
  root.traverseVisible((node) => {
    const bounds = node.userData.contentBounds as ProductBounds | undefined;
    if (!(node instanceof Mesh) || !bounds) return;
    node.geometry.computeBoundingBox();
    const local = node.geometry.boundingBox!;
    const w = local.max.x - local.min.x;
    for (const x of [local.min.x + bounds.left * w, local.min.x + bounds.right * w]) {
      const at = new Vector3(x, 0, local.min.z).applyMatrix4(node.matrixWorld)[axis];
      min = Math.min(min, at);
      max = Math.max(max, at);
    }
  });
  return { min, max };
}
/**
 * Moves a floor product's photo (not its footprint or ground shadow) against the wall behind it. Seen
 * from the side the photo shows the product's depth: its back edge goes on the wall. Seen from the
 * front or back the photo is one flat layer: it stands WALL_PLANE_SHARE of half the depth towards the
 * wall, never closer than 1 mm (a click on it picks the product, not the wall).
 */
function leanOnWall(content: Object3D, room: RoomDimensions, wall: WallSide, depthMm: number) {
  const { axis, at, inward } = wallPlane(room, wall);
  const extent = contentAlong(content, axis);
  if (!Number.isFinite(extent.min)) return;
  const back = inward > 0 ? extent.min : extent.max;
  const flat = extent.max - extent.min < 1;
  const target = flat ? back - inward * WALL_PLANE_SHARE * (depthMm / 2) : at + inward;
  // Never into the wall: the photo's back stays at least 1 mm inside.
  const limit = at + inward;
  const goal = inward > 0 ? Math.max(target, limit) : Math.min(target, limit);
  content.position[axis] += goal - back;
}

/**
 * Stands a product on its face once the picture has decided which way it looks: the side that
 * meets a wall touches the wall's inner face (nothing inside the wall, nothing floating off it), a
 * product on a side wall stands centred on its place along the wall, one on the floor centred on
 * its place and on the floor. Its height on a wall and its place across the back wall are the
 * anchor's, as in the 2D editor. `gap` keeps a flat photo a hair off its wall: a photo that turns to
 * face a side wall would otherwise lie exactly on it, and a click would pick the wall, not the product. Returns whether
 * it then reaches beyond the room.
 */
function seatProduct(product: Group, room: RoomDimensions, face: RoomFace, gap: number): boolean {
  const box = visibleBounds(product);
  if (box.isEmpty()) return false;
  const wall = room.widthMm / 2;
  const move = new Vector3();
  if (face === 'left') move.x = -wall + gap - box.min.x;
  else if (face === 'right') move.x = wall - gap - box.max.x;
  else if (face === 'back') move.z = gap - box.min.z;
  if (face === 'left' || face === 'right' || face === 'floor')
    move.z = product.position.z - (box.min.z + box.max.z) / 2;
  if (face === 'floor') {
    // What shows of the product meets the floor, not the picture's transparent margin around it.
    const shown = visibleContent(product) ?? { bottom: box.min.y, height: box.max.y - box.min.y };
    const snap = Math.max(FLOOR_SNAP_MM, shown.height * FLOOR_SNAP_SHARE);
    if (shown.bottom > 0 || -shown.bottom <= snap) move.y = -shown.bottom;
  }
  // Tiny moves are rounding only: leave the anchor's exact place alone.
  for (const axis of ['x', 'y', 'z'] as const)
    if (Math.abs(move[axis]) > 1e-6) product.position[axis] += move[axis];
  const seated = visibleBounds(product);
  const slack = 1;
  return (
    seated.min.z < -slack ||
    seated.max.z > room.depthMm + slack ||
    seated.min.x < -wall - slack ||
    seated.max.x > wall + slack ||
    seated.max.y > room.heightMm + slack
  );
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
  // Photo planes are unlit on purpose; only lit models (the standard models) are tone mapped.
  const lit = !(material instanceof MeshBasicMaterial);
  material.onBeforeCompile = (shader) => {
    shader.uniforms.sjnViewerFixtureColor = { value: adjustment };
    shader.fragmentShader =
      'uniform vec4 sjnViewerFixtureColor;\n' + (lit ? TONE_MAPPING_GLSL : '') + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <opaque_fragment>',
      `
outgoingLight *= exp2(sjnViewerFixtureColor.x);
outgoingLight = (outgoingLight - .18) * sjnViewerFixtureColor.y + .18;
outgoingLight = mix(vec3(dot(outgoingLight,vec3(.2126,.7152,.0722))),outgoingLight,sjnViewerFixtureColor.z);
outgoingLight = max(vec3(0.), outgoingLight * vec3(1.+sjnViewerFixtureColor.w*.18,1.,1.-sjnViewerFixtureColor.w*.18));
${lit ? 'outgoingLight = sjnToneMap(outgoingLight);' : ''}
#include <opaque_fragment>`,
    );
  };
  material.customProgramCacheKey = () => `room-viewer-fixture-linear-2-${lit ? 'lit' : 'unlit'}`;
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

function planeGeometry(
  fixture: FixtureInstance,
  size: PhotoPlaneSize,
  bounds: ProductBounds,
  aspect: number,
  anchor: { x: number; y: number },
) {
  const p = checkPlacement(fixture);
  checkBounds(bounds);
  if (!Number.isFinite(aspect) || aspect <= 0) throw new Error('제품 이미지 비율이 올바르지 않아요.');
  if (![size.width, size.height].every((n) => Number.isFinite(n) && n > 0))
    throw new Error('제품 이미지 크기를 계산할 수 없어요.');
  return new PlaneGeometry(size.width, size.height).translate(
    (0.5 - anchor.x) * size.width,
    (anchor.y - 0.5) * size.height,
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
    /** What the last frame's side shows in place of a missing direction, per fixture. */
    viewNotices = new Map<string, ViewerFixtureNotice>(),
    update: ((camera: Camera) => void)[] = [];
  const notice = (
    fixture: FixtureInstance,
    message: string,
    severity: ViewerFixtureNotice['severity'] = 'limitation',
  ) => notices.push({ id: fixture.id, name: fixture.name, message, severity });
  const room = scene.room;
  for (const fixture of scene.fixtures) {
    let product: Group | undefined;
    let reachesBeyond = false;
    /** The photo the room shows for this product (the selected one, unless that is a retired 위·아래 photo). */
    let shownIndex = fixture.viewIndex;
    try {
      if (!room) throw new Error('공간 크기와 설치면이 없어 3D 위치를 계산할 수 없어요.');
      const saved = checkPlacement(fixture);
      // A product kept against its wall stands there whatever its saved u/v (room-wall-contact.ts).
      const wall = saved.face === 'floor' && saved.againstWall ? behindWall(fixture, materials) : undefined;
      const p = { ...saved, ...(wall ? wallContactPlace(room, fixture, materials, wall) : {}) };
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
        // A retired 위·아래 photo is never shown in the room: the 정면 photo (else the first direction
        // photo) stands in for it, and a product with no direction photo at all cannot be drawn.
        if (viewDirection(selected.direction) === undefined) {
          const front = material.views.findIndex((view) => viewDirection(view.direction) === '정면');
          shownIndex = front >= 0 ? front : material.views.findIndex((view) => viewDirection(view.direction));
          if (shownIndex < 0) throw new Error('방 화면에 쓸 방향 사진이 없어요. 정면 사진을 등록해 주세요.');
          notice(
            fixture,
            `고른 사진은 위·아래에서 찍은 사진이라 방 화면에 쓰이지 않아요. ‘${viewDirection(material.views[shownIndex].direction)}’ 사진으로 보여요.`,
          );
        }
        product = new Group();
        product.position.copy(roomFacePoint(room, p.face, p.u, p.v));
        // No turn for the wall: the photo's angle name decides which way the product looks (as in 2D),
        // then seatProduct stands it on its face.
        const content = new Group();
        content.rotation.z = (-fixture.rotation * Math.PI) / 180;
        product.add(content);
        // The viewer and the AI input look from one of four sides, and a product is a flat photo
        // facing the camera: every photo of a horizontal direction gets its own plane (its size
        // from what it shows across, see photoPlaneSize), and each side shows the photo of the
        // direction it would see (see view-photo.ts). An older 360° view is its stored capture.
        const directions = material.views.map((view) => view.direction);
        const planes = new Map<number, Mesh>();
        let depthEstimated = false;
        for (const [index, view] of material.views.entries()) {
          // A retired 위·아래 photo is not used from the four sides, selected or not.
          if (photoViewAngle(view) === undefined) continue;
          try {
            const image = await cache.image(view.assetId);
            const own = index === fixture.viewIndex;
            const bounds = own ? p.contentBounds : image.bounds,
              aspect = own ? p.imageAspect : image.aspect;
            const size = photoPlaneSize(p, material.depthMm, viewDirection(view.direction)!, bounds, aspect);
            if (size.estimated) depthEstimated = true;
            const plane = new Mesh(
              planeGeometry(fixture, size, bounds, aspect, own ? fixture.anchor : view.anchor),
              new MeshBasicMaterial({
                map: image.texture,
                side: DoubleSide,
                alphaTest: 0.04,
                transparent: false,
                toneMapped: false,
              }),
            );
            plane.visible = index === shownIndex;
            plane.userData.viewIndex = index;
            plane.userData.contentBounds = bounds;
            plane.userData.solidBottom = image.solidBottom;
            planes.set(index, plane);
            content.add(plane);
          } catch (error) {
            if (index === shownIndex) throw error;
            notice(
              fixture,
              `방향 사진 일부를 읽지 못했어요: ${error instanceof Error ? error.message : String(error)}`,
              'error',
            );
          }
        }
        // Standing on its face is decided per side (the plane turns to the camera, so its extent
        // along the wall changes); the first stand is the front's, as in 2D.
        const target = product,
          base = product.position.clone(),
          back = p.face === 'back' ? 1 : 0;
        // A photo turned to face a side wall lies on it: keep it a hair off (see seatProduct).
        const gapAt = (quarter: number) =>
          back || ((p.face === 'left' || p.face === 'right') && Math.abs(quarter) === 90) ? 1 : 0;
        const stands = new Map<string, Vector3>();
        const depthMm = productDepthMm(fixture, materials);
        const standAt = (index: number, quarter: number) => {
          for (const [i, plane] of planes) {
            plane.visible = i === index;
            plane.rotation.y = (quarter * Math.PI) / 180;
          }
          content.position.set(0, 0, 0);
          const key = `${index}:${quarter}`;
          let place = stands.get(key);
          let beyond = false;
          if (!place) {
            target.position.copy(base);
            beyond = seatProduct(target, room, p.face, gapAt(quarter));
            place = target.position.clone();
            stands.set(key, place);
          } else target.position.copy(place);
          if (wall) leanOnWall(content, room, wall, depthMm);
          target.updateMatrixWorld(true);
          return beyond;
        };
        if (p.face === 'floor') {
          // The footprint turns with the product: one facing a side wall is deep along the room's width.
          const sideways =
            Math.abs(
              Math.sin(((viewDirectionAngle(material.views[shownIndex]?.direction) ?? 0) * Math.PI) / 180),
            ) > 0.5;
          const across = p.widthMm * p.scale;
          product.add(sideways ? groundShadow(depthMm, across) : groundShadow(across, depthMm));
        }
        reachesBeyond = standAt(shownIndex, 0);
        const look = new Quaternion();
        update.push((camera) => {
          const quarter = snapQuarter(cameraQuarterAzimuth(camera.getWorldQuaternion(look)));
          const photo = choosePhotoForView(directions, shownIndex, quarter, new Set(planes.keys()));
          standAt(planes.has(photo.index) ? photo.index : shownIndex, quarter);
          const message = viewPhotoNote(fixture.name, quarter, photo);
          if (message)
            viewNotices.set(fixture.id, {
              id: fixture.id,
              name: fixture.name,
              message,
              severity: 'limitation',
            });
          else viewNotices.delete(fixture.id);
        });
        product.userData.representation = planes.size > 1 ? 'directional-photo-planes' : 'fixed-photo-plane';
        notice(
          fixture,
          planes.size > 1
            ? '2D 제품·각도 표현 제한: 정면·왼쪽·오른쪽·뒤 사진을 화면 방향마다 카메라를 보는 평면으로 바꿔 보여요. 실제 입체가 아니며 위·아래에서는 볼 수 없어요.'
            : '2D 제품·각도 표현 제한: 선택 사진 한 장을 카메라를 보는 평면으로 보여요. 다른 방향 사진이 없어 어느 방향에서든 같은 사진이고, 뒷면도 실제 제품 뒷면이 아니에요.',
        );
        if (depthEstimated)
          notice(
            fixture,
            '자재에 깊이가 없어 바닥 자리와 벽 붙이기에는 가로의 절반을 깊이로 써요. 자재에 깊이를 등록하면 더 정확해요.',
          );
      }
      if (!fixture.reconstruction) {
        if (reachesBeyond)
          notice(fixture, '제품이 방 밖으로 나가요. 위치나 크기, 각도 방향을 확인해 주세요.');
        else {
          const direction =
            viewDirection(materials[fixture.materialVersionId]?.views[shownIndex]?.direction) ?? '정면';
          const suits = directionSuitsFace(p.face, direction);
          notice(
            fixture,
            `‘${direction}’ 각도 사진이 제품이 놓인 방향이에요(${describeProductFacing(p.face, direction)}). 화면을 돌리면 그 방향에서 보이는 사진으로 바뀌어요.${
              suits ? '' : ' 이 면에는 어울리는 각도가 아니에요.'
            }`,
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
    /** The photo stand-ins of the last updateView, in plain words. */
    viewNotices(): ViewerFixtureNotice[] {
      return [...viewNotices.values()];
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
