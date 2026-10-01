import { Matrix4, Quaternion, Vector3 } from 'three';
import { directionAngle, nearestHorizontalDirection, type ProductDirection } from '../product-direction';
import { levelCameraQuaternion, validatePose } from './pose';
import type { ProductPose } from './state-types';

/**
 * How a 360° pose reads as an angle name. The room puts a saved product down as the level camera
 * saw it (see levelCameraQuaternion), so the direction it faces there follows from the pose:
 * the product's front (TripoSR +x, the photographed side) in the camera's frame, screen-right
 * being the room's +x and towards-the-viewer the room's +z. 정면 is 0°, 오른쪽 +90°, 왼쪽 −90°,
 * 뒤 180°. A camera looking steeply down or up (more than ELEVATION_LIMIT) is a 위 or 아래 photo.
 */
export const ELEVATION_LIMIT = 35;
/** How far a pose may be from its name before the editor warns (degrees of turn). */
export const DIRECTION_TOLERANCE = 25;
const DEFAULT_ELEVATION = 10;
const UP_ELEVATION = 60;
const DOWN_ELEVATION = -45;
const degrees = (radians: number) => (radians * 180) / Math.PI;
const radians = (value: number) => (value * Math.PI) / 180;

/** The direction the product faces and the camera's height angle, both in degrees. */
export function poseDirection(pose: ProductPose): { angle: number; elevation: number } {
  const valid = validatePose(pose);
  const camera = new Quaternion(...valid.cameraQuaternion);
  const back = new Vector3(0, 0, 1).applyQuaternion(camera);
  const front = new Vector3(1, 0, 0).applyQuaternion(
    levelCameraQuaternion(camera)
      .invert()
      .multiply(new Quaternion(...valid.objectQuaternion)),
  );
  return {
    angle: degrees(Math.atan2(front.x, front.z)),
    elevation: degrees(Math.asin(Math.max(-1, Math.min(1, back.z)))),
  };
}

/** The name a pose reads as right now. */
export function nearestPoseDirection(pose: ProductPose): {
  name: ProductDirection;
  angle: number;
  elevation: number;
} {
  const { angle, elevation } = poseDirection(pose);
  if (elevation > ELEVATION_LIMIT) return { name: '위', angle, elevation };
  if (elevation < -ELEVATION_LIMIT) return { name: '아래', angle, elevation };
  return { name: nearestHorizontalDirection(angle).name, angle, elevation };
}

/**
 * Whether a pose and the name it is about to be saved under disagree: a horizontal name more than
 * DIRECTION_TOLERANCE° from where the product faces (or seen from steeply above or below), 위 or
 * 아래 from a camera that is not that high or low. Gives the name the pose reads as instead.
 */
export function directionMismatch(
  pose: ProductPose,
  name: ProductDirection,
): { nearest: ProductDirection; degrees: number } | undefined {
  const read = nearestPoseDirection(pose);
  const target = directionAngle(name);
  if (target === undefined) return read.name === name ? undefined : { nearest: read.name, degrees: 0 };
  if (read.name === '위' || read.name === '아래') return { nearest: read.name, degrees: 0 };
  const distance = Math.abs(((read.angle - target + 540) % 360) - 180);
  return distance > DIRECTION_TOLERANCE ? { nearest: read.name, degrees: distance } : undefined;
}

/**
 * The pose turned so the product faces a name's direction: the camera moves around the product
 * (the object's own standing and tilt are kept), upright with no roll. 위 and 아래 only raise or
 * lower the camera and keep the side it is on; a horizontal name keeps the camera height when it is
 * within the normal range, else returns to the default height.
 */
export function poseForDirection(pose: ProductPose, name: ProductDirection): ProductPose {
  const valid = validatePose(pose);
  const current = poseDirection(valid);
  const objectQ = new Quaternion(...valid.objectQuaternion);
  const front = new Vector3(1, 0, 0).applyQuaternion(objectQ);
  // Where the product's front points on the ground (its azimuth around the up axis).
  const heading =
    Math.hypot(front.x, front.y) > 1e-6
      ? Math.atan2(front.y, front.x)
      : Math.atan2(
          new Vector3(0, 0, 1).applyQuaternion(new Quaternion(...valid.cameraQuaternion)).y,
          new Vector3(0, 0, 1).applyQuaternion(new Quaternion(...valid.cameraQuaternion)).x,
        );
  const wanted = directionAngle(name);
  const angle = wanted ?? current.angle;
  let elevation = current.elevation;
  if (name === '위') elevation = current.elevation > ELEVATION_LIMIT ? current.elevation : UP_ELEVATION;
  else if (name === '아래')
    elevation = current.elevation < -ELEVATION_LIMIT ? current.elevation : DOWN_ELEVATION;
  else if (Math.abs(current.elevation) > ELEVATION_LIMIT) elevation = DEFAULT_ELEVATION;
  // The level camera stands at the ground azimuth `heading − angle` (see poseDirection).
  const azimuth = heading - radians(angle);
  const e = radians(elevation);
  const back = new Vector3(Math.cos(azimuth) * Math.cos(e), Math.sin(azimuth) * Math.cos(e), Math.sin(e));
  const right = new Vector3(-Math.sin(azimuth), Math.cos(azimuth), 0);
  const up = new Vector3().crossVectors(back, right);
  const camera = new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(right, up, back));
  return validatePose({ ...valid, cameraQuaternion: camera.toArray() });
}
