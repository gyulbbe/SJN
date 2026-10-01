import { describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { Box3, Matrix4, Mesh, PerspectiveCamera, Quaternion, Texture, Vector3 } from 'three';
import { DEFAULT_ROOM } from '../src/lib/room-geometry';
import {
  DEFAULT_COLOR,
  EMPTY_MASK,
  type FixtureInstance,
  type MaterialVersion,
  type Scene,
} from '../src/lib/types';
import {
  buildViewerFixtures,
  chooseDirectionalPhoto,
  createSavedProductGeometry,
  declaredProductDirection,
  ProductAssetCache,
} from '../src/lib/room-viewer/fixtures';
import { encodeProductMesh, makeProductMeshAsset } from '../src/lib/product3d/codec';
import { createDefaultPose } from '../src/lib/product3d/pose';
import { poseDirection, poseForDirection } from '../src/lib/product3d/direction-pose';
import type { ProductDirection } from '../src/lib/product-direction';
import { roomPlacementSchema } from '../src/lib/room-validation';
import type { Product3dReference, ProductMesh } from '../src/lib/product3d/state-types';

function fixture(): FixtureInstance {
  return {
    id: 'f',
    name: '제품',
    materialVersionId: 'm',
    viewIndex: 0,
    position: { x: 0.5, y: 0.5 },
    width: 0.2,
    height: 0.3,
    rotation: 0,
    anchor: { x: 0.5, y: 1 },
    locked: false,
    shadow: { x: 0, y: 0, opacity: 0, blur: 0, scale: 1 },
    occlusion: EMPTY_MASK(),
    color: { ...DEFAULT_COLOR },
    roomPlacement: {
      face: 'floor',
      u: 0.5,
      v: 0.5,
      widthMm: 400,
      heightMm: 800,
      scale: 1,
      imageAspect: 0.5,
      contentBounds: { left: 0, top: 0, right: 1, bottom: 1 },
    },
  };
}
function scene(fixtures = [fixture()]): Scene {
  return {
    room: { ...DEFAULT_ROOM },
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
function material(): MaterialVersion {
  return {
    id: 'm',
    materialId: 'catalog',
    version: 1,
    name: '제품',
    brand: '',
    code: '',
    category: 'basin',
    scope: 'personal',
    description: '',
    color: '',
    finish: '',
    widthMm: 400,
    heightMm: 800,
    depthMm: 200,
    usage: 'both',
    installation: 'floor',
    textureAssetIds: [],
    views: [{ assetId: 'photo', direction: '정면', anchor: { x: 0.5, y: 1 } }],
    defaultGroutWidth: 0,
    defaultGroutColor: '#fff',
    defaultPattern: 'grid',
    createdAt: 'test',
  };
}
/**
 * A box in TripoSR coordinates (+z up, photographed from +x): 1 deep (x), 2 wide (y), 4 tall (z).
 * Placed in a room it is 2 wide (x), 4 tall (y) and 1 deep (z), before the fit to its envelope.
 */
function cube(): ProductMesh {
  return {
    positions: new Float32Array([
      -0.5, -1, -2, -0.5, 1, -2, -0.5, 1, 2, -0.5, -1, 2, 0.5, -1, -2, 0.5, 1, -2, 0.5, 1, 2, 0.5, -1, 2,
    ]),
    colors: new Float32Array(24).fill(0.5),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 3, 2, 6, 3, 6, 7]),
  };
}
/**
 * The 360° editor's camera: on the side `azimuth` degrees from the photographed one (+y positive),
 * `elevation` degrees above the horizon, turned `roll` degrees about its view axis. The default
 * pose is `cameraAt(0, 10)`.
 */
function cameraAt(azimuth: number, elevation = 0, roll = 0) {
  const rad = (degrees: number) => (degrees * Math.PI) / 180;
  const eye = new Vector3(
    Math.cos(rad(elevation)) * Math.cos(rad(azimuth)),
    Math.cos(rad(elevation)) * Math.sin(rad(azimuth)),
    Math.sin(rad(elevation)),
  );
  const q = new Quaternion().setFromRotationMatrix(
    new Matrix4().lookAt(eye, new Vector3(), new Vector3(0, 0, 1)),
  );
  return q
    .multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), rad(roll)))
    .toArray() as Product3dReference['pose']['cameraQuaternion'];
}
const reference = (): Product3dReference => ({
  version: 1,
  meshAssetId: 'mesh',
  inputAssetId: 'input',
  modelId: 'stored-model',
  modelRevision: 'stored-revision',
  pose: { objectQuaternion: [0, 0, 0, 1], cameraQuaternion: cameraAt(0), zoom: 1 },
});
function fakeImage(cache: ProductAssetCache) {
  return vi.spyOn(cache, 'image').mockImplementation(async () => ({
    texture: new Texture(),
    bounds: { left: 0, top: 0, right: 1, bottom: 1 },
    aspect: 0.5,
    canvas: { width: 100, height: 200 } as HTMLCanvasElement,
  }));
}

