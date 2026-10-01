import { Quaternion } from 'three';
import { levelCameraQuaternion, rotateInScreen, validatePose } from './pose';
import { estimateSilhouetteTilt } from './silhouette-tilt';
import type { ProductPose } from './state-types';

/** What a camera at a pose sees of the product: its alpha channel, top row first. */
export interface OutlineImage {
  alpha: ArrayLike<number>;
  width: number;
  height: number;
}
export type OutlineLevelStatus =
  /** The outline was turned. */
  | 'turned'
  /** Its straight edges are already level or upright (within `minDegrees`). */
  | 'level'
  /** No clear direction in the outline (round, lumpy, or edges that disagree): left as it was. */
  | 'unclear';
export interface OutlineLevelResult {
  pose: ProductPose;
  status: OutlineLevelStatus;
  /** Clockwise degrees the outline was turned on the screen in total (0 unless 'turned'). */
  degrees: number;
}

/**
 * Levels a product by its outline: reads the screen roll of the straight edges of the outline as a
 * level camera sees it (the room's view, without the editor's look-down angle) and turns the
 * product about that camera's axis until they are level and upright, twice so the second reading
 * catches what the first left (a changed outline). Only the product turns; the camera stays. When
 * the outline gives no clear answer the pose is returned as it was.
 *
 * `silhouette` draws the product at a pose (WebGL in the editor, any renderer in a test).
 */
export function levelByOutline(
  pose: ProductPose,
  silhouette: (pose: ProductPose) => OutlineImage,
  { iterations = 2, minDegrees = 0.3, maxDegrees = 44 } = {},
): OutlineLevelResult {
  let current = validatePose(pose);
  let total = 0;
  let status: OutlineLevelStatus = 'unclear';
  for (let i = 0; i < iterations; i++) {
    const level: ProductPose = {
      ...current,
      cameraQuaternion: levelCameraQuaternion(
        new Quaternion(...current.cameraQuaternion),
      ).toArray() as ProductPose['cameraQuaternion'],
    };
    const picture = silhouette(level);
    const tilt = estimateSilhouetteTilt(picture.alpha, picture.width, picture.height, { maxDegrees });
    if (!tilt) break;
    if (Math.abs(tilt.degrees) < minDegrees) {
      if (status === 'unclear') status = 'level';
      break;
    }
    // The outline leans clockwise by tilt.degrees: turn the product back the other way.
    const turned = rotateInScreen(level, (-tilt.degrees * Math.PI) / 180);
    current = validatePose({ ...current, objectQuaternion: turned.objectQuaternion });
    total += tilt.degrees;
    status = 'turned';
  }
  // Unturned means untouched: the pose as it was given, not a re-normalised copy of it.
  return status === 'turned' ? { pose: current, status, degrees: total } : { pose, status, degrees: 0 };
}
