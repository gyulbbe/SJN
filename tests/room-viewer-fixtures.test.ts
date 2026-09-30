import { describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { Box3, Mesh, PerspectiveCamera, Quaternion, Texture, Vector3 } from 'three';
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
function cube(): ProductMesh {
  return {
    positions: new Float32Array([
      -1, -2, -0.5, 1, -2, -0.5, 1, 2, -0.5, -1, 2, -0.5, -1, -2, 0.5, 1, -2, 0.5, 1, 2, 0.5, -1, 2, 0.5,
    ]),
    colors: new Float32Array(24).fill(0.5),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 3, 2, 6, 3, 6, 7]),
  };
}
const reference = (): Product3dReference => ({
  version: 1,
  meshAssetId: 'mesh',
  inputAssetId: 'input',
  modelId: 'stored-model',
  modelRevision: 'stored-revision',
  pose: { objectQuaternion: [0, 0, 0, 1], cameraQuaternion: [0, 0, 0, 1], zoom: 1 },
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
      r = reference(),
      q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2).toArray();
    r.pose.objectQuaternion = q;
    r.pose.cameraQuaternion = q;
    r.pose.zoom = 3;
    const g = createSavedProductGeometry(m, r, f);
    expect(g.boundingBox!.getSize(new Vector3()).toArray()).toEqual([400, 800, 200]);
    expect(m.positions[0]).toBe(-1);
    g.dispose();
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
    const unique = (g: ReturnType<typeof createSavedProductGeometry>) =>
      new Set([...(g.getAttribute('color').array as Float32Array)].map((c) => c.toFixed(4))).size;
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
  it('places saved wall meshes rear against their installation surface', async () => {
    const f = fixture();
    f.roomPlacement!.face = 'left';
    f.roomPlacement!.v = 0.5;
    f.anchor.y = 0.5;
    const m = material();
    m.views[0].product3d = reference();
    const mesh = await makeProductMeshAsset(cube(), 'mesh', 'input'),
      result = await buildViewerFixtures(scene([f]), { m }, async () => mesh);
    const b = new Box3().setFromObject(result.group);
    expect(b.min.x).toBeCloseTo(-1200);
    expect(b.max.x).toBeCloseTo(-1000);
    expect((b.min.y + b.max.y) / 2).toBeCloseTo(1200);
    result.dispose();
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
  it('switches declared side photographs only at a matching camera direction, at the same install point', async () => {
    const reader = vi.fn(async () => undefined),
      cache = new ProductAssetCache(reader),
      images = fakeImage(cache),
      m = material();
    m.views.push(
      { assetId: 'side', direction: '오른쪽 측면', anchor: { x: 0.5, y: 1 } },
      { assetId: 'random', direction: 'my 90 fancy', anchor: { x: 0.5, y: 1 } },
    );
    const result = await buildViewerFixtures(scene(), { m }, reader, cache);
    expect(images).toHaveBeenCalledTimes(2);
    const camera = new PerspectiveCamera();
    camera.position.set(4000, 100, 1200);
    result.updateView(camera);
    const planes = result.group.children[0].children[0].children;
    expect(planes[0].visible).toBe(false);
    expect(planes[1].visible).toBe(true);
    expect(result.group.children[0].position.toArray()).toEqual([0, 0, 1200]);
    camera.position.set(0, 6000, 1200);
    result.updateView(camera);
    expect(planes[0].visible).toBe(true);
    expect(planes[1].visible).toBe(false);
    result.dispose();
    cache.dispose();
  });
  it('does not invent directional metadata for arbitrary angle names', () => {
    expect(declaredProductDirection('왼쪽 사선')).toBeUndefined();
    expect(declaredProductDirection('정면 새버전')).toBeUndefined();
    expect(declaredProductDirection('90°')).toBeUndefined();
    const views = material().views;
    views[0].direction = 'my front';
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

describe('facing of a product on a side wall (room placement `facing`)', () => {
  const wallFixture = (face: 'left' | 'right' | 'back' | 'floor', facing?: 'wall' | 'front', u = 0.5) => {
    const f = fixture();
    f.roomPlacement!.face = face;
    f.roomPlacement!.u = u;
    f.roomPlacement!.v = 0.5;
    f.anchor.y = 0.5;
    if (facing) f.roomPlacement!.facing = facing;
    return f;
  };
  const meshBuild = async (f: FixtureInstance) => {
    const m = material();
    m.views[0].product3d = reference();
    const mesh = await makeProductMeshAsset(cube(), 'mesh', 'input');
    return buildViewerFixtures(scene([f]), { m }, async () => mesh);
  };
  const photoBuild = async (f: FixtureInstance) => {
    const m = material();
    const cache = new ProductAssetCache(async () => undefined);
    fakeImage(cache);
    return buildViewerFixtures(scene([f]), { m }, async () => undefined, cache);
  };
  const half = DEFAULT_ROOM.widthMm / 2;
  const snapshot = (group: { children: { position: Vector3; rotation: { y: number } }[] }) =>
    group.children.map((c) => ({ position: c.position.toArray(), y: c.rotation.y }));

  it.each(['mesh', 'photo'] as const)(
    'without `facing` (or "wall") a %s product turns into the room exactly as before',
    async (kind) => {
      const build = kind === 'mesh' ? meshBuild : photoBuild;
      const left = await build(wallFixture('left'));
      const right = await build(wallFixture('right'));
      expect(left.group.children[0].rotation.y).toBeCloseTo(Math.PI / 2, 12);
      expect(right.group.children[0].rotation.y).toBeCloseTo(-Math.PI / 2, 12);
      expect(left.group.children[0].position.x).toBe(-half);
      expect(right.group.children[0].position.x).toBe(half);
      // "wall" is the same as nothing, to the matrix.
      for (const face of ['left', 'right'] as const) {
        const a = await build(wallFixture(face)),
          b = await build(wallFixture(face, 'wall'));
        expect(b.group.children[0].matrixWorld.toArray()).toEqual(a.group.children[0].matrixWorld.toArray());
        expect(b.notices.map((n) => n.message)).toEqual(a.notices.map((n) => n.message));
        a.dispose();
        b.dispose();
      }
      left.dispose();
      right.dispose();
    },
  );

  it('faces the front from the left wall with its side touching the wall, not in it, not floating', async () => {
    const before = await meshBuild(wallFixture('left'));
    const into = new Box3().setFromObject(before.group, true);
    const result = await meshBuild(wallFixture('left', 'front'));
    expect(result.group.children[0].rotation.y).toBe(0);
    const b = new Box3().setFromObject(result.group, true);
    expect(b.min.x).toBeCloseTo(-half, 6);
    expect(
      b
        .getSize(new Vector3())
        .toArray()
        .map((n) => Math.round(n)),
    ).toEqual([400, 800, 200]);
    // Same height and same place along the wall; the wall's side now shows the width (400 mm).
    expect((b.min.y + b.max.y) / 2).toBeCloseTo((into.min.y + into.max.y) / 2, 6);
    // It stands at the same place along the wall: its anchor stays at the spot (z 1200), depth to the front.
    expect(into.getCenter(new Vector3()).z).toBeCloseTo(1200, 6);
    expect(b.min.z).toBeCloseTo(1200, 6);
    expect(into.getSize(new Vector3()).x).toBeCloseTo(200, 6);
    expect(result.notices.some((n) => n.message.includes('방 밖'))).toBe(false);
    expect(result.notices.some((n) => n.message.includes('앞쪽(정면)'))).toBe(true);
    result.dispose();
    before.dispose();
  });

  it('faces the front from the right wall the same way, mirrored', async () => {
    const result = await meshBuild(wallFixture('right', 'front'));
    expect(result.group.children[0].rotation.y).toBe(0);
    const b = new Box3().setFromObject(result.group, true);
    expect(b.max.x).toBeCloseTo(half, 6);
    expect(b.min.x).toBeCloseTo(half - 400, 6);
    result.dispose();
  });

  it('stands a photo product upright to the front against the wall', async () => {
    const result = await photoBuild(wallFixture('left', 'front'));
    expect(result.group.children[0].rotation.y).toBe(0);
    const b = new Box3().setFromObject(result.group.children[0], true);
    expect(b.min.x).toBeCloseTo(-half, 6);
    // A flat plane 400 mm wide, facing +z (the open front).
    expect(b.getSize(new Vector3()).x).toBeCloseTo(400, 6);
    expect(b.getSize(new Vector3()).z).toBeCloseTo(0, 6);
    result.dispose();
  });

  it.each([
    ['floor', 'mesh'],
    ['back', 'mesh'],
    ['floor', 'photo'],
    ['back', 'photo'],
  ] as const)('changes nothing for a product on the %s (%s)', async (face, kind) => {
    const build = kind === 'mesh' ? meshBuild : photoBuild;
    const plain = await build(wallFixture(face)),
      front = await build(wallFixture(face, 'front'));
    expect(snapshot(front.group)).toEqual(snapshot(plain.group));
    expect(front.group.children[0].matrixWorld.toArray()).toEqual(
      plain.group.children[0].matrixWorld.toArray(),
    );
    expect(front.notices.map((n) => n.message)).toEqual(plain.notices.map((n) => n.message));
    plain.dispose();
    front.dispose();
  });

  it('says so when turning it to the front sends it out of the room, and leaves the source alone', async () => {
    // At the very front of the left wall the 200 mm depth reaches past the open front.
    const f = wallFixture('left', 'front', 0);
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

  it('a default-pose 3D product faces the front exactly (no yaw); a pose the user turned keeps its turn', () => {
    // The footprint's smallest bounding rectangle, as the angle from the front–back axis.
    const yawOf = (pose: Product3dReference['pose']) => {
      const g = createSavedProductGeometry(cube(), { ...reference(), pose }, wallFixture('left', 'front'));
      const p = g.getAttribute('position');
      let best = { a: 0, area: Infinity };
      for (let a = -45; a <= 45; a += 0.25) {
        const c = Math.cos((a * Math.PI) / 180),
          s = Math.sin((a * Math.PI) / 180);
        let x0 = Infinity,
          x1 = -Infinity,
          z0 = Infinity,
          z1 = -Infinity;
        for (let i = 0; i < p.count; i++) {
          const x = p.getX(i) * c - p.getZ(i) * s,
            z = p.getX(i) * s + p.getZ(i) * c;
          x0 = Math.min(x0, x);
          x1 = Math.max(x1, x);
          z0 = Math.min(z0, z);
          z1 = Math.max(z1, z);
        }
        if ((x1 - x0) * (z1 - z0) < best.area - 1e-9) best = { a, area: (x1 - x0) * (z1 - z0) };
      }
      g.dispose();
      return best.a;
    };
    const pose = createDefaultPose();
    expect(yawOf(pose)).toBe(0);
    // The front vector of the default pose: straight at the viewer, only the 10° the camera looked down.
    const orientation = new Quaternion(...pose.cameraQuaternion)
      .invert()
      .multiply(new Quaternion(...pose.objectQuaternion));
    const front = new Vector3(1, 0, 0).applyQuaternion(orientation);
    expect(front.x).toBeCloseTo(0, 9);
    expect(front.z).toBeGreaterThan(0.98);
    // A turn the user made in the 3D editor (about the model's up axis, z) shows up as that yaw.
    const turned = {
      ...pose,
      objectQuaternion: new Quaternion()
        .setFromAxisAngle(new Vector3(0, 0, 1), (20 * Math.PI) / 180)
        .toArray() as [number, number, number, number],
    };
    expect(Math.abs(yawOf(turned))).toBeCloseTo(20, 0);
  });

  it('keeps choosing the side photo from where the camera stands relative to the room, not the wall', async () => {
    const f = wallFixture('left', 'front');
    const m = material();
    m.views = [
      { assetId: 'front', direction: '정면', anchor: { x: 0.5, y: 1 } },
      { assetId: 'right', direction: '우측면', anchor: { x: 0.5, y: 1 } },
    ];
    const cache = new ProductAssetCache(async () => undefined);
    fakeImage(cache);
    const result = await buildViewerFixtures(scene([f]), { m }, async () => undefined, cache);
    const visible = () => {
      const planes: number[] = [];
      result.group.traverse((node) => {
        if (node instanceof Mesh && node.visible) planes.push(node.userData.viewIndex);
      });
      return planes;
    };
    const camera = new PerspectiveCamera();
    // In front of the room: the front photo. The product does not turn with the wall.
    camera.position.set(0, 1200, 6000);
    result.updateView(camera);
    expect(visible()).toEqual([0]);
    result.dispose();
  });
});
