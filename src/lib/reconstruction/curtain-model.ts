import {
  Box3,
  BoxGeometry,
  BufferGeometry,
  CylinderGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshStandardMaterial,
  TorusGeometry,
  Vector3,
} from 'three';

export type CurtainHardware = 'rod' | 'track' | 'none';

export type CurtainModelOptions = {
  /** Entire assembly, including its rod or track. These are not cloth dimensions. */
  widthMm: number;
  heightMm: number;
  depthMm: number;
  color: string;
  curtainHardware?: CurtainHardware;
};

export type CurtainModelMetadata = {
  revision: 1;
  hardware: CurtainHardware;
  dimensionsMeaning: 'whole-assembly';
  anchorMeaning: 'hanging-support-centre';
};

const ACROSS = 96;
const DOWN = 24;
const PLEATS = 12;
const HANGERS = 13;
const CLOTH_PROFILE = { width: 1200, height: 1850, pleatDepth: 64 };
const ROD_PROFILE = { radius: 8, endExtension: 30, ringRadius: 18, ringTubeRadius: 2 };
const TRACK_PROFILE = { height: 22, depth: 28, carrierHeight: 16, carrierWidth: 4, carrierDepth: 4 };

function positiveDimension(name: string, value: number) {
  if (!Number.isFinite(value) || value <= 0 || value > 100_000)
    throw new RangeError(`${name} must be finite, positive, and at most 100000mm`);
}

function hardwareProfile(hardware: CurtainHardware): { anchorY: number; topY: number } {
  if (hardware === 'none') return { anchorY: 0, topY: 0 };
  if (hardware === 'rod') {
    const anchorY = 2 * ROD_PROFILE.ringRadius - ROD_PROFILE.ringTubeRadius - ROD_PROFILE.radius;
    return {
      anchorY,
      topY: Math.max(2 * ROD_PROFILE.ringRadius + ROD_PROFILE.ringTubeRadius, anchorY + ROD_PROFILE.radius),
    };
  }
  if (hardware === 'track') {
    return {
      anchorY: TRACK_PROFILE.carrierHeight + TRACK_PROFILE.height / 2,
      topY: TRACK_PROFILE.carrierHeight + TRACK_PROFILE.height,
    };
  }
  throw new TypeError('Unsupported curtain hardware');
}

/** Distance from the baked assembly bottom to its hanging line, without allocating geometry. */
export function curtainHangingOffset(heightMm: number, hardware: CurtainHardware = 'rod'): number {
  positiveDimension('heightMm', heightMm);
  const profile = hardwareProfile(hardware);
  return heightMm * ((CLOTH_PROFILE.height + profile.anchorY) / (CLOTH_PROFILE.height + profile.topY));
}

/**
 * An authored, opaque fabric model; it does not reproduce a photograph or simulate cloth.
 * The returned direct Mesh children have unique, baked geometry. Bounds are centred in
 * X/Z and start at Y=0. userData.hangingAnchor and clothBounds use that same local frame.
 * The caller owns the geometry/materials and may use disposeTemplateModel().
 */
