import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { PRODUCT_DIRECTIONS } from '../src/lib/product-direction';
import {
  autoSaveFailure,
  autoSavedNotice,
  directionMoved,
  notSavedNotice,
  openingPose,
  planAutoSave,
  poseForNewAngle,
  sameAngle,
} from '../src/lib/product3d/auto-save';
import { directionMismatch, nearestPoseDirection, poseDirection } from '../src/lib/product3d/direction-pose';
import { createDefaultPose } from '../src/lib/product3d/pose';
import { estimateUprightQuaternion } from '../src/lib/product3d/upright';
import type { ProductPose } from '../src/lib/product3d/state-types';

const away = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);
const quaternion = (q: Quaternion) => q.toArray() as ProductPose['objectQuaternion'];
/** An object turned about the vertical and leaned a few degrees, as a model made from a photo stands. */
const standing = (yaw: number, lean = 0, roll = 0): ProductPose => ({
  ...createDefaultPose(),
  objectQuaternion: quaternion(
    new Quaternion()
      .setFromAxisAngle(new Vector3(0, 0, 1), (yaw * Math.PI) / 180)
      .multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), (lean * Math.PI) / 180))
      .multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), (roll * Math.PI) / 180)),
  ),
});
const flat = { direction: '정면' };
const solid = { direction: '정면', product3d: { meshAssetId: 'm' } };

describe('which angle a new model is saved to by itself', () => {
  it('saves a flat photo of a listed direction, under its own name', () => {
    for (const name of PRODUCT_DIRECTIONS)
      expect(planAutoSave({ direction: name }, true)).toEqual({ action: 'save', name });
  });

  it('never overwrites an angle that is already 3D: it says the new model is not saved', () => {
    expect(planAutoSave(solid, true)).toEqual({ action: 'ask', name: '정면' });
    expect(planAutoSave({ direction: '오른쪽', product3d: {} }, true)).toEqual({
      action: 'ask',
      name: '오른쪽',
    });
  });

  it('writes nothing without permission, with no angle, or for a name that is not on the list', () => {
    expect(planAutoSave(flat, false)).toEqual({ action: 'denied' });
    expect(planAutoSave(solid, false)).toEqual({ action: 'denied' });
    expect(planAutoSave(undefined, true)).toEqual({ action: 'none' });
    expect(planAutoSave({ direction: '사선' }, true)).toEqual({ action: 'unnamed' });
  });

  it('is saved only while the same photo is still selected at the same place', () => {
    const target = { index: 1, assetId: 'a1' };
    expect(sameAngle(target, { index: 1, view: { assetId: 'a1' } })).toBe(true);
    // Closed or another angle picked, the photo replaced, the list changed, or no view any more.
    expect(sameAngle(target, { index: 0, view: { assetId: 'a1' } })).toBe(false);
    expect(sameAngle(target, { index: 1, view: { assetId: 'a2' } })).toBe(false);
    expect(sameAngle(target, { index: 1 })).toBe(false);
  });

  it('words what happened, plainly, with the angle name', () => {
    expect(autoSavedNotice('정면')).toBe(
      '“정면” 사진을 입체로 저장했어요. 자재를 저장하면 반영돼요. 이어서 다른 각도를 추가할 수 있어요.',
    );
    expect(notSavedNotice('오른쪽')).toBe(
      '새 형상은 아직 저장되지 않았어요. ‘선택한 각도 수정’을 눌러 “오른쪽” 각도에 반영해 주세요.',
    );
    const failed = autoSaveFailure('정면', '저장 공간이 부족해요.');
    expect(failed).toContain('자동 저장하지 못했어요');
    expect(failed).toContain('입체 결과는 그대로 있어요');
    expect(failed).toContain('‘선택한 각도 수정’을 눌러 직접 저장');
  });
});

