import { isProductDirection, type ProductDirection } from '../product-direction';
import { directionMismatch, poseDirection, poseForDirection } from './direction-pose';
import type { ProductPose } from './state-types';

/**
 * What the 360° editor does with a model just made for the selected angle (docs/product3d-editor.md,
 * "정면도 입체로 저장"). A flat photo (no `product3d`) of a listed direction is saved as 3D by itself,
 * facing the direction its name gives, so the angle does not stay a paper-thin picture in the room
 * and in the AI export. Anything else is left for the user: an angle that is already 3D is never
 * overwritten without a click, and without editing permission nothing is written.
 */
export type AutoSavePlan =
  /** Save the new model as this angle, turned to face `name`. */
  | { action: 'save'; name: ProductDirection }
  /** The angle already has a 3D model: tell the user the new one is not saved (no overwrite). */
  | { action: 'ask'; name: string }
  /** The angle's name is not on the list (an older stored name): it has to be chosen first. */
  | { action: 'unnamed' }
  /** No permission to save the material. */
  | { action: 'denied' }
  /** No angle is selected. */
  | { action: 'none' };

export function planAutoSave(
  view: { direction: string; product3d?: unknown } | undefined,
  canApply: boolean,
): AutoSavePlan {
  if (!view) return { action: 'none' };
  if (!canApply) return { action: 'denied' };
  if (view.product3d) return { action: 'ask', name: view.direction };
  if (!isProductDirection(view.direction)) return { action: 'unnamed' };
  return { action: 'save', name: view.direction };
}

/**
 * Whether the angle a model was made for is still the one on screen when it comes to saving it: the
 * same photo at the same place in the list (the form draft may have changed under a long inference).
 */
export function sameAngle(
  target: { index: number; assetId: string },
  now: { index: number; view?: { assetId: string } },
): boolean {
  return now.index === target.index && now.view?.assetId === target.assetId;
}

/**
 * The pose a new model opens with: the camera turned to the selected angle's direction (the same
 * pose the automatic save stores), or as it is when the name is not on the list.
 */
export function openingPose(base: ProductPose, direction: string | undefined): ProductPose {
  return direction !== undefined && isProductDirection(direction) ? poseForDirection(base, direction) : base;
}

/**
 * Whether the product was turned (where it faces, or the camera's height) by more than `degrees`
 * between two poses; zoom and tilt of the picture do not count.
 */
export function directionMoved(from: ProductPose, to: ProductPose, degrees = 1): boolean {
  const a = poseDirection(from),
    b = poseDirection(to);
  const turn = Math.abs(((a.angle - b.angle + 540) % 360) - 180);
  return turn > degrees || Math.abs(a.elevation - b.elevation) > degrees;
}

/**
 * The pose a new angle is saved with. A product the user has neither turned nor named yet is shown
 * as it was opened, which does not face the next name the list suggests; it is turned to face the
 * name, as picking the name from the list would. Otherwise the pose is saved as it is.
 */
export function poseForNewAngle(
  pose: ProductPose,
  name: string,
  untouched: boolean,
): { pose: ProductPose; turned: boolean } {
  if (!untouched || !isProductDirection(name) || !directionMismatch(pose, name))
    return { pose, turned: false };
  return { pose: poseForDirection(pose, name), turned: true };
}

/** What the dialog says once the angle was saved as 3D by itself. */
export const autoSavedNotice = (name: string) =>
  `“${name}” 사진을 입체로 저장했어요. 자재를 저장하면 반영돼요. 이어서 다른 각도를 추가할 수 있어요.`;
/** What it says when a new model was made for an angle that is already 3D. */
export const notSavedNotice = (name: string) =>
  `새 형상은 아직 저장되지 않았어요. ‘선택한 각도 수정’을 눌러 “${name}” 각도에 반영해 주세요.`;
export const UNNAMED_NOTICE =
  '이 각도의 이름이 목록에 없어 입체로 저장하지 않았어요. 이름을 목록에서 고른 뒤 ‘선택한 각도 수정’을 눌러 주세요.';
export const DENIED_NOTICE = '이 자재를 저장할 권한이 없어 입체 결과만 보여 줘요.';
/** What it says when the automatic save failed: the model stays, nothing is retried. */
export const autoSaveFailure = (name: string, reason: string) =>
  `“${name}” 사진을 입체로 자동 저장하지 못했어요. ${reason} 입체 결과는 그대로 있어요. ‘선택한 각도 수정’을 눌러 직접 저장할 수 있어요.`;
