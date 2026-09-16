import { Matrix4, Quaternion, Vector3 } from 'three';
import { validateRoomDimensions } from '../room-geometry';
import type { RoomDefinition } from '../room-types';
import { unprojectSourceToFace, type SourceCameraFit } from './source-camera';
import type { Point } from '../types';

/** Offline model observations, NOT measured geometry or complete room boundaries. */
export type DepthPlaneObservation = {
  id: string;
  normalCamera: [number, number, number];
  /** n.p + offset = 0, in the model's estimated metres. */
  offset: number;
  medianPointCamera: [number, number, number];
  inlierCount: number;
  /** Fraction of the original semantic class support, not a calibrated confidence. */
  inlierFraction: number;
  imageAreaFraction: number;
  rmsResidual: number;
  /** Occupied observed support cells, never a full physical room face. */
  imageSupport?: {
    bounds: { left: number; top: number; right: number; bottom: number };
    width: 64;
    height: 64;
    occupied: string;
  };
};
export type DepthRoomObservation = {
  version: 1;
  inputFingerprint: string;
  image: { width: number; height: number };
  /** Full-frame inference raster, when integer resize rounding changes the pixel aspect slightly. */
  analysisImage?: { width: number; height: number };
  model: { id: string; revision: string };
  coordinateSystem: 'opencv-camera';
  scale: 'model-estimated-metres';
  intrinsics: { fx: number; fy: number; cx: number; cy: number };
  floor: DepthPlaneObservation | null;
  walls: DepthPlaneObservation[];
};
export type DepthWallSupportCheck = {
  point: Point;
  bounds?: { left: number; top: number; right: number; bottom: number };
  status: 'held' | 'estimated';
  reason: string;
  candidates: ({ face: 'back' | 'left' | 'right' } & ReturnType<typeof inspectDepthWallSupport>)[];
};
export type DepthRoomCameraResult = {
  fit: SourceCameraFit;
  selected?: { floorId: string; backId: string; sideId: string; side: 'left' | 'right' };
  rejectedPlanes: { id: string; reason: string }[];
  diagnostics: {
    scope: 'model-plane-consistency';
    wallSupportChecks?: DepthWallSupportCheck[];
    /** A good residual only measures agreement with the model, not reality. */
    maxOrthogonalityErrorDegrees?: number;
    axisAdjustmentDegrees?: number;
    scaleMmPerModelUnit: number;
    imageResampling?: { width: number; height: number; sourcePixelAspectRatio: number };
  };
};

const angle = (a: Vector3, b: Vector3) => (a.angleTo(b) * 180) / Math.PI;
const dotLimit = Math.sin((12 * Math.PI) / 180);

/**
 * Creates an opt-in experimental pose from independently observed floor + two walls.
 * It never promotes the visible floor polygon into four physical room corners. The most
 * camera-facing wall defines the back axis; ambiguous rotations or an absent side wall
 * leave the origin unresolved. No production model is downloaded or executed here.
 */
