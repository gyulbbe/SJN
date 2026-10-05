import {
  Box3,
  Camera,
  CanvasTexture,
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
  directionAngle,
  directionSuitsFace,
  readProductDirection,
  type ProductDirection,
} from '../product-direction';
import { choosePhotoForView, viewPhotoNote } from './view-photo';
import { cameraQuarterAzimuth, snapQuarter } from './view-state';
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
    this.assets.clear();
  }
}

/** The name of a photo's angle, as the closed list reads it. */
const nameOf = (view: { direction: string }) => readProductDirection(view.direction).name;
/** The horizontal direction (degrees) a photo shows its product facing; none for 위 and 아래. */
export function declaredProductDirection(direction: string): number | undefined {
  return directionAngle(readProductDirection(direction).name);
}

/** A photo's horizontal angle: its name's direction (none for 위 and 아래, which are not used). */
export function photoViewAngle(view: MaterialVersion['views'][number]): number | undefined {
  return declaredProductDirection(view.direction);
}
/**
 * The drawn picture of one product photo (mm, the whole image including its transparent margin).
 * What a photo shows across is not the same for every photo: 정면 and 뒤 show the product's width,
 * 왼쪽 and 오른쪽 its depth, so the photo's visible area (`bounds`) is fitted into width × height or
 * depth × height, keeping its aspect. Without a depth the side photos use the width (`estimated`).
 */
export type PhotoPlaneSize = { width: number; height: number; across: 'width' | 'depth'; estimated: boolean };
export function photoPlaneSize(
  placement: Pick<RoomPlacement, 'widthMm' | 'heightMm' | 'scale'>,
  depthMm: number | undefined,
  name: ProductDirection,
  bounds: ProductBounds,
  aspect: number,
): PhotoPlaneSize {
  const side = name === '왼쪽' || name === '오른쪽';
  const known = typeof depthMm === 'number' && Number.isFinite(depthMm) && depthMm > 0;
  const across = side && known ? depthMm : placement.widthMm;
  const width =
    Math.min(
      across / (bounds.right - bounds.left),
      (placement.heightMm * aspect) / (bounds.bottom - bounds.top),
    ) * placement.scale;
  return { width, height: width / aspect, across: side ? 'depth' : 'width', estimated: side && !known };
}

/** World bounds of what shows of a product (the visible meshes only), from their vertices. */
function visibleBounds(root: Object3D): Box3 {
  root.updateMatrixWorld(true);
  const box = new Box3();
  root.traverseVisible((node) => {
    if (node instanceof Mesh) box.union(new Box3().setFromObject(node, true));
  });
  return box;
}
/**
 * A flat photo floating or sinking by less than this (mm) because of where its anchor sits is put
 * on the floor; a bigger gap is taken to be what the anchor was set to.
 */
const FLOOR_SNAP_MM = 20;
const FLOOR_SNAP_SHARE = 0.05;
/**
 * Stands a product on its face once the picture has decided which way it looks: the side that
 * meets a wall touches the wall's inner face (nothing inside the wall, nothing floating off it), a
 * product on a side wall stands centred on its place along the wall, one on the floor centred on
 * its place and on the floor. Its height on a wall and its place across the back wall are the
 * anchor's, as in the 2D editor. `gap` keeps a flat photo a hair off the back wall. Returns whether
 * it then reaches beyond the room.
 */
function seatProduct(product: Group, room: RoomDimensions, face: RoomFace, gap: number): boolean {
  const box = visibleBounds(product);
  if (box.isEmpty()) return false;
  const wall = room.widthMm / 2;
  const move = new Vector3();
  if (face === 'left') move.x = -wall - box.min.x;
  else if (face === 'right') move.x = wall - box.max.x;
  else if (face === 'back') move.z = gap - box.min.z;
  if (face === 'left' || face === 'right' || face === 'floor')
    move.z = product.position.z - (box.min.z + box.max.z) / 2;
  if (face === 'floor') {
    const snap = Math.max(FLOOR_SNAP_MM, (box.max.y - box.min.y) * FLOOR_SNAP_SHARE);
    if (Math.abs(box.min.y) <= snap) move.y = -box.min.y;
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
          // 위 and 아래 are not used from the four sides; the selected photo is, whatever its name.
          if (index !== fixture.viewIndex && photoViewAngle(view) === undefined) continue;
          try {
            const image = await cache.image(view.assetId);
            const own = index === fixture.viewIndex;
            const bounds = own ? p.contentBounds : image.bounds,
              aspect = own ? p.imageAspect : image.aspect;
            const size = photoPlaneSize(p, material.depthMm, nameOf(view), bounds, aspect);
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
            plane.visible = own;
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
        // Standing on its face is decided per side (the plane turns to the camera, so its extent
        // along the wall changes); the first stand is the front's, as in 2D.
        const target = product,
          base = product.position.clone(),
          gap = p.face === 'back' ? 1 : 0;
        const stands = new Map<string, Vector3>();
        const standAt = (index: number, quarter: number) => {
          for (const [i, plane] of planes) {
            plane.visible = i === index;
            plane.rotation.y = (quarter * Math.PI) / 180;
          }
          const key = `${index}:${quarter}`;
          let place = stands.get(key);
          let beyond = false;
          if (!place) {
            target.position.copy(base);
            beyond = seatProduct(target, room, p.face, gap);
            place = target.position.clone();
            stands.set(key, place);
          } else target.position.copy(place);
          target.updateMatrixWorld(true);
          return beyond;
        };
        reachesBeyond = standAt(fixture.viewIndex, 0);
        const look = new Quaternion();
        update.push((camera) => {
          const quarter = snapQuarter(cameraQuarterAzimuth(camera.getWorldQuaternion(look)));
          const photo = choosePhotoForView(directions, fixture.viewIndex, quarter, new Set(planes.keys()));
          standAt(planes.has(photo.index) ? photo.index : fixture.viewIndex, quarter);
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
            '왼쪽·오른쪽 사진은 제품의 깊이로 그려야 하는데 자재에 깊이가 없어 가로 값으로 그렸어요. 자재에 깊이를 등록해 주세요.',
          );
      }
      if (!fixture.reconstruction) {
        if (reachesBeyond)
          notice(fixture, '제품이 방 밖으로 나가요. 위치나 크기, 각도 방향을 확인해 주세요.');
        else {
          const direction = readProductDirection(
            materials[fixture.materialVersionId]?.views[fixture.viewIndex]?.direction,
          ).name;
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
