import { vi } from 'vitest';
import { Box3, Mesh, Plane, Ray, Texture, Vector3 } from 'three';
import { createRoomCamera, DEFAULT_ROOM, roomFacePoint } from '../../src/lib/room-geometry';
import { buildViewerFixtures, ProductAssetCache } from '../../src/lib/room-viewer/fixtures';
import { reprojectRoomScene } from '../../src/lib/room-editing';
import { getPlacementViewIndex } from '../../src/lib/material-images';
import { RECONSTRUCTION_DEFAULTS, type ReconstructionKind } from '../../src/lib/reconstruction/types';
import type { FixtureInstance, MaterialVersion, Point, Scene } from '../../src/lib/types';
import type { ProductBounds, RoomDimensions } from '../../src/lib/room-types';
import { cameraOn, contactFixture, contactScene, type ContactPhoto } from './fixture-contact';

/**
 * How far a wall product's visible picture (or standard model) is from its wall, from the four sides
 * and in the 2D editor, in room millimetres (docs/wall-contact-results-20261024.md).
 */
export type WallSide = 'back' | 'left' | 'right';
export const WALLS: WallSide[] = ['back', 'left', 'right'];
export type WallCase = {
  name: string;
  category: MaterialVersion['category'];
  widthMm: number;
  heightMm: number;
  depthMm: number;
  installation: MaterialVersion['installation'];
  photos: ContactPhoto[];
};

/**
 * The user's shower photo (2026-10-24, a 정면 photo of a mixer, hose and hand shower): the visible part
 * is the middle 30% across, 35% transparent on each side. Its side photos are made for the test: the
 * set is 150 mm deep, so its profile is a narrow strip.
 */
const SHOWER_FRONT: ContactPhoto = {
  direction: '정면',
  bounds: { left: 0.345, top: 0.04, right: 0.63, bottom: 0.89 },
  aspect: 1,
  anchor: { x: 0.5, y: 0.5 },
};
const showerProfile = (direction: '왼쪽' | '오른쪽'): ContactPhoto => ({
  direction,
  // The back (the wall side) is on the image's right for 왼쪽 (it faces left), on the left for 오른쪽.
  bounds:
    direction === '왼쪽'
      ? { left: 0.5, top: 0.04, right: 0.63, bottom: 0.89 }
      : { left: 0.37, top: 0.04, right: 0.5, bottom: 0.89 },
  aspect: 1,
  anchor: { x: 0.5, y: 0.5 },
});
/** The local development wall basins (measured with sharp, alpha > 8), 560 × 560 × 440. */
const BASIN_FRONT: ContactPhoto = {
  direction: '정면',
  bounds: { left: 0.13, top: 0.196, right: 0.854, bottom: 0.778 },
  aspect: 1,
  anchor: { x: 0.507, y: 0.488 },
};

export const WALL_CASES: WallCase[] = [
  {
    name: '샤워 설비(정면 사진만, 기준점 가운데)',
    category: 'shower',
    widthMm: 330,
    heightMm: 1000,
    depthMm: 150,
    installation: 'wall',
    photos: [SHOWER_FRONT],
  },
  {
    name: '샤워 설비(정면 사진만, 기준점 슬라이드 바)',
    category: 'shower',
    widthMm: 330,
    heightMm: 1000,
    depthMm: 150,
    installation: 'wall',
    photos: [{ ...SHOWER_FRONT, anchor: { x: 0.62, y: 0.3 } }],
  },
  {
    name: '샤워 설비(네 방향 사진)',
    category: 'shower',
    widthMm: 330,
    heightMm: 1000,
    depthMm: 150,
    installation: 'wall',
    photos: [
      SHOWER_FRONT,
      showerProfile('왼쪽'),
      showerProfile('오른쪽'),
      { ...SHOWER_FRONT, direction: '뒤', bounds: { left: 0.37, top: 0.04, right: 0.655, bottom: 0.89 } },
    ],
  },
  {
    name: '벽걸이 세면대(정면 사진만)',
    category: 'basin',
    widthMm: 560,
    heightMm: 560,
    depthMm: 440,
    installation: 'wall',
    photos: [BASIN_FRONT],
  },
  {
    name: '벽걸이 세면대(정면 + AI 방향 사진)',
    category: 'basin',
    widthMm: 560,
    heightMm: 560,
    depthMm: 440,
    installation: 'wall',
    photos: [
      {
        ...BASIN_FRONT,
        bounds: { left: 0.083, top: 0.068, right: 0.917, bottom: 0.932 },
        anchor: { x: 0.5, y: 0.5 },
      },
      {
        direction: '오른쪽',
        bounds: { left: 0.168, top: 0.068, right: 0.832, bottom: 0.932 },
        aspect: 1,
        anchor: { x: 0.5, y: 0.5 },
      },
      {
        direction: '왼쪽',
        bounds: { left: 0.168, top: 0.068, right: 0.832, bottom: 0.932 },
        aspect: 1,
        anchor: { x: 0.5, y: 0.5 },
      },
      {
        direction: '뒤',
        bounds: { left: 0.083, top: 0.068, right: 0.917, bottom: 0.932 },
        aspect: 1,
        anchor: { x: 0.5, y: 0.5 },
      },
    ],
  },
  {
    name: '거울(여백 거의 없음)',
    category: 'mirror',
    widthMm: 600,
    heightMm: 800,
    depthMm: 30,
    installation: 'wall',
    photos: [
      {
        direction: '정면',
        bounds: { left: 0.01, top: 0.01, right: 0.99, bottom: 0.99 },
        aspect: 0.75,
        anchor: { x: 0.5, y: 0.5 },
      },
    ],
  },
];

