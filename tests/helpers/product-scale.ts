import { vi } from 'vitest';
import { Box3, Mesh, Texture, Vector3 } from 'three';
import { DEFAULT_ROOM, projectRoomPoint, roomFacePoint } from '../../src/lib/room-geometry';
import { buildViewerFixtures, ProductAssetCache } from '../../src/lib/room-viewer/fixtures';
import { projectRoomFixture } from '../../src/lib/room-fixtures';
import { viewDirection } from '../../src/lib/product-direction';
import type { ProductBounds } from '../../src/lib/room-types';
import type { FixtureInstance, MaterialVersion, Scene } from '../../src/lib/types';
import {
  asStandardModel,
  cameraOn,
  contactScene,
  type ContactCase,
  type ContactPhoto,
} from './fixture-contact';

/**
 * How big a room product is drawn, in room millimetres, against its registered size
 * (docs/product-scale-results-20261024.md): what shows of its photo (alpha > 8, and > 128 for the
 * product itself) on the 3D room's photo plane and in the 2D editor's drawing.
 */

/** A photo with its opaque box at alpha > 128 as well (measured with sharp from the local photos). */
export type ScalePhoto = ContactPhoto & { solid: ProductBounds };
export type ScaleCase = Omit<ContactCase, 'photos'> & { photos: ScalePhoto[] };

const photo = (
  direction: string,
  anchorY: number,
  bounds: ProductBounds,
  solid: ProductBounds,
): ScalePhoto => ({ direction, bounds, solid, aspect: 1, anchor: { x: 0.5, y: anchorY } });
/**
 * The local development products (2026-10-24, sharp): 정면 photos a person uploaded (with a margin,
 * anchor left at the default 0.97), 오른쪽·왼쪽·뒤 made by the AI direction photos (1024 px).
 */
export const SCALE_CASES: ScaleCase[] = [
  {
    name: '곰 변기',
    category: 'toilet',
    widthMm: 370,
    heightMm: 660,
    depthMm: 640,
    photos: [
      photo(
        '정면',
        0.97,
        { left: 0.272, top: 0.176, right: 0.686, bottom: 0.882 },
        { left: 0.274, top: 0.178, right: 0.684, bottom: 0.88 },
      ),
      photo(
        '오른쪽',
        0.931,
        { left: 0.0996, top: 0.0684, right: 0.9004, bottom: 0.9316 },
        { left: 0.1006, top: 0.0693, right: 0.8994, bottom: 0.9307 },
      ),
      photo(
        '왼쪽',
        0.931,
        { left: 0.0986, top: 0.0684, right: 0.9014, bottom: 0.9316 },
        { left: 0.0996, top: 0.0693, right: 0.9004, bottom: 0.9307 },
      ),
      photo(
        '뒤',
        0.931,
        { left: 0.2461, top: 0.0684, right: 0.7539, bottom: 0.9316 },
        { left: 0.2461, top: 0.0693, right: 0.7539, bottom: 0.9307 },
      ),
    ],
  },
  {
    name: '스마트 변기',
    category: 'toilet',
    widthMm: 400,
    heightMm: 520,
    depthMm: 700,
    photos: [
      photo(
        '정면',
        0.97,
        { left: 0.2219, top: 0.2406, right: 0.8625, bottom: 0.9219 },
        { left: 0.225, top: 0.2437, right: 0.8594, bottom: 0.9187 },
      ),
      photo(
        '오른쪽',
        0.8421,
        { left: 0.0684, top: 0.1572, right: 0.9316, bottom: 0.8428 },
        { left: 0.0693, top: 0.1582, right: 0.9307, bottom: 0.8418 },
      ),
      photo(
        '왼쪽',
        0.8361,
        { left: 0.0684, top: 0.1641, right: 0.9316, bottom: 0.8359 },
        { left: 0.0693, top: 0.1641, right: 0.9307, bottom: 0.8359 },
      ),
      photo(
        '뒤',
        0.931,
        { left: 0.1563, top: 0.0684, right: 0.8438, bottom: 0.9316 },
        { left: 0.1572, top: 0.0693, right: 0.8428, bottom: 0.9307 },
      ),
    ],
  },
  {
    name: '사각 욕조',
    category: 'bath',
    widthMm: 1700,
    heightMm: 560,
    depthMm: 750,
    photos: [
      photo(
        '정면',
        0.97,
        { left: 0.0563, top: 0.2656, right: 0.9437, bottom: 0.8187 },
        { left: 0.0594, top: 0.2719, right: 0.9406, bottom: 0.8156 },
      ),
      photo(
        '오른쪽',
        0.931,
        { left: 0.084, top: 0.0684, right: 0.916, bottom: 0.9316 },
        { left: 0.084, top: 0.0693, right: 0.916, bottom: 0.9307 },
      ),
      photo(
        '왼쪽',
        0.931,
        { left: 0.1006, top: 0.0684, right: 0.8994, bottom: 0.9316 },
        { left: 0.1016, top: 0.0693, right: 0.8984, bottom: 0.9307 },
      ),
      photo(
        '뒤',
        0.6554,
        { left: 0.0684, top: 0.3447, right: 0.9316, bottom: 0.6553 },
        { left: 0.0693, top: 0.3447, right: 0.9307, bottom: 0.6553 },
      ),
    ],
  },
];