export function fitDepthRoomCamera(
  room: RoomDefinition,
  observation: DepthRoomObservation,
  expectedFingerprint: string,
): DepthRoomCameraResult {
  const result: DepthRoomCameraResult = {
    fit: {
      status: 'held',
      reasons: [],
      assumptions: [
        '깊이 모델이 추정한 거리와 방향이며 실측한 방 치수·카메라가 아니에요.',
        '서로 직각인 바닥과 두 벽을 가정하며, 사진에서 가장 정면인 관측 벽을 표준 공간의 뒤벽으로 정의해요.',
        '입력한 공간 크기를 유지해요. 사진에 보이지 않은 방 경계를 검출하거나 모델 거리를 방 크기에 맞춰 강제 축소하지 않아요.',
      ],
      method: 'depth-room-planes',
      intrinsics: 'estimated',
    },
    rejectedPlanes: [],
    diagnostics: { scope: 'model-plane-consistency', scaleMmPerModelUnit: 1000 },
  };
  const held = (reason: string) => {
    result.fit.reasons.push(reason);
    return result;
  };
  const intrinsics = observation.intrinsics;
  if (
    !validateRoomDimensions(room) ||
    observation.version !== 1 ||
    observation.coordinateSystem !== 'opencv-camera' ||
    observation.scale !== 'model-estimated-metres' ||
    !/^[0-9a-f]{64}$/.test(expectedFingerprint) ||
    observation.inputFingerprint !== expectedFingerprint ||
    !observation.model.id.trim() ||
    !observation.model.revision.trim() ||
    ![observation.image.width, observation.image.height].every((v) => Number.isInteger(v) && v > 0) ||
    ![intrinsics.fx, intrinsics.fy, intrinsics.cx, intrinsics.cy].every(Number.isFinite) ||
    intrinsics.fx <= 0 ||
    intrinsics.fy <= 0 ||
    observation.walls.length > 16
  )
    return held('기하 관측의 사진·버전·좌표계·카메라 입력이 맞지 않아요.');
  // Intrinsics belong to the full-frame analysis raster. Integer resize rounding is an
  // explicitly recorded approximation; arbitrary anisotropy/cropping remains unsupported.
  const raster = observation.analysisImage ?? observation.image;
  if (observation.analysisImage) {
    const scale = Math.max(raster.width, raster.height) / Math.max(observation.image.width, observation.image.height);
    if (![raster.width, raster.height].every(v => Number.isInteger(v) && v > 0) || scale > 1 ||
      Math.abs(raster.width - observation.image.width * scale) > 0.500001 ||
      Math.abs(raster.height - observation.image.height * scale) > 0.500001)
      return held('분석 이미지의 크기가 원본 전체 사진을 축소한 비율과 맞지 않아요.');
  }
  if (
    Math.abs(intrinsics.cx - 0.5) > 1e-6 ||
    Math.abs(intrinsics.cy - 0.5) > 1e-6 ||
    Math.abs((intrinsics.fx * raster.width) / (intrinsics.fy * raster.height) - 1) > 0.001
  )
    return held('현재 원본 시점 형식에서 표현할 수 없는 주점 또는 픽셀 비율이에요.');
  if (observation.analysisImage) {
    result.diagnostics.imageResampling = { ...raster,
      sourcePixelAspectRatio: (intrinsics.fx * observation.image.width) / (intrinsics.fy * observation.image.height) };
    result.fit.assumptions.push('분석 해상도 축소 시 정수 픽셀 반올림으로 생기는 미세한 가로세로 비율 차이는 원본 시점의 근사 오차에 포함돼요.');
  }
  const fov = (2 * Math.atan(0.5 / intrinsics.fy) * 180) / Math.PI;
  if (fov < 5 || fov > 150) return held('모델의 추정 화각이 지원 범위를 벗어났어요.');
  const seen = new Set<string>();
  const validate = (plane: DepthPlaneObservation) => {
    const normal = new Vector3(...plane.normalCamera);
    const point = new Vector3(...plane.medianPointCamera);
    let reason = '';
    if (!plane.id || seen.has(plane.id)) reason = '평면 ID가 비었거나 중복됐어요.';
    seen.add(plane.id);
    if (
      ![
        ...plane.normalCamera,
        ...plane.medianPointCamera,
        plane.offset,
        plane.rmsResidual,
        plane.inlierFraction,
        plane.imageAreaFraction,
      ].every(Number.isFinite) ||
      Math.abs(normal.length() - 1) > 1e-4 ||
      !Number.isInteger(plane.inlierCount) ||
      plane.inlierCount < 96 ||
      plane.inlierFraction < 0.05 ||
      plane.inlierFraction > 1 ||
      plane.imageAreaFraction < 0.01 ||
      plane.imageAreaFraction > 1 ||
      plane.rmsResidual < 0 ||
      plane.offset < 0.01 ||
      point.z <= 0
    )
      reason ||= '유한한 방향·거리와 충분한 평면 지지가 없어요.';
    if (
      plane.rmsResidual / plane.offset > 0.025 ||
      Math.abs(normal.dot(point) + plane.offset) / plane.offset > 0.04
    )
      reason ||= '평면 잔차가 커서 하나의 설치 면으로 사용하기 어려워요.';
    if (reason) {
      result.rejectedPlanes.push({ id: plane.id, reason });
      return undefined;
    }
    return { plane, normal, point };
  };
  const floor = observation.floor && validate(observation.floor);
  if (!floor || floor.normal.y > -0.35 || floor.plane.inlierFraction < 0.3)
    return held('바닥의 위쪽 방향과 카메라 높이를 지지하는 관측이 부족해요.');
  const walls = observation.walls.flatMap((plane) => {
    const entry = validate(plane);
    if (!entry) return [];
    if (Math.abs(entry.normal.dot(floor.normal)) > dotLimit) {
      result.rejectedPlanes.push({ id: plane.id, reason: '바닥에 수직인 벽 방향과 맞지 않아요.' });
      return [];
    }
    return [entry];
  });
  // Camera image-right/down/forward. Looking into a front-facing wall makes its inward
  // normal point mostly towards camera -Z. A side wall must be a distinct orthogonal plane.
  const ordered = walls.filter((entry) => entry.normal.z < -0.2).sort((a, b) => a.normal.z - b.normal.z);
  const back = ordered[0];
  if (!back) return held('사진의 뒤벽 방향을 정할 수 있는 수직 벽 관측이 없어요.');
  if (ordered[1] && Math.abs(back.normal.z - ordered[1].normal.z) < 0.12)
    return held('두 벽이 비슷하게 정면을 향해 뒤벽 방향이 모호해요. 어느 벽인지 확인해 주세요.');
  const up = floor.normal.clone();
  const forward = back.normal.clone().addScaledVector(up, -back.normal.dot(up)).normalize();
  const right = new Vector3().crossVectors(up, forward).normalize();
  const sides = walls.filter(
    (entry) => entry !== back && Math.abs(entry.normal.dot(right)) > Math.cos((12 * Math.PI) / 180),
  );
  if (sides.length !== 1)
    return held(
      sides.length
        ? '같은 설치 축의 옆벽 후보가 여러 개라 위치 기준이 모호해요.'
        : '옆벽 관측이 없어 방 안의 좌우 위치를 정할 수 없어요.',
    );
  const side = sides[0];
  const sideName = side.normal.dot(right) > 0 ? 'left' : 'right';
  const cameraY = floor.plane.offset * 1000;
  const cameraZ = -forward.dot(back.point) * 1000;
  const sideDistance = -(sideName === 'left' ? 1 : -1) * right.dot(side.point) * 1000;
  const cameraX = sideName === 'left' ? sideDistance - room.widthMm / 2 : room.widthMm / 2 - sideDistance;
  result.selected = { floorId: floor.plane.id, backId: back.plane.id, sideId: side.plane.id, side: sideName };
  result.diagnostics.maxOrthogonalityErrorDegrees = Math.max(
    Math.abs(90 - angle(up, back.normal)),
    Math.abs(90 - angle(up, side.normal)),
    Math.abs(90 - angle(back.normal, side.normal)),
  );
  result.diagnostics.axisAdjustmentDegrees = Math.max(
    angle(forward, back.normal),
    angle(right.clone().multiplyScalar(sideName === 'left' ? 1 : -1), side.normal),
  );
  if (cameraY <= 0 || cameraY >= room.heightMm || cameraZ <= 0 || Math.abs(cameraX) >= room.widthMm / 2)
    return held(
      'モデル 거리로 추정한 촬영 위치가 입력한 방 높이·너비와 맞지 않아요. 치수 또는 기하 기준 확인이 필요해요.',
    );
  // Columns map room axes to OpenCV camera axes. Transpose with the CV→Three sign
  // conversion gives the camera's world rotation; camera translation stays in room mm.
  const rotation = new Matrix4().set(
    right.x,
    up.x,
    forward.x,
    0,
    -right.y,
    -up.y,
    -forward.y,
    0,
    -right.z,
    -up.z,
    -forward.z,
    0,
    0,
    0,
    0,
    1,
  );
  // Convert world→camera rotation to camera→world.
  rotation.transpose();
  const quaternion = new Quaternion().setFromRotationMatrix(rotation).normalize();
  result.fit.status = 'estimated';
  result.fit.camera = {
    version: 1,
    positionMm: [cameraX, cameraY, cameraZ],
    quaternion: quaternion.toArray() as [number, number, number, number],
    verticalFovDegrees: fov,
    image: { ...observation.image },
  };
  result.fit.assumptions.push(
    `기하 모델: ${observation.model.id}@${observation.model.revision}. 사진별 스케일 보정 없이 모델 추정 단위를 사용했어요.`,
  );
  return result;
}

