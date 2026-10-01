import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import {
  PRODUCT_DIRECTIONS,
  MAX_PRODUCT_VIEWS,
  describeProductFacing,
  directionAngle,
  directionSuitsFace,
  facingOfDirection,
  isProductDirection,
  mismatchMessage,
  nearestHorizontalDirection,
  nextProductDirection,
  readMaterialViews,
  readProductDirection,
  suitingDirection,
} from '../src/lib/product-direction';
import {
  DIRECTION_TOLERANCE,
  directionMismatch,
  nearestPoseDirection,
  poseDirection,
  poseForDirection,
} from '../src/lib/product3d/direction-pose';
import { createDefaultPose, levelCameraQuaternion } from '../src/lib/product3d/pose';
import type { ProductPose } from '../src/lib/product3d/state-types';

const away = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);
const quaternion = (q: Quaternion) => q.toArray() as ProductPose['objectQuaternion'];

describe('the closed list of angle names', () => {
  it('has the six names, in the list order, one photo each', () => {
    expect([...PRODUCT_DIRECTIONS]).toEqual(['정면', '왼쪽', '오른쪽', '위', '아래', '뒤']);
    expect(MAX_PRODUCT_VIEWS).toBe(6);
    expect(PRODUCT_DIRECTIONS.every(isProductDirection)).toBe(true);
    for (const free of ['사선', '정면 ', '', 'front', '각도 1', 3, null, undefined])
      expect(isProductDirection(free)).toBe(false);
  });

  it('reads older names as their nearest direction, and what it cannot read as 정면 (unknown)', () => {
    const cases: [string, string][] = [
      ['오른쪽 측면', '오른쪽'],
      ['왼쪽 측면', '왼쪽'],
      ['뒤에서', '뒤'],
      ['후면', '뒤'],
      ['위에서', '위'],
      ['front', '정면'],
      ['left', '왼쪽'],
      ['right', '오른쪽'],
      ['back', '뒤'],
      ['오른쪽 사선', '오른쪽'],
      ['왼쪽 사선', '왼쪽'],
      [' 정면 ', '정면'],
      ['오른쪽', '오른쪽'],
    ];
    for (const [old, now] of cases) expect(readProductDirection(old)).toEqual({ name: now, known: true });
    for (const old of ['사선', '원본 사진 방향', '공간 공통 카메라', '각도 1', '', '옆면 비스듬히'])
      expect(readProductDirection(old)).toEqual({ name: '정면', known: false });
  });

  it('suggests the first direction not used yet, in the list order', () => {
    expect(nextProductDirection([])).toBe('정면');
    expect(nextProductDirection(['정면'])).toBe('왼쪽');
    expect(nextProductDirection(['정면', '왼쪽'])).toBe('오른쪽');
    expect(nextProductDirection(['정면', '오른쪽'])).toBe('왼쪽');
    expect(nextProductDirection(['정면', '왼쪽', '오른쪽'])).toBe('위');
    expect(nextProductDirection([...PRODUCT_DIRECTIONS])).toBeUndefined();
  });

  it('maps names to the angle the product faces; 위 and 아래 have none', () => {
    expect(PRODUCT_DIRECTIONS.map((name) => directionAngle(name))).toEqual([
      0,
      -90,
      90,
      undefined,
      undefined,
      180,
    ]);
    expect(nearestHorizontalDirection(80).name).toBe('오른쪽');
    expect(nearestHorizontalDirection(-200).name).toBe('뒤');
    expect(nearestHorizontalDirection(-44).name).toBe('정면');
    expect(nearestHorizontalDirection(-46).name).toBe('왼쪽');
    expect(PRODUCT_DIRECTIONS.map((name) => facingOfDirection(name))).toEqual([
      'front',
      'left',
      'right',
      undefined,
      undefined,
      'back',
    ]);
  });
});

