import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { levelByOutline } from '../src/lib/product3d/outline-level';
import { createDefaultPose, levelCameraQuaternion, rotateInScreen } from '../src/lib/product3d/pose';
import { estimateSilhouetteTilt } from '../src/lib/product3d/silhouette-tilt';
import type { ProductPose } from '../src/lib/product3d/state-types';
import { boxMesh, joinMeshes, rasterizeSilhouette, sphereMesh } from './helpers/silhouette-raster';

/**
 * A one-piece toilet in TripoSR coordinates (+z up, photographed from +x): a tank behind and a
 * wider bowl in front. Seen from the side or the front its outline is made of level and upright
 * lines, whichever way it is turned about the vertical.
 */
const toilet = () =>
  joinMeshes(boxMesh([-0.32, -0.2, 0.1], [-0.05, 0.2, 0.55]), boxMesh([-0.3, -0.22, -0.5], [0.3, 0.22, 0.1]));
const basin = () =>
  joinMeshes(boxMesh([-0.2, -0.45, -0.2], [0.2, 0.45, 0.2]), boxMesh([-0.15, -0.03, 0.2], [-0.1, 0.03, 0.5]));

const level = (pose: ProductPose): ProductPose => ({
  ...pose,
  cameraQuaternion: levelCameraQuaternion(
    new Quaternion(...pose.cameraQuaternion),
  ).toArray() as ProductPose['cameraQuaternion'],
});
/** The pose with its product rolled on the (level) screen by `degrees` clockwise. */
const rolled = (pose: ProductPose, degrees: number): ProductPose => ({
  ...pose,
  objectQuaternion: rotateInScreen(level(pose), (degrees * Math.PI) / 180).objectQuaternion,
});
/** Radians between two rotations. */
const angleBetween = (a: number[], b: number[]) =>
  2 * Math.acos(Math.min(1, Math.abs(new Quaternion(...a).dot(new Quaternion(...b)))));
const yawed = (pose: ProductPose, degrees: number): ProductPose => ({
  ...pose,
  objectQuaternion: new Quaternion()
    .setFromAxisAngle(new Vector3(0, 0, 1), (degrees * Math.PI) / 180)
    .multiply(new Quaternion(...pose.objectQuaternion))
    .toArray() as ProductPose['objectQuaternion'],
});
/** The screen roll of the outline a level camera sees, by the estimator itself. */
const rollOf = (mesh: ReturnType<typeof toilet>, pose: ProductPose) => {
  const picture = rasterizeSilhouette(mesh, level(pose), 384);
  return estimateSilhouetteTilt(picture.alpha, picture.width, picture.height)?.degrees;
};

