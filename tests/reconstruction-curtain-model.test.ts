import { Box3, BufferGeometry, DoubleSide, Mesh, MeshStandardMaterial, Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import {
  createCurtainModel,
  curtainHangingOffset,
  type CurtainHardware,
} from '../src/lib/reconstruction/curtain-model';
import { disposeTemplateModel } from '../src/lib/reconstruction/templates';

const defaults = { widthMm: 900, heightMm: 1900, depthMm: 50, color: '#c7d7cf' };
const hardwareModes: CurtainHardware[] = ['rod', 'track', 'none'];

describe('authored curtain standard model', () => {
  for (const curtainHardware of hardwareModes) {
    it.each([
      defaults,
      { widthMm: 450, heightMm: 1200, depthMm: 25, color: '#e4e1d9' },
      { widthMm: 1823.4, heightMm: 2357.2, depthMm: 83.6, color: '#222222' },
    ])(`${curtainHardware}: whole assembly occupies the requested envelope %j`, (options) => {
      const model = createCurtainModel({ ...options, curtainHardware });
      try {
        const bounds = new Box3().setFromObject(model, true);
        const dimensions = bounds.getSize(new Vector3());
        expect(dimensions.x).toBeCloseTo(options.widthMm, 3);
        expect(dimensions.y).toBeCloseTo(options.heightMm, 3);
        expect(dimensions.z).toBeCloseTo(options.depthMm, 3);
        expect(bounds.min.x).toBeCloseTo(-options.widthMm / 2, 3);
        expect(bounds.min.y).toBeCloseTo(0, 3);
        expect(bounds.min.z).toBeCloseTo(-options.depthMm / 2, 3);
        expect(model.position.toArray()).toEqual([0, 0, 0]);
        expect(model.scale.toArray()).toEqual([1, 1, 1]);
        expect(model.quaternion.toArray()).toEqual([0, 0, 0, 1]);
        expect(model.children.every((node) => node instanceof Mesh)).toBe(true);
        expect(new Set(model.children.map((node) => (node as Mesh).geometry)).size).toBe(
          model.children.length,
        );
        for (const node of model.children) {
          const mesh = node as Mesh;
          expect(mesh.position.toArray()).toEqual([0, 0, 0]);
          expect(mesh.scale.toArray()).toEqual([1, 1, 1]);
          expect(mesh.quaternion.toArray()).toEqual([0, 0, 0, 1]);
          const positions = mesh.geometry.getAttribute('position');
          expect(Array.from(positions.array).every(Number.isFinite)).toBe(true);
          expect(Array.from(mesh.geometry.getAttribute('normal').array).every(Number.isFinite)).toBe(true);
          expect(
            Array.from(mesh.geometry.index!.array).every(
              (index) => Number.isInteger(index) && index >= 0 && index < positions.count,
            ),
          ).toBe(true);
        }
        const cloth = model.getObjectByName('curtain-cloth') as Mesh;
        const clothBounds = new Box3().setFromObject(cloth, true);
        expect(model.userData.clothBounds).toEqual({
          min: clothBounds.min.toArray(),
          max: clothBounds.max.toArray(),
        });
        expect(bounds.containsBox(clothBounds)).toBe(true);
        if (curtainHardware === 'none') expect(clothBounds.max.y).toBeCloseTo(options.heightMm, 3);
        else expect(clothBounds.max.y).toBeLessThan(options.heightMm);
        expect(model.userData.curtainModel).toEqual({
          revision: 1,
          hardware: curtainHardware,
          dimensionsMeaning: 'whole-assembly',
          anchorMeaning: 'hanging-support-centre',
        });
      } finally {
        disposeTemplateModel(model);
      }
    });
  }

  it.each(hardwareModes)(
    '%s preserves the hanging point in the baked local coordinate frame',
    (curtainHardware) => {
      const model = createCurtainModel({ ...defaults, curtainHardware });
      try {
        const anchor = new Vector3().fromArray(model.userData.hangingAnchor);
        expect(anchor.x).toBeCloseTo(0, 8);
        expect(anchor.z).toBeCloseTo(0, 8);
        expect(anchor.y).toBeGreaterThan(0);
        expect(anchor.y).toBeLessThanOrEqual(defaults.heightMm);
        if (curtainHardware === 'none') expect(anchor.y).toBeCloseTo(defaults.heightMm, 6);
        else {
          const hardware = model.getObjectByName(
            curtainHardware === 'rod' ? 'curtain-rod' : 'curtain-track',
          )!;
          const hardwareCentre = new Box3().setFromObject(hardware, true).getCenter(new Vector3());
          expect(anchor.distanceTo(hardwareCentre)).toBeLessThan(0.001);
          expect(anchor.y).toBeGreaterThan(model.userData.clothBounds.max[1]);
        }
        const desired = new Vector3(800, 2250, -400);
        model.quaternion.copy(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2));
        model.position.copy(desired).sub(anchor.clone().applyQuaternion(model.quaternion));
        model.updateMatrixWorld(true);
        expect(anchor.clone().applyMatrix4(model.matrixWorld).distanceTo(desired)).toBeLessThan(1e-8);
        expect(model.position.y).toBeCloseTo(desired.y - anchor.y, 6);
        expect(JSON.parse(JSON.stringify(model.userData))).toEqual(model.userData);
      } finally {
        disposeTemplateModel(model);
      }
    },
  );

  it.each(hardwareModes)(
    '%s computes the hanging offset without a model and agrees with baked geometry',
    (curtainHardware) => {
      for (const heightMm of [600, 1900, 2400, 3333.3]) {
        const offset = curtainHangingOffset(heightMm, curtainHardware);
        const model = createCurtainModel({
          ...defaults,
          widthMm: 723.5,
          heightMm,
          depthMm: 37,
          curtainHardware,
        });
        try {
          expect(offset).toBeCloseTo(model.userData.hangingAnchor[1], 8);
          expect(offset).toBeGreaterThan(model.userData.clothBounds.min[1]);
          expect(offset).toBeLessThanOrEqual(heightMm);
        } finally {
          disposeTemplateModel(model);
        }
      }
    },
  );

  it('validates the allocation-free hanging offset inputs and matches the default rod mode', () => {
    expect(curtainHangingOffset(1900)).toBe(curtainHangingOffset(1900, 'rod'));
    for (const height of [NaN, Infinity, 0, -1, 100001]) expect(() => curtainHangingOffset(height)).toThrow();
    expect(() => curtainHangingOffset(1900, 'unsupported' as CurtainHardware)).toThrow();
  });

  it('uses a round rod and rings, a rectangular track and carriers, or only fabric', () => {
    for (const curtainHardware of hardwareModes) {
      const model = createCurtainModel({ ...defaults, curtainHardware });
      try {
        const rod = model.getObjectByName('curtain-rod') as Mesh | undefined;
        const track = model.getObjectByName('curtain-track') as Mesh | undefined;
        expect(rod?.geometry.type).toBe(curtainHardware === 'rod' ? 'CylinderGeometry' : undefined);
        expect(track?.geometry.type).toBe(curtainHardware === 'track' ? 'BoxGeometry' : undefined);
        expect(model.children.filter((node) => node.name.startsWith('curtain-ring-'))).toHaveLength(
          curtainHardware === 'rod' ? 13 : 0,
        );
        expect(model.children.filter((node) => node.name.startsWith('curtain-hook-'))).toHaveLength(
          curtainHardware === 'track' ? 13 : 0,
        );
        if (curtainHardware === 'none')
          expect(model.children.map((node) => node.name)).toEqual(['curtain-cloth']);
      } finally {
        disposeTemplateModel(model);
      }
    }
  });

  it('keeps cloth opaque on both sides with real, shallow pleated geometry and no image textures', () => {
    const model = createCurtainModel(defaults);
    try {
      const cloth = model.getObjectByName('curtain-cloth') as Mesh<BufferGeometry, MeshStandardMaterial>;
      expect(cloth.material.side).toBe(DoubleSide);
      expect(cloth.material.transparent).toBe(false);
      expect(cloth.material.opacity).toBe(1);
      expect(cloth.material.depthWrite).toBe(true);
      expect(cloth.material.roughness).toBeGreaterThanOrEqual(0.9);
      expect(cloth.material.metalness).toBe(0);
      expect(cloth.material.map).toBeNull();
      expect(cloth.material.alphaMap).toBeNull();
      expect(cloth.material.color.getHexString()).toBe('c7d7cf');
      const positions = cloth.geometry.getAttribute('position');
      const zValues = new Set(Array.from({ length: positions.count }, (_, index) => positions.getZ(index)));
      expect(zValues.size).toBeGreaterThan(3);
      expect(Math.min(...zValues)).toBeCloseTo(-defaults.depthMm / 2, 3);
      expect(Math.max(...zValues)).toBeCloseTo(defaults.depthMm / 2, 3);
    } finally {
      disposeTemplateModel(model);
    }
  });

  it.each(hardwareModes)('%s produces deterministic independent geometry', (curtainHardware) => {
    const first = createCurtainModel({ ...defaults, curtainHardware });
    const second = createCurtainModel({ ...defaults, curtainHardware });
    try {
      expect(first.userData).toEqual(second.userData);
      expect(first.children.map((node) => node.name)).toEqual(second.children.map((node) => node.name));
      for (let index = 0; index < first.children.length; index++) {
        const a = first.children[index] as Mesh;
        const b = second.children[index] as Mesh;
        expect(a.geometry).not.toBe(b.geometry);
        expect(a.geometry.getAttribute('position').array).toEqual(b.geometry.getAttribute('position').array);
        expect(a.geometry.index!.array).toEqual(b.geometry.index!.array);
      }
    } finally {
      disposeTemplateModel(first);
      disposeTemplateModel(second);
    }
  });

  it.each(hardwareModes)(
    '%s disposes every owned resource exactly once with the existing generic traversal',
    (curtainHardware) => {
      const model = createCurtainModel({ ...defaults, curtainHardware });
      const counts: { count: number }[] = [];
      const materials = new Set<MeshStandardMaterial>();
      for (const node of model.children) {
        const mesh = node as Mesh;
        const geometryCount = { count: 0 };
        mesh.geometry.addEventListener('dispose', () => geometryCount.count++);
        counts.push(geometryCount);
        for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material])
          materials.add(material as MeshStandardMaterial);
      }
      for (const material of materials) {
        const materialCount = { count: 0 };
        material.addEventListener('dispose', () => materialCount.count++);
        counts.push(materialCount);
      }
      disposeTemplateModel(model);
      expect(counts.every((resource) => resource.count === 1)).toBe(true);
    },
  );

  it.each([
    { widthMm: 0 },
    { heightMm: -1 },
    { depthMm: 0 },
    { depthMm: -1 },
    { widthMm: NaN },
    { heightMm: Infinity },
    { depthMm: 100_001 },
    { curtainHardware: 'unsupported' },
    { color: 'url(https://example.com/image.png)' },
  ])('rejects unsupported inputs before allocating a model: %j', (patch) => {
    expect(() =>
      createCurtainModel({ ...defaults, ...patch } as Parameters<typeof createCurtainModel>[0]),
    ).toThrow();
  });
});