/** The wall kinds of standard model (a shower curtain is a floor frame, not on a wall). */
export const WALL_MODEL_KINDS: ReconstructionKind[] = [
  'shower',
  'mirror',
  'mirrorCabinet',
  'wallShelf',
  'wallCabinet',
  'basin',
];

export function wallMaterial(c: WallCase): MaterialVersion {
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
    installation: c.installation,
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
/** A photo product on `wall` at u, v, with the photo the editor picks for that wall. */
export function wallFixture(c: WallCase, wall: WallSide, u = 0.3, v = 0.4): FixtureInstance {
  const viewIndex = getPlacementViewIndex(wallMaterial(c), wall).index;
  const photo = c.photos[viewIndex];
  const fixture = contactFixture({ ...c, photos: [photo] }, u, v);
  fixture.viewIndex = viewIndex;
  fixture.anchor = { ...photo.anchor };
  fixture.roomPlacement!.face = wall;
  return fixture;
}
/** A standard model of `kind` on `wall` (its usual size), its lower edge at `baseHeightMm`. */
export function wallModel(kind: ReconstructionKind, wall: WallSide, u = 0.3): FixtureInstance {
  const d = RECONSTRUCTION_DEFAULTS[kind];
  const base = d.baseHeightMm ?? 1000;
  const fixture = contactFixture(
    {
      name: kind,
      category: 'basin',
      widthMm: d.widthMm,
      heightMm: d.heightMm,
      depthMm: d.depthMm,
      photos: [SHOWER_FRONT],
    },
    u,
    1 - base / DEFAULT_ROOM.heightMm,
  );
  fixture.roomPlacement!.face = wall;
  fixture.reconstruction = {
    ...d,
    version: 2,
    kind,
    color: d.color,
    widthMm: d.widthMm,
    heightMm: d.heightMm,
    depthMm: d.depthMm,
    baseHeightMm: base,
    yawDegrees: 0,
  };
  return fixture;
}
export { contactScene as wallScene };

/** Distance (mm) of a world point from the inner face of `wall`, + into the room. */
export function fromWall(room: RoomDimensions, wall: WallSide, p: Vector3) {
  return wall === 'back' ? p.z : wall === 'left' ? p.x + room.widthMm / 2 : room.widthMm / 2 - p.x;
}
export type WallGap = {
  quarter: number;
  direction?: string;
  /** The visible picture's (or model's) nearest and farthest points from the wall (mm, + into the room). */
  nearMm: number;
  farMm: number;
};
const QUARTERS = [0, 90, 180, -90];

/** The opaque corners of a photo plane in world space. */
function contentCorners(plane: Mesh, bounds: ProductBounds) {
  plane.geometry.computeBoundingBox();
  const local = plane.geometry.boundingBox!;
  const w = local.max.x - local.min.x,
    h = local.max.y - local.min.y;
  return [bounds.left, bounds.right].flatMap((x) =>
    [bounds.top, bounds.bottom].map((y) =>
      new Vector3(local.min.x + x * w, local.max.y - y * h, local.min.z).applyMatrix4(plane.matrixWorld),
    ),
  );
}

/** Builds the scene as the 3D room does and measures its first fixture from the four sides. */
export async function measureWall3d(
  scene: Scene,
  material: MaterialVersion,
  photos: ContactPhoto[],
  wall: WallSide,
) {
  const cache = new ProductAssetCache(async () => undefined);
  vi.spyOn(cache, 'image').mockImplementation(async (id: string) => {
    const photo = photos[Number(id.split('-')[1])];
    return {
      texture: new Texture(),
      bounds: photo.bounds,
      aspect: photo.aspect,
      canvas: { width: 100, height: 100 } as HTMLCanvasElement,
    };
  });
  const result = await buildViewerFixtures(scene, { m: material }, async () => undefined, cache);
  const root = result.group.children[0];
  const fixture = scene.fixtures[0];
  const room = scene.room!;
  const sides: WallGap[] = [];
  for (const quarter of QUARTERS) {
    result.updateView(cameraOn(quarter));
    result.group.updateMatrixWorld(true);
    if (!root) break;
    if (root.userData.representation === 'standard-model') {
      const box = new Box3().setFromObject(root, true);
      const gaps = [box.min, box.max].map((p) => fromWall(room, wall, p));
      sides.push({ quarter, nearMm: Math.min(...gaps), farMm: Math.max(...gaps) });
      continue;
    }
    let plane: Mesh | undefined;
    root.traverse((node) => {
      if (node instanceof Mesh && node.visible && node.userData.viewIndex !== undefined) plane = node;
    });
    if (!plane) continue;
    const index = plane.userData.viewIndex as number;
    const bounds = index === fixture.viewIndex ? fixture.roomPlacement!.contentBounds : photos[index].bounds;
    const gaps = contentCorners(plane, bounds).map((p) => fromWall(room, wall, p));
    sides.push({
      quarter,
      direction: photos[index].direction,
      nearMm: Math.min(...gaps),
      farMm: Math.max(...gaps),
    });
  }
  const notices = result.notices.map((n) => n.message);
  result.dispose();
  cache.dispose();
  return { sides, notices };
}

/**
 * Draws the scene as the 2D editor does (the read migration on opening) and measures its first
 * fixture: the visible part of its picture on the canvas, put back in the room. A picture drawn on the
 * wall (`projectedQuad`) lies on the wall plane; one drawn as a screen rectangle stands upright at
 * the depth of its anchor's place.
 */
export function measureWall2d(scene: Scene, material: MaterialVersion, wall: WallSide) {
  reprojectRoomScene(scene, { m: material });
  const fixture = scene.fixtures[0];
  const room = scene.room!;
  const placement = fixture.roomPlacement!;
  const aspect = scene.imageWidth / scene.imageHeight;
  const camera = createRoomCamera(room, aspect);
  const b = placement.contentBounds;
  const corners: Point[] = [];
  for (const x of [b.left, b.right])
    for (const y of [b.top, b.bottom]) {
      if (fixture.projectedQuad) {
        // The quad is the whole picture: its corners are the image's corners, in order TL TR BR BL.
        const [tl, tr, br, bl] = fixture.projectedQuad;
        const top = { x: tl.x + (tr.x - tl.x) * x, y: tl.y + (tr.y - tl.y) * x };
        const bottom = { x: bl.x + (br.x - bl.x) * x, y: bl.y + (br.y - bl.y) * x };
        corners.push({ x: top.x + (bottom.x - top.x) * y, y: top.y + (bottom.y - top.y) * y });
      } else
        corners.push({
          x: fixture.position.x + (x - fixture.anchor.x) * fixture.width,
          y: fixture.position.y + (y - fixture.anchor.y) * fixture.height,
        });
    }
  const anchorAt = roomFacePoint(room, placement.face, placement.u, placement.v);
  // A picture drawn on the wall lies 1 mm in front of it (as the 3D room puts it).
  const inward = wall === 'back' ? new Vector3(0, 0, 1) : new Vector3(wall === 'left' ? 1 : -1, 0, 0);
  const surface = fixture.projectedQuad
    ? new Plane().setFromNormalAndCoplanarPoint(inward, anchorAt.clone().add(inward))
    : new Plane(new Vector3(0, 0, 1), -anchorAt.z);
  const gaps = corners.map((c) => {
    const towards = new Vector3(c.x * 2 - 1, 1 - c.y * 2, 0.5)
      .unproject(camera)
      .sub(camera.position)
      .normalize();
    const hit = new Ray(camera.position.clone(), towards).intersectPlane(surface, new Vector3());
    return hit ? fromWall(room, wall, hit) : NaN;
  });
  return {
    nearMm: Math.min(...gaps),
    farMm: Math.max(...gaps),
    onWall: !!fixture.projectedQuad,
  };
}
