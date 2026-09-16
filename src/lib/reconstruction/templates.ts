import { createCurtainModel } from './curtain-model';
import { shapedMirrorMeshes } from './fixture-variants';
import {
  AmbientLight,
  Box3,
  BoxGeometry,
  BufferGeometry,
  Float32BufferAttribute,
  PlaneGeometry,
  Color,
  CylinderGeometry,
  CatmullRomCurve3,
  TubeGeometry,
  DirectionalLight,
  Group,
  Mesh,
  MeshStandardMaterial,
  NoToneMapping,
  Scene,
  SphereGeometry,
  SRGBColorSpace,
  TorusGeometry,
  Vector3,
  Vector2,
  LatheGeometry,
  WebGLRenderer,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import type { Point } from '../types';
import {
  reconstructionModelTransform,
  reconstructionVolumeProjection,
  type FixtureOrientation,
} from './projection';
import type { RoomDefinition, RoomFace } from '../room-types';
import { createRoomCamera } from '../room-geometry';
import { canvasBlob } from '../images';
import type { ReconstructionKind, ReconstructionStandardOptions } from './types';

export type TemplateOptions = ReconstructionStandardOptions & {
  version?: 1 | 2;
  kind: ReconstructionKind;
  color: string;
  widthMm: number;
  heightMm: number;
  depthMm: number;
  room: RoomDefinition;
  face: RoomFace;
  u: number;
  v: number;
  aspect: number;
  orientation?: FixtureOrientation;
};
export const TEMPLATE_RENDERER_REVISION = 15;

/** Original sanitary silhouettes and cabinet joinery, normalized to an exact physical box. */
export function createTemplateModel({
  kind,
  color,
  widthMm: w,
  heightMm: h,
  depthMm: d,
  version,
  basinVariant,
  basinShape,
  pedestalShape,
  bowlCount,
  toiletLidState,
  face,
  hasFrame,
  opacity,
  doorCount,
  shelfStyle,
  support,
  bathLiningColor,
  mirrorShape,
  vanityStyle,
  counterSupport,
  showerVariant,
  curtainHardware,
}: Pick<TemplateOptions, 'kind' | 'color' | 'widthMm' | 'heightMm' | 'depthMm' | 'version'> &
  ReconstructionStandardOptions & { face?: RoomFace }): Group {
  if (kind === 'showerCurtain') {
    if (version !== 2) throw new Error('샤워 커튼은 표준 모형 v2에서 지원해요.');
    return createCurtainModel({ widthMm: w, heightMm: h, depthMm: d, color, curtainHardware });
  }
  const group = new Group();
  const ceramic = new MeshStandardMaterial({ color, roughness: 0.32, metalness: 0.02 });
  const white = new MeshStandardMaterial({ color: '#eeefeb', roughness: 0.25, metalness: 0.02 });
  const shaded = new MeshStandardMaterial({ color: new Color(color).multiplyScalar(0.6), roughness: 0.58 });
  const chrome = new MeshStandardMaterial({ color: '#949c9e', roughness: 0.19, metalness: 0.7 });
  const part = (mesh: Mesh, x: number, y: number, z: number) => {
    mesh.position.set(x, y, z);
    group.add(mesh);
    return mesh;
  };
  const box = (
    x: number,
    y: number,
    z: number,
    sx: number,
    sy: number,
    sz: number,
    material = ceramic,
    rounded = false,
  ) =>
    part(
      new Mesh(
        rounded
          ? new RoundedBoxGeometry(sx, sy, sz, 3, Math.min(sx, sy, sz) * 0.13)
          : new BoxGeometry(sx, sy, sz),
        material,
      ),
      x,
      y,
      z,
    );
  const oval = (x: number, y: number, z: number, sx: number, sy: number, sz: number, material = ceramic) => {
    const mesh = part(new Mesh(new SphereGeometry(1, 48, 28), material), x, y, z);
    mesh.scale.set(sx / 2, sy / 2, sz / 2);
    return mesh;
  };
  const rim = (
    x: number,
    y: number,
    z: number,
    sx: number,
    sz: number,
    thickness: number,
    material = ceramic,
  ) => {
    const mesh = part(new Mesh(new TorusGeometry(1, 0.055, 16, 80), material), x, y, z);
    mesh.rotation.x = -Math.PI / 2;
    mesh.scale.set(sx / 2.11, sz / 2.11, thickness / 0.11);
    return mesh;
  };
  const bowl = (x: number, y: number, z: number, sx: number, sy: number, sz: number, material = ceramic) => {
    // Thick rim returns into a recessed basin, instead of painting a dark oval on a ball.
    const profile = [
      [0, 0],
      [0.12, 0],
      [0.27, 0.1],
      [0.43, 0.55],
      [0.49, 0.85],
      [0.5, 0.96],
      [0.48, 1],
      [0.44, 0.98],
      [0.42, 0.78],
      [0.34, 0.37],
      [0.14, 0.24],
      [0, 0.24],
    ].map(([r, v]) => new Vector2(r, v));
    const mesh = part(new Mesh(new LatheGeometry(profile, 64), material), x, y, z);
    mesh.scale.set(sx, sy, sz);
    mesh.name = 'basin-bowl';
    mesh.userData.basinShape = 'round';
    return mesh;
  };
  const rectangularBowl = (
    x: number,
    y: number,
    z: number,
    sx: number,
    sy: number,
    sz: number,
    material = ceramic,
  ) => {
    // The four sloped inner walls meet a recessed floor; the outer shell tapers below.
    // Height is the whole basin + faucet envelope, so its rim sits at about .55h.
    const ring = (halfWidth: number, front: number, back: number, y: number) => [
      [-halfWidth, y, back],
      [-halfWidth, y, front],
      [halfWidth, y, front],
      [halfWidth, y, back],
    ];
    const outerTop = ring(sx * 0.5, sz * 0.5, -sz * 0.5, sy);
    const outerBottom = ring(sx * 0.39, sz * 0.35, -sz * 0.39, 0);
    const innerTop = ring(sx * 0.42, sz * 0.41, -sz * 0.27, sy);
    const innerFloor = ring(sx * 0.32, sz * 0.26, -sz * 0.2, sy * (0.16 / 0.55));
    const positions: number[] = [],
      indices: number[] = [];
    const quad = (a: number[], b: number[], c: number[], d: number[]) => {
      const offset = positions.length / 3;
      positions.push(...a, ...b, ...c, ...d);
      indices.push(offset, offset + 1, offset + 2, offset, offset + 2, offset + 3);
    };
    for (let i = 0; i < 4; i++) {
      const n = (i + 1) % 4;
      quad(outerTop[i], outerBottom[i], outerBottom[n], outerTop[n]);
      quad(outerTop[i], outerTop[n], innerTop[n], innerTop[i]);
      quad(innerTop[i], innerTop[n], innerFloor[n], innerFloor[i]);
    }
    quad(...(innerFloor as [number[], number[], number[], number[]]));
    quad(...([...outerBottom].reverse() as [number[], number[], number[], number[]]));
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    const shell = part(new Mesh(geometry, material), x, y, z);
    shell.name = 'basin-bowl';
    shell.userData.basinShape = 'rectangular';
    return shell;
  };
  const faucet = (x: number, y: number, z: number, size: number) => {
    const stem = part(
      new Mesh(new CylinderGeometry(size * 0.08, size * 0.09, size * 0.9, 20), chrome),
      x,
      y + size * 0.45,
      z,
    );
    stem.scale.z = 0.8;
    box(x, y + size * 0.86, z + size * 0.24, size * 0.14, size * 0.12, size * 0.62, chrome, true);
    box(x, y + size * 0.98, z - size * 0.03, size * 0.1, size * 0.035, size * 0.28, chrome, true);
  };
  if (kind === 'toilet') {
    // Foot, tapered siphon support, bowl, seat, cistern and flush handle are independent silhouettes.
    oval(0, h * 0.045, d * 0.1, w * 0.67, h * 0.09, d * 0.59);
    const foot = part(
      new Mesh(
        new LatheGeometry(
          [
            [0.27, 0],
            [0.29, 0.015],
            [0.285, 0.05],
            [0.25, 0.11],
            [0.195, 0.24],
            [0.19, 0.34],
            [0.22, 0.43],
            [0.24, 0.46],
          ].map(([radius, y]) => new Vector2(radius * w, y * h)),
          64,
        ),
        ceramic,
      ),
      0,
      0,
      d * 0.03,
    );
    foot.scale.z = (d / w) * 0.64;
    const seat = new MeshStandardMaterial({
      color: new Color(color).lerp(new Color('#ffffff'), 0.22),
      roughness: 0.22,
      metalness: 0.015,
    });
    bowl(0, h * 0.31, d * 0.13, w, h * 0.25, d * 0.73);
    oval(0, h * 0.397, d * 0.16, w * 0.44, h * 0.012, d * 0.39, shaded);
    rim(0, h * 0.568, d * 0.13, w * 1.01, d * 0.78, h * 0.033);
    rim(0, h * 0.596, d * 0.13, w * 0.99, d * 0.76, h * 0.025, seat);
    box(0, h * 0.765, -d * 0.32, w * 0.88, h * 0.43, d * 0.27, ceramic, true);
    box(0, h * 0.984, -d * 0.32, w * 0.94, h * 0.03, d * 0.31, ceramic, true);
    box(-w * 0.28, h * 0.874, -d * 0.172, w * 0.17, h * 0.028, d * 0.025, chrome, true);
    // Optional lids stay inside the pre-existing tank/bowl envelope. The shared body therefore
    // keeps exactly the same physical scale when toggling state or opening older saved fixtures.
    if (toiletLidState === 'open') {
      const lid = oval(0, h * 0.79, -d * 0.17, w * 0.92, h * 0.37, d * 0.045, seat);
      lid.name = 'toilet-lid-open';
    } else if (toiletLidState === 'closed') {
      const lid = oval(0, h * 0.629, d * 0.13, w * 0.99, h * 0.041, d * 0.76, seat);
      lid.name = 'toilet-lid-closed';
    }
  } else if (kind === 'basin' && version === 2 && (basinVariant ?? 'wall') === 'wall') {
    const count = bowlCount ?? 1,
      moduleWidth = w / count;
    for (let n = 0; n < count; n++) {
      const x = (n - (count - 1) / 2) * moduleWidth,
        bw = moduleWidth * (count === 1 ? 1 : 0.96);
      if (basinShape === 'round') {
        bowl(x, 0, 0, bw, h * 0.58, d).name = 'wall-basin-bowl';
        box(x, h * 0.53, -d * 0.38, bw * 0.72, h * 0.06, d * 0.24, ceramic, true);
      } else {
        rectangularBowl(x, 0, 0, bw, h * 0.55, d).name = 'wall-basin-bowl';
      }
      oval(x, h * 0.17, d * 0.07, bw * 0.045, h * 0.012, d * 0.06, chrome);
      faucet(x, h * 0.55, -d * 0.35, h * 0.45);
    }
  } else if (kind === 'basin' && !(version === 2 && basinVariant === 'vanity')) {
    const count = version === 2 ? (bowlCount ?? 1) : 1,
      moduleWidth = w / count;
    for (let n = 0; n < count; n++) {
      const x = (n - (count - 1) / 2) * moduleWidth,
        bw = moduleWidth * (count === 1 ? 1 : 0.96);
      // Bowl outline does not identify the support cross-section. Only an explicit v2
      // option changes the historical cylinder; old photographs/material versions stay intact.
      const rectangularPedestal = version === 2 && pedestalShape === 'rectangular';
      const pedestal = part(
        new Mesh(
          rectangularPedestal
            ? new BoxGeometry(bw * 0.36, h * 0.79, d * 0.48)
            : new CylinderGeometry(bw * 0.13, bw * 0.16, h * 0.79, 40),
          ceramic,
        ),
        x,
        h * 0.395,
        -d * 0.09,
      );
      pedestal.name = 'basin-pedestal';
      pedestal.userData.pedestalShape = rectangularPedestal ? 'rectangular' : 'round';
      if (!rectangularPedestal) pedestal.scale.z = 0.8;
      if (version === 2 && basinShape === 'rectangular') {
        rectangularBowl(x, h * 0.73, d * 0.03, bw, h * 0.22, d);
      } else {
        bowl(x, h * 0.73, d * 0.03, bw, h * 0.22, d);
        box(x, h * 0.91, -d * 0.35, bw * 0.82, h * 0.04, d * 0.22, ceramic, true);
      }
      faucet(x, h * 0.93, -d * 0.33, h * 0.12);
    }
  } else if (
    (kind === 'vanity' || (kind === 'basin' && basinVariant === 'vanity')) &&
    version === 2 &&
    vanityStyle === 'open-counter'
  ) {
    const wallOnly = counterSupport === 'wall';
    const surface = new MeshStandardMaterial({ color, roughness: 0.58, metalness: 0 });
    const slabThickness = Math.min(70, h * (wallOnly ? 0.16 : 0.065));
    const top = wallOnly ? slabThickness : h * 0.72;
    box(0, top - slabThickness / 2, 0, w, slabThickness, d, surface).name = 'open-counter-slab';
    if (!wallOnly) {
      const panelWidth = Math.min(100, w * 0.1);
      for (const side of [-1, 1]) {
        if (counterSupport !== 'both-panels' && counterSupport !== (side < 0 ? 'left-panel' : 'right-panel'))
          continue;
        box(
          (side * (w - panelWidth)) / 2,
          (top - slabThickness) / 2,
          0,
          panelWidth,
          top - slabThickness,
          d,
          surface,
        ).name = side < 0 ? 'open-counter-left-panel' : 'open-counter-right-panel';
      }
    }
    const count = bowlCount ?? 1,
      moduleWidth = w / count,
      remaining = h - top;
    for (let n = 0; n < count; n++) {
      const x = (n - (count - 1) / 2) * moduleWidth;
      if (basinShape === 'rectangular')
        rectangularBowl(x, top, d * 0.04, moduleWidth * 0.72, remaining * 0.62, d * 0.68, white);
      else bowl(x, top, d * 0.04, moduleWidth * 0.72, remaining * 0.62, d * 0.68, white);
      faucet(x, top, -d * 0.36, remaining);
    }
  } else if (kind === 'vanity' || (kind === 'basin' && basinVariant === 'vanity')) {
    const cabinet = new MeshStandardMaterial({ color, roughness: 0.64, metalness: 0 });
    const joinery = new MeshStandardMaterial({
      color: new Color(color).multiplyScalar(0.72),
      roughness: 0.72,
    });
    if (version !== 2 || face === undefined || face === 'floor')
      box(0, h * 0.055, -d * 0.03, w * 0.91, h * 0.11, d * 0.88, joinery).name = 'vanity-plinth';
    box(0, h * 0.49, -d * 0.015, w, h * 0.86, d * 0.96, cabinet);
    // Old saved models omitted bowlCount; keep their historic geometry until explicitly edited.
    // Every newly created v2 fixture supplies an explicit count, never inferred from cabinet width.
    const count = bowlCount ?? (w >= 1000 ? 2 : 1),
      moduleWidth = w / count;
    for (let n = 0; n < count; n++) {
      const x = (n - (count - 1) / 2) * moduleWidth;
      for (const side of [-1, 1]) {
        const cx = x + side * moduleWidth * 0.245;
        box(cx, h * 0.43, d * 0.483, moduleWidth * 0.472, h * 0.61, d * 0.023, cabinet, true);
        box(cx, h * 0.43, d * 0.497, moduleWidth * 0.385, h * 0.51, d * 0.012, joinery, true);
        box(cx, h * 0.43, d * 0.507, moduleWidth * 0.351, h * 0.48, d * 0.012, cabinet, true);
        box(
          x + side * moduleWidth * 0.055,
          h * 0.59,
          d * 0.523,
          moduleWidth * 0.022,
          h * 0.14,
          d * 0.034,
          chrome,
          true,
        );
      }
      // Recessed bowls surrounded by a ceramic top; the voids are not solid white slabs.
      const basinW = moduleWidth * 0.72,
        basinD = d * 0.69;
      box(x, h * 0.937, -d * 0.42, moduleWidth, h * 0.06, d * 0.15, white, true);
      box(x, h * 0.937, d * 0.43, moduleWidth, h * 0.06, d * 0.13, white, true);
      for (const side of [-1, 1])
        box(
          x + side * moduleWidth * 0.444,
          h * 0.937,
          0,
          moduleWidth * 0.112,
          h * 0.06,
          d * 0.72,
          white,
          true,
        );
      if (version === 2 && basinShape === 'rectangular')
        rectangularBowl(x, h * 0.82, d * 0.02, basinW, h * 0.12, basinD, white);
      else bowl(x, h * 0.82, d * 0.02, basinW, h * 0.12, basinD, white);
      faucet(x, h * 0.96, -d * 0.365, h * 0.12);
    }
  } else if (kind === 'bath') {
    // Old models retain exactly the original materials when this explicit option is absent.
    const lining = bathLiningColor
      ? new MeshStandardMaterial({ color: bathLiningColor, roughness: 0.32, metalness: 0.02 })
      : ceramic;
    const innerShade = bathLiningColor
      ? new MeshStandardMaterial({ color: new Color(bathLiningColor).multiplyScalar(0.78), roughness: 0.58 })
      : shaded;
    box(0, h * 0.43, 0, w * 0.97, h * 0.86, d * 0.96, ceramic, true);
    box(0, h * 0.885, 0, w * 0.88, h * 0.025, d * 0.76, innerShade, true);
    for (const z of [-1, 1])
      box(0, h * 0.947, z * d * 0.46, w, h * 0.106, d * 0.08, lining, true).name =
        z < 0 ? 'bath-rim-back' : 'bath-rim-front';
    for (const x of [-1, 1])
      box(x * w * 0.465, h * 0.947, 0, w * 0.07, h * 0.106, d * 0.85, lining, true).name =
        x < 0 ? 'bath-rim-left' : 'bath-rim-right';
    faucet(-w * 0.36, h * 0.96, -d * 0.405, h * 0.11);
  }
  if (kind === 'glassPartition') {
    const glass = new MeshStandardMaterial({
      color,
      roughness: 0.12,
      metalness: 0.02,
      transparent: true,
      opacity: opacity ?? 0.18,
      depthWrite: false,
    });
    const edge = Math.min(18, w * 0.025, h * 0.025);
    box(0, h / 2, 0, w, h, d, glass);
    if (hasFrame !== false) {
      for (const x of [-1, 1]) box((x * (w - edge)) / 2, h / 2, 0, edge, h, d, chrome);
      for (const y of [edge / 2, h - edge / 2]) box(0, y, 0, w, edge, d, chrome);
    }
  } else if (kind === 'shower' && version === 2 && showerVariant !== undefined) {
    // New explicit variants only. The following legacy branch stays byte-for-byte unchanged.
    const pipeRadius = Math.max(0.8, Math.min(w * 0.018, d * 0.03));
    const tag = (mesh: Mesh, name: string, showerPart?: 'handset' | 'rail' | 'hose' | 'overhead-head') => {
      mesh.name = name;
      if (showerPart) mesh.userData.showerPart = showerPart;
      return mesh;
    };
    const pipe = (
      name: string,
      points: Vector3[],
      radius = pipeRadius,
      showerPart?: 'handset' | 'rail' | 'hose' | 'overhead-head',
    ) =>
      tag(
        part(
          new Mesh(new TubeGeometry(new CatmullRomCurve3(points), 80, radius, 12, false), chrome),
          0,
          0,
          0,
        ),
        name,
        showerPart,
      );
    const darkFace = new MeshStandardMaterial({ color: '#566166', roughness: 0.65, metalness: 0.2 });
    if (showerVariant === 'overhead-head') {
      // A fixed head and its arm are not evidence for a rail, handset, hose or mixer.
      tag(box(0, h * 0.78, -d * 0.43, w * 0.32, h * 0.32, d * 0.08, chrome, true),
        'shower-wall-mount', 'overhead-head');
      pipe('shower-overhead-arm', [
        new Vector3(0, h * 0.78, -d * 0.4),
        new Vector3(0, h * 0.78, -d * 0.05),
        new Vector3(0, h * 0.65, d * 0.22),
        new Vector3(0, h * 0.3, d * 0.29),
      ], pipeRadius * 1.2, 'overhead-head');
      tag(oval(0, h * 0.24, d * 0.3, w, h * 0.25, d * 0.44, chrome),
        'shower-overhead-head', 'overhead-head');
      tag(oval(0, h * 0.12, d * 0.3, w * 0.91, h * 0.025, d * 0.4, darkFace),
        'shower-overhead-face', 'overhead-head');
    } else if (showerVariant === 'handheld-wall') {
      // Explicit connected wall hardware: an ordinary handset, long hose and finished control.
      // No rail, overhead head or compact trigger-spray geometry is inferred.
      const hx = -w * 0.18;
      tag(box(hx, h * 0.8, -d * 0.36, w * 0.2, h * 0.045, d * 0.22, chrome, true),
        'shower-handset-holder', 'handset');
      pipe('shower-handset', [
        new Vector3(hx, h * 0.72, -d * 0.07),
        new Vector3(hx, h * 0.87, d * 0.06),
        new Vector3(hx, h * 0.93, d * 0.2),
      ], w * 0.025, 'handset');
      tag(oval(hx, h * 0.93, d * 0.2, w * 0.32, h * 0.11, d * 0.13, chrome),
        'shower-handset-head', 'handset');
      tag(oval(hx, h * 0.93, d * 0.267, w * 0.285, h * 0.095, d * 0.015, darkFace),
        'shower-handset-face', 'handset');
      tag(box(0, h * 0.3, -d * 0.22, w, h * 0.075, d * 0.6, chrome, true), 'shower-mixer');
      for (const x of [-w * 0.28, w * 0.28])
        tag(oval(x, h * 0.3, d * 0.13, w * 0.12, h * 0.038, d * 0.2, chrome), 'shower-control');
      pipe('shower-hose', [
        new Vector3(hx, h * 0.72, -d * 0.07),
        new Vector3(hx, h * 0.36, d * 0.05),
        new Vector3(-w * 0.15, h * 0.045, d * 0.15),
        new Vector3(w * 0.18, h * 0.035, d * 0.22),
        new Vector3(w * 0.27, h * 0.13, d * 0.15),
        new Vector3(w * 0.28, h * 0.27, -d * 0.05),
      ], pipeRadius * 0.8, 'hose');
    } else if (showerVariant === 'hand-spray') {
      tag(
        box(-w * 0.17, h * 0.78, -d * 0.3, w * 0.22, h * 0.08, d * 0.28, chrome, true),
        'shower-handset-holder',
        'handset',
      );
      tag(
        box(w * 0.3, h * 0.64, -d * 0.32, w * 0.15, h * 0.08, d * 0.36, chrome, true),
        'shower-wall-outlet',
      );
      pipe(
        'shower-handset',
        [
          new Vector3(-w * 0.17, h * 0.64, -d * 0.02),
          new Vector3(-w * 0.17, h * 0.84, d * 0.02),
          new Vector3(-w * 0.1, h * 0.94, d * 0.23),
        ],
        w * 0.055,
        'handset',
      );
      tag(
        oval(-w * 0.1, h * 0.94, d * 0.27, w * 0.25, h * 0.09, d * 0.22, chrome),
        'shower-handset-head',
        'handset',
      );
      tag(
        oval(-w * 0.1, h * 0.94, d * 0.39, w * 0.19, h * 0.065, d * 0.025, darkFace),
        'shower-handset-face',
        'handset',
      );
      tag(
        box(-w * 0.11, h * 0.82, d * 0.14, w * 0.07, h * 0.13, d * 0.1, chrome, true),
        'shower-handset-trigger',
        'handset',
      );
      const hose = [new Vector3(-w * 0.17, h * 0.64, -d * 0.02)];
      for (let i = 0; i <= 72; i++) {
        const t = i / 72,
          phase = t * Math.PI * 2 * 6;
        hose.push(
          new Vector3(
            -w * 0.1 + w * 0.22 * Math.sin(phase),
            h * (0.59 - 0.42 * t),
            d * (0.03 + 0.12 * Math.cos(phase)),
          ),
        );
      }
      hose.push(
        new Vector3(0, h * 0.045, d * 0.12),
        new Vector3(w * 0.31, h * 0.06, d * 0.08),
        new Vector3(w * 0.34, h * 0.35, -d * 0.03),
        new Vector3(w * 0.3, h * 0.64, -d * 0.1),
      );
      pipe('shower-hose', hose, pipeRadius * 0.75, 'hose');
    } else {
      const overhead = showerVariant === 'overhead-set';
      if (!overhead && showerVariant !== 'handheld-rail')
        throw new Error('지원하는 샤워 형태를 선택해 주세요.');
      const railX = overhead ? w * 0.15 : -w * 0.16;
      tag(
        box(railX, h * 0.58, -d * 0.36, pipeRadius * 2, h * 0.65, pipeRadius * 2, chrome, true),
        'shower-rail',
        'rail',
      );
      for (const y of [h * 0.3, h * 0.86])
        tag(box(railX, y, -d * 0.4, w * 0.16, h * 0.035, d * 0.15, chrome, true), 'shower-wall-mount');
      const hx = overhead ? -w * 0.28 : w * 0.07,
        hy = overhead ? h * 0.64 : h * 0.9;
      pipe(
        'shower-handset',
        [
          new Vector3(hx, hy - h * 0.17, -d * 0.1),
          new Vector3(hx, hy - h * 0.04, d * 0.04),
          new Vector3(hx, hy, d * 0.14),
        ],
        pipeRadius * 2.1,
        'handset',
      );
      tag(oval(hx, hy, d * 0.16, w * 0.3, h * 0.09, d * 0.09, chrome), 'shower-handset-head', 'handset');
      tag(oval(hx, hy, d * 0.21, w * 0.24, h * 0.075, d * 0.018, darkFace), 'shower-handset-face', 'handset');
      tag(
        box(hx, hy - h * 0.1, -d * 0.23, w * 0.15, h * 0.04, d * 0.2, chrome, true),
        'shower-handset-holder',
        'handset',
      );
      pipe(
        'shower-hose',
        [
          new Vector3(hx, hy - h * 0.17, -d * 0.1),
          new Vector3(-w * 0.38, h * 0.29, d * 0.13),
          new Vector3(-w * 0.32, h * 0.04, d * 0.23),
          new Vector3(w * 0.3, h * 0.035, d * 0.24),
          new Vector3(w * 0.4, h * 0.2, d * 0.12),
          new Vector3(w * 0.28, h * 0.28, -d * 0.2),
        ],
        pipeRadius * 0.72,
        'hose',
      );
      if (overhead) {
        tag(box(0, h * 0.26, -d * 0.28, w * 0.9, h * 0.05, d * 0.15, chrome, true), 'shower-mixer');
        pipe(
          'shower-overhead-arm',
          [
            new Vector3(railX, h * 0.86, -d * 0.36),
            new Vector3(railX, h * 0.96, -d * 0.3),
            new Vector3(0, h * 0.97, d * 0.32),
          ],
          pipeRadius,
          'overhead-head',
        );
        tag(
          box(0, h * 0.94, d * 0.29, w, h * 0.018, d * 0.4, chrome, true),
          'shower-overhead-head',
          'overhead-head',
        );
        tag(
          box(0, h * 0.928, d * 0.29, w * 0.92, h * 0.002, d * 0.36, darkFace),
          'shower-overhead-face',
          'overhead-head',
        );
      } else {
        tag(
          box(w * 0.28, h * 0.28, -d * 0.28, w * 0.18, h * 0.055, d * 0.17, chrome, true),
          'shower-wall-outlet',
        );
      }
    }
  } else if (kind === 'shower') {
    const pipeRadius = Math.max(3, Math.min(w * 0.018, d * 0.06));
    const pipe = (name: string, points: Vector3[], radius = pipeRadius) => {
      const mesh = part(
        new Mesh(new TubeGeometry(new CatmullRomCurve3(points), 56, radius, 10, false), chrome),
        0,
        0,
        0,
      );
      mesh.name = name;
      return mesh;
    };
    // This generic wall kit has no shower enclosure or source-image surface.
    box(0, h * 0.58, -d * 0.36, pipeRadius * 2, h * 0.7, pipeRadius * 2, chrome, true).name = 'shower-rail';
    for (const y of [h * 0.24, h * 0.86])
      box(0, y, -d * 0.42, w * 0.16, h * 0.045, d * 0.16, chrome, true).name = 'shower-wall-mount';
    box(0, h * 0.25, -d * 0.28, w, h * 0.06, d * 0.25, chrome, true).name = 'shower-mixer';
    for (const side of [-1, 1]) {
      const valve = part(
        new Mesh(new CylinderGeometry(w * 0.07, w * 0.07, d * 0.13, 24), chrome),
        side * w * 0.32,
        h * 0.25,
        -d * 0.08,
      );
      valve.rotation.x = Math.PI / 2;
      valve.name = 'shower-control';
    }
    pipe('shower-head-stem', [
      new Vector3(0, h * 0.78, -d * 0.32),
      new Vector3(0, h * 0.88, -d * 0.14),
      new Vector3(0, h * 0.92, d * 0.23),
    ]);
    const head = oval(0, h * 0.94, d * 0.28, w * 0.6, h * 0.12, d * 0.16, chrome);
    head.name = 'shower-head';
    head.rotation.x = -0.22;
    const faceMaterial = new MeshStandardMaterial({ color: '#565f61', roughness: 0.65, metalness: 0.2 });
    oval(0, h * 0.94, d * 0.37, w * 0.49, h * 0.097, d * 0.025, faceMaterial).name = 'shower-head-face';
    pipe(
      'shower-hose',
      [
        new Vector3(-w * 0.14, h * 0.22, -d * 0.17),
        new Vector3(-w * 0.17, h * 0.055, d * 0.1),
        new Vector3(w * 0.14, h * 0.035, d * 0.2),
        new Vector3(w * 0.3, h * 0.22, d * 0.16),
        new Vector3(w * 0.19, h * 0.62, -d * 0.05),
        new Vector3(0, h * 0.79, -d * 0.2),
      ],
      pipeRadius * 0.72,
    );
  } else if (kind === 'wallCabinet') {
    const body = new MeshStandardMaterial({ color, roughness: 0.7, metalness: 0 });
    const seams = new MeshStandardMaterial({
      color: new Color(color).multiplyScalar(0.6),
      roughness: 0.8,
    });
    box(0, h / 2, -d * 0.055, w, h, d * 0.89, body).name = 'wall-cabinet-body';
    box(0, h / 2, d * 0.395, w * 0.94, h * 0.94, d * 0.025, seams).name = 'wall-cabinet-door-reveal';
    const doors = Math.max(1, Math.min(4, Math.round(doorCount ?? 2)));
    const moduleWidth = (w * 0.94) / doors;
    for (let n = 0; n < doors; n++) {
      const x = (n - (doors - 1) / 2) * moduleWidth;
      box(x, h / 2, d * 0.43, moduleWidth * 0.965, h * 0.925, d * 0.065, body).name = 'wall-cabinet-door';
      box(
        x + (n % 2 === 0 ? 1 : -1) * moduleWidth * 0.33,
        h * 0.48,
        d * 0.48,
        Math.min(18, moduleWidth * 0.055),
        h * 0.11,
        d * 0.04,
        chrome,
        true,
      ).name = 'wall-cabinet-handle';
    }
  } else if (kind === 'lowPartition') {
    const masonry = new MeshStandardMaterial({ color, roughness: 0.82, metalness: 0 });
    const cap = new MeshStandardMaterial({ color, roughness: 0.65, metalness: 0 });
    const capHeight = Math.min(20, h * 0.035);
    box(0, (h - capHeight) / 2, 0, w, h - capHeight, d, masonry).name = 'low-partition-body';
    box(0, h - capHeight / 2, 0, w, capHeight, d, cap).name = 'low-partition-cap';
  } else if (kind === 'wallShelf') {
    if (shelfStyle === 'rack') {
      for (const x of [-1, 1]) box(x * w * 0.48, h / 2, 0, w * 0.04, h, d, chrome, true);
      for (let z = 0; z < 6; z++)
        box(0, h / 2, (z / 5 - 0.5) * d * 0.94, w, h, Math.min(12, d / 14), chrome, true);
    } else {
      box(0, h / 2, 0, w, h, d, ceramic, true);
    }
  } else if (kind === 'mirror' && version === 2 && (mirrorShape === 'oval' || mirrorShape === 'arched')) {
    group.add(...shapedMirrorMeshes(w, h, d, mirrorShape, !!hasFrame, color));
  } else if (kind === 'mirror' || kind === 'mirrorCabinet' || kind === 'window' || kind === 'door') {
    const border = Math.min(w, h) * (kind === 'mirror' ? 0.025 : 0.045);
    const body = new MeshStandardMaterial({
      color: kind === 'door' || kind === 'mirrorCabinet' ? color : '#d5d8d5',
      roughness: 0.5,
    });
    box(0, h / 2, 0, w, h, d * 0.95, body);
    if (kind === 'door') {
      const panel = new MeshStandardMaterial({
        color: new Color(color).multiplyScalar(0.92),
        roughness: 0.65,
      });
      box(0, h * 0.57, d * 0.48, w * 0.76, h * 0.69, d * 0.025, panel);
      box(w * 0.37, h * 0.47, d * 0.5, w * 0.12, h * 0.012, d * 0.035, chrome, true);
    } else {
      // Neutral manufactured surface: no source reflection, room crop, or outside photograph.
      const plane = new PlaneGeometry(w - 2 * border, h - 2 * border, 12, 12);
      const coords = plane.getAttribute('position');
      const values: number[] = [];
      for (let i = 0; i < coords.count; i++) {
        const diagonal = coords.getX(i) / w + coords.getY(i) / h;
        const highlight = Math.exp(-Math.pow((diagonal - 0.18) / 0.38, 2));
        const c = new Color(kind === 'window' ? '#c2d4db' : '#aeb8bd').lerp(
          new Color('#f2f5f5'),
          highlight * 0.7,
        );
        values.push(c.r, c.g, c.b);
      }
      plane.setAttribute('color', new Float32BufferAttribute(values, 3));
      const reflective = new MeshStandardMaterial({
        color: '#ffffff',
        vertexColors: true,
        roughness: 0.3,
        metalness: 0.08,
      });
      part(new Mesh(plane, reflective), 0, h / 2, d / 2);
      if (kind === 'window') {
        box(0, h / 2, d * 0.505, border * 0.75, h - border * 2, d * 0.015, body);
        box(0, h / 2, d * 0.505, w - border * 2, border * 0.75, d * 0.015, body);
      } else if (kind === 'mirrorCabinet') {
        const doors = Math.max(1, Math.min(4, Math.round(doorCount ?? 2)));
        for (let n = 1; n < doors; n++)
          box(
            (n / doors - 0.5) * (w - 2 * border),
            h / 2,
            d * 0.505,
            Math.max(2, w * 0.004),
            h - border * 2,
            d * 0.015,
            chrome,
          );
      }
    }
  }
  // Rotated shower ellipses need vertex bounds; conservative transformed boxes shrink the kit.
  const bounds = new Box3().setFromObject(group, kind === 'shower');
  const size = bounds.getSize(new Vector3());
  if (size.x > 0 && size.y > 0 && size.z > 0) {
    const scale = new Vector3(w / size.x, h / size.y, d / size.z);
    group.scale.copy(scale);
    group.position.set(
      -(bounds.min.x + bounds.max.x) * 0.5 * scale.x,
      -bounds.min.y * scale.y,
      -(bounds.min.z + bounds.max.z) * 0.5 * scale.z,
    );
  }
  group.updateMatrixWorld(true);
  for (const node of group.children) {
    const mesh = node as Mesh;
    mesh.geometry.applyMatrix4(mesh.matrixWorld);
    mesh.position.set(0, 0, 0);
    mesh.quaternion.identity();
    mesh.scale.set(1, 1, 1);
    mesh.updateMatrix();
  }
  group.position.set(0, 0, 0);
  group.scale.set(1, 1, 1);
  // Add support only after normalizing/baking the glass. Glass dimensions and origin must not shrink.
  if (version === 2 && kind === 'glassPartition' && support?.kind === 'shower-curb' && support.curb) {
    const { widthMm: cw, depthMm: cd } = support.curb;
    const capHeight = Math.min(12, support.heightMm * 0.2);
    const edgeInset = Math.min(2, cw * 0.01, cd * 0.01);
    const body = new MeshStandardMaterial({ color: '#bab9b3', roughness: 0.78 });
    const cap = new MeshStandardMaterial({ color: '#d9dad5', roughness: 0.48 });
    // Continuous upstand with a shallow tile cap; the cap top is exactly the glass bottom (y=0).
    box(
      0,
      -(support.heightMm + capHeight) / 2,
      0,
      cw - edgeInset * 2,
      support.heightMm - capHeight,
      cd - edgeInset * 2,
      body,
    ).name = 'shower-curb-body';
    box(0, -capHeight / 2, 0, cw, capHeight, cd, cap).name = 'shower-curb-cap';
  }
  group.updateMatrixWorld(true);
  return group;
}

export function disposeTemplateModel(model: Group) {
  const materials = new Set<MeshStandardMaterial>();
  model.traverse((node) => {
    if (!(node instanceof Mesh)) return;
    node.geometry.dispose();
    for (const material of Array.isArray(node.material) ? node.material : [node.material])
      materials.add(material as MeshStandardMaterial);
  });
  materials.forEach((material) => material.dispose());
}
function planarCanvas(kind: ReconstructionKind, color: string, widthMm: number, heightMm: number) {
  const canvas = document.createElement('canvas');
  const factor = 1024 / Math.max(widthMm, heightMm);
  canvas.width = Math.max(32, Math.round(widthMm * factor));
  canvas.height = Math.max(32, Math.round(heightMm * factor));
  const ctx = canvas.getContext('2d')!;
  const w = canvas.width,
    h = canvas.height,
    border = Math.max(4, Math.min(w, h) * 0.045);
  ctx.fillStyle = kind === 'door' ? '#9c9487' : '#adb6b8';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = color;
  ctx.fillRect(border, border, w - 2 * border, h - 2 * border);
  if (kind === 'door') {
    ctx.strokeStyle = '#00000026';
    ctx.lineWidth = 2;
    ctx.strokeRect(w * 0.17, h * 0.1, w * 0.66, h * 0.68);
    ctx.fillStyle = '#6d7272';
    ctx.fillRect(w * 0.82, h * 0.55, w * 0.1, h * 0.014);
  } else {
    const gradient = ctx.createLinearGradient(0, 0, w, h);
    gradient.addColorStop(0, '#ffffff88');
    gradient.addColorStop(0.48, '#ffffff00');
    gradient.addColorStop(1, '#52748144');
    ctx.fillStyle = gradient;
    ctx.fillRect(border, border, w - 2 * border, h - 2 * border);
    if (kind === 'window') {
      ctx.fillStyle = '#e1e4e2';
      ctx.fillRect(w * 0.49, 0, w * 0.025, h);
      ctx.fillRect(0, h * 0.49, w, h * 0.025);
    }
  }
  return canvas;
}
/** Transparent model image seen through the same room camera, then cropped to the model. */
export async function renderReconstructionTemplate(
  options: TemplateOptions,
): Promise<{ blob: Blob; anchor: Point }> {
  if (options.version !== 2 && ['mirror', 'door', 'window'].includes(options.kind))
    return {
      blob: await canvasBlob(planarCanvas(options.kind, options.color, options.widthMm, options.heightMm)),
      anchor: { x: 0.5, y: options.kind === 'door' ? 1 : 0.5 },
    };
  const scene = new Scene(),
    group = createTemplateModel(options);
  const { origin, angle } = reconstructionModelTransform(options.room, options);
  group.position.copy(origin);
  group.rotation.y = angle;
  scene.add(group, new AmbientLight('#ffffff', 1.6));
  const light = new DirectionalLight('#ffffff', 1.65);
  light.position.set(-1500, 4000, 6000);
  const fill = new DirectionalLight('#e8f0f5', 0.28);
  fill.position.set(3500, 2200, 2000);
  scene.add(light, fill);
  const camera = createRoomCamera(options.room, options.aspect);
  scene.updateMatrixWorld(true);
  const { left, right, top, bottom } = reconstructionVolumeProjection(options.room, options, options.aspect);
  const fullWidth = 1536,
    fullHeight = Math.round(fullWidth / options.aspect);
  const x = left * fullWidth,
    y = top * fullHeight;
  const cropWidth = (right - left) * fullWidth,
    cropHeight = (bottom - top) * fullHeight;
  if (cropWidth < 1 || cropHeight < 1 || cropWidth > 8192 || cropHeight > 8192) {
    disposeTemplateModel(group);
    throw new Error('기본 모형이 공간에 비해 너무 커요. 규격을 줄여 주세요.');
  }
  const factor = Math.min(4, 2048 / Math.max(cropWidth, cropHeight));
  let renderer: WebGLRenderer | undefined;
  try {
    renderer = new WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
    renderer.setSize(
      Math.max(1, Math.round(cropWidth * factor)),
      Math.max(1, Math.round(cropHeight * factor)),
      false,
    );
    renderer.setPixelRatio(1);
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.toneMapping = NoToneMapping;
    renderer.setClearColor('#000000', 0);
    camera.setViewOffset(fullWidth, fullHeight, x, y, cropWidth, cropHeight);
    renderer.render(scene, camera);
    if (renderer.getContext().isContextLost()) throw new Error('기본 모형 생성 중 그래픽 연결이 끊겼어요.');
    const base = origin.clone().project(createRoomCamera(options.room, options.aspect));
    return {
      blob: await canvasBlob(renderer.domElement),
      anchor: {
        x: Math.max(0, Math.min(1, (((base.x + 1) / 2) * fullWidth - x) / cropWidth)),
        y: Math.max(0, Math.min(1, (((1 - base.y) / 2) * fullHeight - y) / cropHeight)),
      },
    };
  } finally {
    disposeTemplateModel(group);
    renderer?.dispose();
    renderer?.forceContextLoss();
  }
}
