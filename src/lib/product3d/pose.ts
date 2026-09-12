import { Matrix4, Quaternion, Vector3 } from 'three';
import type { ProductPose } from './state-types';

export const POSE_HISTORY_LIMIT = 50;
export const MIN_PRODUCT_ZOOM = 0.2;
export const MAX_PRODUCT_ZOOM = 8;
type QuaternionTuple = [number, number, number, number];

function normalizedQuaternion(value: unknown): QuaternionTuple {
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    !value.every((n) => typeof n === 'number' && Number.isFinite(n))
  ) {
    throw new Error('제품의 회전 정보가 올바르지 않습니다.');
  }
  const q = new Quaternion(...(value as QuaternionTuple));
  if (!Number.isFinite(q.lengthSq()) || q.lengthSq() < 1e-12)
    throw new Error('제품의 회전 정보가 올바르지 않습니다.');
  q.normalize();
  // q and -q encode the same rotation; canonical signs keep history stable.
  if (q.w < 0) q.set(-q.x, -q.y, -q.z, -q.w);
  return q.toArray() as QuaternionTuple;
}

export function validatePose(value: unknown): ProductPose {
  if (!value || typeof value !== 'object') throw new Error('제품 자세 정보가 없습니다.');
  const pose = value as ProductPose;
  if (!Number.isFinite(pose.zoom) || pose.zoom < MIN_PRODUCT_ZOOM || pose.zoom > MAX_PRODUCT_ZOOM) {
    throw new Error('제품 확대 배율이 올바르지 않습니다.');
  }
  return {
    objectQuaternion: normalizedQuaternion(pose.objectQuaternion),
    cameraQuaternion: normalizedQuaternion(pose.cameraQuaternion),
    zoom: pose.zoom,
  };
}

/** TripoSR coordinates: +z is up, the source-facing camera is near +x. */
export function createDefaultPose(): ProductPose {
  const elevation = (10 * Math.PI) / 180;
  const matrix = new Matrix4().lookAt(
    new Vector3(Math.cos(elevation), 0, Math.sin(elevation)),
    new Vector3(),
    new Vector3(0, 0, 1),
  );
  return {
    objectQuaternion: [0, 0, 0, 1],
    cameraQuaternion: new Quaternion().setFromRotationMatrix(matrix).toArray() as QuaternionTuple,
    zoom: 1,
  };
}

export function samePose(a: ProductPose, b: ProductPose): boolean {
  return (
    Math.abs(a.zoom - b.zoom) < 1e-7 &&
    Math.abs(new Quaternion(...a.objectQuaternion).dot(new Quaternion(...b.objectQuaternion))) > 1 - 1e-10 &&
    Math.abs(new Quaternion(...a.cameraQuaternion).dot(new Quaternion(...b.cameraQuaternion))) > 1 - 1e-10
  );
}

/** Positive angles turn clockwise on the current screen, independently of camera orientation. */
export function rotateInScreen(pose: ProductPose, clockwiseRadians: number): ProductPose {
  if (!Number.isFinite(clockwiseRadians)) throw new Error('기울기 각도가 올바르지 않습니다.');
  const valid = validatePose(pose);
  const axis = new Vector3(0, 0, 1).applyQuaternion(new Quaternion(...valid.cameraQuaternion));
  const rotation = new Quaternion().setFromAxisAngle(axis, -clockwiseRadians);
  const object = new Quaternion(...valid.objectQuaternion).premultiply(rotation).normalize();
  return validatePose({ ...valid, objectQuaternion: object.toArray() });
}

/** Screen coordinates have downward-positive Y: top-right and bottom-left are both clockwise. */
export function screenDragAngle(
  center: { x: number; y: number },
  start: { x: number; y: number },
  current: { x: number; y: number },
): number {
  const a = { x: start.x - center.x, y: start.y - center.y };
  const b = { x: current.x - center.x, y: current.y - center.y };
  if (Math.hypot(a.x, a.y) < 1 || Math.hypot(b.x, b.y) < 1) return 0;
  return Math.atan2(a.x * b.y - a.y * b.x, a.x * b.x + a.y * b.y);
}

export class ProductPoseHistory {
  private current: ProductPose;
  private past: ProductPose[] = [];
  private future: ProductPose[] = [];
  constructor(initial: ProductPose) {
    this.current = validatePose(initial);
  }
  get canUndo() {
    return this.past.length > 0;
  }
  get canRedo() {
    return this.future.length > 0;
  }
  get pose() {
    return validatePose(this.current);
  }
  record(next: ProductPose): boolean {
    const valid = validatePose(next);
    if (samePose(this.current, valid)) return false;
    this.past.push(this.current);
    if (this.past.length > POSE_HISTORY_LIMIT) this.past.shift();
    this.current = valid;
    this.future = [];
    return true;
  }
  undo(): ProductPose {
    const previous = this.past.pop();
    if (previous) {
      this.future.push(this.current);
      this.current = previous;
    }
    return this.pose;
  }
  redo(): ProductPose {
    const next = this.future.pop();
    if (next) {
      this.past.push(this.current);
      this.current = next;
    }
    return this.pose;
  }
}
