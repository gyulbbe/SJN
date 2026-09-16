import { Quaternion, Vector3 } from 'three';
import type { ProductBounds, RoomFace } from '../room-types';
import type { SceneCandidate } from './pipeline-contract';
import type { SourceCamera } from './source-camera';
import {
  inspectDepthWallSupport,
  type DepthPlaneObservation,
  type DepthRoomObservation,
} from './depth-room-geometry';

export type EstimatedDepthWallInput = {
  observation: DepthRoomObservation;
  /** Independently recorded hash of the normalized photo, not copied from the observation. */
  expectedInputFingerprint: string;
};
type Wall = Exclude<RoomFace, 'floor'>;
type Support = ReturnType<typeof inspectDepthWallSupport>;
export type EstimatedDepthWallEvidence = {
  version: 1;
  scope: 'surrounding-plane-orientation-only';
  status: 'available' | 'held';
  reasons: string[];
  inputFingerprint: string;
  model: DepthRoomObservation['model'];
  rejectedPlanes: { id: string; reason: string }[];
  families: { id: string; planeIds: string[]; normalCamera: [number, number, number] }[];
  nodes: {
    candidateId: string;
    status: 'supported' | 'held' | 'excluded';
    reasons: string[];
    familyId?: string;
    normalCamera?: [number, number, number];
    selected?: { wall: Wall; worldNormal: [number, number, number]; angleDegrees: number; penalty: number };
    support: (Support & { familyId: string; maskedOccupiedCells: number })[];
  }[];
};
const vector = (v: [number, number, number]) => new Vector3(...v);
const within = (x: number, y: number, b: ProductBounds) =>
  x >= b.left && x <= b.right && y >= b.top && y <= b.bottom;
const validBounds = (b: ProductBounds) =>
  Object.values(b).every(Number.isFinite) &&
  b.left >= 0 &&
  b.top >= 0 &&
  b.right <= 1 &&
  b.bottom <= 1 &&
  b.left < b.right &&
  b.top < b.bottom;

/** Canonicalize the equation, not arbitrary normal components: opposite room walls remain opposite. */
function normalizedPlane(plane: DepthPlaneObservation): DepthPlaneObservation | undefined {
  if (
    !plane.id ||
    ![
      ...plane.normalCamera,
      ...plane.medianPointCamera,
      plane.offset,
      plane.rmsResidual,
      plane.inlierFraction,
      plane.imageAreaFraction,
    ].every(Number.isFinite)
  )
    return undefined;
  const normal = vector(plane.normalCamera);
  if (
    Math.abs(normal.length() - 1) > 1e-4 ||
    Math.abs(plane.offset) < 0.01 ||
    !Number.isInteger(plane.inlierCount) ||
    plane.inlierCount < 96 ||
    plane.inlierFraction < 0.05 ||
    plane.inlierFraction > 1 ||
    plane.imageAreaFraction < 0.01 ||
    plane.imageAreaFraction > 1 ||
    plane.rmsResidual < 0 ||
    plane.medianPointCamera[2] <= 0
  )
    return undefined;
  const sign = plane.offset < 0 ? -1 : 1;
  normal.multiplyScalar(sign);
  const offset = Math.abs(plane.offset);
  if (
    plane.rmsResidual / offset > 0.025 ||
    Math.abs(normal.dot(vector(plane.medianPointCamera)) + offset) / offset > 0.04
  )
    return undefined;
  return { ...plane, normalCamera: normal.toArray() as [number, number, number], offset };
}

/**
 * Independent weak orientation evidence. It never fits a camera origin, assigns a wall name,
 * measures a fixture, or uses pixels inside its image rectangle as installation evidence.
 */