describe('the pose a model opens with, which is the pose that is saved', () => {
  it.each([
    ['정면', 0],
    ['오른쪽', 90],
    ['왼쪽', -90],
    ['뒤', 180],
  ] as const)('faces %s (%i°) at 10°, leaning and turned objects included', (name, angle) => {
    // Upright by the shape estimate, a model photographed from any side, a few degrees off the vertical.
    for (const object of [standing(0), standing(40), standing(-130, 7), standing(75, -4, 3)]) {
      const opened = openingPose(object, name);
      const read = poseDirection(opened);
      expect(away(read.angle, angle)).toBeLessThan(2);
      expect(read.elevation).toBeCloseTo(10, 6);
      expect(opened.objectQuaternion).toEqual(object.objectQuaternion);
      expect(nearestPoseDirection(opened).name).toBe(name);
      expect(directionMismatch(opened, name)).toBeUndefined();
    }
  });

  it('is the pose the automatic save stores even after the outline level turned the object a little', () => {
    // The viewer opens level by the outline (a few degrees of roll) before the model is saved: facing
    // the name is worked out again from that pose, so the saved pose still reads as the name.
    const opened = openingPose(standing(40), '정면');
    const leveled: ProductPose = {
      ...opened,
      objectQuaternion: quaternion(
        new Quaternion(...opened.objectQuaternion).premultiply(
          new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), (6 * Math.PI) / 180),
        ),
      ),
    };
    expect(away(poseDirection(leveled).angle, 0)).toBeGreaterThan(2);
    const saved = openingPose(leveled, '정면');
    expect(away(poseDirection(saved).angle, 0)).toBeLessThan(2);
    expect(poseDirection(saved).elevation).toBeCloseTo(10, 6);
  });

  it('opens as it is when the name is not on the list, and keeps the zoom', () => {
    const base = { ...standing(20), zoom: 1.5 };
    expect(openingPose(base, '사선')).toBe(base);
    expect(openingPose(base, undefined)).toBe(base);
    expect(openingPose(base, '왼쪽').zoom).toBe(1.5);
  });

  it('reads 정면 at a level 10° for the estimate an upright mesh starts from', () => {
    // A mesh whose shape estimate gives no tilt: the default pose already faces front.
    const positions = new Float32Array([-1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, 1, 1]);
    const object = quaternion(new Quaternion(...estimateUprightQuaternion(positions)));
    const opened = openingPose({ ...createDefaultPose(), objectQuaternion: object }, '정면');
    expect(away(poseDirection(opened).angle, 0)).toBeLessThan(2);
    expect(poseDirection(opened).elevation).toBeCloseTo(10, 6);
  });
});

describe('telling whether the product was turned', () => {
  it('counts a change of where it faces or of the camera height, not zoom or the picture’s tilt', () => {
    const base = openingPose(standing(30), '정면');
    expect(directionMoved(base, base)).toBe(false);
    expect(directionMoved(base, { ...base, zoom: 3 })).toBe(false);
    expect(directionMoved(base, openingPose(base, '오른쪽'))).toBe(true);
    expect(directionMoved(base, openingPose(base, '뒤'))).toBe(true);
    expect(directionMoved(base, openingPose(base, '위'))).toBe(true);
    // A small turn under the threshold is not a turn; just over it is.
    const turned = (degrees: number): ProductPose => ({
      ...base,
      cameraQuaternion: quaternion(
        new Quaternion()
          .setFromAxisAngle(new Vector3(0, 0, 1), (degrees * Math.PI) / 180)
          .multiply(new Quaternion(...base.cameraQuaternion)),
      ),
    });
    expect(directionMoved(base, turned(0.5))).toBe(false);
    expect(directionMoved(base, turned(2))).toBe(true);
    // Wraps around 180°: 179.5° and −179.5° are one degree apart.
    const behind = openingPose(base, '뒤');
    expect(directionMoved(behind, turned(0))).toBe(true);
  });
});

describe('a new angle added without picking the name or turning the product', () => {
  const opened = openingPose(standing(40), '정면');
  it('is turned to face the name the list suggests, as picking it would', () => {
    const next = poseForNewAngle(opened, '왼쪽', true);
    expect(next.turned).toBe(true);
    expect(away(poseDirection(next.pose).angle, -90)).toBeLessThan(2);
    expect(directionMismatch(next.pose, '왼쪽')).toBeUndefined();
  });

  it('is saved as it is once the user picked a name or turned the product', () => {
    const next = poseForNewAngle(opened, '왼쪽', false);
    expect(next.turned).toBe(false);
    expect(next.pose).toBe(opened);
  });

  it('is left alone when the pose already faces the name, or the name is not on the list', () => {
    expect(poseForNewAngle(opened, '정면', true)).toEqual({ pose: opened, turned: false });
    expect(poseForNewAngle(opened, '사선', true)).toEqual({ pose: opened, turned: false });
  });
});
