import { vi } from 'vitest';
import { Box3, Mesh, PerspectiveCamera, Texture, Vector3, type Object3D } from 'three';
import { DEFAULT_ROOM } from '../../src/lib/room-geometry';
import { buildViewerFixtures, ProductAssetCache } from '../../src/lib/room-viewer/fixtures';
import { showAsStandardModel } from '../../src/lib/standard-model-view';
import {
  DEFAULT_COLOR,
  EMPTY_MASK,
  type FixtureInstance,
  type MaterialVersion,
  type Point,
  type Scene,
} from '../../src/lib/types';
import type { ProductBounds, RoomDefinition } from '../../src/lib/room-types';

/**
 * Where a floor product's visible picture (or standard model) meets the floor and the wall behind it,
 * from the four sides, in room millimetres (docs/size-order-and-contact-results-20261024.md).
 */

/** A product photo as the viewer reads it: what is opaque (alpha > 8), its aspect, and its anchor. */
export type ContactPhoto = {
  direction: string;
  bounds: ProductBounds;
  /** The lowest row with alpha > 128 (0–1 down); the bottom of `bounds` when not given. */
  solidBottom?: number;
  aspect: number;
  anchor: Point;
};
export type ContactCase = {
  name: string;
  category: MaterialVersion['category'];
  widthMm: number;
  heightMm: number;
  depthMm: number;
  photos: ContactPhoto[];
};

/**
 * Photos of the local development toilets (measured 2026-10-23 with sharp, alpha > 8). The 정면 photos
 * were registered with the default anchor 0.97 below their visible bottom; the AI direction photos'
 * anchors are their visible bottom.
 */
export const CONTACT_CASES: ContactCase[] = [
  {
    name: '곰 변기(정면 사진만, 기본 기준점)',
    category: 'toilet',
    widthMm: 370,
    heightMm: 660,
    depthMm: 640,
    photos: [
      {
        direction: '정면',
        bounds: { left: 0.272, top: 0.176, right: 0.686, bottom: 0.882 },
        aspect: 1,
        anchor: { x: 0.5, y: 0.97 },
      },
    ],
  },
  {
    name: '곰 변기 v2(정면 + AI 방향 사진)',
    category: 'toilet',
    widthMm: 370,
    heightMm: 660,
    depthMm: 640,
    photos: [
      {
        direction: '정면',
        bounds: { left: 0.272, top: 0.176, right: 0.686, bottom: 0.882 },
        aspect: 1,
        anchor: { x: 0.5, y: 0.97 },
      },
      {
        direction: '오른쪽',
        bounds: { left: 0.0996, top: 0.0684, right: 0.9004, bottom: 0.9316 },
        aspect: 1,
        anchor: { x: 0.5, y: 0.931 },
      },
      {
        direction: '왼쪽',
        bounds: { left: 0.0986, top: 0.0684, right: 0.9014, bottom: 0.9316 },
        aspect: 1,
        anchor: { x: 0.5, y: 0.931 },
      },
      {
        direction: '뒤',
        bounds: { left: 0.2461, top: 0.0684, right: 0.7539, bottom: 0.9316 },
        aspect: 1,
        anchor: { x: 0.5, y: 0.931 },
      },
    ],
  },
  {
    name: '스마트 변기(정면 + AI 방향 사진)',
    category: 'toilet',
    widthMm: 400,
    heightMm: 520,
    depthMm: 700,
    photos: [
      {
        direction: '정면',
        bounds: { left: 0.2219, top: 0.2406, right: 0.8625, bottom: 0.9219 },
        aspect: 1,
        anchor: { x: 0.5, y: 0.97 },
      },
      {
        direction: '오른쪽',
        bounds: { left: 0.0684, top: 0.1572, right: 0.9316, bottom: 0.8428 },
        aspect: 1,
        anchor: { x: 0.5, y: 0.842 },
      },
      {
        direction: '왼쪽',
        bounds: { left: 0.0684, top: 0.1641, right: 0.9316, bottom: 0.8359 },
        aspect: 1,
        anchor: { x: 0.5, y: 0.836 },
      },
      {
        direction: '뒤',
        bounds: { left: 0.1563, top: 0.0684, right: 0.8438, bottom: 0.9316 },
        aspect: 1,
        anchor: { x: 0.5, y: 0.931 },
      },
    ],
  },
  {
    // A cut-out whose soft ground shadow (alpha ≤ 128) reaches 4% below the product.
    name: '합성: 옅은 접지 그림자',
    category: 'toilet',
    widthMm: 380,
    heightMm: 700,
    depthMm: 650,
    photos: [
      {
        direction: '정면',
        bounds: { left: 0.2, top: 0.05, right: 0.8, bottom: 0.99 },
        solidBottom: 0.95,
        aspect: 0.75,
        anchor: { x: 0.5, y: 0.95 },
      },
    ],
  },
];

