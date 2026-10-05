import { describe, expect, it, vi } from 'vitest';
import { Box3, Mesh, PerspectiveCamera, Texture, Vector3 } from 'three';
import { DEFAULT_ROOM } from '../src/lib/room-geometry';
import {
  DEFAULT_COLOR,
  EMPTY_MASK,
  type AssetRecord,
  type FixtureInstance,
  type MaterialVersion,
  type Product3dReference,
  type Scene,
} from '../src/lib/types';
import {
  buildViewerFixtures,
  declaredProductDirection,
  photoPlaneSize,
  ProductAssetCache,
} from '../src/lib/room-viewer/fixtures';
import type { ProductDirection } from '../src/lib/product-direction';
import { roomPlacementSchema } from '../src/lib/room-validation';

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
/** What a material saved with the removed 360° editor still carries on a view (docs/product3d-removal.md). */
const reference = (): Product3dReference => ({
  version: 1,
  meshAssetId: 'mesh',
  inputAssetId: 'input',
  modelId: 'stored-model',
  modelRevision: 'stored-revision',
  pose: { objectQuaternion: [0, 0, 0, 1], cameraQuaternion: [0, 0, 0, 1], zoom: 1 },
});
/** A camera on one of the four sides (0 the front, 90 the right, 180 the back, −90 the left), level. */
function cameraOn(quarter: number) {
  const camera = new PerspectiveCamera();
  camera.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), (quarter * Math.PI) / 180);
  return camera;
}
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
  it('shows a view saved with the removed 360° editor as its flat capture and reads no mesh', async () => {
    const reader = vi.fn(async () => undefined),
      cache = new ProductAssetCache(reader),
      images = fakeImage(cache),
      assets = vi.spyOn(cache, 'asset'),
      m = material();
    m.views[0].product3d = reference();
    m.views.push({ assetId: 'side', direction: '오른쪽', anchor: { x: 0.5, y: 1 }, product3d: reference() });
    const value = scene(),
      original = structuredClone(value);
    const result = await buildViewerFixtures(value, { m }, reader, cache);
    // Only the pictures are read (the capture of each view): never the mesh or the input photo.
    expect(images.mock.calls.map(([id]) => id).sort()).toEqual(['photo', 'side']);
    expect(assets).not.toHaveBeenCalled();
    expect(reader).not.toHaveBeenCalled();
    const object = result.group.children[0];
    expect(object.userData.representation).toBe('directional-photo-planes');
    expect(result.notices.some((n) => n.severity === 'error')).toBe(false);
    expect(result.notices.some((n) => n.message.includes('저장된 입체'))).toBe(false);
    const front = new Box3().setFromObject(object.children[0].children[0]);
    expect(front.min.y).toBeCloseTo(0);
    expect(front.getSize(new Vector3()).toArray().map(Math.round)).toEqual([400, 800, 0]);
    // The older 오른쪽 view turns up for the side that sees the product facing right, like any photo.
    result.updateView(cameraOn(-90));
    expect(object.children[0].children.map((plane) => plane.visible)).toEqual([false, true]);
    expect(value).toEqual(original);
    expect(m.views[0].product3d).toEqual(reference());
    result.dispose();
    cache.dispose();
  });
  it('uses visible alpha bounds and the selected anchor, not the full transparent PNG, as the physical size', async () => {
    const f = fixture();
    f.roomPlacement!.contentBounds = { left: 0.1, right: 0.9, top: 0.1, bottom: 0.9 };
    f.anchor = { x: 0.5, y: 0.9 };
    const cache = new ProductAssetCache(async () => undefined);
    fakeImage(cache);
    const result = await buildViewerFixtures(scene([f]), { m: material() }, async () => undefined, cache);
    const box = new Box3().setFromObject(result.group, true);
    // The visible 80 % is 400 × 800, so the whole picture is 500 × 1000; the anchor (90 % down) is the foot.
    expect(box.getSize(new Vector3()).x).toBeCloseTo(500, 4);
    expect(box.getSize(new Vector3()).y).toBeCloseTo(1000, 4);
    expect(box.min.y).toBeCloseTo(-100, 4);
    expect(box.max.y).toBeCloseTo(900, 4);
    result.dispose();
    cache.dispose();
  });
  it('reports a product photo that cannot be read instead of drawing nothing quietly', async () => {
    const result = await buildViewerFixtures(scene(), { m: material() }, async () => undefined);
    expect(result.group.children).toHaveLength(0);
    expect(result.notices).toHaveLength(1);
    expect(result.notices[0].severity).toBe('error');
    result.dispose();
  });
  it('late asset completion after closing cannot revive the cache', async () => {
    let finish!: (value: AssetRecord) => void;
    const cache = new ProductAssetCache(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      ),
      task = cache.asset('photo');
    cache.dispose();
    finish({} as AssetRecord);
    await expect(task).rejects.toThrow('닫혔');
    expect(cache.diagnostics.pending).toBe(0);
    expect(cache.diagnostics.assets).toBe(0);
  });
  it('turns a single PNG to face each of the four sides, keeps its install point, and says so', async () => {
    const reader = vi.fn(async () => undefined),
      cache = new ProductAssetCache(reader);
    fakeImage(cache);
    const result = await buildViewerFixtures(scene(), { m: material() }, reader, cache),
      object = result.group.children[0],
      plane = object.children[0].children[0],
      before = (object.updateMatrix(), object.matrix.clone());
    for (const quarter of [90, 180, -90, 0]) {
      result.updateView(cameraOn(quarter));
      // The plane faces the camera (about the vertical only); the product group stays where it is.
      expect(plane.rotation.y).toBeCloseTo((quarter * Math.PI) / 180, 9);
      expect(plane.rotation.x).toBe(0);
      expect(object.quaternion.toArray()).toEqual([0, 0, 0, 1]);
      expect(object.matrix.elements).toEqual(before.elements);
      expect(plane.visible).toBe(true);
    }
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
    // The 위 photo is not used from the four sides, so it is not even read.
    expect(images.mock.calls.map(([id]) => id).sort()).toEqual(['photo', 'side']);
    // On the room's left (−90) the product that faces the front is seen facing right: the 오른쪽 photo.
    result.updateView(cameraOn(-90));
    const planes = result.group.children[0].children[0].children;
    expect(planes.map((plane) => plane.visible)).toEqual([false, true]);
    // Every plane turns to face that camera (−90 about y); the install point stays.
    expect(planes.map((plane) => plane.rotation.y)).toEqual([-Math.PI / 2, -Math.PI / 2]);
    expect(result.group.children[0].position.toArray()).toEqual([0, 0, 1200]);
    expect(result.viewNotices()).toEqual([]);
    // From the right it would need a 왼쪽 photo: there is none, the front stands in, and it says so.
    result.updateView(cameraOn(90));
    expect(planes.map((plane) => plane.visible)).toEqual([true, false]);
    expect(result.viewNotices().map((n) => n.message)).toEqual([
      '오른쪽 화면: 제품의 ‘왼쪽’ 사진이 없어 ‘정면’ 사진을 썼어요. 방향별 사진을 더 등록하면 더 자연스러워요.',
    ]);
    // From behind: no 뒤 photo either; the nearest registered one is the 오른쪽 (90° away, the front is 180°).
    result.updateView(cameraOn(180));
    expect(planes.map((plane) => plane.visible)).toEqual([false, true]);
    expect(result.viewNotices()[0].message).toBe(
      '뒤 화면: 제품의 ‘뒤’ 사진이 없어 ‘오른쪽’ 사진을 썼어요. 방향별 사진을 더 등록하면 더 자연스러워요.',
    );
    // Looking from above names the side the picture's bottom points to: the front here.
    const above = new PerspectiveCamera();
    above.quaternion.setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2);
    result.updateView(above);
    expect(planes.map((plane) => plane.visible)).toEqual([true, false]);
    expect(planes[0].rotation.y).toBe(0);
    // Back on the front, the stand-in note goes away.
    result.updateView(cameraOn(0));
    expect(result.viewNotices()).toEqual([]);
    result.dispose();
    cache.dispose();
  });
  it('draws a side photo as the product depth and the front and back photos as its width', () => {
    const placement = { widthMm: 400, heightMm: 800, scale: 1 };
    const whole = { left: 0, top: 0, right: 1, bottom: 1 };
    // 정면 and 뒤 show the width: 400 across, the height binds nothing (aspect 0.5 → 400 wide, 800 high).
    for (const name of ['정면', '뒤'] as const) {
      const size = photoPlaneSize(placement, 200, name, whole, 0.5);
      expect([size.width, size.height, size.across, size.estimated]).toEqual([400, 800, 'width', false]);
    }
    // 왼쪽 and 오른쪽 show the depth: 200 across.
    for (const name of ['왼쪽', '오른쪽'] as const) {
      const size = photoPlaneSize(placement, 200, name, whole, 0.5);
      expect([size.width, size.height, size.across, size.estimated]).toEqual([200, 400, 'depth', false]);
    }
    // The height still fits: a tall narrow depth keeps the picture inside width × height.
    expect(photoPlaneSize({ ...placement, heightMm: 300 }, 200, '오른쪽', whole, 0.5).height).toBe(300);
    // Visible area with a margin: it is the content that is fitted, and the scale multiplies.
    const margin = { left: 0.1, top: 0.1, right: 0.9, bottom: 0.9 };
    expect(photoPlaneSize({ ...placement, scale: 2 }, 200, '오른쪽', margin, 0.5).width).toBeCloseTo(
      (200 / 0.8) * 2,
      9,
    );
    // No depth registered: the width stands in, flagged; the front photo is never flagged.
    expect(photoPlaneSize(placement, undefined, '오른쪽', whole, 0.5)).toMatchObject({
      width: 400,
      across: 'depth',
      estimated: true,
    });
    expect(photoPlaneSize(placement, undefined, '정면', whole, 0.5).estimated).toBe(false);
  });
  it('shows a side photo at the product depth in the room, with the stand held on the floor', async () => {
    const reader = vi.fn(async () => undefined),
      cache = new ProductAssetCache(reader);
    fakeImage(cache);
    const m = material();
    m.views.push({ assetId: 'side', direction: '오른쪽', anchor: { x: 0.5, y: 1 } });
    const result = await buildViewerFixtures(scene(), { m }, reader, cache);
    const planes = result.group.children[0].children[0].children as Mesh[];
    const size = (plane: Mesh) => new Box3().setFromObject(plane, true).getSize(new Vector3());
    // The front camera sees the front photo at 400 wide; the side photo is 200 (the depth).
    result.updateView(cameraOn(0));
    expect(size(planes[0]).x).toBeCloseTo(400, 4);
    // From the left the product that faces front shows its 오른쪽 photo: 200 across, and across
    // the camera's depth (z), centred on its place, standing on the floor all the same.
    result.updateView(cameraOn(-90));
    const side = new Box3().setFromObject(planes[1], true);
    expect(side.getSize(new Vector3()).z).toBeCloseTo(200, 4);
    expect(side.getSize(new Vector3()).x).toBeCloseTo(0, 4);
    expect((side.min.z + side.max.z) / 2).toBeCloseTo(1200, 4);
    expect(side.min.y).toBeCloseTo(0, 4);
    result.updateView(cameraOn(0));
    expect(new Box3().setFromObject(planes[0], true).min.y).toBeCloseTo(0, 4);
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
  });
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
  const photoBuild = async (f: FixtureInstance, name: ProductDirection = '정면') => {
    const m = material();
    m.views[0].direction = name;
    const cache = new ProductAssetCache(async () => undefined);
    fakeImage(cache);
    return buildViewerFixtures(scene([f]), { m }, async () => undefined, cache);
  };
  const bounds = (group: Parameters<Box3['setFromObject']>[0]) => new Box3().setFromObject(group, true);

  it('no product is turned for its wall any more: every flat photo has rotation 0', async () => {
    for (const face of ['left', 'right', 'back', 'floor'] as const) {
      const result = await photoBuild(placed(face));
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
    const note = result.notices.find((n) => n.message.includes('각도 사진이 제품이 놓인 방향이에요'));
    expect(note?.message).toContain('‘정면’ 각도 사진');
    expect(note?.message).toContain('정면(열린 쪽)을 봐요');
    expect(note?.message).toContain('어울리는 각도가 아니에요');
    result.dispose();
  });

  it('a 오른쪽 photo on the left wall suits it: no warning, the same stand, looking into the room', async () => {
    const result = await photoBuild(placed('left'), '오른쪽');
    const b = bounds(result.group.children[0]);
    expect(b.min.x).toBeCloseTo(-half, 6);
    const note = result.notices.find((n) => n.message.includes('각도 사진이 제품이 놓인 방향이에요'));
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

  it('a photo turned to face a side wall stays a hair off it, so a click picks the product, not the wall', async () => {
    // The camera sits in the room on the other side: the left wall is seen from the right (90), the right wall from the left (−90).
    for (const [face, camera, inner] of [
      ['left', 90, -half + 1],
      ['right', -90, half - 1],
    ] as const) {
      const result = await photoBuild(placed(face), '정면');
      result.updateView(cameraOn(camera));
      const b = bounds(result.group);
      expect(b.min.x).toBeCloseTo(inner, 6);
      expect(b.max.x).toBeCloseTo(inner, 6);
      result.dispose();
    }
  });

  it('name × wall: a flat photo has its edge on the wall for every name, never inside it, never off it', async () => {
    for (const name of ['정면', '오른쪽', '왼쪽', '뒤'] as const) {
      // What it shows across: the side photos show the depth (200), the front and back the width.
      const across = name === '오른쪽' || name === '왼쪽' ? 200 : 400;
      const left = bounds((await photoBuild(placed('left'), name)).group);
      expect(left.min.x).toBeCloseTo(-half, 4);
      expect(left.getSize(new Vector3()).x).toBeCloseTo(across, 4);
      expect((left.min.z + left.max.z) / 2).toBeCloseTo(1200, 4);
      const right = bounds((await photoBuild(placed('right'), name)).group);
      expect(right.max.x).toBeCloseTo(half, 4);
      const back = bounds((await photoBuild(placed('back'), name)).group);
      expect(back.min.z).toBeCloseTo(1, 4);
      expect((back.min.x + back.max.x) / 2).toBeCloseTo(0, 4);
    }
  });

  it("a flat photo keeps the old rule: a small float or sink is settled, a big one is the anchor's", async () => {
    const slightly = placed('floor');
    slightly.anchor.y = 0.9875;
    const near = await photoBuild(slightly);
    expect(bounds(near.group).min.y).toBeCloseTo(0, 6);
    near.dispose();
    const middle = placed('floor');
    middle.anchor.y = 0.5;
    const sunk = await photoBuild(middle);
    expect(bounds(sunk.group).min.y).toBeLessThan(-100);
    sunk.dispose();
  });

  it("a flat photo on a wall is not grounded: its height is the anchor's", async () => {
    const f = placed('left');
    f.anchor.y = 0.5;
    const built = await photoBuild(f);
    expect(bounds(built.group).min.y).toBeGreaterThan(100);
    built.dispose();
  });

  it('says so when the product reaches beyond the room, and leaves the source alone', async () => {
    // On the floor at the very edge of the left wall, half of the product's 400 width is outside it.
    const f = placed('floor', 0);
    const value = scene([f]),
      original = structuredClone(value);
    const cache = new ProductAssetCache(async () => undefined);
    fakeImage(cache);
    const result = await buildViewerFixtures(value, { m: material() }, async () => undefined, cache);
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
});