describe('names against the wall a product stands on', () => {
  it('suits 오른쪽 on the left wall, 왼쪽 on the right wall, 정면 on the back wall, anything on the floor', () => {
    expect(suitingDirection('left')).toBe('오른쪽');
    expect(suitingDirection('right')).toBe('왼쪽');
    expect(suitingDirection('back')).toBe('정면');
    expect(suitingDirection('floor')).toBeUndefined();
    for (const name of PRODUCT_DIRECTIONS) expect(directionSuitsFace('floor', name)).toBe(true);
    expect(directionSuitsFace('left', '오른쪽')).toBe(true);
    expect(directionSuitsFace('left', '정면')).toBe(false);
    expect(directionSuitsFace('back', '정면')).toBe(true);
    expect(directionSuitsFace('back', '위')).toBe(false);
  });

  it('says where the product looks and warns, in words, only when it does not suit', () => {
    expect(describeProductFacing('left', '오른쪽')).toBe('방 안쪽을 봐요.');
    expect(describeProductFacing('right', '왼쪽')).toBe('방 안쪽을 봐요.');
    expect(describeProductFacing('back', '정면')).toBe('정면(방 안쪽)을 봐요.');
    expect(describeProductFacing('floor', '정면')).toBe('정면(열린 쪽)을 봐요.');
    expect(describeProductFacing('left', '정면')).toBe('정면(열린 쪽)을 봐요.');
    expect(describeProductFacing('floor', '뒤')).toBe('뒤 벽 쪽을 봐요.');
    expect(describeProductFacing('back', '위')).toMatch(/방향은 정하지 않아요/);
    expect(mismatchMessage('left', '오른쪽')).toBe('');
    expect(mismatchMessage('floor', '뒤')).toBe('');
    expect(mismatchMessage('left', '정면')).toBe(
      '왼쪽 벽에는 ‘오른쪽’ 각도가 어울려요. 지금은 ‘정면’ 각도라 정면(열린 쪽)을 봐요.',
    );
  });
});

describe('older stored material versions', () => {
  const view = (direction: string, extra = {}) => ({
    assetId: 'a',
    direction,
    anchor: { x: 0.5, y: 0.5 },
    ...extra,
  });
  it('reads every view through the list, in place, flagging only what it could not read', () => {
    const version = { id: 'v', views: [view('정면'), view('오른쪽 측면'), view('사선'), view('뒤에서')] };
    const read = readMaterialViews(version);
    expect(read.views.map((v) => v.direction)).toEqual(['정면', '오른쪽', '정면', '뒤']);
    expect(read.views.map((v) => (v as { directionWas?: string }).directionWas)).toEqual([
      undefined,
      undefined,
      '사선',
      undefined,
    ]);
    // Nothing else changes, and the stored object is not modified.
    expect(read.views[1]).toEqual(view('오른쪽'));
    expect(version.views[1].direction).toBe('오른쪽 측면');
  });

  it('returns the very same object when every name is already on the list', () => {
    const version = { views: [view('정면'), view('왼쪽')] };
    expect(readMaterialViews(version)).toBe(version);
    const none = { views: [] };
    expect(readMaterialViews(none)).toBe(none);
  });

  it('does not flag a reconstruction material (internal, disposable)', () => {
    const read = readMaterialViews({ reconstruction: { version: 2 }, views: [view('공간 공통 카메라')] });
    expect(read.views[0]).toEqual(view('정면'));
  });

  it('drops a stale flag once the name is on the list', () => {
    const read = readMaterialViews({ views: [view('정면', { directionWas: '사선' })] });
    expect('directionWas' in read.views[0]).toBe(false);
  });
});

