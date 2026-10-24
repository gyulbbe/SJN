import {
  Box3,
  Camera,
  CanvasTexture,
  DataTexture,
  DoubleSide,
  Group,
  LinearFilter,
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
import { liesOnWall } from '../room-fixtures';
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
  /** The photo's outline, black and soft, for its shadow on a wall (wallShadow). */
  outline?: Texture;
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
            outline: softOutline(canvas),
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
            image.outline.dispose();
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
          image.outline?.dispose();
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

/** World bounds of what shows of a product (the visible meshes only, not a shadow), from their vertices. */
function visibleBounds(root: Object3D): Box3 {
  root.updateMatrixWorld(true);
  const box = new Box3();
  root.traverseVisible((node) => {
    if (node instanceof Mesh && !node.userData.groundShadow && !node.userData.wallShadow)
      box.union(new Box3().setFromObject(node, true));
  });
  return box;
}
/**
 * A photo's outline as a soft black picture (its alpha, small and blurred): the shadow a product
 * hanging on a wall casts on the wall just under and around it.
 */
function softOutline(source: HTMLCanvasElement): DataTexture {
  const scale = 96 / Math.max(source.width, source.height);
  const w = Math.max(1, Math.round(source.width * scale)),
    h = Math.max(1, Math.round(source.height * scale));
  const small = document.createElement('canvas');
  small.width = w;
  small.height = h;
  const context = small.getContext('2d', { willReadFrequently: true })!;
  context.drawImage(source, 0, 0, w, h);
  const pixels = context.getImageData(0, 0, w, h).data;
  small.width = small.height = 0;
  let alpha = Float32Array.from({ length: w * h }, (_, i) => pixels[i * 4 + 3] / 255);
  // Three box passes each way, 2 px: close to a gaussian of about 3 px (3% of the picture).
  for (let pass = 0; pass < 3; pass++)
    for (const [step, count, lines, stride] of [
      [1, w, h, w],
      [w, h, w, 1],
    ] as const) {
      const next = new Float32Array(w * h);
      for (let line = 0; line < lines; line++)
        for (let i = 0; i < count; i++) {
          let sum = 0;
          for (let k = -2; k <= 2; k++) {
            const j = Math.max(0, Math.min(count - 1, i + k));
            sum += alpha[line * stride + j * step];
          }
          next[line * stride + i * step] = sum / 5;
        }
      alpha = next;
    }
  // A data texture's first row is its bottom.
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) data[((h - 1 - y) * w + x) * 4 + 3] = Math.round(alpha[y * w + x] * 255);
  const texture = new DataTexture(data, w, h);
  texture.magFilter = texture.minFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}
/** How far below its photo a wall product's shadow falls (mm), as the 2D editor's default offset. */
export const WALL_SHADOW_DROP_MM = 15;
/**
 * A wall product's shadow on its wall (docs/wall-contact-results-20261024.md): its photo's outline,
 * soft, a little lower, between the photo and the wall. Not part of its size or place. `strength` is
 * the fixture's shadow strength (0 none), as the 2D editor draws it.
 */
