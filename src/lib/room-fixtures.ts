import { Vector3 } from 'three';
import type { RoomDefinition, RoomFace, RoomPlacement, ProductBounds } from './room-types';
import type { AssetRecord, FixtureInstance, MaterialVersion, Point, Quad } from './types';
import { createRoomCamera, roomFacePoint } from './room-geometry';
import { homography, transformPoint } from './render/math';
import type { WallSide } from './room-wall-contact';
import { FLOOR_SNAP_MM, FLOOR_SNAP_SHARE } from './room-viewer/floor-contact';

const clamp = (n: number) => Math.max(0, Math.min(1, n));
const projections = new Map<string, ReturnType<typeof createRoomCamera>>();
function camera(room: RoomDefinition, aspect: number) {
  const key = `${room.version}:${room.widthMm}:${room.depthMm}:${room.heightMm}:${aspect}`;
  let result = projections.get(key);
  if (!result) {
    result = createRoomCamera(room, aspect);
    if (projections.size >= 12) projections.delete(projections.keys().next().value!);
    projections.set(key, result);
  }
  return result;
}
function project(room: RoomDefinition, world: Vector3, aspect: number): Point {
  const p = world.clone().project(camera(room, aspect));
  return { x: (p.x + 1) / 2, y: (1 - p.y) / 2 };
}
export function roomPositionFromPhoto(room: RoomDefinition, face: RoomFace, photo: Point, aspect: number) {
  const corners = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ].map(([u, v]) => project(room, roomFacePoint(room, face, u, v), aspect)) as Quad;
  const uv = transformPoint(homography(corners), photo);
  return { u: clamp(uv.x), v: clamp(uv.y) };
}

/** The whole picture in mm, as the 3D room sizes the photo shown (photoPlaneSize). */
function pictureMm(placement: RoomPlacement) {
  const b = placement.contentBounds;
  const width =
    Math.min(
      placement.widthMm / (b.right - b.left),
      (placement.heightMm * placement.imageAspect) / (b.bottom - b.top),
    ) * placement.scale;
  return { width, height: width / placement.imageAspect };
}
/**
 * How far the 2D drawing moves a floor photo up so what shows of it stands on its floor point
 * (a fraction of the canvas height; `height` is the fixture's drawn height). Zero for a wall
 * product, a standard model, and a photo whose anchor was set well above its bottom.
 */
export function floorShift(fixture: FixtureInstance, height = fixture.height): number {
  const placement = fixture.roomPlacement;
  if (!placement || placement.face !== 'floor' || fixture.reconstruction) return 0;
  const b = placement.contentBounds;
  const imageHeightMm = pictureMm(placement).height;
  // How far what shows ends below the anchor (negative: above it, floating).
  const below = (b.bottom - fixture.anchor.y) * height * Math.cos((fixture.rotation * Math.PI) / 180);
  const sinkMm = (b.bottom - fixture.anchor.y) * imageHeightMm;
  const snap = Math.max(FLOOR_SNAP_MM, (b.bottom - b.top) * imageHeightMm * FLOOR_SNAP_SHARE);
  return below < 0 || sinkMm <= snap ? below : 0;
}
/**
 * The product keeps its image aspect; its visible alpha bounds fit its physical W×H envelope. On the
 * floor what shows of it stands on the floor point, as in the 3D room (room-viewer/fixtures.ts): one
 * floating above it because of its anchor is put down, one sinking a little is lifted, one sinking
 * more is left as its anchor says. `wall` (a product kept against that wall, room-wall-contact.ts)
 * draws it on the wall as the 3D room does from the front.
 */
export function projectRoomFixture(
  room: RoomDefinition,
  fixture: FixtureInstance,
  aspect: number,
  wall?: WallSide,
): void {
  const placement = fixture.roomPlacement;
  if (!placement) return;
  const b = placement.contentBounds;
  const floorPhoto = placement.face === 'floor' && !fixture.reconstruction;
  const imageWidthMm = pictureMm(placement).width;
  const origin = roomFacePoint(room, placement.face, placement.u, placement.v);
  if (floorPhoto && wall === 'back') origin.z = 1;
  else if (floorPhoto && wall)
    origin.x =
      wall === 'left'
        ? -room.widthMm / 2 + 1 + (fixture.anchor.x - b.left) * imageWidthMm
        : room.widthMm / 2 - 1 - (b.right - fixture.anchor.x) * imageWidthMm;
  const p = project(room, origin, aspect);
  const right = project(
    room,
    origin.clone().add(new Vector3(placement.widthMm * placement.scale, 0, 0)),
    aspect,
  );
  const top = project(
    room,
    origin.clone().add(new Vector3(0, placement.heightMm * placement.scale, 0)),
    aspect,
  );
  const width = Math.min(
    Math.abs(right.x - p.x) / (b.right - b.left),
    (Math.abs(top.y - p.y) * placement.imageAspect) / (aspect * (b.bottom - b.top)),
  );
  const height = (width * aspect) / placement.imageAspect;
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0 ||
    width > 10 ||
    height > 10
  )
    throw new Error('제품이 공간에 비해 너무 커요. 등록 규격과 공간 크기를 확인해 주세요.');
  p.y -= floorShift(fixture, height);
  fixture.position = p;
  fixture.width = width;
  fixture.height = height;
}

const boundsCache = new Map<string, Promise<ProductBounds>>();
export function productContentBounds(asset: AssetRecord): Promise<ProductBounds> {
  if (asset.kind === 'product-mesh')
    return Promise.reject(new Error('제품 사진에는 이미지 자산이 필요해요.'));
  const cached = boundsCache.get(asset.id);
  if (cached) return cached;
  const task = (async () => {
    const bitmap = await createImageBitmap(asset.blob);
    try {
      // Read a bounded raster once per immutable asset, never on pointer movement.
      const factor = Math.min(1, 1024 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * factor));
      canvas.height = Math.max(1, Math.round(bitmap.height * factor));
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('제품 이미지 영역을 읽을 수 없어요.');
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      let left = canvas.width,
        top = canvas.height,
        right = 0,
        bottom = 0;
      for (let y = 0; y < canvas.height; y++)
        for (let x = 0; x < canvas.width; x++) {
          if (data[(y * canvas.width + x) * 4 + 3] <= 8) continue;
          left = Math.min(left, x);
          right = Math.max(right, x + 1);
          top = Math.min(top, y);
          bottom = Math.max(bottom, y + 1);
        }
      if (right <= left || bottom <= top)
        throw new Error('제품 이미지가 모두 투명해요. 제품이 보이는 이미지를 선택해 주세요.');
      return {
        left: left / canvas.width,
        top: top / canvas.height,
        right: right / canvas.width,
        bottom: bottom / canvas.height,
      };
    } finally {
      bitmap.close();
    }
  })();
  if (boundsCache.size >= 100) boundsCache.delete(boundsCache.keys().next().value!);
  boundsCache.set(asset.id, task);
  void task.catch(() => boundsCache.delete(asset.id));
  return task;
}
export async function createRoomPlacement(
  material: MaterialVersion,
  asset: AssetRecord,
  face: RoomFace,
): Promise<RoomPlacement> {
  if (asset.kind === 'product-mesh') throw new Error('제품 사진에는 이미지 자산이 필요해요.');
  return {
    face,
    u: 0.5,
    v: 0.55,
    scale: 1,
    widthMm: material.widthMm,
    heightMm: material.heightMm,
    imageAspect: asset.width / asset.height,
    contentBounds: { ...(await productContentBounds(asset)) },
  };
}