/** Only an observed surrounding support ring can corroborate the ray/nominal-wall intersection. */
export function inspectDepthWallSupport(
  plane: DepthPlaneObservation,
  bounds: { left: number; top: number; right: number; bottom: number },
) {
  const sides = ['left', 'top', 'right', 'bottom'] as const;
  const occupied = { left: 0, top: 0, right: 0, bottom: 0 };
  const eligible = { left: 0, top: 0, right: 0, bottom: 0 };
  const support = plane.imageSupport;
  if (!support || support.width !== 64 || support.height !== 64 || !/^[01]{4096}$/.test(support.occupied))
    return {
      planeId: plane.id,
      occupied,
      eligible,
      supportedSides: [] as (typeof sides)[number][],
      reason: 'missing-observed-image-support',
    };
  // The fixture bounding rectangle was deliberately excluded from the plane evidence.
  // Look immediately outside it; never treat its empty centre as contrary evidence.
  const pad = 2 / 64;
  for (let y = 0; y < 64; y++)
    for (let x = 0; x < 64; x++) {
      const px = (x + 0.5) / 64,
        py = (y + 0.5) / 64;
      let side: (typeof sides)[number] | undefined;
      if (py >= bounds.top && py <= bounds.bottom) {
        if (px >= bounds.left - pad && px < bounds.left) side = 'left';
        if (px > bounds.right && px <= bounds.right + pad) side = 'right';
      }
      if (px >= bounds.left && px <= bounds.right) {
        if (py >= bounds.top - pad && py < bounds.top) side = 'top';
        if (py > bounds.bottom && py <= bounds.bottom + pad) side = 'bottom';
      }
      if (!side) continue;
      eligible[side]++;
      if (support.occupied[y * 64 + x] === '1') occupied[side]++;
    }
  const supportedSides = sides.filter(
    (side) => occupied[side] >= Math.max(2, Math.ceil(eligible[side] * 0.2)),
  );
  return {
    planeId: plane.id,
    occupied,
    eligible,
    supportedSides,
    reason: supportedSides.length >= 2 ? 'multiple-boundary-support' : 'insufficient-surrounding-support',
  };
}

