import { describe, expect, it } from 'vitest';
import { inspectDepthRoomCameraHypotheses } from '../src/lib/reconstruction/depth-room-hypotheses';
import { fitDepthRoomCamera, type DepthRoomObservation, type DepthPlaneObservation } from '../src/lib/reconstruction/depth-room-geometry';
import { DEFAULT_ROOM } from '../src/lib/room-geometry';

const fingerprint = 'a'.repeat(64);
function input(): DepthRoomObservation {
  const plane = (id: string, normalCamera: [number, number, number], offset: number, medianPointCamera: [number, number, number]): DepthPlaneObservation => ({
    id, normalCamera, offset, medianPointCamera, inlierCount: 1000, inlierFraction: .5,
    imageAreaFraction: .1, rmsResidual: .001,
  });
  return { version: 1, inputFingerprint: fingerprint, image: { width: 1000, height: 1000 },
    model: { id: 'synthetic', revision: '1' }, coordinateSystem: 'opencv-camera', scale: 'model-estimated-metres',
    intrinsics: { fx: 1, fy: 1, cx: .5, cy: .5 },
    floor: plane('floor', [0, -1, 0], 1, [0, 1, 2]),
    walls: [plane('back-a', [0, 0, -1], 2, [0, 0, 2]),
      plane('back-b', [0, 0, -1], 2.03, [0, 0, 2.03]), plane('side', [1, 0, 0], 1, [-1, 0, 2])],
  };
}

describe('unselected depth room hypotheses', () => {
  it('keeps the strict result held while exposing separate same-direction offsets', () => {
    const observation = input();
    const original = structuredClone(observation);
    const result = inspectDepthRoomCameraHypotheses(DEFAULT_ROOM, observation, fingerprint);
    expect(result.strict).toEqual(fitDepthRoomCamera(DEFAULT_ROOM, observation, fingerprint));
    expect(result.strict.fit.status).toBe('held');
    expect(result.directionGroups[0].planeIds).toEqual(['back-a', 'back-b']);
    expect(result.directionGroups[0].maximumOffsetModelUnits).toBe(2.03);
    expect(result.hypotheses).toHaveLength(2);
    expect(result.hypotheses.every((p) => p.result.fit.status === 'estimated')).toBe(true);
    expect(result.poseDifferences[0].positionDifferenceMm).toBeCloseTo(30, 8);
    expect(result.poseDifferences[0].rotationDifferenceDegrees).toBe(0);
    expect(result.hypotheses[0].excludedWallIds).toEqual(['back-b']);
    expect(result.promotedToProduction).toBe(false);
    expect(observation).toEqual(original);
  });
  it('does not manufacture a side plane from parallel front-facing patches', () => {
    const observation = input();
    observation.walls.pop();
    const result = inspectDepthRoomCameraHypotheses(DEFAULT_ROOM, observation, fingerprint);
    expect(result.hypotheses).toHaveLength(0);
    expect(result.strict.fit.status).toBe('held');
  });
  it('every pair still obeys fingerprint and residual checks', () => {
    const observation = input();
    const mismatch = inspectDepthRoomCameraHypotheses(DEFAULT_ROOM, observation, 'b'.repeat(64));
    expect(mismatch.hypotheses.every((p) => p.result.fit.status === 'held')).toBe(true);
    observation.walls[2].rmsResidual = 1;
    const noisy = inspectDepthRoomCameraHypotheses(DEFAULT_ROOM, observation, fingerprint);
    expect(noisy.hypotheses.every((p) => p.result.fit.status === 'held')).toBe(true);
  });
  it('does not enumerate oversized or invalid-normal inputs', () => {
    const observation = input();
    observation.walls = Array.from({ length: 17 }, () => observation.walls[0]);
    expect(inspectDepthRoomCameraHypotheses(DEFAULT_ROOM, observation, fingerprint).hypotheses).toHaveLength(0);
    observation.walls = [input().walls[0]];
    observation.walls[0].normalCamera = [0, 0, -2];
    expect(inspectDepthRoomCameraHypotheses(DEFAULT_ROOM, observation, fingerprint).hypotheses).toHaveLength(0);
  });
});