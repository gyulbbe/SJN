import { describe, it, expect } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import {
  chooseExportPhoto,
  photoFootprint,
  photoViewAngle,
  poseAzimuth,
  sameFootprint,
} from '../src/lib/room-viewer/fixtures';
import { createDefaultPose } from '../src/lib/product3d/pose';
import type { ProductPose } from '../src/lib/product3d/state-types';

/** The default pose with the object turned about its up axis (TripoSR +z) by `degrees`. */
function turned(degrees: number): ProductPose {
  const pose = createDefaultPose();
  return {
    ...pose,
    objectQuaternion: new Quaternion()
      .setFromAxisAngle(new Vector3(0, 0, 1), (degrees * Math.PI) / 180)
      .toArray() as ProductPose['objectQuaternion'],
  };
}
const view = (direction: string, pose?: ProductPose) => ({
  assetId: direction,
  direction,
  anchor: { x: 0.5, y: 1 },
  ...(pose
    ? {
        product3d: {
          version: 1 as const,
          meshAssetId: 'm',
          inputAssetId: 'i',
          pose,
          modelId: 'triposr',
          modelRevision: '1',
        },
      }
    : {}),
});

describe('AI export photo angles', () => {
  it('reads the saved 3D pose as the camera angle around the product, like the side names', () => {
    expect(poseAzimuth(createDefaultPose())).toBeCloseTo(0, 6);
    // Turning the object left brings its right side (+y) to the camera: like "오른쪽 측면" (90).
    expect(poseAzimuth(turned(-90))).toBeCloseTo(90, 6);
    expect(poseAzimuth(turned(45))).toBeCloseTo(-45, 6);
    // From steeply above: no horizontal angle.
    const above = createDefaultPose();
    above.cameraQuaternion = new Quaternion().toArray() as ProductPose['cameraQuaternion'];
    expect(poseAzimuth(above)).toBeUndefined();
  });

  it('names the angle of a photo from its label or its pose, nothing else', () => {
    expect(photoViewAngle(view('정면'))).toBe(0);
    expect(photoViewAngle(view('오른쪽 사선'))).toBe(45);
    expect(photoViewAngle(view('왼쪽 사선'))).toBe(-45);
    expect(photoViewAngle(view('왼쪽 측면'))).toBe(-90);
    expect(photoViewAngle(view('위에서'))).toBeUndefined();
    expect(photoViewAngle(view('사선'))).toBeUndefined();
    expect(photoViewAngle(view('각도 1', turned(-45)))).toBeCloseTo(45, 6);
  });

  it('keeps the footprint: width, height within 5%, the anchor within 2% of the content', () => {
    const placement = { widthMm: 400, heightMm: 600, scale: 1 };
    const bounds = { left: 0, right: 1, top: 0, bottom: 1 };
    const front = photoFootprint(placement, bounds, 200 / 300, { x: 0.5, y: 1 });
    expect(front).toEqual({ width: 400, height: 600, anchorX: 0.5, anchorY: 1 });
    // The same outline from a diagonal: kept.
    expect(sameFootprint(front, photoFootprint(placement, bounds, 200 / 300, { x: 0.5, y: 1 }))).toBe(true);
    // A narrow side photo: another width.
    expect(sameFootprint(front, photoFootprint(placement, bounds, 90 / 300, { x: 0.5, y: 1 }))).toBe(false);
    // Same size, the base point moved.
    expect(sameFootprint(front, photoFootprint(placement, bounds, 200 / 300, { x: 0.46, y: 1 }))).toBe(false);
    // A photo with a margin around the product draws the same content: kept.
    const margin = { left: 0.1, right: 0.9, top: 0.05, bottom: 0.95 };
    expect(
      sameFootprint(front, photoFootprint(placement, margin, (200 / 300) * (0.9 / 0.8), { x: 0.5, y: 0.95 })),
    ).toBe(true);
  });

  it('picks the usable photo nearest the camera angle, else keeps the chosen one', () => {
    const angles = [0, 45, 90, undefined];
    const all = new Set([0, 1, 2, 3]);
    expect(chooseExportPhoto(angles, 0, 10, 0, all)).toBe(0);
    expect(chooseExportPhoto(angles, 0, 30, 0, all)).toBe(1);
    expect(chooseExportPhoto(angles, 0, 80, 0, all)).toBe(2);
    // Not usable (another footprint): the next nearest usable, or the chosen one.
    expect(chooseExportPhoto(angles, 0, 80, 0, new Set([0, 1]))).toBe(1);
    expect(chooseExportPhoto(angles, 0, 30, 0, new Set([0]))).toBe(0);
    // Steeply above, or a chosen photo without an angle: unchanged.
    expect(chooseExportPhoto(angles, 0, 45, 50, all)).toBe(0);
    expect(chooseExportPhoto(angles, 3, 45, 0, all)).toBe(3);
    // A diagonal chosen by the user: the front is nearer from straight ahead.
    expect(chooseExportPhoto(angles, 1, -40, 0, all)).toBe(0);
  });
});