export function createCurtainModel({
  widthMm,
  heightMm,
  depthMm,
  color,
  curtainHardware = 'rod',
}: CurtainModelOptions): Group {
  for (const [name, value] of Object.entries({ widthMm, heightMm, depthMm })) positiveDimension(name, value);
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw new TypeError('Curtain color must be #RRGGBB');
  const profile = hardwareProfile(curtainHardware);

  // Standard proportions before the entire assembly is fitted to its requested envelope.
  const { width: clothWidth, height: clothHeight, pleatDepth } = CLOTH_PROFILE;
  const group = new Group();
  group.name = 'reconstruction-curtain';
  const vertices: number[] = [];
  const uv: number[] = [];
  const indices: number[] = [];
  for (let row = 0; row <= DOWN; row++) {
    const v = row / DOWN;
    for (let column = 0; column <= ACROSS; column++) {
      const u = column / ACROSS;
      const wave = Math.sin(u * Math.PI * 2 * PLEATS);
      vertices.push(
        (u - 0.5) * clothWidth,
        -v * clothHeight,
        Math.abs(wave) < 1e-12 ? 0 : (wave * pleatDepth) / 2,
      );
      uv.push(u, 1 - v);
    }
  }
  for (let row = 0; row < DOWN; row++) {
    for (let column = 0; column < ACROSS; column++) {
      const a = row * (ACROSS + 1) + column;
      const b = a + 1;
      const c = a + ACROSS + 1;
      indices.push(a, c, b, b, c, c + 1);
    }
  }
  const clothGeometry = new BufferGeometry();
  clothGeometry.setAttribute('position', new Float32BufferAttribute(vertices, 3));
  clothGeometry.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  clothGeometry.setIndex(indices);
  clothGeometry.computeVertexNormals();
  const fabric = new MeshStandardMaterial({
    color,
    side: DoubleSide,
    roughness: 0.96,
    metalness: 0,
    opacity: 1,
    transparent: false,
    depthWrite: true,
  });
  const cloth = new Mesh(clothGeometry, fabric);
  cloth.name = 'curtain-cloth';
  cloth.castShadow = true;
  cloth.receiveShadow = true;
  group.add(cloth);

  const hangingAnchor = new Vector3(0, profile.anchorY, 0);
  if (curtainHardware !== 'none') {
    const chrome = new MeshStandardMaterial({ color: '#9fa8a8', roughness: 0.28, metalness: 0.65 });
    const add = (name: string, geometry: BufferGeometry, x: number, y: number, z = 0) => {
      const mesh = new Mesh(geometry, chrome);
      mesh.name = name;
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      group.add(mesh);
      return mesh;
    };
    if (curtainHardware === 'rod') {
      // The rod fits inside the rings; their lower arc meets the cloth's top edge.
      const rod = add(
        'curtain-rod',
        new CylinderGeometry(
          ROD_PROFILE.radius,
          ROD_PROFILE.radius,
          clothWidth + ROD_PROFILE.endExtension * 2,
          24,
        ),
        0,
        profile.anchorY,
      );
      rod.rotation.z = Math.PI / 2;
      for (let index = 0; index < HANGERS; index++) {
        const ring = add(
          `curtain-ring-${index + 1}`,
          new TorusGeometry(ROD_PROFILE.ringRadius, ROD_PROFILE.ringTubeRadius, 8, 24),
          (index / (HANGERS - 1) - 0.5) * clothWidth,
          ROD_PROFILE.ringRadius,
        );
        ring.rotation.y = Math.PI / 2;
      }
    } else {
      // A rectangular rail and short straight carriers are distinct from rod/rings.
      add(
        'curtain-track',
        new BoxGeometry(clothWidth + ROD_PROFILE.endExtension * 2, TRACK_PROFILE.height, TRACK_PROFILE.depth),
        0,
        profile.anchorY,
      );
      for (let index = 0; index < HANGERS; index++) {
        add(
          `curtain-hook-${index + 1}`,
          new BoxGeometry(
            TRACK_PROFILE.carrierWidth,
            TRACK_PROFILE.carrierHeight,
            TRACK_PROFILE.carrierDepth,
          ),
          (index / (HANGERS - 1) - 0.5) * clothWidth,
          TRACK_PROFILE.carrierHeight / 2,
        );
      }
    }
  }

  const bounds = new Box3().setFromObject(group, true);
  const size = bounds.getSize(new Vector3());
  const scale = new Vector3(widthMm / size.x, heightMm / size.y, depthMm / size.z);
  group.scale.copy(scale);
  group.position.set(
    -((bounds.min.x + bounds.max.x) / 2) * scale.x,
    -bounds.min.y * scale.y,
    -((bounds.min.z + bounds.max.z) / 2) * scale.z,
  );
  group.updateMatrixWorld(true);
  hangingAnchor.applyMatrix4(group.matrixWorld);
  for (const node of group.children) {
    const mesh = node as Mesh;
    // Every child owns its geometry, so one ring's bake cannot mutate another ring.
    mesh.geometry.applyMatrix4(mesh.matrixWorld);
    mesh.geometry.computeBoundingBox();
    mesh.geometry.computeBoundingSphere();
    mesh.position.set(0, 0, 0);
    mesh.quaternion.identity();
    mesh.scale.set(1, 1, 1);
    mesh.updateMatrix();
  }
  group.position.set(0, 0, 0);
  group.scale.set(1, 1, 1);
  group.updateMatrixWorld(true);

  const clothBounds = cloth.geometry.boundingBox!;
  group.userData.hangingAnchor = hangingAnchor.toArray();
  group.userData.clothBounds = { min: clothBounds.min.toArray(), max: clothBounds.max.toArray() };
  group.userData.curtainModel = {
    revision: 1,
    hardware: curtainHardware,
    dimensionsMeaning: 'whole-assembly',
    anchorMeaning: 'hanging-support-centre',
  } satisfies CurtainModelMetadata;
  return group;
}