describe('levelByOutline: the product is turned until the edges of its outline are level', () => {
  const draw = (mesh: ReturnType<typeof toilet>) => (pose: ProductPose) =>
    rasterizeSilhouette(mesh, pose, 384);

  it('stands a rolled toilet and basin upright from −40° to 40° (the outline reads level after)', () => {
    for (const [name, mesh] of [
      ['toilet', toilet()],
      ['basin', basin()],
    ] as const)
      for (const degrees of [-40, -25, -10, 8, 22, 38]) {
        const start = rolled(createDefaultPose(), degrees);
        const result = levelByOutline(start, draw(mesh));
        expect(result.status, `${name} ${degrees}°`).toBe('turned');
        expect(Math.abs(result.degrees - degrees), `${name} ${degrees}°`).toBeLessThan(1);
        expect(Math.abs(rollOf(mesh, result.pose) ?? 99), `${name} ${degrees}° after`).toBeLessThan(0.6);
      }
  });

  it('turns only the product: the camera stays, the turn is the roll that was read', () => {
    const start = rolled(createDefaultPose(), 21);
    const result = levelByOutline(start, draw(toilet()));
    expect(result.pose.cameraQuaternion).toEqual(start.cameraQuaternion);
    expect(result.pose.zoom).toBe(start.zoom);
    expect(
      Math.abs((angleBetween(result.pose.objectQuaternion, start.objectQuaternion) * 180) / Math.PI - 21),
    ).toBeLessThan(1);
  });

  it('measures through a level camera, whatever the camera it was given looks down from', () => {
    const seen: number[] = [];
    const start = rolled(createDefaultPose(), 15);
    // The saved camera looks 10° down; the pictures asked for are level (no elevation).
    expect(new Vector3(0, 0, 1).applyQuaternion(new Quaternion(...start.cameraQuaternion)).z).toBeGreaterThan(
      0.15,
    );
    levelByOutline(start, (pose) => {
      seen.push(new Vector3(0, 0, 1).applyQuaternion(new Quaternion(...pose.cameraQuaternion)).z);
      return rasterizeSilhouette(toilet(), pose, 384);
    });
    expect(seen.length).toBeGreaterThan(0);
    for (const z of seen) expect(Math.abs(z)).toBeLessThan(1e-9);
  });

  it('reads at most twice, and the second reading finds it level', () => {
    let reads = 0;
    const start = rolled(createDefaultPose(), 33);
    const result = levelByOutline(start, (pose) => {
      reads++;
      return rasterizeSilhouette(toilet(), pose, 384);
    });
    expect(reads).toBe(2);
    expect(result.status).toBe('turned');
    // Another run from the result changes nothing.
    const again = levelByOutline(result.pose, draw(toilet()));
    expect(again.status).toBe('level');
    expect(again.pose).toEqual(result.pose);
  });

  it('levels a product that is also turned about the vertical (the camera sees it from the side)', () => {
    for (const yaw of [25, 70, 140, -50]) {
      const start = rolled(yawed(createDefaultPose(), yaw), -18);
      const result = levelByOutline(start, draw(toilet()));
      expect(result.status, `yaw ${yaw}°`).toBe('turned');
      expect(Math.abs(rollOf(toilet(), result.pose) ?? 99), `yaw ${yaw}°`).toBeLessThan(0.6);
    }
  });

  it('keeps which way the product faces: the turn is about the view axis only', () => {
    const start = rolled(yawed(createDefaultPose(), 60), 14);
    const result = levelByOutline(start, draw(toilet()));
    const axis = new Vector3(0, 0, 1).applyQuaternion(
      levelCameraQuaternion(new Quaternion(...start.cameraQuaternion)),
    );
    const turn = new Quaternion(...result.pose.objectQuaternion).multiply(
      new Quaternion(...start.objectQuaternion).invert(),
    );
    // The rotation between them is about the level camera's axis: its axis part is parallel to it.
    const part = new Vector3(turn.x, turn.y, turn.z).normalize();
    expect(Math.abs(Math.abs(part.dot(axis)) - 1)).toBeLessThan(1e-6);
  });

  it('leaves a level product alone (no reading above 0.3°) and says so', () => {
    const start = createDefaultPose();
    const result = levelByOutline(start, draw(toilet()));
    expect(result.status).toBe('level');
    expect(result.degrees).toBe(0);
    expect(result.pose.objectQuaternion).toEqual(start.objectQuaternion);
  });

  it('does not touch a round product: no clear direction, the pose comes back as it was', () => {
    for (const degrees of [0, 20]) {
      const start = rolled(createDefaultPose(), degrees);
      const result = levelByOutline(start, draw(sphereMesh(0.4)));
      expect(result.status).toBe('unclear');
      expect(result.degrees).toBe(0);
      expect(result.pose.objectQuaternion).toEqual(start.objectQuaternion);
    }
  });

  it('does not answer past ±44°: a half-turn from level is not a tilt', () => {
    const start = rolled(createDefaultPose(), 45);
    expect(levelByOutline(start, draw(toilet())).status).toBe('unclear');
  });

  it('keeps the reading to what the caller allows (±maxDegrees)', () => {
    const start = rolled(createDefaultPose(), 30);
    const narrow = levelByOutline(start, draw(toilet()), { maxDegrees: 25 });
    expect(narrow.status).toBe('unclear');
    expect(narrow.pose.objectQuaternion).toEqual(start.objectQuaternion);
  });

  it('validates the pose it is given', () => {
    expect(() => levelByOutline({ ...createDefaultPose(), zoom: 0 }, draw(toilet()))).toThrow();
  });
});