function wallShadow(geometry: PlaneGeometry, outline: Texture, strength: number): Mesh {
  const mesh = new Mesh(
    geometry.clone(),
    new MeshBasicMaterial({
      map: outline,
      color: 0x000000,
      transparent: true,
      opacity: strength,
      depthWrite: false,
      toneMapped: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -2,
    }),
  );
  mesh.position.set(0, -WALL_SHADOW_DROP_MM, -0.5);
  mesh.userData.wallShadow = true;
  mesh.renderOrder = 1;
  return mesh;
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
/** The corners of the opaque part of the photos shown, in world space (a turned photo too). */
function contentCorners(root: Object3D): Vector3[] {
  root.updateMatrixWorld(true);
  const corners: Vector3[] = [];
  root.traverseVisible((node) => {
    const bounds = node.userData.contentBounds as ProductBounds | undefined;
    if (!(node instanceof Mesh) || !bounds) return;
    node.geometry.computeBoundingBox();
    const local = node.geometry.boundingBox!;
    const w = local.max.x - local.min.x,
      h = local.max.y - local.min.y;
    for (const x of [bounds.left, bounds.right])
      for (const y of [bounds.top, bounds.bottom])
        corners.push(
          new Vector3(local.min.x + x * w, local.max.y - y * h, local.min.z).applyMatrix4(node.matrixWorld),
        );
  });
  return corners;
}
/** The opaque part of the photos shown, along one world axis (min and max). */
function contentAlong(root: Object3D, axis: 'x' | 'z') {
  let min = Infinity,
    max = -Infinity;
  for (const corner of contentCorners(root)) {
    min = Math.min(min, corner[axis]);
    max = Math.max(max, corner[axis]);
  }
  return { min, max };
}
/** The way (degrees, as the planes turn to a camera) into the room from `wall`. */
const intoRoom = (wall: WallSide) => (wall === 'back' ? 0 : wall === 'left' ? 90 : -90);
/**
 * The way (degrees, as the planes turn to a camera) a photo lying on `wall` faces: into the room, or
 * out of it when the camera looks from behind that wall, so the photo never reads mirrored.
 */
function wallFacing(wall: WallSide, quarter: number) {
  const into = intoRoom(wall);
  const off = ((((quarter - into + 180) % 360) + 360) % 360) - 180;
  return Math.abs(off) > 90 ? into + 180 : into;
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
 * Stands a product on its face once the picture has decided which way it looks. On a wall, what
 * shows of it touches the wall's inner face, 1 mm in front of it so a click picks the product, not
 * the wall (docs/wall-contact-results-20261024.md): a photo lying on the wall all over, a photo
 * standing (facing the camera) by its wall side, never by its transparent margin. A photo standing on
 * a side wall is centred on its place along the wall, one lying on it has its anchor there, as in the
 * 2D editor; one on the floor is centred on its place and on the floor. Its height on a wall and its
 * place across the back wall are the anchor's, as in the 2D editor. Returns whether what shows of it
 * then reaches beyond the room.
 */
function seatProduct(product: Group, room: RoomDimensions, face: RoomFace, flat: boolean): boolean {
  const box = visibleBounds(product);
  if (box.isEmpty()) return false;
  const wall = room.widthMm / 2;
  const move = new Vector3();
  if (face !== 'floor') {
    const { axis, at, inward } = wallPlane(room, face);
    const extent = contentAlong(product, axis);
    if (Number.isFinite(extent.min)) move[axis] = at + inward - (inward > 0 ? extent.min : extent.max);
  }
  if (((face === 'left' || face === 'right') && !flat) || face === 'floor')
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
  // What shows of it: a photo's transparent margin may reach into a wall.
  const corners = contentCorners(product);
  const seated = corners.length ? new Box3().setFromPoints(corners) : visibleBounds(product);
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
        // then seatProduct stands it on its face. On a wall the photo turns within its own plane.
        const roll = (-fixture.rotation * Math.PI) / 180;
        const content = new Group();
        if (p.face === 'floor') content.rotation.z = roll;
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
            plane.rotation.order = 'YXZ';
            // A photo lying on its wall casts its outline on it (shown only from the room side).
            if (
              p.face !== 'floor' &&
              image.outline &&
              fixture.shadow.opacity > 0 &&
              liesOnWall(p.face, viewDirection(view.direction))
            )
              plane.add(wallShadow(plane.geometry, image.outline, Math.min(1, fixture.shadow.opacity)));
            plane.userData.viewIndex = index;
            plane.userData.direction = viewDirection(view.direction);
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
        // along the wall changes); the first stand is the front's, as in 2D. On a wall a 정면 or 뒤
        // photo (the product's face or back, flat on the wall) lies on it whatever the side; a side
        // photo (its profile) turns to the camera (docs/wall-contact-results-20261024.md).
        const target = product,
          base = product.position.clone(),
          wallFace = p.face === 'floor' ? undefined : p.face;
        const lies = (plane: Mesh) => !!wallFace && liesOnWall(p.face, plane.userData.direction);
        const stands = new Map<string, Vector3>();
        const depthMm = productDepthMm(fixture, materials);
        const standAt = (index: number, quarter: number) => {
          for (const [i, plane] of planes) {
            plane.visible = i === index;
            const yaw = wallFace && lies(plane) ? wallFacing(wallFace, quarter) : quarter;
            plane.rotation.set(0, (yaw * Math.PI) / 180, wallFace ? roll : 0);
            // Seen from behind its wall (the wall is cut away) the shadow would hang in the air.
            for (const child of plane.children)
              if (child.userData.wallShadow) child.visible = !!wallFace && yaw === intoRoom(wallFace);
          }
          content.position.set(0, 0, 0);
          const key = `${index}:${quarter}`;
          let place = stands.get(key);
          let beyond = false;
          if (!place) {
            target.position.copy(base);
            const shown = planes.get(index);
            beyond = seatProduct(target, room, p.face, !!shown && lies(shown));
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
      // A photo on a wall casts its own outline on it, as in 2D (wallShadow).
      if (fixture.shadow.opacity > 0 && (p.face === 'floor' || fixture.reconstruction))
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