export function contactMaterial(c: ContactCase): MaterialVersion {
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
    depthMm: c.depthMm,
    usage: 'both',
    installation: 'floor',
    textureAssetIds: [],
    views: c.photos.map((photo, i) => ({
      assetId: 'photo-' + i,
      direction: photo.direction,
      anchor: photo.anchor,
    })),
    defaultGroutWidth: 0,
    defaultGroutColor: '#fff',
    defaultPattern: 'grid',
    createdAt: 'test',
  };
}
export function contactFixture(c: ContactCase, u = 0.5, v = 0.55): FixtureInstance {
  const photo = c.photos[0];
  return {
    id: 'f',
    name: c.name,
    materialVersionId: 'm',
    viewIndex: 0,
    position: { x: 0.5, y: 0.5 },
    width: 0.2,
    height: 0.3,
    rotation: 0,
    anchor: { ...photo.anchor },
    locked: false,
    shadow: { x: 0, y: 0, opacity: 0, blur: 0, scale: 1 },
    occlusion: EMPTY_MASK(),
    color: { ...DEFAULT_COLOR },
    roomPlacement: {
      face: 'floor',
      u,
      v,
      widthMm: c.widthMm,
      heightMm: c.heightMm,
      scale: 1,
      imageAspect: photo.aspect,
      contentBounds: { ...photo.bounds },
    },
  };
}
export function contactScene(fixtures: FixtureInstance[], room: RoomDefinition = { ...DEFAULT_ROOM }): Scene {
  return {
    room,
    originalAssetId: 'original',
    previewAssetId: 'preview',
    imageWidth: 1536,
    imageHeight: 1024,
    surfaces: [],
    fixtures,
    protection: EMPTY_MASK(),
    color: { ...DEFAULT_COLOR },
  };
}
/** A level camera on one of the four sides (0 the front, 90 the right, 180 the back, −90 the left). */
export function cameraOn(quarter: number) {
  const camera = new PerspectiveCamera();
  camera.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), (quarter * Math.PI) / 180);
  return camera;
}

export type SideContact = {
  quarter: number;
  direction?: string;
  /** Visible bottom above the floor (mm; + floats, − sinks), by alpha > 8 and alpha > 128. */
  floorMm: number;
  solidFloorMm: number;
  /** The visible picture's (or model's) nearest point to the back wall (mm from it). */
  backMm: number;
};
const QUARTERS = [0, 90, 180, -90];

/** The opaque part of a photo plane in world space: its four corners through the plane's matrix. */
function contentBox(plane: Mesh, bounds: ProductBounds, solidBottom: number) {
  plane.geometry.computeBoundingBox();
  const local = plane.geometry.boundingBox!;
  const w = local.max.x - local.min.x,
    h = local.max.y - local.min.y;
  const x0 = local.min.x + bounds.left * w,
    x1 = local.min.x + bounds.right * w;
  const yAt = (down: number) => local.max.y - down * h;
  const corners = (bottom: number) =>
    [x0, x1].flatMap((x) =>
      [yAt(bounds.top), yAt(bottom)].map((y) =>
        new Vector3(x, y, local.min.z).applyMatrix4(plane.matrixWorld),
      ),
    );
  return {
    all: new Box3().setFromPoints(corners(bounds.bottom)),
    solid: new Box3().setFromPoints(corners(solidBottom)),
  };
}

/** Builds the fixture as the viewer does and measures it from the four sides. */
export async function measureContact(
  scene: Scene,
  material: MaterialVersion,
  photos: ContactPhoto[],
): Promise<{ sides: SideContact[]; notices: string[]; root: Object3D | undefined }> {
  const cache = new ProductAssetCache(async () => undefined);
  vi.spyOn(cache, 'image').mockImplementation(async (id: string) => {
    const photo = photos[Number(id.split('-')[1])];
    return {
      texture: new Texture(),
      bounds: photo.bounds,
      aspect: photo.aspect,
      canvas: { width: 100, height: 100 } as HTMLCanvasElement,
      ...(photo.solidBottom !== undefined ? { solidBottom: photo.solidBottom } : {}),
    };
  });
  const result = await buildViewerFixtures(scene, { m: material }, async () => undefined, cache);
  const root = result.group.children[0];
  const fixture = scene.fixtures[0];
  const sides: SideContact[] = [];
  for (const quarter of QUARTERS) {
    result.updateView(cameraOn(quarter));
    result.group.updateMatrixWorld(true);
    if (!root) break;
    if (root.userData.representation === 'standard-model') {
      const box = new Box3().setFromObject(root, true);
      sides.push({ quarter, floorMm: box.min.y, solidFloorMm: box.min.y, backMm: box.min.z });
      continue;
    }
    let plane: Mesh | undefined;
    root.traverse((node) => {
      if (node instanceof Mesh && node.visible && node.userData.viewIndex !== undefined) plane = node;
    });
    if (!plane) continue;
    const index = plane.userData.viewIndex as number;
    const own = index === fixture.viewIndex;
    const photo = photos[index];
    const bounds = own ? fixture.roomPlacement!.contentBounds : photo.bounds;
    const box = contentBox(plane, bounds, Math.min(bounds.bottom, photo.solidBottom ?? bounds.bottom));
    sides.push({
      quarter,
      direction: photo.direction,
      floorMm: box.all.min.y,
      solidFloorMm: box.solid.min.y,
      backMm: box.all.min.z,
    });
  }
  const notices = result.notices.map((n) => n.message);
  result.dispose();
  cache.dispose();
  return { sides, notices, root };
}

/** The same case as a standard model (the switch "표준 모형으로 보기"). */
export function asStandardModel(scene: Scene, material: MaterialVersion) {
  showAsStandardModel(scene, scene.fixtures[0].id, material);
  return scene;
}
