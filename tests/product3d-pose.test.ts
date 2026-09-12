import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import {
  createDefaultPose,
  ProductPoseHistory,
  rotateInScreen,
  samePose,
  screenDragAngle,
  validatePose,
} from '../src/lib/product3d/pose';

describe('360도 제품 자세', () => {
  it('기본 시점은 +z 위쪽, +x 제품 촬영 방향을 바라본다', () => {
    const pose = createDefaultPose();
    const facing = new Vector3(0, 0, 1).applyQuaternion(new Quaternion(...pose.cameraQuaternion));
    expect(facing.x).toBeCloseTo(Math.cos(Math.PI / 18));
    expect(facing.z).toBeCloseTo(Math.sin(Math.PI / 18));
    expect(pose.objectQuaternion).toEqual([0, 0, 0, 1]);
  });
  it('저장 자세의 quaternion을 정규화하고 참조를 분리한다', () => {
    const original = createDefaultPose();
    original.objectQuaternion = [0, 0, 0, -4];
    const normalized = validatePose(original);
    expect(normalized.objectQuaternion[3]).toBe(1);
    normalized.cameraQuaternion[0] = 100;
    expect(original.cameraQuaternion[0]).not.toBe(100);
  });
  it.each([0, NaN, Infinity, -1, 9])('잘못된 확대값 %s를 거부한다', (zoom) => {
    expect(() => validatePose({ ...createDefaultPose(), zoom })).toThrow();
  });
  it.each([
    [0, 0, 0, 0],
    [0, 1, NaN, 1],
    [0, 1, 2],
    ['0', 0, 0, 1],
  ])('잘못된 회전을 거부한다: %s', (...quaternion) => {
    expect(() => validatePose({ ...createDefaultPose(), objectQuaternion: quaternion })).toThrow();
  });
  it('위 손잡이를 오른쪽, 아래 손잡이를 왼쪽으로 움직이면 같은 시계 방향이다', () => {
    const center = { x: 200, y: 200 };
    const top = screenDragAngle(center, { x: 200, y: 100 }, { x: 220, y: 100 });
    const bottom = screenDragAngle(center, { x: 200, y: 300 }, { x: 180, y: 300 });
    expect(top).toBeGreaterThan(0);
    expect(top).toBeCloseTo(bottom);
    expect(
      samePose(rotateInScreen(createDefaultPose(), top), rotateInScreen(createDefaultPose(), bottom)),
    ).toBe(true);
  });
  it('자유 시점에서도 화면 평면 보정은 카메라를 변경하지 않고 오른쪽으로 제품을 세운다', () => {
    const pose = createDefaultPose();
    const camera = new Quaternion().setFromAxisAngle(new Vector3(1, 2, 3).normalize(), 1.3);
    pose.cameraQuaternion = camera.toArray();
    const next = rotateInScreen(pose, Math.PI / 12);
    expect(next.cameraQuaternion).toEqual(validatePose(pose).cameraQuaternion);
    const up = new Vector3(0, 1, 0).applyQuaternion(camera);
    up.applyQuaternion(new Quaternion(...next.objectQuaternion)).applyQuaternion(camera.clone().invert());
    expect(up.x).toBeGreaterThan(0);
    expect(up.y).toBeCloseTo(Math.cos(Math.PI / 12));
  });
  it('기울기 보정은 여러 번 이어져도 정규화되어 누적되며 360도에서 원래 자세로 돌아온다', () => {
    let pose = createDefaultPose();
    for (let i = 0; i < 360; i++) pose = rotateInScreen(pose, Math.PI / 180);
    expect(samePose(pose, createDefaultPose())).toBe(true);
    expect(new Quaternion(...pose.objectQuaternion).length()).toBeCloseTo(1, 12);
  });
  it('손잡이를 중심으로 이동할 때 유효하지 않은 각도를 만들지 않는다', () => {
    expect(screenDragAngle({ x: 0, y: 0 }, { x: 0, y: -100 }, { x: 0, y: 0 })).toBe(0);
    expect(() => rotateInScreen(createDefaultPose(), NaN)).toThrow();
  });
  it('한 번 확정한 드래그를 한 이력으로 저장하고 별도 카메라·제품 회전을 함께 복원한다', () => {
    const initial = createDefaultPose();
    const history = new ProductPoseHistory(initial);
    const tilted = rotateInScreen(initial, 0.3);
    const final = {
      ...tilted,
      cameraQuaternion: new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 2).toArray(),
      zoom: 2,
    };
    history.record(final);
    expect(samePose(history.undo(), initial)).toBe(true);
    expect(samePose(history.redo(), final)).toBe(true);
  });
  it('최근 50개만 저장하며 같은 자세나 quaternion 부호 차이는 새 편집이 아니다', () => {
    const initial = createDefaultPose(),
      history = new ProductPoseHistory(initial);
    expect(history.record(initial)).toBe(false);
    const opposite = { ...initial, objectQuaternion: [0, 0, 0, -1] as [number, number, number, number] };
    expect(history.record(opposite)).toBe(false);
    for (let i = 1; i <= 60; i++) history.record(rotateInScreen(initial, i / 100));
    let count = 0;
    while (history.canUndo) {
      history.undo();
      count++;
    }
    expect(count).toBe(50);
    expect(samePose(history.pose, rotateInScreen(initial, 0.1))).toBe(true);
    history.record(initial);
    expect(history.canRedo).toBe(false);
  });
});