export function buildEstimatedDepthWallEvidence(
  input: EstimatedDepthWallInput,
  candidates: readonly SceneCandidate[],
  image: { width: number; height: number },
  manualIdSet?: ReadonlySet<string>,
): EstimatedDepthWallEvidence {
  const observation = input.observation;
  const result: EstimatedDepthWallEvidence = {
    version: 1,
    scope: 'surrounding-plane-orientation-only',
    status: 'held',
    reasons: [],
    inputFingerprint: observation.inputFingerprint,
    model: { ...observation.model },
    rejectedPlanes: [],
    families: [],
    nodes: [],
  };
  if (
    observation.version !== 1 ||
    observation.coordinateSystem !== 'opencv-camera' ||
    observation.scale !== 'model-estimated-metres' ||
    !/^[0-9a-f]{64}$/.test(input.expectedInputFingerprint) ||
    observation.inputFingerprint !== input.expectedInputFingerprint ||
    !observation.model.id.trim() ||
    !observation.model.revision.trim() ||
    image.width !== observation.image.width ||
    image.height !== observation.image.height ||
    ![image.width, image.height].every((n) => Number.isInteger(n) && n > 0) ||
    observation.walls.length > 16
  ) {
    result.reasons.push('사진 해시·크기·좌표계가 맞지 않아 주변 벽 방향을 사용하지 않았어요.');
    return result;
  }
  const floor = observation.floor && normalizedPlane(observation.floor);
  if (!floor || floor.inlierFraction < 0.3) {
    result.reasons.push('유효한 바닥 방향이 없어 벽 평면의 수직성을 확인하지 못했어요.');
    return result;
  }
  const planes: DepthPlaneObservation[] = [];
  const seen = new Set<string>([floor.id]);
  for (const raw of observation.walls) {
    const plane = normalizedPlane(raw);
    let reason = '';
    if (seen.has(raw.id)) reason = 'duplicate-plane-id';
    else if (!plane) reason = 'invalid-or-weak-plane';
    else if (
      Math.abs(vector(plane.normalCamera).dot(vector(floor.normalCamera))) > Math.sin((15 * Math.PI) / 180)
    )
      reason = 'not-perpendicular-to-observed-floor';
    else if (
      !plane.imageSupport ||
      plane.imageSupport.width !== 64 ||
      plane.imageSupport.height !== 64 ||
      !/^[01]{4096}$/.test(plane.imageSupport.occupied)
    )
      reason = 'missing-observed-image-support';
    seen.add(raw.id);
    if (reason || !plane) result.rejectedPlanes.push({ id: raw.id, reason });
    else planes.push(plane);
  }
  const groups: DepthPlaneObservation[][] = [];
  for (const plane of planes) {
    // Complete-link grouping avoids joining two axes through an intermediate noisy plane.
    const group = groups.find((g) =>
      g.every(
        (p) => vector(p.normalCamera).dot(vector(plane.normalCamera)) >= Math.cos((15 * Math.PI) / 180),
      ),
    );
    if (group) group.push(plane);
    else groups.push([plane]);
  }
  result.families = groups.map((group, index) => {
    const n = new Vector3();
    group.forEach((p) => n.addScaledVector(vector(p.normalCamera), p.inlierCount));
    return {
      id: 'parallel-wall-family-' + (index + 1),
      planeIds: group.map((p) => p.id),
      normalCamera: n.normalize().toArray() as [number, number, number],
    };
  });
  for (const item of candidates) {
    const node: EstimatedDepthWallEvidence['nodes'][number] = {
      candidateId: item.id,
      status: 'held',
      reasons: [],
      support: [],
    };
    result.nodes.push(node);
    const isWall =
      ['mirror', 'mirrorCabinet', 'window', 'wallShelf', 'wallCabinet', 'shower'].includes(item.kind) ||
      (item.kind === 'basin' && item.basinStyle === 'wall') ||
      ((item.kind === 'vanity' || (item.kind === 'basin' && item.basinStyle === 'vanity')) &&
        item.mounting === 'wall');
    if (!isWall || item.reflection !== 'physical' || manualIdSet?.has(item.id) || !validBounds(item.bounds)) {
      node.status = 'excluded';
      node.reasons.push('바닥·투명 설비·반사 후보·사용자 지정은 주변 평면으로 설치벽을 판단하지 않아요.');
      continue;
    }
    const blockers = candidates.filter((other) => other.id !== item.id && validBounds(other.bounds));
    groups.forEach((group, index) => {
      const raw = Array.from({ length: 4096 }, (_, cell) =>
        group.some((p) => p.imageSupport!.occupied[cell] === '1') ? '1' : '0',
      );
      let maskedOccupiedCells = 0;
      const masked = raw
        .map((bit, cell) => {
          const x = ((cell % 64) + 0.5) / 64,
            y = (Math.floor(cell / 64) + 0.5) / 64;
          if (bit === '1' && blockers.some((other) => within(x, y, other.bounds))) {
            maskedOccupiedCells++;
            return '0';
          }
          return bit;
        })
        .join('');
      const family = result.families[index];
      const support = inspectDepthWallSupport(
        {
          ...group[0],
          id: family.id,
          imageSupport: { ...group[0].imageSupport!, occupied: masked },
        },
        item.bounds,
      );
      node.support.push({ ...support, familyId: family.id, maskedOccupiedCells });
    });
    const supported = node.support.filter((s) => s.supportedSides.length >= 2);
    if (supported.length !== 1) {
      node.reasons.push(
        supported.length
          ? '둘 이상의 벽 방향이 주변에 있어 설치벽을 특정하지 않았어요.'
          : '다른 물체와 유리·거울 영역을 뺀 주변 표본이 두 변 이상을 지지하지 못했어요.',
      );
      continue;
    }
    const family = result.families.find((f) => f.id === supported[0].familyId)!;
    node.status = 'supported';
    node.familyId = family.id;
    node.normalCamera = [...family.normalCamera];
    node.reasons.push(
      '제품 바깥 두 변 이상의 깊이 표본으로 주변 벽 방향만 추정했어요. 위치·실측·벽 이름은 관측하지 않았어요.',
    );
  }
  result.status = result.nodes.some((n) => n.status === 'supported') ? 'available' : 'held';
  result.reasons.push(
    '평행 평면은 방향 증거로만 묶었어요. 거리·벽 경계·카메라 원점의 보류는 그대로 유지해요.',
  );
  return result;
}

/** Score each proposed camera/world-wall pairing; never equate a camera-facing plane with back. */
export function estimatedDepthWallOrientation(
  normalCamera: [number, number, number],
  camera: SourceCamera,
  wall: Wall,
) {
  const q = new Quaternion(...camera.quaternion);
  const n = new Vector3(normalCamera[0], -normalCamera[1], -normalCamera[2]).applyQuaternion(q).normalize();
  const target =
    wall === 'back' ? new Vector3(0, 0, 1) : wall === 'left' ? new Vector3(1, 0, 0) : new Vector3(-1, 0, 0);
  const dot = Math.max(-1, Math.min(1, n.dot(target)));
  return {
    worldNormal: n.toArray() as [number, number, number],
    angleDegrees: (Math.acos(dot) * 180) / Math.PI,
    penalty: 1.25 * (1 - dot) ** 2,
  };
}