describe('room viewer immutable physical fixtures', () => {
  it('keeps wall basin height and physical dimensions without changing source references', async () => {
    const f = fixture();
    f.roomPlacement!.face = 'left';
    f.roomPlacement!.v = 0.8;
    f.reconstruction = {
      version: 2,
      kind: 'basin',
      color: '#abcabc',
      widthMm: 400,
      heightMm: 180,
      depthMm: 350,
      baseHeightMm: 650,
      basinVariant: 'wall',
      basinShape: 'rectangular',
    };
    // Existing standard pass takes physical W/H snapshots from placement.
    f.roomPlacement!.heightMm = 180;
    const value = scene([f]),
      original = structuredClone(value),
      reader = vi.fn(async () => undefined);
    const result = await buildViewerFixtures(value, {}, reader);
    const box = new Box3().setFromObject(result.group);
    expect(box.min.x).toBeCloseTo(-1200, 3);
    expect(box.min.y).toBeCloseTo(650, 3);
    expect(box.max.y).toBeCloseTo(830, 3);
    expect(box.max.x).toBeCloseTo(-850, 3);
    expect(value).toEqual(original);
    expect(reader).not.toHaveBeenCalled();
    expect(result.notices).toEqual([]);
    const camera = new PerspectiveCamera();
    camera.position.set(3000, 5000, 0);
    result.updateView(camera);
    expect(value).toEqual(original);
    result.dispose();
    result.dispose();
    expect(result.group.children).toHaveLength(0);
  });
  it('keeps neutral mirrors and transparent glass as actual independent depth geometry', async () => {
    const mirror = fixture();
    mirror.id = 'mirror';
    mirror.reconstruction = {
      version: 2,
      kind: 'mirrorCabinet',
      color: '#eee',
      widthMm: 400,
      heightMm: 800,
      depthMm: 150,
      doorCount: 2,
      appearanceAssetId: 'old-reflection',
    };
    mirror.roomPlacement!.face = 'back';
    mirror.roomPlacement!.v = 0.5;
    mirror.anchor.y = 0.5;
    const glass = fixture();
    glass.id = 'glass';
    glass.reconstruction = {
      version: 2,
      kind: 'glassPartition',
      color: '#fff',
      widthMm: 400,
      heightMm: 800,
      depthMm: 8,
      opacity: 0.2,
    };
    const reader = vi.fn(async () => undefined),
      result = await buildViewerFixtures(scene([mirror, glass]), {}, reader);
    expect(result.group.children).toHaveLength(2);
    expect(reader).not.toHaveBeenCalled();
    expect(result.notices.some((n) => n.message.includes('원사진 반사'))).toBe(true);
    const materials: { transparent: boolean; opacity: number; depthWrite: boolean }[] = [];
    result.group.children[1].traverse((node) => {
      if (node instanceof Mesh)
        for (const m of Array.isArray(node.material) ? node.material : [node.material]) materials.push(m);
    });
    expect(materials.some((m) => m.transparent && m.opacity < 1)).toBe(true);
    result.dispose();
  });
  it.each([
    'missing',
    'invalid-scale',
    'invalid-position',
    'invalid-size',
    'invalid-base',
    'invalid-kind',
  ] as const)('reports %s instead of silently accepting an empty reconstruction', async (mode) => {
    const f = fixture();
    f.reconstruction = {
      version: 2,
      kind: 'toilet',
      color: '#fff',
      widthMm: 400,
      heightMm: 800,
      depthMm: 600,
    };
    if (mode === 'missing') delete f.roomPlacement;
    if (mode === 'invalid-scale') f.roomPlacement!.scale = NaN;
    if (mode === 'invalid-position') f.roomPlacement!.v = 1.5;
    if (mode === 'invalid-size') f.reconstruction.depthMm = Infinity;
    if (mode === 'invalid-base') f.reconstruction.baseHeightMm = NaN;
    if (mode === 'invalid-kind') f.reconstruction.kind = 'unknown';
    const result = await buildViewerFixtures(scene([f]), {}, async () => undefined);
    expect(result.group.children).toHaveLength(0);
    expect(result.notices).toHaveLength(1);
    expect(result.notices[0].severity).toBe('error');
    result.dispose();
  });
  it.each(['exposure', 'contrast', 'saturation', 'warmth'] as const)(
    'rejects nonfinite %s for only the broken fixture and preserves the source',
    async (field) => {
      const good = fixture();
      good.id = 'good';
      good.reconstruction = {
        version: 2,
        kind: 'toilet',
        color: '#fff',
        widthMm: 400,
        heightMm: 800,
        depthMm: 600,
      };
      const bad = structuredClone(good);
      bad.id = 'bad';
      bad.color[field] = NaN;
      const value = scene([good, bad]),
        original = structuredClone(value),
        result = await buildViewerFixtures(value, {}, async () => undefined);
      expect(result.group.children.map((f) => f.userData.fixtureId)).toEqual(['good']);
      expect(result.notices.filter((n) => n.severity === 'error')).toEqual([
        {
          id: 'bad',
          name: bad.name,
          severity: 'error',
          message: '제품의 색감 보정 값이 올바르지 않아요. 기존 편집에서 확인해 주세요.',
        },
      ]);
      expect(value).toEqual(original);
      result.dispose();
    },
  );
  it('refuses a broken bath support link rather than relocating the glass', async () => {
    const f = fixture();
    f.reconstruction = {
      version: 2,
      kind: 'glassPartition',
      color: '#fff',
      widthMm: 400,
      heightMm: 800,
      depthMm: 8,
      baseHeightMm: 550,
      support: {
        kind: 'bath-rim',
        heightMm: 550,
        provenance: { kind: 'user', height: 'parent' },
        bathRim: {
          parentFixtureId: 'missing',
          side: 'left',
          offsetMm: 0,
          provenance: { parent: 'user', side: 'user', offset: 'user' },
        },
      },
    };
    const original = structuredClone(f),
      result = await buildViewerFixtures(scene([f]), {}, async () => undefined);
    expect(result.group.children).toHaveLength(0);
    expect(result.notices[0].severity).toBe('error');
    expect(f).toEqual(original);
    result.dispose();
  });
  it('resolves linked glass on the actual bath rim without editing the saved placement', async () => {
    const bath = fixture();
    bath.id = 'bath';
    bath.roomPlacement!.widthMm = 1600;
    bath.roomPlacement!.heightMm = 600;
    bath.reconstruction = {
      version: 2,
      kind: 'bath',
      color: '#eee',
      widthMm: 1600,
      heightMm: 600,
      depthMm: 800,
      baseHeightMm: 0,
      yawDegrees: 0,
    };
    const glass = fixture();
    glass.id = 'glass';
    glass.roomPlacement!.widthMm = 600;
    glass.roomPlacement!.heightMm = 1500;
    glass.reconstruction = {
      version: 2,
      kind: 'glassPartition',
      color: '#cde',
      widthMm: 600,
      heightMm: 1500,
      depthMm: 8,
      baseHeightMm: 600,
      yawDegrees: 0,
      support: {
        kind: 'bath-rim',
        heightMm: 600,
        provenance: { kind: 'user', height: 'parent' },
        bathRim: {
          parentFixtureId: 'bath',
          side: 'front',
          offsetMm: 0,
          provenance: { parent: 'user', side: 'user', offset: 'user' },
        },
      },
    };
    const value = scene([bath, glass]),
      original = structuredClone(value),
      result = await buildViewerFixtures(value, {}, async () => undefined);
    expect(result.notices.filter((n) => n.severity === 'error')).toEqual([]);
    expect(result.group.children).toHaveLength(2);
    const rim = result.group.children[0].getObjectByName('bath-rim-front')!,
      rimBounds = new Box3().setFromObject(rim),
      glassBounds = new Box3().setFromObject(result.group.children[1]);
    expect(glassBounds.min.y).toBeCloseTo(rimBounds.max.y, 2);
    expect(glassBounds.getCenter(new Vector3()).z).toBeCloseTo(rimBounds.getCenter(new Vector3()).z, 2);
    expect(value).toEqual(original);
    result.dispose();
  });
  it('loads and shares an immutable saved mesh once, without reading its PNG or invoking AI', async () => {
    const mesh = await makeProductMeshAsset(cube(), 'mesh', 'input');
    const reader = vi.fn(async () => mesh),
      cache = new ProductAssetCache(reader);
    const m = material();
    m.views[0].product3d = reference();
    const value = scene(),
      original = structuredClone(value);
    const a = await buildViewerFixtures(value, { m }, reader, cache),
      b = await buildViewerFixtures(value, { m }, reader, cache);
    expect(reader).toHaveBeenCalledTimes(1);
    expect(reader).toHaveBeenCalledWith('mesh');
    expect(a.group.children[0].userData.representation).toBe('saved-product-mesh');
    const box = new Box3().setFromObject(a.group);
    expect(box.min.y).toBeCloseTo(0);
    expect(box.getSize(new Vector3()).toArray()).toEqual([400, 800, 200]);
    expect(value).toEqual(original);
    a.dispose();
    expect(cache.diagnostics.meshes).toBe(1);
    b.dispose();
    cache.dispose();
    expect(cache.diagnostics.assets).toBe(0);
    expect(cache.diagnostics.meshes).toBe(0);
  });
  it('applies inverse captured camera and object rotation once, ignoring inspection zoom', () => {
    const f = fixture(),
      m = cube(),
      r = reference();
    // The camera stands on the product's right side and the product was turned a quarter turn about
    // its up axis to face it: as seen, the product faces the viewer again.
    r.pose.cameraQuaternion = cameraAt(90);
    r.pose.objectQuaternion = new Quaternion()
      .setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2)
      .toArray() as Product3dReference['pose']['objectQuaternion'];
    r.pose.zoom = 3;
    const g = createSavedProductGeometry(m, r, f);
    const size = g.boundingBox!.getSize(new Vector3());
    expect(size.toArray().map((v) => Math.round(v * 1e6) / 1e6)).toEqual([400, 800, 200]);
    expect(m.positions[0]).toBe(-0.5);
    g.dispose();
  });
  describe('stands the product level, however the 360° editor looked at it', () => {
    const placed = (pose: Product3dReference['pose']) => {
      const g = createSavedProductGeometry(cube(), { ...reference(), pose }, fixture());
      const p = g.getAttribute('position');
      const corners = Array.from({ length: p.count }, (_, i) => new Vector3(p.getX(i), p.getY(i), p.getZ(i)));
      g.dispose();
      return corners;
    };
    // Corners 0–3 are the back face of the TripoSR box (mesh x −0.5), 4–7 the photographed front.
    it('does not lean it by the default camera looking down 10° (base and top stay horizontal)', () => {
      const corners = placed(createDefaultPose());
      const bottom = [corners[0], corners[1], corners[4], corners[5]],
        top = [corners[2], corners[3], corners[6], corners[7]];
      for (const corner of bottom) expect(corner.y).toBeCloseTo(0, 6);
      for (const corner of top) expect(corner.y).toBeCloseTo(800, 6);
      // The photographed face is upright: its four corners share one depth.
      for (const corner of corners.slice(4)) expect(corner.z).toBeCloseTo(corners[4].z, 6);
      expect(corners[4].z).toBeGreaterThan(corners[0].z);
    });
    it('gives the same product from any look-down angle, including straight above', () => {
      const level = placed({ ...createDefaultPose(), cameraQuaternion: cameraAt(0, 0) });
      for (const elevation of [10, 45, 80, -30]) {
        const other = placed({ ...createDefaultPose(), cameraQuaternion: cameraAt(0, elevation) });
        other.forEach((corner, i) => expect(corner.distanceTo(level[i])).toBeLessThan(1e-3));
      }
    });
    it('keeps the side of the product the camera stood on, and the roll it had', () => {
      // From the product's right side the photographed face turns 90° away from the viewer.
      const right = placed({ ...createDefaultPose(), cameraQuaternion: cameraAt(90, 10) });
      const faceX = right.slice(4).map((c) => c.x);
      expect(Math.max(...faceX) - Math.min(...faceX)).toBeCloseTo(0, 6);
      // A camera rolled 10° shows the product leaning 10° in the picture, and so does the room.
      const rolled = placed({ ...createDefaultPose(), cameraQuaternion: cameraAt(0, 10, 10) });
      const lean = (corners: Vector3[]) =>
        (Math.atan2(corners[6].x - corners[5].x, corners[6].y - corners[5].y) * 180) / Math.PI;
      expect(Math.abs(lean(rolled))).toBeCloseTo(10, 4);
      expect(Math.abs(lean(placed(createDefaultPose())))).toBeCloseTo(0, 6);
    });
  });
  it('uses visible alpha bounds and selected anchor, not the full transparent PNG as the physical box', () => {
    const f = fixture();
    f.roomPlacement!.contentBounds = { left: 0.1, right: 0.9, top: 0.1, bottom: 0.9 };
    f.anchor = { x: 0.5, y: 0.9 };
    const g = createSavedProductGeometry(cube(), reference(), f);
    expect(g.boundingBox!.min.y).toBeCloseTo(0);
    expect(g.boundingBox!.max.y).toBeCloseTo(800);
    expect(g.boundingBox!.min.x).toBeCloseTo(-200);
    g.dispose();
  });
  it('shows a view saved with lighting correction as lit base colours, and older views unchanged', async () => {
    const shadedCube = cube();
    shadedCube.colors = new Float32Array(24).map((_, i) => 0.35 + (Math.floor(i / 3) % 4) * 0.18);
    // Distinct vertex colours (a neutral grey's channels may differ in the fourth decimal).
    const unique = (g: ReturnType<typeof createSavedProductGeometry>) => {
      const colors = g.getAttribute('color').array as Float32Array;
      const seen = new Set<string>();
      for (let i = 0; i < colors.length; i += 3)
        seen.add([colors[i], colors[i + 1], colors[i + 2]].map((c) => c.toFixed(3)).join());
      return seen.size;
    };
    const baked = createSavedProductGeometry(shadedCube, reference(), fixture());
    const lit = createSavedProductGeometry(shadedCube, { ...reference(), shading: 'lit' }, fixture());
    expect(unique(baked)).toBeGreaterThan(1);
    expect(unique(lit)).toBe(1);
    baked.dispose();
    lit.dispose();
    const f = fixture();
    const m = material();
    m.views[0].product3d = { ...reference(), shading: 'lit' };
    const mesh = await makeProductMeshAsset(shadedCube, 'mesh', 'input');
    const result = await buildViewerFixtures(scene([f]), { m }, async () => mesh);
    const kinds = new Set<string>();
    result.group.traverse((node) => {
      if (node instanceof Mesh) kinds.add((node.material as { type: string }).type);
    });
    expect(kinds).toEqual(new Set(['MeshStandardMaterial']));
  });
  it('stands a saved mesh on its wall by the way its pose faces: side against the wall for 정면, back against it for 오른쪽', async () => {
    const build = async (face: 'left' | 'right' | 'back', name: ProductDirection) => {
      const f = fixture();
      f.roomPlacement!.face = face;
      f.roomPlacement!.v = 0.5;
      f.anchor.y = 0.5;
      const m = material();
      m.views[0].product3d = { ...reference(), pose: poseForDirection(createDefaultPose(), name) };
      m.views[0].direction = name;
      const mesh = await makeProductMeshAsset(cube(), 'mesh', 'input');
      const result = await buildViewerFixtures(scene([f]), { m }, async () => mesh);
      const box = new Box3().setFromObject(result.group, true);
      result.dispose();
      return box;
    };
    // The pose faces the front (a front photo): 400 wide across the room, its side on the left wall,
    // centred on its place along the wall (z 1200), as high as the anchor says.
    const front = await build('left', '정면');
    expect(front.min.x).toBeCloseTo(-1200, 4);
    expect(front.max.x).toBeCloseTo(-800, 4);
    expect(front.min.z).toBeCloseTo(1100, 4);
    expect(front.max.z).toBeCloseTo(1300, 4);
    expect((front.min.y + front.max.y) / 2).toBeCloseTo(1200, 4);
    // The pose faces right (a right photo): it looks into the room with its back on the wall.
    const right = await build('left', '오른쪽');
    expect(right.min.x).toBeCloseTo(-1200, 4);
    expect(right.max.x).toBeCloseTo(-1000, 4);
    expect(right.min.z).toBeCloseTo(1000, 4);
    expect(right.max.z).toBeCloseTo(1400, 4);
    // The right wall, mirrored: a left photo looks into the room.
    const left = await build('right', '왼쪽');
    expect(left.min.x).toBeCloseTo(1000, 4);
    expect(left.max.x).toBeCloseTo(1200, 4);
    // The back wall: a front photo has its back on it; x stays the anchor's.
    const back = await build('back', '정면');
    expect(back.min.z).toBeCloseTo(0, 4);
    expect(back.max.z).toBeCloseTo(200, 4);
    expect((back.min.x + back.max.x) / 2).toBeCloseTo(0, 4);
  });
  it('reports malformed saved mesh without an automatic replacement or data write', async () => {
    const m = material();
    m.views[0].product3d = reference();
    const mesh = await makeProductMeshAsset(cube(), 'mesh', 'input');
    mesh.blob = new Blob(['bad']);
    const result = await buildViewerFixtures(scene(), { m }, async () => mesh);
    expect(result.group.children).toHaveLength(0);
    expect(result.notices[0].severity).toBe('error');
    expect(result.notices[0].message).toContain('손상');
    result.dispose();
  });
  it('late asset completion after closing cannot revive the cache', async () => {
    let finish!: (value: Awaited<ReturnType<typeof makeProductMeshAsset>>) => void;
    const cache = new ProductAssetCache(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      ),
      task = cache.mesh('mesh');
    cache.dispose();
    finish(await makeProductMeshAsset(cube(), 'mesh', 'input'));
    await expect(task).rejects.toThrow('닫혔');
    expect(cache.diagnostics.pending).toBe(0);
    expect(cache.diagnostics.meshes).toBe(0);
  });
  it('keeps a single PNG physically fixed when camera turns and records its restriction', async () => {
    const reader = vi.fn(async () => undefined),
      cache = new ProductAssetCache(reader);
    fakeImage(cache);
    const result = await buildViewerFixtures(scene(), { m: material() }, reader, cache),
      object = result.group.children[0],
      before = (object.updateMatrix(), object.matrix.clone());
    const camera = new PerspectiveCamera();
    camera.position.set(4000, 1200, 1200);
    result.updateView(camera);
    expect(object.quaternion.toArray()).toEqual([0, 0, 0, 1]);
    expect(object.matrix.elements).toEqual(before.elements);
    expect(object.userData.representation).toBe('fixed-photo-plane');
    expect(result.notices[0].message).toContain('2D 제품');
    result.dispose();
    cache.dispose();
  });
  it('switches to the photo showing the product as that camera sees it, at the same install point', async () => {
    const reader = vi.fn(async () => undefined),
      cache = new ProductAssetCache(reader),
      images = fakeImage(cache),
      m = material();
    m.views.push(
      { assetId: 'side', direction: '오른쪽', anchor: { x: 0.5, y: 1 } },
      { assetId: 'top', direction: '위', anchor: { x: 0.5, y: 1 } },
    );
    const result = await buildViewerFixtures(scene(), { m }, reader, cache);
    expect(images).toHaveBeenCalledTimes(3);
    const camera = new PerspectiveCamera();
    // On the room's left (−x) the product that faces the front is seen facing right: the 오른쪽 photo.
    camera.position.set(-4000, 100, 1200);
    result.updateView(camera);
    const planes = result.group.children[0].children[0].children;
    expect(planes.map((plane) => plane.visible)).toEqual([false, true, false]);
    // That photo turns to face the camera that sees it so (−90 about y); the install point stays.
    expect(planes[1].rotation.y).toBeCloseTo(-Math.PI / 2, 9);
    expect(planes[0].rotation.y).toBe(0);
    expect(result.group.children[0].position.toArray()).toEqual([0, 0, 1200]);
    // From the right it would need a 왼쪽 photo: there is none, the front stays. From above too.
    camera.position.set(4000, 100, 1200);
    result.updateView(camera);
    expect(planes.map((plane) => plane.visible)).toEqual([true, false, false]);
    camera.position.set(0, 6000, 1200);
    result.updateView(camera);
    expect(planes.map((plane) => plane.visible)).toEqual([true, false, false]);
    result.dispose();
    cache.dispose();
  });
  it('reads the direction from the closed list of names (older names read, unknown ones as 정면)', () => {
    expect(declaredProductDirection('정면')).toBe(0);
    expect(declaredProductDirection('오른쪽')).toBe(90);
    expect(declaredProductDirection('왼쪽')).toBe(-90);
    expect(declaredProductDirection('뒤')).toBe(180);
    expect(declaredProductDirection('위')).toBeUndefined();
    expect(declaredProductDirection('오른쪽 측면')).toBe(90);
    expect(declaredProductDirection('왼쪽 사선')).toBe(-90);
    expect(declaredProductDirection('my 90 fancy')).toBe(0);
    const views = material().views;
    expect(chooseDirectionalPhoto(views, 0, 90, 0)).toBe(0);
  });
});