export function scaleMaterial(c: ScaleCase, depthMm = c.depthMm): MaterialVersion {
  return {
    id: 'm',
    materialId: 'catalog',
    version: 1,
    name: c.name,
    brand: '',
    code: '',
    category: c.category,
    scope: 'personal',
    description: '',
    color: '',
    finish: '',
    widthMm: c.widthMm,
    heightMm: c.heightMm,
    depthMm,
    usage: 'both',
    installation: 'floor',
    textureAssetIds: [],
    views: c.photos.map((p, i) => ({ assetId: 'photo-' + i, direction: p.direction, anchor: p.anchor })),
    defaultGroutWidth: 0,
    defaultGroutColor: '#fff',
    defaultPattern: 'grid',
    createdAt: 'test',
  };
}
/** The product placed on the floor with photo `viewIndex` chosen, as the editor places it. */
export function scaleFixture(c: ScaleCase, viewIndex = 0, u = 0.5, v = 0.55): FixtureInstance {
  const chosen = c.photos[viewIndex];
  return {
    id: 'f',
    name: c.name,
    materialVersionId: 'm',
    viewIndex,
    position: { x: 0.5, y: 0.5 },
    width: 0.2,
    height: 0.3,
    rotation: 0,
    anchor: { ...chosen.anchor },
    locked: false,
    shadow: { x: 0, y: 0, opacity: 0, blur: 0, scale: 1 },
    occlusion: { polygon: [], strokes: [] },
    color: { exposure: 0, contrast: 1, saturation: 1, warmth: 0 },
    roomPlacement: {
      face: 'floor',
      u,
      v,
      widthMm: c.widthMm,
      heightMm: c.heightMm,
      scale: 1,
      imageAspect: chosen.aspect,
      contentBounds: { ...chosen.bounds },
    },
  };
}

export type DrawnSize = {
  /** Which photo shows (or the standard model), from which side. */
  quarter?: number;
  direction: string;
  /**
   * What shows across (mm) and the product's real value: the width for 정면·뒤, the depth for 옆
   * (its real depth even when the material has none registered).
   */
  acrossMm: number;
  registeredAcrossMm: number;
  heightMm: number;
  registeredHeightMm: number;
  /** The same for the product itself (alpha > 128). */
  solidAcrossMm: number;
  solidHeightMm: number;
};
const side = (direction: string) => direction === '왼쪽' || direction === '오른쪽';