describe('a 360° pose against a name', () => {
  it("the default pose faces the front at the editor's 10° height", () => {
    const read = poseDirection(createDefaultPose());
    expect(read.angle).toBeCloseTo(0, 6);
    expect(read.elevation).toBeCloseTo(10, 6);
    expect(nearestPoseDirection(createDefaultPose()).name).toBe('정면');
  });

  it.each([
    ['정면', 0],
    ['오른쪽', 90],
    ['왼쪽', -90],
    ['뒤', 180],
  ] as const)('turning to %s makes the product face %i° and keeps its standing', (name, angle) => {
    const start = createDefaultPose();
    const turned = poseForDirection(start, name);
    const read = poseDirection(turned);
    expect(away(read.angle, angle)).toBeLessThan(1e-6);
    expect(read.elevation).toBeCloseTo(10, 6);
    // The object is not touched, only the camera moves; no roll.
    expect(turned.objectQuaternion).toEqual(start.objectQuaternion);
    const camera = new Quaternion(...turned.cameraQuaternion);
    expect(new Vector3(1, 0, 0).applyQuaternion(camera).z).toBeCloseTo(0, 9);
    expect(directionMismatch(turned, name)).toBeUndefined();
    expect(nearestPoseDirection(turned).name).toBe(name);
  });

  it('turns an already turned or tilted object by where it faces, not from the default', () => {
    // An object standing 7° off the vertical and turned 130° about it.
    const object = new Quaternion()
      .setFromAxisAngle(new Vector3(0, 0, 1), (130 * Math.PI) / 180)
      .multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), (7 * Math.PI) / 180));
    const start: ProductPose = { ...createDefaultPose(), objectQuaternion: quaternion(object) };
    for (const name of ['정면', '오른쪽', '왼쪽', '뒤'] as const) {
      const turned = poseForDirection(start, name);
      expect(turned.objectQuaternion).toEqual(start.objectQuaternion);
      expect(away(poseDirection(turned).angle, directionAngle(name)!)).toBeLessThan(1e-6);
    }
  });

  it('위 raises the camera above the limit and keeps the side; 아래 lowers it; a name turns it back', () => {
    const side = poseForDirection(createDefaultPose(), '오른쪽');
    const up = poseForDirection(side, '위');
    expect(poseDirection(up).elevation).toBeCloseTo(60, 6);
    expect(poseDirection(up).angle).toBeCloseTo(poseDirection(side).angle, 6);
    expect(nearestPoseDirection(up).name).toBe('위');
    const down = poseForDirection(side, '아래');
    expect(poseDirection(down).elevation).toBeCloseTo(-45, 6);
    expect(nearestPoseDirection(down).name).toBe('아래');
    // Already high enough: stays where it is.
    expect(poseDirection(poseForDirection(up, '위')).elevation).toBeCloseTo(60, 6);
    // Back to a side from above returns to the normal height.
    expect(poseDirection(poseForDirection(up, '왼쪽')).elevation).toBeCloseTo(10, 6);
    expect(directionMismatch(up, '위')).toBeUndefined();
    expect(directionMismatch(side, '위')?.nearest).toBe('오른쪽');
    expect(directionMismatch(up, '정면')?.nearest).toBe('위');
  });

  it('warns past 25° and names the nearest direction', () => {
    const turn = (degreesOff: number) => {
      const q = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), (-degreesOff * Math.PI) / 180);
      // Orbiting the camera about the vertical by degreesOff changes where the product faces by the same.
      const pose = createDefaultPose();
      const camera = new Quaternion(...pose.cameraQuaternion);
      return { ...pose, cameraQuaternion: quaternion(q.multiply(camera)) };
    };
    expect(DIRECTION_TOLERANCE).toBe(25);
    expect(directionMismatch(turn(20), '정면')).toBeUndefined();
    expect(directionMismatch(turn(24), '정면')).toBeUndefined();
    const off = directionMismatch(turn(35), '정면');
    expect(off?.nearest).toBe('정면');
    expect(off!.degrees).toBeGreaterThan(25);
    const far = directionMismatch(turn(80), '정면');
    expect(far?.nearest === '오른쪽' || far?.nearest === '왼쪽').toBe(true);
  });

  it('the room sees the same direction the name gives (level camera)', () => {
    // The product's front in the level camera's frame, as the 3D room places it.
    for (const name of ['정면', '오른쪽', '왼쪽', '뒤'] as const) {
      const pose = poseForDirection(createDefaultPose(), name);
      const level = levelCameraQuaternion(new Quaternion(...pose.cameraQuaternion));
      const front = new Vector3(1, 0, 0).applyQuaternion(
        level.invert().multiply(new Quaternion(...pose.objectQuaternion)),
      );
      const angle = (Math.atan2(front.x, front.z) * 180) / Math.PI;
      expect(away(angle, directionAngle(name)!)).toBeLessThan(1e-6);
    }
  });
});