const actualMeshDirectory = 'test-results/front-alignment-toilet/photograph';
describe('previously saved actual TripoSR geometry (no new inference)', () => {
  it.skipIf(!existsSync(`${actualMeshDirectory}/mesh-positions.bin`))(
    'decodes the real toilet arrays and mounts their selected pose with finite bounds',
    async () => {
      const floats = (name: string) => {
        const b = readFileSync(`${actualMeshDirectory}/mesh-${name}.bin`);
        return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
      };
      const b = readFileSync(`${actualMeshDirectory}/mesh-indices.bin`),
        mesh = {
          positions: floats('positions'),
          colors: floats('colors'),
          indices: new Uint32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)),
        };
      expect(mesh.positions.length / 3).toBeGreaterThan(50000);
      expect(encodeProductMesh(mesh).size).toBeGreaterThan(1000000);
      const ref = reference();
      ref.pose = createDefaultPose();
      const g = createSavedProductGeometry(mesh, ref, fixture()),
        box = g.boundingBox!;
      expect([...box.min.toArray(), ...box.max.toArray()].every(Number.isFinite)).toBe(true);
      expect(box.min.y).toBeCloseTo(0, 3);
      expect(box.getSize(new Vector3()).x).toBeLessThanOrEqual(400.001);
      expect(box.getSize(new Vector3()).y).toBeLessThanOrEqual(800.001);
      g.dispose();
    },
  );
});