/** The 3D room from the four sides: what shows of the photo plane (or the model) in mm. */
export async function measure3d(c: ScaleCase, scene: Scene, material: MaterialVersion): Promise<DrawnSize[]> {
  const cache = new ProductAssetCache(async () => undefined);
  vi.spyOn(cache, 'image').mockImplementation(async (id: string) => {
    const p = c.photos[Number(id.split('-')[1])];
    return {
      texture: new Texture(),
      bounds: p.bounds,
      aspect: p.aspect,
      canvas: { width: 100, height: 100 } as HTMLCanvasElement,
      solidBottom: p.solid.bottom,
    };
  });
  const result = await buildViewerFixtures(scene, { m: material }, async () => undefined, cache);
  const root = result.group.children[0];
  const fixture = scene.fixtures[0];
  const out: DrawnSize[] = [];
  for (const quarter of [0, 90, 180, -90]) {
    result.updateView(cameraOn(quarter));
    result.group.updateMatrixWorld(true);
    if (!root) break;
    if (root.userData.representation === 'standard-model') {
      const box = new Box3();
      root.traverseVisible((node) => {
        if (node instanceof Mesh && !node.userData.groundShadow)
          box.union(new Box3().setFromObject(node, true));
      });
      const size = box.getSize(new Vector3());
      const across = quarter === 0 || quarter === 180 ? size.x : size.z;
      out.push({
        quarter,
        direction: '표준 모형',
        acrossMm: across,
        registeredAcrossMm: quarter === 0 || quarter === 180 ? c.widthMm : c.depthMm,
        heightMm: size.y,
        registeredHeightMm: c.heightMm,
        solidAcrossMm: across,
        solidHeightMm: size.y,
      });
      continue;
    }
    let plane: Mesh | undefined;
    root.traverse((node) => {
      if (node instanceof Mesh && node.visible && node.userData.viewIndex !== undefined) plane = node;
    });
    if (!plane) continue;
    const index = plane.userData.viewIndex as number;
    const p = c.photos[index];
    const bounds = index === fixture.viewIndex ? fixture.roomPlacement!.contentBounds : p.bounds;
    plane.geometry.computeBoundingBox();
    const local = plane.geometry.boundingBox!;
    const w = local.max.x - local.min.x,
      h = local.max.y - local.min.y;
    const direction = viewDirection(p.direction) ?? '정면';
    out.push({
      quarter,
      direction,
      acrossMm: (bounds.right - bounds.left) * w,
      registeredAcrossMm: side(direction) ? c.depthMm : c.widthMm,
      heightMm: (bounds.bottom - bounds.top) * h,
      registeredHeightMm: c.heightMm,
      solidAcrossMm: (p.solid.right - p.solid.left) * w,
      solidHeightMm: (p.solid.bottom - p.solid.top) * h,
    });
  }
  result.dispose();
  cache.dispose();
  return out;
}

/**
 * The 2D editor's drawing of the chosen photo, in mm: its drawn size against the room's width and
 * height at its floor point (as projectRoomFixture measures them).
 */
export function measure2d(c: ScaleCase, fixture: FixtureInstance): DrawnSize {
  const scene = contactScene([fixture]);
  const room = scene.room!;
  const aspect = scene.imageWidth / scene.imageHeight;
  projectRoomFixture(room, fixture, aspect);
  const p = fixture.roomPlacement!;
  const origin = roomFacePoint(room, p.face, p.u, p.v);
  const at = projectRoomPoint(room, origin, aspect);
  const pxPerMmX =
    Math.abs(projectRoomPoint(room, origin.clone().add(new Vector3(1000, 0, 0)), aspect).x - at.x) / 1000;
  const pxPerMmY =
    Math.abs(projectRoomPoint(room, origin.clone().add(new Vector3(0, 1000, 0)), aspect).y - at.y) / 1000;
  const chosen = c.photos[fixture.viewIndex];
  const b = p.contentBounds;
  const direction = viewDirection(chosen.direction) ?? '정면';
  return {
    direction,
    acrossMm: (fixture.width * (b.right - b.left)) / pxPerMmX,
    registeredAcrossMm: side(direction) ? c.depthMm : c.widthMm,
    heightMm: (fixture.height * (b.bottom - b.top)) / pxPerMmY,
    registeredHeightMm: c.heightMm,
    solidAcrossMm: (fixture.width * (chosen.solid.right - chosen.solid.left)) / pxPerMmX,
    solidHeightMm: (fixture.height * (chosen.solid.bottom - chosen.solid.top)) / pxPerMmY,
  };
}

export { asStandardModel, contactScene, DEFAULT_ROOM };
