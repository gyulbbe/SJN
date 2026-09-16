import { fixtureVariantErrors } from './fixture-variants';
import type { ObservedSupportContact } from './observed-support-contact';
import { raisedGlassSupportErrors, reconstructionLocalBoxes } from './raised-glass-support';
import { Matrix4, PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { homography, validateQuad } from '../render/math';
import { validateRoomDimensions, roomFacePoint } from '../room-geometry';
import type { ProductBounds, RoomDefinition, RoomDimensions, RoomFace } from '../room-types';
import type { Point, Quad } from '../types';
import type {
  SceneCandidate,
  SceneRelation,
  SceneRoomLayout,
  SourceRoomCorner,
  SourceRoomLine,
} from './pipeline-contract';
import { OBSERVED_ANCHOR_BOUNDS_TOLERANCE } from './pipeline-contract';
import { reconstructionModelTransform, type VolumePlacement } from './projection';

export const SOURCE_CAMERA_REVISION = 2;
export type SourceCamera = {
  version: 1;
  positionMm: [number, number, number];
  quaternion: [number, number, number, number];
  verticalFovDegrees: number;
  image: { width: number; height: number };
};
export type SourceReprojection = {
  rmsPx: number;
  maxPx: number;
  observations: { corner: SourceRoomCorner; observed: Point; projected: Point; errorPx: number }[];
  /** Fitted observations, not independent detection accuracy. */
  scope: 'observed-room-corners';
  lineConstraints?: { axis: SourceRoomLine['axis']; start: Point; end: Point; errorPx: number }[];
  maxLineErrorPx?: number;
};
export type SourceCameraFit = {
  status: 'estimated' | 'held';
  camera?: SourceCamera;
  reprojection?: SourceReprojection;
  reasons: string[];
  assumptions: string[];
  method: 'back-wall-pinhole' | 'room-corners-pinhole' | 'room-lines-pinhole' | 'depth-room-planes' | 'none';
  intrinsics: 'estimated' | 'supplied' | 'unresolved';
};
export type SourcePlacement = {
  candidateId: string;
  status: 'estimated' | 'held';
  placement?: { face: RoomFace; u: number; v: number; baseHeightMm: number };
  anchor?: { point: Point; worldMm: [number, number, number]; source: 'model' | 'geometry' };
  reprojectionErrorPx?: number;
  /** Independently matched support contour; never inserted into the model's observed anchor. */
  supportEvidence?: ObservedSupportContact;
  /** Filled only after independent baseline placement succeeds; original model fields stay untouched. */
  derivedInstallation?: { mode: 'floor' | 'wall'; wall?: Exclude<RoomFace, 'floor'>; source: 'geometry' };
  /** Independent baseline plane reuse; does not establish a source-camera pose. */
  baselineEvidence?: {
    candidateId: string;
    planeId: string;
    intersectionOverUnion: number;
    matchMode?: 'bounds-overlap' | 'pedestal-bowl-part';
    candidateCoverage?: number;
    point: Point;
    /** The baseline lower contour is only assumed to be a front contact, not a measured footprint. */
    pointRole?: 'estimated-front-contact' | 'lower-contour' | 'bounds-center';
    assumedYawDegrees?: number;
    /** Normalized intervals used by the mapper; explicit values still describe estimates. */
    planeExtent?: {
      face: RoomFace;
      depthStart: number;
      depthEnd: number;
      horizontalStart?: number;
      horizontalEnd?: number;
      horizontalDefaulted?: boolean;
      verticalStart?: number;
      verticalEnd?: number;
      confirmed: boolean;
    };
  };
  reasons: string[];
  provenance: { position: 'geometry' | 'user'; dimensions: 'default' | 'user' };
};

const BACK_CORNERS: SourceRoomCorner[] = [
  'back-top-left',
  'back-top-right',
  'back-bottom-right',
  'back-bottom-left',
];
const validPoint = (p: Point) =>
  Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1;
const pxDistance = (a: Point, b: Point, image: SourceCamera['image']) =>
  Math.hypot((a.x - b.x) * image.width, (a.y - b.y) * image.height);

export function sourceRoomCornerPoint(room: RoomDimensions, corner: SourceRoomCorner): Vector3 {
  return new Vector3(
    (corner.endsWith('left') ? -0.5 : 0.5) * room.widthMm,
    corner.includes('-top-') ? room.heightMm : 0,
    corner.startsWith('front-') ? room.depthMm : 0,
  );
}

/** Math only: creates no renderer/context and never replaces the editor's common room camera. */
export function createSourceCamera(source: SourceCamera): PerspectiveCamera {
  if (
    ![
      ...source.positionMm,
      ...source.quaternion,
      source.verticalFovDegrees,
      source.image.width,
      source.image.height,
    ].every(Number.isFinite) ||
    source.image.width <= 0 ||
    source.image.height <= 0 ||
    source.verticalFovDegrees < 5 ||
    source.verticalFovDegrees > 150 ||
    Math.abs(Math.hypot(...source.quaternion) - 1) > 1e-5
  )
    throw new Error('원본 시점 값이 올바르지 않습니다.');
  const camera = new PerspectiveCamera(
    source.verticalFovDegrees,
    source.image.width / source.image.height,
    0.1,
    1e7,
  );
  camera.position.fromArray(source.positionMm);
  camera.quaternion.fromArray(source.quaternion).normalize();
  camera.updateMatrixWorld(true);
  return camera;
}

export function projectSourcePoint(source: SourceCamera, world: Vector3 | [number, number, number]) {
  const camera = createSourceCamera(source);
  const point = Array.isArray(world) ? new Vector3(...world) : world.clone();
  const local = point.clone().applyMatrix4(camera.matrixWorldInverse);
  const ndc = point.project(camera);
  return {
    point: { x: (ndc.x + 1) / 2, y: (1 - ndc.y) / 2 },
    inFront: local.z < -0.1,
    inFrame: local.z < -0.1 && Math.abs(ndc.x) <= 1 && Math.abs(ndc.y) <= 1,
  };
}

function poseFromWall(
  room: RoomDimensions,
  quad: Quad,
  image: SourceCamera['image'],
  fov: number,
): SourceCamera {
  const aspect = image.width / image.height;
  const h = homography(
    [
      { x: -room.widthMm / 2, y: room.heightMm },
      { x: room.widthMm / 2, y: room.heightMm },
      { x: room.widthMm / 2, y: 0 },
      { x: -room.widthMm / 2, y: 0 },
    ],
    quad.map((p) => ({ x: (p.x - 0.5) * aspect, y: p.y - 0.5 })) as Quad,
  );
  const focal = 1 / (2 * Math.tan((fov * Math.PI) / 360));
  const a = new Vector3(h[0] / focal, h[3] / focal, h[6]);
  const b = new Vector3(h[1] / focal, h[4] / focal, h[7]);
  const scale = 2 / (a.length() + b.length());
  const r1 = a.normalize();
  const r2 = b.addScaledVector(r1, -b.dot(r1)).normalize();
  const r3 = new Vector3().crossVectors(r1, r2).normalize();
  const cvRotation = new Matrix4().makeBasis(r1, r2, r3);
  const translation = new Vector3(h[2] / focal, h[5] / focal, 1).multiplyScalar(scale);
  const position = translation.clone().negate().applyMatrix4(cvRotation.clone().transpose());
  // Computer vision uses image-down/+forward; Three uses image-up/-forward.
  const worldToCamera = new Matrix4().set(
    r1.x,
    r2.x,
    r3.x,
    0,
    -r1.y,
    -r2.y,
    -r3.y,
    0,
    -r1.z,
    -r2.z,
    -r3.z,
    0,
    0,
    0,
    0,
    1,
  );
  const rotation = new Quaternion().setFromRotationMatrix(worldToCamera.transpose()).normalize();
  return {
    version: 1,
    positionMm: position.toArray() as SourceCamera['positionMm'],
    quaternion: rotation.toArray() as SourceCamera['quaternion'],
    verticalFovDegrees: fov,
    image: { ...image },
  };
}

function lineReprojection(source: SourceCamera, lines: SourceRoomLine[]) {
  const camera = createSourceCamera(source);
  const focal = 1 / (2 * Math.tan((source.verticalFovDegrees * Math.PI) / 360));
  const metric = (point: Point) =>
    new Vector3(((point.x - 0.5) * source.image.width) / source.image.height, point.y - 0.5, 1);
  return lines.map((line) => {
    const direction = new Vector3(
      line.axis === 'width' ? 1 : 0,
      line.axis === 'height' ? 1 : 0,
      line.axis === 'depth' ? 1 : 0,
    ).transformDirection(camera.matrixWorldInverse);
    const vanishing = new Vector3(direction.x * focal, -direction.y * focal, -direction.z);
    const a = metric(line.start),
      b = metric(line.end);
    const centre = a.clone().add(b).multiplyScalar(0.5);
    const expected = new Vector3().crossVectors(centre, vanishing);
    const length = Math.hypot(expected.x, expected.y);
    const errorPx =
      length < 1e-12
        ? Infinity
        : (Math.max(Math.abs(expected.dot(a)), Math.abs(expected.dot(b))) / length) * source.image.height;
    return { axis: line.axis, start: { ...line.start }, end: { ...line.end }, errorPx };
  });
}

function reproject(
  room: RoomDimensions,
  camera: SourceCamera,
  observations: { corner: SourceRoomCorner; point: Point }[],
  lines: SourceRoomLine[] = [],
): SourceReprojection {
  const entries = observations.map(({ corner, point }) => {
    const result = projectSourcePoint(camera, sourceRoomCornerPoint(room, corner));
    const errorPx = result.inFront ? pxDistance(point, result.point, camera.image) : Infinity;
    return { corner, observed: { ...point }, projected: result.point, errorPx };
  });
  return {
    rmsPx: Math.sqrt(entries.reduce((sum, entry) => sum + entry.errorPx ** 2, 0) / entries.length),
    maxPx: Math.max(...entries.map((entry) => entry.errorPx)),
    observations: entries,
    scope: 'observed-room-corners',
    ...(lines.length
      ? {
          lineConstraints: lineReprojection(camera, lines),
          maxLineErrorPx: Math.max(...lineReprojection(camera, lines).map((line) => line.errorPx)),
        }
      : {}),
  };
}

/** Pivoted normal equations for this small, normalized overdetermined camera fit. */
function leastSquares(rows: number[][], values: number[]): number[] | undefined {
  const size = rows[0].length;
  const matrix = Array.from({ length: size }, (_, i) =>
    Array.from({ length: size + 1 }, (_, j) =>
      rows.reduce((sum, row, index) => sum + row[i] * (j === size ? values[index] : row[j]), 0),
    ),
  );
  const norm = Math.max(...matrix.flat().map(Math.abs));
  for (let col = 0; col < size; col++) {
    let pivot = col;
    for (let row = col + 1; row < size; row++)
      if (Math.abs(matrix[row][col]) > Math.abs(matrix[pivot][col])) pivot = row;
    if (Math.abs(matrix[pivot][col]) < Math.max(1e-12, norm * 1e-10)) return undefined;
    [matrix[pivot], matrix[col]] = [matrix[col], matrix[pivot]];
    const value = matrix[col][col];
    for (let j = col; j <= size; j++) matrix[col][j] /= value;
    for (let row = 0; row < size; row++)
      if (row !== col) {
        const ratio = matrix[row][col];
        for (let j = col; j <= size; j++) matrix[row][j] -= ratio * matrix[col][j];
      }
  }
  return matrix.map((row) => row[size]);
}

/** Six or more actual non-coplanar corners can constrain a camera even with a cropped back wall. */
function poseFromCorners(
  room: RoomDimensions,
  observations: { corner: SourceRoomCorner; point: Point }[],
  image: SourceCamera['image'],
  suppliedFov?: number,
): SourceCamera | undefined {
  if (observations.length < 6) return undefined;
  const worldScale = Math.max(room.widthMm, room.depthMm, room.heightMm);
  const rows: number[][] = [],
    values: number[] = [];
  for (const observation of observations) {
    const [x, y, z] = sourceRoomCornerPoint(room, observation.corner).divideScalar(worldScale).toArray();
    const u = ((observation.point.x - 0.5) * image.width) / image.height,
      v = observation.point.y - 0.5;
    rows.push([x, y, z, 1, 0, 0, 0, 0, -u * x, -u * y, -u * z]);
    values.push(u);
    rows.push([0, 0, 0, 0, x, y, z, 1, -v * x, -v * y, -v * z]);
    values.push(v);
  }
  const p = leastSquares(rows, values);
  if (!p) return undefined;
  const a = new Vector3(p[0], p[1], p[2]),
    b = new Vector3(p[4], p[5], p[6]),
    c = new Vector3(p[8], p[9], p[10]);
  const scale = c.length();
  if (scale < 1e-8) return undefined;
  const focal =
    suppliedFov === undefined
      ? (a.length() + b.length()) / (2 * scale)
      : 1 / (2 * Math.tan((suppliedFov * Math.PI) / 360));
  const fov = (2 * Math.atan(1 / (2 * focal)) * 180) / Math.PI;
  if (!Number.isFinite(fov) || fov < 10 || fov > 130) return undefined;
  const forward = c.normalize();
  const right = a.addScaledVector(forward, -a.dot(forward)).normalize();
  const down = new Vector3().crossVectors(forward, right).normalize();
  if (down.dot(b) <= 0) return undefined;
  const translation = new Vector3(p[3] / focal, p[7] / focal, 1).divideScalar(scale);
  const cvRotation = new Matrix4().set(
    right.x,
    right.y,
    right.z,
    0,
    down.x,
    down.y,
    down.z,
    0,
    forward.x,
    forward.y,
    forward.z,
    0,
    0,
    0,
    0,
    1,
  );
  const position = translation
    .negate()
    .applyMatrix4(cvRotation.clone().transpose())
    .multiplyScalar(worldScale);
  const worldToCamera = new Matrix4().set(
    right.x,
    right.y,
    right.z,
    0,
    -down.x,
    -down.y,
    -down.z,
    0,
    -forward.x,
    -forward.y,
    -forward.z,
    0,
    0,
    0,
    0,
    1,
  );
  const rotation = new Quaternion().setFromRotationMatrix(worldToCamera.transpose()).normalize();
  return {
    version: 1,
    positionMm: position.toArray() as SourceCamera['positionMm'],
    quaternion: rotation.toArray() as SourceCamera['quaternion'],
    verticalFovDegrees: fov,
    image: { ...image },
  };
}

function lineVanishingPoint(lines: SourceRoomLine[], image: SourceCamera['image']): Vector3 | undefined {
  if (lines.length < 2) return undefined;
  const equations = lines.map((line) => {
    const a = new Vector3(((line.start.x - 0.5) * image.width) / image.height, line.start.y - 0.5, 1);
    const b = new Vector3(((line.end.x - 0.5) * image.width) / image.height, line.end.y - 0.5, 1);
    return a.cross(b).normalize();
  });
  let best: Vector3 | undefined,
    bestScore = Infinity;
  for (let i = 0; i < equations.length; i++)
    for (let j = i + 1; j < equations.length; j++) {
      const point = new Vector3().crossVectors(equations[i], equations[j]);
      if (point.length() < 1e-6) continue;
      point.normalize();
      const score = equations.reduce((sum, line) => sum + line.dot(point) ** 2, 0);
      if (score < bestScore) {
        best = point;
        bestScore = score;
      }
    }
  return best;
}

function poseFromRoomLines(
  room: RoomDimensions,
  observations: { corner: SourceRoomCorner; point: Point }[],
  lines: SourceRoomLine[],
  image: SourceCamera['image'],
  suppliedFov?: number,
) {
  if (observations.length < 2) return undefined;
  const axes = ['width', 'height', 'depth'] as const;
  const points = axes.map((axis) =>
    lineVanishingPoint(
      lines.filter((line) => line.axis === axis),
      image,
    ),
  );
  const available = points.flatMap((point, index) => (point ? [index] : []));
  if (available.length < 2) return undefined;
  let focal: number;
  if (suppliedFov !== undefined) focal = 1 / (2 * Math.tan((suppliedFov * Math.PI) / 360));
  else {
    let numerator = 0,
      denominator = 0;
    for (let i = 0; i < available.length; i++)
      for (let j = i + 1; j < available.length; j++) {
        const a = points[available[i]]!,
          b = points[available[j]]!;
        const z = a.z * b.z;
        numerator -= z * (a.x * b.x + a.y * b.y);
        denominator += z * z;
      }
    if (denominator < 1e-12 || numerator <= 0) return undefined;
    focal = Math.sqrt(numerator / denominator);
  }
  const fov = (2 * Math.atan(1 / (2 * focal)) * 180) / Math.PI;
  if (!Number.isFinite(fov) || fov < 10 || fov > 130) return undefined;
  const first = available[0],
    second = available[1],
    worldScale = Math.max(room.widthMm, room.depthMm, room.heightMm);
  let best: { camera: SourceCamera; reprojection: SourceReprojection; score: number } | undefined;
  for (const firstSign of [-1, 1])
    for (const secondSign of [-1, 1]) {
      const directions: Vector3[] = [];
      directions[first] = new Vector3(points[first]!.x / focal, points[first]!.y / focal, points[first]!.z)
        .normalize()
        .multiplyScalar(firstSign);
      directions[second] = new Vector3(
        points[second]!.x / focal,
        points[second]!.y / focal,
        points[second]!.z,
      ).multiplyScalar(secondSign);
      directions[second]
        .addScaledVector(directions[first], -directions[second].dot(directions[first]))
        .normalize();
      if (!directions[0])
        directions[0] = new Vector3().crossVectors(directions[1], directions[2]).normalize();
      if (!directions[1])
        directions[1] = new Vector3().crossVectors(directions[2], directions[0]).normalize();
      if (!directions[2])
        directions[2] = new Vector3().crossVectors(directions[0], directions[1]).normalize();
      const cv = new Matrix4().makeBasis(directions[0], directions[1], directions[2]);
      const rows: number[][] = [],
        values: number[] = [];
      for (const observation of observations) {
        const point = sourceRoomCornerPoint(room, observation.corner)
          .divideScalar(worldScale)
          .applyMatrix4(cv);
        const x = ((observation.point.x - 0.5) * image.width) / image.height / focal,
          y = (observation.point.y - 0.5) / focal;
        rows.push([1, 0, -x]);
        values.push(x * point.z - point.x);
        rows.push([0, 1, -y]);
        values.push(y * point.z - point.y);
      }
      const translation = leastSquares(rows, values);
      if (!translation) continue;
      const position = new Vector3(...(translation as [number, number, number]))
        .negate()
        .applyMatrix4(cv.clone().transpose())
        .multiplyScalar(worldScale);
      if (
        position.z <= 0 ||
        position.y <= 0 ||
        position.y > room.heightMm ||
        Math.abs(position.x) > room.widthMm * 3
      )
        continue;
      const [x, y, z] = directions;
      const rotation = new Quaternion()
        .setFromRotationMatrix(
          new Matrix4()
            .set(x.x, y.x, z.x, 0, -x.y, -y.y, -z.y, 0, -x.z, -y.z, -z.z, 0, 0, 0, 0, 1)
            .transpose(),
        )
        .normalize();
      const camera: SourceCamera = {
        version: 1,
        image: { ...image },
        positionMm: position.toArray() as SourceCamera['positionMm'],
        quaternion: rotation.toArray() as SourceCamera['quaternion'],
        verticalFovDegrees: fov,
      };
      const reprojection = reproject(room, camera, observations, lines);
      const score = reprojection.rmsPx + (reprojection.maxLineErrorPx ?? 0);
      if (!best || score < best.score) best = { camera, reprojection, score };
    }
  return best;
}

/** Fits actual observed corners; a fronto-parallel rectangle alone cannot determine focal length. */
export function fitSourceCamera(
  room: RoomDimensions,
  image: SourceCamera['image'],
  layout: SceneRoomLayout,
  options: { verticalFovDegrees?: number; maxReprojectionPx?: number } = {},
): SourceCameraFit {
  const assumptions = [
    '직사각형 방과 입력한 방 치수를 사용합니다.',
    '주점은 원본 이미지 중심이며 렌즈 왜곡은 없다고 가정합니다.',
  ];
  const held = (reason: string, extra: Partial<SourceCameraFit> = {}): SourceCameraFit => ({
    status: 'held',
    method: 'none',
    intrinsics: 'unresolved',
    reasons: [reason],
    assumptions,
    ...extra,
  });
  if (
    !validateRoomDimensions(room) ||
    !Number.isInteger(image.width) ||
    !Number.isInteger(image.height) ||
    image.width <= 0 ||
    image.height <= 0
  )
    return held('방 치수 또는 원본 이미지 크기가 올바르지 않습니다.');
  if (layout.orthogonal !== true)
    return held(
      layout.orthogonal === false
        ? '직각이 아닌 공간은 현재 직사각형 기하로 맞출 수 없습니다.'
        : '벽과 바닥이 직각인 공간인지 확인이 필요합니다.',
    );
  const lines = layout.lines ?? [];
  if (
    lines.some(
      (line) =>
        !['width', 'height', 'depth'].includes(line.axis) ||
        !validPoint(line.start) ||
        !validPoint(line.end) ||
        pxDistance(line.start, line.end, image) < 10 ||
        !line.evidence.some((text) => text.trim()),
    )
  )
    return held('소실 방향 선분의 실제 관측 근거와 이미지 안의 두 끝점이 필요합니다.');
  const named = layout.corners ?? [];
  if (named.some((entry) => !entry.evidence.some((text) => text.trim())))
    return held('방 모서리에는 실제로 관측한 근거가 필요합니다.');
  if (layout.backWallQuad && !layout.evidence.some((text) => text.trim()))
    return held('뒤 벽 네 모서리를 실제로 관측한 근거가 필요합니다.');
  if (
    new Set(named.map((entry) => entry.corner)).size !== named.length ||
    named.some((entry) => !validPoint(entry.point))
  )
    return held('방 모서리 관측이 중복되거나 이미지 범위 밖입니다.');
  const supplied = options.verticalFovDegrees;
  if (supplied !== undefined && (!Number.isFinite(supplied) || supplied < 10 || supplied > 130))
    return held('명시한 수직 화각은 10–130도여야 합니다.');
  const threshold = options.maxReprojectionPx ?? Math.max(3, Math.hypot(image.width, image.height) * 0.012);
  if (!Number.isFinite(threshold) || threshold <= 0) return held('재투영 오차 기준이 올바르지 않습니다.');
  const fromNamed = BACK_CORNERS.map((name) => named.find((entry) => entry.corner === name)?.point);
  const quad = layout.backWallQuad ?? (fromNamed.every(Boolean) ? (fromNamed as Quad) : undefined);
  if (!quad || quad.length !== 4) {
    const direct = poseFromCorners(room, named, image, supplied);
    const lineFit = direct ? undefined : poseFromRoomLines(room, named, lines, image, supplied);
    const camera = direct ?? lineFit?.camera;
    if (!camera)
      return held(
        '방 모서리 또는 직교 선분과 거리 기준을 충분히 관측하지 못했습니다. 선분만으로 촬영 거리와 스케일을 임의로 정하지 않습니다.',
      );
    const method = direct ? ('room-corners-pinhole' as const) : ('room-lines-pinhole' as const);
    const reprojection = reproject(room, camera, named, lines);
    const [x, y, z] = camera.positionMm;
    if (
      reprojection.maxPx > threshold ||
      (reprojection.maxLineErrorPx ?? 0) > threshold ||
      z <= 0 ||
      y <= 0 ||
      y >= room.heightMm ||
      Math.abs(x) > room.widthMm * 3 ||
      z > room.depthMm + Math.max(room.widthMm, room.heightMm) * 20
    )
      return held(
        '방 모서리와 직각 카메라 모델의 재투영이 일치하지 않습니다. 모서리·치수·크롭을 확인해 주세요.',
        { method, reprojection },
      );
    return {
      status: 'estimated',
      method,
      intrinsics: supplied === undefined ? 'estimated' : 'supplied',
      camera,
      reprojection,
      reasons: [...layout.uncertainty],
      assumptions: [
        ...assumptions,
        direct
          ? '서로 다른 깊이의 실제 관측 모서리로 시점과 화각을 적합했습니다. 실측 카메라 보정값이 아닙니다.'
          : '관측 직교 선분과 실제 방 모서리 사이의 거리로 시점을 적합했습니다. 실측 카메라 보정값이 아닙니다.',
      ],
    };
  }
  if (quad.some((p) => !validPoint(p)) || !validateQuad(quad))
    return held('뒤 벽 모서리는 이미지 안의 서로 겹치지 않는 네 점이어야 합니다.');
  const area =
    Math.abs(quad.reduce((sum, p, i) => sum + p.x * quad[(i + 1) % 4].y - p.y * quad[(i + 1) % 4].x, 0)) / 2;
  if (area < 0.005) return held('뒤 벽의 관측 면적이 너무 작아 시점을 안정적으로 추정할 수 없습니다.');
  const observations = BACK_CORNERS.map((corner, i) => ({ corner, point: quad[i] }));
  for (const entry of named) {
    const existing = observations.find((observation) => observation.corner === entry.corner);
    if (existing && pxDistance(existing.point, entry.point, image) > 2)
      return held('같은 뒤 벽 모서리에 서로 다른 관측 좌표가 있습니다.');
    if (!existing) observations.push(entry);
  }
  try {
    const evaluate = (fov: number) => {
      const camera = poseFromWall(room, quad, image, fov);
      const reprojection = reproject(room, camera, observations, lines);
      return { camera, reprojection, score: reprojection.rmsPx + (reprojection.maxLineErrorPx ?? 0) };
    };
    let best = evaluate(supplied ?? 60);
    if (supplied === undefined) {
      const samples = Array.from({ length: 61 }, (_, i) => evaluate(10 + i * 2));
      best = samples.reduce((a, b) => (a.score < b.score ? a : b));
      if (!Number.isFinite(best.score)) return held('관측 모서리를 향하는 원본 시점을 계산할 수 없습니다.');
      if (Math.max(...samples.map((sample) => sample.score)) - best.score < 0.01)
        return held(
          '정면에 가까운 뒤 벽 네 점만으로 초점거리와 촬영 거리를 구분할 수 없습니다. 추가 방 모서리 또는 촬영 화각이 필요합니다.',
        );
      let lo = Math.max(10, best.camera.verticalFovDegrees - 2),
        hi = Math.min(130, best.camera.verticalFovDegrees + 2);
      for (let i = 0; i < 36; i++) {
        const a = evaluate(lo + (hi - lo) / 3),
          b = evaluate(hi - (hi - lo) / 3);
        if (a.score < b.score) hi = b.camera.verticalFovDegrees;
        else lo = a.camera.verticalFovDegrees;
      }
      best = evaluate((lo + hi) / 2);
      if (best.camera.verticalFovDegrees < 10.1 || best.camera.verticalFovDegrees > 129.9)
        return held('관측 모서리와 방 치수로 안정적인 촬영 화각을 찾지 못했습니다.', {
          method: 'back-wall-pinhole',
          reprojection: best.reprojection,
        });
      const lower = evaluate(Math.max(10, best.camera.verticalFovDegrees - 8));
      const upper = evaluate(Math.min(130, best.camera.verticalFovDegrees + 8));
      if (Math.max(lower.score, upper.score) - best.score < 0.1)
        return held('촬영 화각 변화에 대한 관측 근거가 약해 시점과 깊이를 확정하지 않습니다.', {
          method: 'back-wall-pinhole',
          reprojection: best.reprojection,
        });
    }
    const threshold = options.maxReprojectionPx ?? Math.max(3, Math.hypot(image.width, image.height) * 0.012);
    if (!Number.isFinite(threshold) || threshold <= 0) return held('재투영 오차 기준이 올바르지 않습니다.');
    if (best.reprojection.maxPx > threshold || (best.reprojection.maxLineErrorPx ?? 0) > threshold)
      return held('방 모서리 재투영 오차가 큽니다. 모서리·방 치수·크롭 여부를 확인해 주세요.', {
        method: 'back-wall-pinhole',
        reprojection: best.reprojection,
      });
    const [x, y, z] = best.camera.positionMm;
    if (
      z <= 0 ||
      y <= 0 ||
      y >= room.heightMm ||
      Math.abs(x) > room.widthMm * 3 ||
      z > room.depthMm + Math.max(room.widthMm, room.heightMm) * 20
    )
      return held('계산된 촬영 위치가 현재 방 모델의 관측 조건과 맞지 않습니다.', {
        method: 'back-wall-pinhole',
        reprojection: best.reprojection,
      });
    return {
      status: 'estimated',
      method: 'back-wall-pinhole',
      intrinsics: supplied === undefined ? 'estimated' : 'supplied',
      camera: best.camera,
      reprojection: best.reprojection,
      reasons: [...layout.uncertainty],
      assumptions: [
        ...assumptions,
        supplied === undefined
          ? '화각은 관측 모서리와 직각 제약으로 추정했으며 실측값이 아닙니다.'
          : '수직 화각은 호출자가 명시한 값을 사용했습니다.',
      ],
    };
  } catch {
    return held('관측 모서리의 원근을 계산할 수 없습니다.');
  }
}

/** Ray/plane inversion keeps out-of-room intersections visible to the caller instead of clamping. */
export function unprojectSourceToFace(
  room: RoomDimensions,
  source: SourceCamera,
  point: Point,
  face: RoomFace,
) {
  if (!validPoint(point)) return undefined;
  const camera = createSourceCamera(source);
  const ray = new Vector3(point.x * 2 - 1, 1 - point.y * 2, 0.5)
    .unproject(camera)
    .sub(camera.position)
    .normalize();
  const axis = face === 'floor' ? 'y' : face === 'back' ? 'z' : 'x';
  const boundary = face === 'left' ? -room.widthMm / 2 : face === 'right' ? room.widthMm / 2 : 0;
  if (Math.abs(ray[axis]) < 1e-8) return undefined;
  const distance = (boundary - camera.position[axis]) / ray[axis];
  if (distance <= 0) return undefined;
  const world = camera.position.clone().addScaledVector(ray, distance);
  const u =
    face === 'left'
      ? 1 - world.z / room.depthMm
      : face === 'right'
        ? world.z / room.depthMm
        : world.x / room.widthMm + 0.5;
  const v = face === 'floor' ? world.z / room.depthMm : 1 - world.y / room.heightMm;
  return {
    worldMm: world.toArray() as [number, number, number],
    face,
    u,
    v,
    inFace: u >= -1e-6 && u <= 1 + 1e-6 && v >= -1e-6 && v <= 1 + 1e-6,
  };
}

/** Returns every candidate, including reflected/unknown/occluded ones, with an explicit hold reason. */
export function solveSourcePlacement(
  room: RoomDimensions,
  fit: SourceCameraFit,
  candidate: SceneCandidate,
  relations: SceneRelation[] = [],
  supportContact?: ObservedSupportContact,
): SourcePlacement {
  const result: SourcePlacement = {
    candidateId: candidate.id,
    status: 'held',
    reasons: [],
    provenance: { position: 'geometry', dimensions: 'default' },
  };
  if (candidate.validation?.issues.length)
    result.reasons.push(...candidate.validation.issues.map((issue) => issue.message));
  if (candidate.kind === 'unknown')
    result.reasons.push('설비 종류를 확인해야 표준 모형을 선택할 수 있습니다.');
  if (
    candidate.reflection !== 'physical' ||
    relations.some((relation) => relation.frontId === candidate.id && relation.relation === 'reflectionOf')
  )
    result.reasons.push('거울에 비친 설비인지 확인이 필요합니다. 후보를 삭제하지 않고 보류합니다.');
  if (candidate.mounting !== 'floor' && candidate.mounting !== 'wall')
    result.reasons.push('바닥 또는 벽 설치 위치를 확인해 주세요.');
  if (candidate.mounting === 'wall' && candidate.wall === 'unknown')
    result.reasons.push('부착할 벽을 확인해 주세요.');
  if (fit.status !== 'estimated' || !fit.camera)
    result.reasons.push('원본 시점을 확정하지 못해 위치를 임의로 생성하지 않습니다.');
  if (result.reasons.length || !fit.camera) return result;
  const bounds = candidate.bounds;
  if (
    ![bounds.left, bounds.top, bounds.right, bounds.bottom].every(Number.isFinite) ||
    bounds.left < 0 ||
    bounds.top < 0 ||
    bounds.right > 1 ||
    bounds.bottom > 1 ||
    bounds.left >= bounds.right ||
    bounds.top >= bounds.bottom
  ) {
    result.reasons.push('설비 사진 범위가 올바르지 않습니다.');
    return result;
  }
  if (candidate.anchor) {
    const point = candidate.anchor.point,
      tolerance = OBSERVED_ANCHOR_BOUNDS_TOLERANCE;
    if (
      !candidate.anchor.evidence.some((text) => text.trim()) ||
      !validPoint(point) ||
      point.x < bounds.left - tolerance ||
      point.x > bounds.right + tolerance ||
      point.y < bounds.top - tolerance ||
      point.y > bounds.bottom + tolerance
    ) {
      result.reasons.push(
        '접점 또는 부착점이 해당 설비 영역과 맞지 않거나 실제 관측 근거가 없습니다. 다른 물체의 기준점으로 대신 배치하지 않습니다.',
      );
      return result;
    }
  }
  const face = candidate.mounting === 'floor' ? 'floor' : (candidate.wall as RoomFace);
  const expectedAnchor = face === 'floor' ? 'floor-contact' : 'wall-attachment';
  if (candidate.anchor && candidate.anchor.kind !== expectedAnchor) {
    result.reasons.push('관측 기준점과 설치 방식이 서로 다릅니다.');
    return result;
  }
  if (supportContact) {
    const b = supportContact.baselineBounds;
    if (
      candidate.anchor ||
      candidate.kind !== 'basin' ||
      candidate.basinStyle !== 'pedestal' ||
      face !== 'floor' ||
      supportContact.candidateId !== candidate.id ||
      supportContact.source !== 'geometry' ||
      supportContact.kind !== 'floor-contact' ||
      supportContact.image.width !== fit.camera.image.width ||
      supportContact.image.height !== fit.camera.image.height ||
      !/^[0-9a-f]{64}$/.test(supportContact.inputFingerprint) ||
      !validPoint(supportContact.point) ||
      ![b.left, b.right, b.top, b.bottom].every(Number.isFinite) ||
      b.left >= b.right ||
      b.top >= b.bottom ||
      supportContact.point.x < b.left ||
      supportContact.point.x > b.right ||
      supportContact.point.y < b.top ||
      supportContact.point.y > b.bottom ||
      supportContact.evidence.interpretation !== 'support-contour-bottom-not-footprint-centre'
    ) {
      result.reasons.push('독립 지지대 관측의 대상·사진·설치 방식이 맞지 않아 접점을 적용하지 않았어요.');
      return result;
    }
    result.supportEvidence = structuredClone(supportContact);
    result.reasons.push(...supportContact.reasons);
  }
  if (
    candidate.kind === 'basin' &&
    candidate.basinStyle === 'pedestal' &&
    !candidate.anchor &&
    !supportContact
  ) {
    result.reasons.push(
      '기둥형 세면대의 하단 지지점을 확인해야 해요. 세면볼 사진 범위의 아래쪽을 바닥 접점으로 사용하지 않았어요.',
    );
    return result;
  }
  // A visible wall attachment does not reveal the bottom of a fixture cropped out of the photo.
  // An explicit floor-contact is different: it may remain observed inside a partially cropped object.
  if (face !== 'floor' && bounds.bottom >= 0.995) {
    result.reasons.push(
      '벽 설치 제품 하단이 사진 밖으로 잘렸어요. 보이는 부착점만으로 하단 높이를 알 수 없으니 설치 높이를 직접 확인해 주세요.',
    );
    return result;
  }
  if (face !== 'floor' && !candidate.anchor && (bounds.left <= 0.005 || bounds.right >= 0.995)) {
    result.reasons.push(
      '벽 설치 제품의 좌우 범위가 잘려 하단 중앙을 기준점으로 사용할 수 없어요. 부착 위치를 확인해 주세요.',
    );
    return result;
  }
  if (!candidate.anchor && !supportContact && bounds.bottom >= 0.995) {
    result.reasons.push('제품 하단이 사진 밖으로 잘려 접점 또는 부착점을 확인할 수 없습니다.');
    return result;
  }
  const point = supportContact?.point ??
    candidate.anchor?.point ?? { x: (bounds.left + bounds.right) / 2, y: bounds.bottom };
  const hit = unprojectSourceToFace(room, fit.camera, point, face);
  if (!hit || !hit.inFace) {
    result.reasons.push('관측 기준점을 선택한 설치 면으로 역투영하면 방 범위를 벗어납니다.');
    return result;
  }
  // An attachment can be near the rim/top of a wall fixture; it is not necessarily its bottom.
  // Keep the observed attachment for diagnostics and derive a separate, explicitly estimated base.
  const basePoint = face !== 'floor' && candidate.anchor ? { x: point.x, y: bounds.bottom } : point;
  const baseHit = basePoint.y === point.y ? hit : unprojectSourceToFace(room, fit.camera, basePoint, face);
  if (!baseHit || !baseHit.inFace) {
    result.reasons.push(
      '관측 부착점은 벽 안에 있지만 제품 하단의 높이를 확인할 수 없습니다. 설치 높이를 직접 확인해 주세요.',
    );
    return result;
  }
  result.status = 'estimated';
  result.placement = {
    face,
    u: hit.u,
    v: baseHit.v,
    baseHeightMm: face === 'floor' ? 0 : baseHit.worldMm[1],
  };
  if (basePoint.y !== point.y)
    result.reasons.push(
      '부착점과 제품 하단을 구분했어요. 사진 범위 하단을 벽으로 투영한 설치 높이는 돌출 깊이·가림의 영향을 받는 추정값이에요.',
    );
  result.anchor = {
    point: { ...point },
    worldMm: hit.worldMm,
    source: candidate.anchor ? 'model' : 'geometry',
  };
  result.reprojectionErrorPx = pxDistance(
    point,
    projectSourcePoint(fit.camera, hit.worldMm).point,
    fit.camera.image,
  );
  result.reasons.push(...candidate.uncertainty, ...(candidate.anchor?.uncertainty ?? []));
  if (supportContact)
    result.reasons.push(
      '지지대 윤곽 하단을 바닥 기준 위치로 사용한 추정이에요. 실제 접지 중심·제품 깊이·방향은 확인이 필요하며 재투영 잔차는 위치 정확도가 아니에요.',
    );
  if (!candidate.anchor && !supportContact)
    result.reasons.push(
      '관측 접점이 없어 사진 범위의 하단 중앙을 기준점으로 추정했습니다. 실제 부착 위치를 확인해 주세요.',
    );
  if (
    relations.some(
      (relation) =>
        relation.behindId === candidate.id &&
        (relation.relation === 'occludes' || relation.relation === 'visibleThrough'),
    )
  )
    result.reasons.push(
      '다른 설비 뒤에 보이는 후보를 유지했습니다. 가려진 기준점은 사용자 확인이 필요합니다.',
    );
  return result;
}

export type SourceFixtureCheck = {
  valid: boolean;
  reasons: string[];
  /** Physical nominal model bounds, retained even when the proposal is rejected. */
  worldBoundsMm?: { min: [number, number, number]; max: [number, number, number] };
  overflowMm?: { left: number; right: number; back: number; front: number; below: number; above: number };
  projectedBounds?: ProductBounds;
  bboxErrorPx?: number;
  visibleCornerCount: number;
};
/** Checks a proposed model without moving/shrinking it to conceal a placement failure. */
export function validateSourceFixture(
  room: RoomDefinition,
  source: SourceCamera | undefined,
  placement: VolumePlacement,
  observedBounds?: ProductBounds,
): SourceFixtureCheck {
  const reasons: string[] = [];
  const scalars = [
    placement.u,
    placement.v,
    placement.widthMm,
    placement.heightMm,
    placement.depthMm,
    placement.scale ?? 1,
    placement.baseHeightMm ?? 0,
    placement.yawDegrees ?? 0,
  ];
  if (
    !scalars.every(Number.isFinite) ||
    placement.widthMm <= 0 ||
    placement.heightMm <= 0 ||
    placement.depthMm <= 0 ||
    (placement.scale ?? 1) <= 0
  )
    return { valid: false, reasons: ['모형 크기 또는 위치가 올바르지 않습니다.'], visibleCornerCount: 0 };
  const { origin, angle, scale } = reconstructionModelTransform(room, placement);
  reasons.push(...fixtureVariantErrors(placement));
  const supportErrors = raisedGlassSupportErrors(placement);
  reasons.push(...supportErrors);
  const suspended = placement.kind === 'showerCurtain';
  if (suspended && (placement.version !== 2 || placement.face !== 'floor' || placement.support !== undefined))
    reasons.push('커튼은 독립 매달림 모형으로 공간 평면 위치와 하단 높이를 지정해야 해요.');
  if (
    suspended &&
    placement.curtainHardware !== undefined &&
    !['rod', 'track', 'none'].includes(placement.curtainHardware)
  )
    reasons.push('커튼 지지 방식이 올바르지 않아요.');
  const contactHeight = placement.support && supportErrors.length === 0 ? placement.support.heightMm : 0;
  if (
    !suspended &&
    supportErrors.length === 0 &&
    placement.face === 'floor' &&
    Math.abs(origin.y - contactHeight) > 1
  )
    reasons.push(
      placement.support && !supportErrors.length
        ? '유리 하단이 확인한 지지면에 닿지 않습니다.'
        : '바닥 설치 제품의 하단이 바닥에 닿지 않습니다.',
    );
  const world: Vector3[] = [];
  for (const box of reconstructionLocalBoxes(placement))
    for (const x of [box.min[0], box.max[0]])
      for (const y of [box.min[1], box.max[1]])
        for (const z of [box.min[2], box.max[2]])
          world.push(
            new Vector3(x * scale, y * scale, z * scale)
              .applyAxisAngle(new Vector3(0, 1, 0), angle)
              .add(origin),
          );
  const worldBoundsMm: NonNullable<SourceFixtureCheck['worldBoundsMm']> = {
    min: [
      Math.min(...world.map((p) => p.x)),
      Math.min(...world.map((p) => p.y)),
      Math.min(...world.map((p) => p.z)),
    ],
    max: [
      Math.max(...world.map((p) => p.x)),
      Math.max(...world.map((p) => p.y)),
      Math.max(...world.map((p) => p.z)),
    ],
  };
  const overflowMm = {
    left: Math.max(0, -room.widthMm / 2 - worldBoundsMm.min[0]),
    right: Math.max(0, worldBoundsMm.max[0] - room.widthMm / 2),
    back: Math.max(0, -worldBoundsMm.min[2]),
    front: Math.max(0, worldBoundsMm.max[2] - room.depthMm),
    below: Math.max(0, -worldBoundsMm.min[1]),
    above: Math.max(0, worldBoundsMm.max[1] - room.heightMm),
  };
  if (Object.values(overflowMm).some((distance) => distance > 1))
    reasons.push('기본 모형 일부가 방 또는 설치 벽 범위를 벗어납니다. 위치와 규격을 확인해 주세요.');
  if (placement.face !== 'floor') {
    const anchor = roomFacePoint(room, placement.face, placement.u, placement.v);
    if (placement.baseHeightMm !== undefined && Math.abs(anchor.y - placement.baseHeightMm) > 1)
      reasons.push('벽의 세로 위치와 설치 높이가 서로 다릅니다.');
  }
  if (!source)
    return { valid: reasons.length === 0, reasons, worldBoundsMm, overflowMm, visibleCornerCount: 0 };
  const projections = world.map((point) => projectSourcePoint(source, point));
  const visibleCornerCount = projections.filter((point) => point.inFrame).length;
  if (projections.some((point) => !point.inFront)) reasons.push('모형 일부가 원본 카메라 뒤에 있습니다.');
  const points = projections.map((entry) => entry.point);
  const bounds = {
    left: Math.min(...points.map((p) => p.x)),
    top: Math.min(...points.map((p) => p.y)),
    right: Math.max(...points.map((p) => p.x)),
    bottom: Math.max(...points.map((p) => p.y)),
  };
  if (bounds.right < 0 || bounds.bottom < 0 || bounds.left > 1 || bounds.top > 1)
    reasons.push('모형이 원본 사진의 보이는 범위를 벗어납니다.');
  const bboxErrorPx = observedBounds
    ? Math.sqrt(
        (((bounds.left - observedBounds.left) ** 2 + (bounds.right - observedBounds.right) ** 2) *
          source.image.width ** 2) /
          4 +
          (((bounds.top - observedBounds.top) ** 2 + (bounds.bottom - observedBounds.bottom) ** 2) *
            source.image.height ** 2) /
            4,
      )
    : undefined;
  return {
    valid: reasons.length === 0,
    reasons,
    worldBoundsMm,
    overflowMm,
    projectedBounds: bounds,
    bboxErrorPx,
    visibleCornerCount,
  };
}