export function depthObservedWallAtPoint(
  room: RoomDefinition,
  geometry: DepthRoomCameraResult,
  point: Point,
  evidence?: {
    observation: DepthRoomObservation;
    bounds: { left: number; top: number; right: number; bottom: number };
  },
) {
  const camera = geometry.fit.camera;
  if (geometry.fit.status !== 'estimated' || !camera || !geometry.selected) return undefined;
  const check: DepthWallSupportCheck = { point: { ...point }, status: 'held', reason: '', candidates: [] };
  (geometry.diagnostics.wallSupportChecks ??= []).push(check);
  const held = (reason: string) => {
    check.reason = reason;
    return undefined;
  };
  if (!evidence) return held('missing-observed-image-support');
  const { bounds, observation } = evidence;
  if (
    !Object.values(bounds).every(Number.isFinite) ||
    bounds.left < 0 ||
    bounds.top < 0 ||
    bounds.right > 1 ||
    bounds.bottom > 1 ||
    bounds.left >= bounds.right ||
    bounds.top >= bounds.bottom ||
    ![point.x, point.y].every((v) => Number.isFinite(v) && v >= 0 && v <= 1)
  )
    return held('invalid-candidate-image-region');
  if (observation.image.width !== camera.image.width || observation.image.height !== camera.image.height)
    return held('image-dimensions-mismatch');
  check.bounds = { ...bounds };
  const faces = ['back', geometry.selected.side] as const;
  const supportChecks = faces.map((face) => {
    const id = face === 'back' ? geometry.selected!.backId : geometry.selected!.sideId;
    const plane = observation.walls.find((p) => p.id === id);
    return { face, support: plane ? inspectDepthWallSupport(plane, bounds) : undefined };
  });
  check.candidates = supportChecks.flatMap((c) => (c.support ? [{ face: c.face, ...c.support }] : []));
  const supported = supportChecks.filter((c) => c.support && c.support.supportedSides.length >= 2);
  if (supported.length !== 1)
    return held(
      supported.length
        ? 'multiple-wall-support-around-candidate'
        : 'insufficient-wall-support-around-candidate',
    );
  const hits = faces
    .flatMap((face) => {
      const hit = unprojectSourceToFace(room, camera, point, face);
      if (!hit?.inFace) return [];
      return [{ face, distance: new Vector3(...hit.worldMm).distanceTo(new Vector3(...camera.positionMm)) }];
    })
    .sort((a, b) => a.distance - b.distance);
  if (!hits.length || (hits[1] && Math.abs(hits[1].distance - hits[0].distance) < 1))
    return held('ambiguous-or-missing-ray-wall-intersection');
  if (hits[0].face !== supported[0].face) return held('ray-and-observed-surrounding-wall-disagree');
  check.status = 'estimated';
  check.reason = 'surrounding-image-support-and-ray-agree';
  return {
    wall: hits[0].face,
    planeId: supported[0].support!.planeId,
    source: 'geometry' as const,
    supportEvidence: supported[0].support!,
    reason:
      '설비 사각 영역 바깥의 두 방향 이상에서 관측한 벽 지지와 원본 광선 교차가 일치해 설치 벽을 추정했어요. 반사·돌출·가림과 실제 부착 관계는 별도 확인이 필요해요.',
  };
}
