import { Matrix4, Quaternion, Vector3 } from 'three';
import { buildEstimatedDepthWallEvidence, type EstimatedDepthWallInput } from './estimated-plane-evidence';
import type { SourceCamera } from './source-camera';

export type EstimatedCameraDirection = {
  id: string;
  familyId: string;
  planeIds: string[];
  assignedWall: 'back' | 'left' | 'right';
  normalCamera: [number, number, number];
  floorNormalCamera: [number, number, number];
  axisAdjustmentDegrees: number;
  camera: SourceCamera;
};
export type EstimatedCameraDirectionResult = {
  status: 'available' | 'held';
  reasons: string[];
  model: EstimatedDepthWallInput['observation']['model'];
  inputFingerprint: string;
  scope: 'observed-orientation-and-intrinsics-estimated-translation';
  hypotheses: EstimatedCameraDirection[];
};
/**
 * Fits rotation and FOV only. Plane offsets validate raw equations but never set camera position,
 * room dimensions, or a measured scale. Translation positions are supplied by the same prior grid.
 */
export function buildEstimatedCameraDirections(
  input: EstimatedDepthWallInput,
  image: { width: number; height: number },
  translations: readonly SourceCamera['positionMm'][],
): EstimatedCameraDirectionResult {
  const observation = input.observation;
  const result: EstimatedCameraDirectionResult = {
    status: 'held',
    reasons: [],
    model: { ...observation.model },
    inputFingerprint: observation.inputFingerprint,
    scope: 'observed-orientation-and-intrinsics-estimated-translation',
    hypotheses: [],
  };
  const evidence = buildEstimatedDepthWallEvidence(input, [], image);
  if (!evidence.families.length) {
    result.reasons.push(...evidence.reasons, '유효한 바닥과 벽 방향이 없어 회전 가설을 만들지 않았어요.');
    return result;
  }
  const k = observation.intrinsics;
  if (
    ![k.fx, k.fy, k.cx, k.cy].every(Number.isFinite) ||
    k.fx <= 0 ||
    k.fy <= 0 ||
    Math.abs(k.cx - 0.5) > 1e-6 ||
    Math.abs(k.cy - 0.5) > 1e-6 ||
    Math.abs((k.fx * image.width) / (k.fy * image.height) - 1) > 0.001
  ) {
    result.reasons.push(
      '주점이 중앙이 아니거나 픽셀 비율이 맞지 않아 현재 카메라 형식으로 변환하지 않았어요.',
    );
    return result;
  }
  const fov = (2 * Math.atan(0.5 / k.fy) * 180) / Math.PI;
  if (fov < 5 || fov > 150) {
    result.reasons.push('관측 화각이 지원 범위를 벗어났어요.');
    return result;
  }
  const floor = observation.floor!;
  const sign = floor.offset < 0 ? -1 : 1;
  const upCv = new Vector3(...floor.normalCamera).multiplyScalar(sign).normalize();
  const up = new Vector3(upCv.x, -upCv.y, -upCv.z);
  const positions = [
    ...new Map(
      translations
        .filter((p) => p.length === 3 && p.every(Number.isFinite))
        .map((p) => [JSON.stringify(p), p]),
    ).values(),
  ];
  for (const family of evidence.families) {
    const raw = new Vector3(family.normalCamera[0], -family.normalCamera[1], -family.normalCamera[2]);
    const back = raw.clone().addScaledVector(up, -raw.dot(up)).normalize();
    const right = up.clone().cross(back).normalize();
    // Basis columns are world axes expressed in Three camera coordinates. Inverting yields
    // the camera-to-world quaternion, including observed roll; y is not forcibly screen-up.
    const qBack = new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(right, up, back)).invert();
    const adjustment = (raw.angleTo(back) * 180) / Math.PI;
    for (const assignedWall of ['back', 'left', 'right'] as const) {
      const turn = assignedWall === 'back' ? 0 : assignedWall === 'left' ? Math.PI / 2 : -Math.PI / 2;
      const q = new Quaternion()
        .setFromAxisAngle(new Vector3(0, 1, 0), turn)
        .multiply(qBack)
        .normalize();
      positions.forEach((position, index) => {
        result.hypotheses.push({
          id: 'observed-direction-' + family.id + '-as-' + assignedWall + '-translation-' + index,
          familyId: family.id,
          planeIds: [...family.planeIds],
          assignedWall,
          normalCamera: [...family.normalCamera],
          floorNormalCamera: upCv.toArray() as [number, number, number],
          axisAdjustmentDegrees: adjustment,
          camera: {
            version: 1,
            positionMm: [...position],
            quaternion: q.toArray() as [number, number, number, number],
            verticalFovDegrees: fov,
            image: { ...image },
          },
        });
      });
    }
  }
  result.status = result.hypotheses.length ? 'available' : 'held';
  result.reasons.push(
    '바닥·평행 벽 방향과 화각만 모델 관측에서 가져왔어요. 깊이 거리·카메라 원점·방 크기는 확정하지 않았어요.',
    '카메라 위치는 기존 비교 가설의 위치를 그대로 재사용해요. 모델 방향을 실측 촬영 자세로 표시하지 않아요.',
  );
  return result;
}