describe('angle names decide the way a product stands on its face', () => {
  const half = DEFAULT_ROOM.widthMm / 2;
  const placed = (face: 'left' | 'right' | 'back' | 'floor', u = 0.5) => {
    const f = fixture();
    f.roomPlacement!.face = face;
    f.roomPlacement!.u = u;
    f.roomPlacement!.v = 0.5;
    f.anchor.y = face === 'floor' ? 1 : 0.5;
    return f;
  };
  const meshBuild = async (f: FixtureInstance, name: ProductDirection = '정면') => {
    const m = material();
    m.views[0].direction = name;
    m.views[0].product3d = { ...reference(), pose: poseForDirection(createDefaultPose(), name) };
    const mesh = await makeProductMeshAsset(cube(), 'mesh', 'input');
    return buildViewerFixtures(scene([f]), { m }, async () => mesh);
  };
  const photoBuild = async (f: FixtureInstance, name: ProductDirection = '정면') => {
    const m = material();
    m.views[0].direction = name;
    const cache = new ProductAssetCache(async () => undefined);
    fakeImage(cache);
    return buildViewerFixtures(scene([f]), { m }, async () => undefined, cache);
  };
  const bounds = (group: Parameters<Box3['setFromObject']>[0]) => new Box3().setFromObject(group, true);

  it('no product is turned for its wall any more: every flat photo and mesh has rotation 0', async () => {
    for (const face of ['left', 'right', 'back', 'floor'] as const)
      for (const build of [meshBuild, photoBuild]) {
        const result = await build(placed(face));
        expect(result.group.children[0].rotation.y).toBe(0);
        result.dispose();
      }
  });

  it('a flat 정면 photo on the left wall stands facing the front with its edge on the wall', async () => {
    const result = await photoBuild(placed('left'), '정면');
    const b = bounds(result.group.children[0]);
    expect(b.min.x).toBeCloseTo(-half, 6);
    expect(b.getSize(new Vector3()).x).toBeCloseTo(400, 6);
    expect(b.getSize(new Vector3()).z).toBeCloseTo(0, 6);
    // Centred on its place along the wall (z 1200), as high as the anchor says.
    expect(b.min.z).toBeCloseTo(1200, 6);
    expect((b.min.y + b.max.y) / 2).toBeCloseTo(1200, 4);
    // 정면 does not suit the left wall: it says so, and says where the product looks.
    const note = result.notices.find(
      (n) => n.message.includes('각도 사진을 써요') || n.message.includes('각도 사진을 쓰며'),
    );
    expect(note?.message).toContain('‘정면’ 각도 사진');
    expect(note?.message).toContain('정면(열린 쪽)을 봐요');
    expect(note?.message).toContain('어울리는 각도가 아니에요');
    result.dispose();
  });

  it('a 오른쪽 photo on the left wall suits it: no warning, the same stand, looking into the room', async () => {
    const result = await photoBuild(placed('left'), '오른쪽');
    const b = bounds(result.group.children[0]);
    expect(b.min.x).toBeCloseTo(-half, 6);
    const note = result.notices.find((n) => n.message.includes('각도 사진을 쓰며'));
    expect(note?.message).toContain('방 안쪽을 봐요');
    expect(note?.message).not.toContain('어울리는 각도가 아니에요');
    result.dispose();
  });

  it('flat photos on the back wall and the floor stand as they always did', async () => {
    const back = await photoBuild(placed('back'), '정면');
    const wall = bounds(back.group.children[0]);
    expect(wall.min.z).toBeCloseTo(1, 6); // a hair off the wall, as before
    expect((wall.min.x + wall.max.x) / 2).toBeCloseTo(0, 6);
    back.dispose();
    const floor = await photoBuild(placed('floor'), '정면');
    const ground = bounds(floor.group.children[0]);
    expect(ground.min.y).toBeCloseTo(0, 6);
    expect(ground.min.z).toBeCloseTo(1200, 6);
    expect(floor.notices.some((n) => n.message.includes('어울리는 각도가 아니에요'))).toBe(false);
    floor.dispose();
  });

  it('name × wall: a mesh has its side or its back on the wall, never inside it, never off it', async () => {
    // 정면·뒤: 400 wide across the room, 200 deep; 오른쪽·왼쪽: 200 across, 400 along the wall.
    const across = { 정면: 400, 뒤: 400, 오른쪽: 200, 왼쪽: 200 } as const;
    for (const name of ['정면', '오른쪽', '왼쪽', '뒤'] as const) {
      const left = bounds((await meshBuild(placed('left'), name)).group);
      expect(left.min.x).toBeCloseTo(-half, 4);
      expect(left.getSize(new Vector3()).x).toBeCloseTo(across[name], 4);
      expect((left.min.z + left.max.z) / 2).toBeCloseTo(1200, 4);
      const right = bounds((await meshBuild(placed('right'), name)).group);
      expect(right.max.x).toBeCloseTo(half, 4);
      expect(right.getSize(new Vector3()).x).toBeCloseTo(across[name], 4);
      const back = bounds((await meshBuild(placed('back'), name)).group);
      expect(back.min.z).toBeCloseTo(0, 4);
      expect((back.min.x + back.max.x) / 2).toBeCloseTo(0, 4);
      expect(back.getSize(new Vector3()).x).toBeCloseTo(across[name], 4);
    }
  });

  it("a mesh stands on the floor: a small float or sink from its anchor is settled, a big one is the anchor's", async () => {
    const onFloor = await meshBuild(placed('floor'));
    const b = bounds(onFloor.group);
    expect(b.min.y).toBeCloseTo(0, 6);
    expect((b.min.z + b.max.z) / 2).toBeCloseTo(1200, 4);
    onFloor.dispose();
    // The anchor 10 mm above the product's foot (y 0.9875 of 800): floating 10 mm → on the floor.
    const slightly = placed('floor');
    slightly.anchor.y = 0.9875;
    const a = bounds((await meshBuild(slightly)).group);
    expect(a.min.y).toBeCloseTo(0, 6);
    // The anchor at the middle of the photo: half the product under the floor is what was asked.
    const middle = placed('floor');
    middle.anchor.y = 0.5;
    const c = bounds((await meshBuild(middle)).group);
    expect(c.min.y).toBeCloseTo(-400, 4);
  });

  it('says so when the product reaches beyond the room, and leaves the source alone', async () => {
    // At the very front of the left wall the product's 400 along the wall reach past the open front.
    const f = placed('left', 0);
    const value = scene([f]),
      original = structuredClone(value);
    const m = material();
    m.views[0].product3d = reference();
    const mesh = await makeProductMeshAsset(cube(), 'mesh', 'input');
    const result = await buildViewerFixtures(value, { m }, async () => mesh);
    expect(result.notices.some((n) => n.message.includes('방 밖'))).toBe(true);
    expect(value).toEqual(original);
    result.dispose();
  });

  it('an older saved project may carry facing "front": it is read, never used, and never written', async () => {
    const plain = await photoBuild(placed('left'), '오른쪽');
    const old = placed('left');
    old.roomPlacement!.facing = 'front';
    const legacy = await photoBuild(old, '오른쪽');
    expect(legacy.group.children[0].matrixWorld.toArray()).toEqual(
      plain.group.children[0].matrixWorld.toArray(),
    );
    expect(legacy.notices.map((n) => n.message)).toEqual(plain.notices.map((n) => n.message));
    // The schema still reads it, so an older document does not fail to open.
    expect(roomPlacementSchema.parse(old.roomPlacement).facing).toBe('front');
    expect(roomPlacementSchema.safeParse({ ...old.roomPlacement, facing: 'sideways' }).success).toBe(false);
    plain.dispose();
    legacy.dispose();
  });

  it('standard models and their orientation are untouched by the names', async () => {
    const f = placed('left');
    f.reconstruction = {
      version: 2,
      kind: 'basin',
      color: '#abcabc',
      widthMm: 400,
      heightMm: 180,
      depthMm: 350,
      baseHeightMm: 650,
      basinVariant: 'wall',
      basinShape: 'rectangular',
    };
    f.roomPlacement!.heightMm = 180;
    const result = await buildViewerFixtures(scene([f]), {}, async () => undefined);
    // Into the room from the left wall, as its own orientation says.
    expect(result.group.children[0].rotation.y).toBeCloseTo(Math.PI / 2, 9);
    result.dispose();
  });

  it('a default-pose 3D product faces the front exactly: the level camera has no look-down lean', () => {
    const pose = createDefaultPose();
    const direction = poseDirection(pose);
    expect(direction.angle).toBeCloseTo(0, 9);
    const faced = poseForDirection(pose, '오른쪽');
    expect(poseDirection(faced).angle).toBeCloseTo(90, 6);
  });
});
