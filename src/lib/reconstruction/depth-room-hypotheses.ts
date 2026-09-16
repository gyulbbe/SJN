import { Quaternion, Vector3 } from 'three';
import type { RoomDefinition } from '../room-types';
import { fitDepthRoomCamera, type DepthRoomObservation } from './depth-room-geometry';

/** Counterfactual diagnostics: no hypothesis is selected or passed to fixture placement. */
export function inspectDepthRoomCameraHypotheses(
  room: RoomDefinition,
  observation: DepthRoomObservation,
  expectedFingerprint: string,
) {
  const strict = fitDepthRoomCamera(room, observation, expectedFingerprint);
  const groups: { planeIds: string[]; normals: Vector3[]; offsets: number[] }[] = [];
  const hypotheses: {
    wallIds: [string, string];
    angleDegrees: number;
    excludedWallIds: string[];
    result: ReturnType<typeof fitDepthRoomCamera>;
  }[] = [];
  const warnings = [
    '각 가설은 다른 관측 벽을 제외했을 때의 계산이에요. 나머지 관측과의 모순이 해결되거나 생산 카메라로 채택된 결과가 아니에요.',
    '방향군은 평면 병합이 아니에요. 각 조각의 거리·잔차·픽셀 지지는 그대로 별도 검증해야 해요.',
    '가설 간 위치·회전 차이는 모델 내부 민감도이며 실측 정확도나 신뢰도가 아니에요.',
  ];
  const validWallList = observation.walls.length <= 16 && observation.walls.every((plane) =>
    plane.normalCamera.length === 3 && plane.normalCamera.every(Number.isFinite) &&
    Math.abs(new Vector3(...plane.normalCamera).length() - 1) <= 1e-4 && Number.isFinite(plane.offset));
  if (validWallList) {
    for (const plane of observation.walls) {
      const normal = new Vector3(...plane.normalCamera);
      // Complete-link signed direction groups avoid transitive chains and opposite boundaries.
      let group = groups.find((entry) => entry.normals.every((member) => member.angleTo(normal) <= Math.PI / 18));
      if (!group) {
        group = { planeIds: [], normals: [], offsets: [] };
        groups.push(group);
      }
      group.planeIds.push(plane.id);
      group.normals.push(normal);
      group.offsets.push(plane.offset);
    }
    for (let i = 0; i < observation.walls.length; i++) {
      for (let j = i + 1; j < observation.walls.length; j++) {
        const first = observation.walls[i];
        const second = observation.walls[j];
        const angleDegrees = Math.acos(Math.min(1, Math.abs(new Vector3(...first.normalCamera).dot(new Vector3(...second.normalCamera))))) * 180 / Math.PI;
        if (Math.abs(90 - angleDegrees) > 12) continue;
        const pair: DepthRoomObservation = { ...observation, walls: [first, second] };
        hypotheses.push({
          wallIds: [first.id, second.id], angleDegrees,
          excludedWallIds: observation.walls.filter((_, index) => index !== i && index !== j).map((p) => p.id),
          result: fitDepthRoomCamera(room, pair, expectedFingerprint),
        });
      }
    }
  }
  const poseDifferences: {
    firstWallIds: [string, string]; secondWallIds: [string, string]; positionDifferenceMm: number; rotationDifferenceDegrees: number;
  }[] = [];
  for (let i = 0; i < hypotheses.length; i++) {
    const first = hypotheses[i].result.fit.camera;
    if (hypotheses[i].result.fit.status !== 'estimated' || !first) continue;
    for (let j = i + 1; j < hypotheses.length; j++) {
      const second = hypotheses[j].result.fit.camera;
      if (hypotheses[j].result.fit.status !== 'estimated' || !second) continue;
      poseDifferences.push({
        firstWallIds: hypotheses[i].wallIds, secondWallIds: hypotheses[j].wallIds,
        positionDifferenceMm: new Vector3(...first.positionMm).distanceTo(new Vector3(...second.positionMm)),
        rotationDifferenceDegrees: new Quaternion(...first.quaternion).angleTo(new Quaternion(...second.quaternion)) * 180 / Math.PI,
      });
    }
  }
  return {
    scope: 'unselected-wall-pair-hypotheses' as const,
    strict,
    directionGroups: groups.map((group) => ({
      planeIds: group.planeIds,
      minimumOffsetModelUnits: Math.min(...group.offsets), maximumOffsetModelUnits: Math.max(...group.offsets),
      maximumAngleDegrees: Math.max(0, ...group.normals.flatMap((a) => group.normals.map((b) => a.angleTo(b) * 180 / Math.PI))),
    })),
    hypotheses, poseDifferences, warnings,
    promotedToProduction: false as const,
  };
}