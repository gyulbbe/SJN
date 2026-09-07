import { describe, expect, it } from 'vitest';
import { refineWallMask, type WallRefinementInput } from '../src/lib/segmentation/wall-refinement';

function input(width = 80, height = 64): WallRefinementInput {
  const rgba = new Uint8ClampedArray(width * height * 4).fill(220);
  for (let p = 0; p < width * height; p++) rgba[p * 4 + 3] = 255;
  const channels = 151;
  const values = new Float32Array(width * height * channels).fill(-20);
  for (let p = 0; p < width * height; p++) values[p * channels + 1] = 20;
  return {
    width,
    height,
    rgba,
    labels: new Uint8Array(width * height).fill(1),
    logits: {
      values,
      width,
      height,
      channels,
      cropWidth: width,
      cropHeight: height,
      paddedWidth: width,
      paddedHeight: height,
    },
  };
}
function paint(scene: WallRefinementInput, x: number, y: number, color: number) {
  const p = y * scene.width + x;
  for (let c = 0; c < 3; c++) scene.rgba[p * 4 + c] = color;
}
function objectEvidence(
  scene: WallRefinementInput,
  x: number,
  y: number,
  label: number,
  wall = 12,
  object = 11.5,
) {
  const p = (y * scene.width + x) * scene.logits!.channels;
  scene.logits!.values[p + 1] = wall;
  scene.logits!.values[p + label] = object;
}
function doorway(withImageEdge = true, withDoorEvidence = true) {
  const scene = input();
  for (let y = 0; y < scene.height; y++)
    for (let x = 0; x < 12; x++) {
      if (withImageEdge) paint(scene, x, y, 160);
      if (withDoorEvidence) objectEvidence(scene, x, y, 15, 18, 12);
    }
  return scene;
}

describe('보수적 벽 물체 보호', () => {
  it('어두운 줄눈이나 그림자만으로 벽을 뚫지 않는다', () => {
    const scene = input();
    for (let y = 0; y < scene.height; y++)
      for (let x = 0; x < scene.width; x++) if (x % 16 === 0 || y % 16 === 0) paint(scene, x, y, 90);
    expect(refineWallMask(scene).stats.excludedPixels).toBe(0);
  });

  it('비벽 분류 후보와 작은 물체의 RGB 대비가 함께 있을 때 보호한다', () => {
    const scene = input();
    for (let y = 28; y < 32; y++)
      for (let x = 38; x < 42; x++) {
        paint(scene, x, y, 110);
        objectEvidence(scene, x, y, 48);
      }
    const refined = refineWallMask(scene);
    expect(refined.wall[29 * scene.width + 39]).toBe(0);
    expect(refined.wall[29 * scene.width + 34]).toBe(255);
    expect(refined.stats.excludedPixels).toBe(16);
  });

  it('비벽 후보만 있고 사진 대비가 없으면 추가 구멍을 만들지 않는다', () => {
    const scene = input();
    for (let y = 28; y < 32; y++) for (let x = 38; x < 42; x++) objectEvidence(scene, x, y, 48);
    expect(refineWallMask(scene).stats.excludedPixels).toBe(0);
  });

  it('문 후보와 긴 사진 경계가 함께 있는 외곽 부분을 보호한다', () => {
    const scene = doorway();
    const refined = refineWallMask(scene);
    expect(refined.stats.exterior).toHaveLength(1);
    expect(refined.wall[30 * scene.width + 4]).toBe(0);
    expect(refined.wall[30 * scene.width + 30]).toBe(255);
  });

  it('사진 경계만 있거나 문 후보만 있으면 외곽을 잘라내지 않는다', () => {
    expect(refineWallMask(doorway(true, false)).stats.exterior).toHaveLength(0);
    expect(refineWallMask(doorway(false, true)).stats.exterior).toHaveLength(0);
  });

  it('바닥을 가로지르는 외곽 후보는 거부한다', () => {
    const scene = doorway();
    for (let y = 48; y < scene.height; y++)
      for (let x = 0; x < 12; x++) scene.labels[y * scene.width + x] = 4;
    const before = scene.labels.slice();
    expect(refineWallMask(scene).stats.exterior).toHaveLength(0);
    expect(scene.labels).toEqual(before);
  });

  it('검출된 비벽 영역은 복원하거나 벽으로 확장하지 않는다', () => {
    const scene = input();
    scene.labels[10 * scene.width + 10] = 28;
    scene.labels[11 * scene.width + 10] = 66;
    const refined = refineWallMask(scene);
    expect(refined.wall[10 * scene.width + 10]).toBe(0);
    expect(refined.wall[11 * scene.width + 10]).toBe(0);
    for (let p = 0; p < refined.wall.length; p++) if (refined.wall[p]) expect(scene.labels[p]).toBe(1);
  });

  it('점수가 없는 입력에서는 추측으로 물체를 추가하지 않는다', () => {
    const scene = doorway();
    delete scene.logits;
    expect(refineWallMask(scene).stats.excludedPixels).toBe(0);
  });

  it('잘못된 입력 크기를 거부한다', () => {
    expect(() => refineWallMask({ ...input(), width: 513 })).toThrow();
  });
});
