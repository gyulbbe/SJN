import { buildCandidatePipeline } from '../src/lib/reconstruction/candidate-pipeline';
import type { SceneUnderstanding } from '../src/lib/reconstruction/pipeline-contract';
import type { ReconstructionReview } from '../src/lib/reconstruction/types';
import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import { DEFAULT_ROOM } from '../src/lib/room-geometry';
import {
  fitDepthRoomCamera,
  depthObservedWallAtPoint,
  type DepthRoomObservation,
  type DepthPlaneObservation,
} from '../src/lib/reconstruction/depth-room-geometry';
import {
  projectSourcePoint,
  unprojectSourceToFace,
  type SourceCamera,
} from '../src/lib/reconstruction/source-camera';

const fingerprint = 'a'.repeat(64);
const room = { ...DEFAULT_ROOM };
function observed(roll = 0, yaw = 0, side: 'left' | 'right' = 'left') {
  const camera = new PerspectiveCamera(58, 1.2, 1, 10000);
  camera.position.set(180, 1520, 2800);
  camera.lookAt(yaw ? 2200 : 0, 900, 0);
  camera.rotateZ(roll);
  camera.updateMatrixWorld(true);
  const source: SourceCamera = {
    version: 1,
    positionMm: camera.position.toArray(),
    quaternion: camera.quaternion.toArray(),
    verticalFovDegrees: 58,
    image: { width: 1200, height: 1000 },
  };
  const plane = (id: string, pointWorld: Vector3, normalWorld: Vector3): DepthPlaneObservation => {
    const point = pointWorld
      .clone()
      .applyMatrix4(camera.matrixWorldInverse)
      .multiply(new Vector3(1, -1, -1))
      .divideScalar(1000);
    const normal = normalWorld
      .clone()
      .transformDirection(camera.matrixWorldInverse)
      .multiply(new Vector3(1, -1, -1));
    return {
      id,
      normalCamera: normal.toArray(),
      offset: -normal.dot(point),
      medianPointCamera: point.toArray(),
      inlierCount: 500,
      inlierFraction: 0.8,
      imageAreaFraction: 0.15,
      rmsResidual: 0.002,
    };
  };
  const fy = 0.5 / Math.tan((58 * Math.PI) / 360);
  const observation: DepthRoomObservation = {
    version: 1,
    inputFingerprint: fingerprint,
    image: source.image,
    model: { id: 'synthetic-test', revision: '1' },
    coordinateSystem: 'opencv-camera',
    scale: 'model-estimated-metres',
    intrinsics: { fx: fy / 1.2, fy, cx: 0.5, cy: 0.5 },
    floor: plane('floor', new Vector3(0, 0, 1300), new Vector3(0, 1, 0)),
    walls: [
      plane('back', new Vector3(0, 1300, 0), new Vector3(0, 0, 1)),
      plane(
        side,
        new Vector3(side === 'left' ? -1200 : 1200, 1200, 1000),
        new Vector3(side === 'left' ? 1 : -1, 0, 0),
      ),
    ],
  };
  return { source, observation };
}

function withImageSupport(
  observation: DepthRoomObservation,
  bounds: { left: number; top: number; right: number; bottom: number },
  supported: readonly string[],
) {
  const value = structuredClone(observation);
  for (const plane of value.walls) {
    const occupied = Array.from({ length: 4096 }, (_, index) => {
      const x = ((index % 64) + 0.5) / 64,
        y = (Math.floor(index / 64) + 0.5) / 64;
      return supported.includes(plane.id) &&
        !(x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom)
        ? '1'
        : '0';
    }).join('');
    plane.imageSupport = {
      bounds: { left: 0, right: 1, top: 0, bottom: 1 },
      width: 64,
      height: 64,
      occupied,
    };
  }
  return value;
}

describe('experimental depth planes → source camera, without a full-floor quad', () => {
  it.each([0, 0.14, -0.21])('recovers tilted camera and ray/floor positions with roll %s', (roll) => {
    const { source, observation } = observed(roll);
    const original = structuredClone(observation);
    const result = fitDepthRoomCamera(room, observation, fingerprint);
    expect(result.fit.status, JSON.stringify(result)).toBe('estimated');
    result.fit.camera!.positionMm.forEach((v, i) => expect(v).toBeCloseTo(source.positionMm[i], 7));
    const point: [number, number, number] = [400, 0, 400];
    const photo = projectSourcePoint(source, point).point;
    const projected = projectSourcePoint(result.fit.camera!, point).point;
    expect(projected.x).toBeCloseTo(photo.x, 8);
    expect(projected.y).toBeCloseTo(photo.y, 8);
    const hit = unprojectSourceToFace(room, result.fit.camera!, photo, 'floor')!;
    hit.worldMm.forEach((v, i) => expect(v).toBeCloseTo(point[i], 6));
    expect(observation).toEqual(original);
    expect(result.fit.reprojection).toBeUndefined();
    expect(result.diagnostics.scope).toBe('model-plane-consistency');
  });
  it('requires surrounding observed wall support as well as the source-photo ray', () => {
    const { observation, source } = observed();
    for (const [world, expected] of [
      [[-1200, 1400, 900], 'left'],
      [[400, 1400, 0], 'back'],
    ] as const) {
      const point = projectSourcePoint(source, [...world]).point;
      const bounds = {
        left: Math.max(0, point.x - 0.04),
        right: Math.min(1, point.x + 0.04),
        top: point.y - 0.05,
        bottom: point.y + 0.05,
      };
      const input = withImageSupport(observation, bounds, [expected]);
      const result = fitDepthRoomCamera(room, input, fingerprint);
      expect(depthObservedWallAtPoint(room, result, point)).toBeUndefined();
      expect(depthObservedWallAtPoint(room, result, point, { observation: input, bounds })?.wall).toBe(
        expected,
      );
      expect(result.diagnostics.wallSupportChecks?.at(-1)?.reason).toBe(
        'surrounding-image-support-and-ray-agree',
      );
    }
  });
  it('does not reject a deliberately empty fixture centre, but holds ambiguous and distant wall support', () => {
    const { observation, source } = observed();
    const point = projectSourcePoint(source, [400, 1400, 0]).point;
    const bounds = {
      left: point.x - 0.06,
      right: point.x + 0.06,
      top: point.y - 0.06,
      bottom: point.y + 0.06,
    };
    const input = withImageSupport(observation, bounds, ['back']);
    const result = fitDepthRoomCamera(room, input, fingerprint);
    const centre = Math.floor(point.y * 64) * 64 + Math.floor(point.x * 64);
    expect(input.walls[0].imageSupport!.occupied[centre]).toBe('0');
    expect(depthObservedWallAtPoint(room, result, point, { observation: input, bounds })?.wall).toBe('back');
    const both = withImageSupport(observation, bounds, ['back', 'left']);
    expect(depthObservedWallAtPoint(room, result, point, { observation: both, bounds })).toBeUndefined();
    expect(result.diagnostics.wallSupportChecks?.at(-1)?.reason).toBe(
      'multiple-wall-support-around-candidate',
    );
    const distant = withImageSupport(observation, bounds, []);
    distant.walls[0].imageSupport!.occupied = '1'.repeat(64) + '0'.repeat(4096 - 64);
    expect(depthObservedWallAtPoint(room, result, point, { observation: distant, bounds })).toBeUndefined();
  });
  it('holds a single supported edge and a wall whose observed support contradicts the ray', () => {
    const { observation, source } = observed();
    const point = projectSourcePoint(source, [400, 1400, 0]).point;
    const bounds = {
      left: point.x - 0.06,
      right: point.x + 0.06,
      top: point.y - 0.06,
      bottom: point.y + 0.06,
    };
    const result = fitDepthRoomCamera(room, observation, fingerprint);
    const wrong = withImageSupport(observation, bounds, ['left']);
    expect(depthObservedWallAtPoint(room, result, point, { observation: wrong, bounds })).toBeUndefined();
    expect(result.diagnostics.wallSupportChecks?.at(-1)?.reason).toBe(
      'ray-and-observed-surrounding-wall-disagree',
    );
    const edge = withImageSupport(observation, bounds, ['back']);
    edge.walls[0].imageSupport!.occupied = Array.from(edge.walls[0].imageSupport!.occupied, (v, i) =>
      (Math.floor(i / 64) + 0.5) / 64 < bounds.top ? v : '0',
    ).join('');
    expect(depthObservedWallAtPoint(room, result, point, { observation: edge, bounds })).toBeUndefined();
  });
  it('uses right-wall distance with the correct signed room origin', () => {
    const { observation, source } = observed(0.1, 0, 'right');
    const result = fitDepthRoomCamera(room, observation, fingerprint);
    expect(result.selected?.side).toBe('right');
    expect(result.fit.camera!.positionMm[0]).toBeCloseTo(source.positionMm[0], 7);
  });
  it('holds an origin with no side wall, rather than centering the camera', () => {
    const { observation } = observed();
    observation.walls.pop();
    const result = fitDepthRoomCamera(room, observation, fingerprint);
    expect(result.fit.status).toBe('held');
    expect(result.fit.reasons.join()).toContain('옆벽');
  });
  it('rejects a different photo, off-centre intrinsics and weak floor support', () => {
    expect(fitDepthRoomCamera(room, observed().observation, 'b'.repeat(64)).fit.status).toBe('held');
    const { observation } = observed();
    observation.intrinsics.cx = 0.53;
    expect(fitDepthRoomCamera(room, observation, fingerprint).fit.status).toBe('held');
    observation.intrinsics.cx = 0.5;
    observation.floor!.inlierCount = 5;
    expect(fitDepthRoomCamera(room, observation, fingerprint).fit.status).toBe('held');
  });
  it('preserves invalid/conflicting geometry as held instead of rescaling it into the room', () => {
    const { observation } = observed();
    for (const p of [observation.floor!, ...observation.walls]) {
      p.offset *= 3;
      p.medianPointCamera = p.medianPointCamera.map((v) => v * 3) as [number, number, number];
    }
    const result = fitDepthRoomCamera(room, observation, fingerprint);
    expect(result.fit.status).toBe('held');
    expect(result.fit.reasons.join()).toContain('맞지');
  });
  it('does not interpret duplicate or high-residual wall planes as a known side boundary', () => {
    const { observation } = observed();
    observation.walls[1].rmsResidual = 0.5;
    const result = fitDepthRoomCamera(room, observation, fingerprint);
    expect(result.fit.status).toBe('held');
    expect(result.rejectedPlanes).toHaveLength(1);
  });
});

describe('observed installation with an available experimental source camera', () => {
  it('places an unknown-mounting inventory item without borrowing the visible-floor extent or modifying model fields', () => {
    const { observation, source } = observed();
    const foot = projectSourcePoint(source, [400, 0, 400]).point;
    const bounds = { left: foot.x - 0.05, right: foot.x + 0.05, top: foot.y - 0.16, bottom: foot.y };
    const understanding: SceneUnderstanding = {
      schemaVersion: 1,
      roomLayout: { orthogonal: 'unknown', evidence: [], uncertainty: [] },
      relations: [],
      candidates: [
        {
          id: 'toilet',
          kind: 'toilet',
          mounting: 'unknown',
          wall: 'unknown',
          basinStyle: 'unknown',
          shape: 'unknown',
          reflection: 'physical',
          bounds,
          evidence: ['synthetic fixture observation'],
          uncertainty: [],
        },
      ],
    };
    const baseline: ReconstructionReview = {
      version: 2,
      analysis: 'partial',
      warnings: [],
      planes: [
        {
          id: 'visible',
          face: 'floor',
          geometrySource: 'visible-floor-region',
          depthStart: 0,
          depthEnd: 0.65,
          confirmed: false,
          quad: [
            { x: 0, y: 0 },
            { x: 1, y: 0 },
            { x: 1, y: 1 },
            { x: 0, y: 1 },
          ],
          tile: { color: '#999', widthMm: 300, heightMm: 300, groutWidth: 2, estimated: true },
        },
      ],
      candidates: [
        {
          id: 'semantic',
          kind: 'toilet',
          source: 'deeplab',
          status: 'unplaced',
          color: '#fff',
          bounds,
          foot,
          pixels: 1000,
          evidence: { semanticPixels: 1000, meanMargin: 3 },
          installation: { mode: 'floor', source: 'inferred', reason: 'synthetic observed support' },
        },
      ],
    };
    const original = structuredClone({ understanding, baseline });
    const old = buildCandidatePipeline(understanding, baseline, room, observation.image);
    expect(old.plans.toilet).toBeNull();
    const result = buildCandidatePipeline(
      understanding,
      baseline,
      room,
      observation.image,
      {},
      understanding,
      {},
      { observation, inputFingerprint: fingerprint },
    );
    expect(result.plans.toilet, JSON.stringify(result.pipeline)).toMatchObject({
      kind: 'toilet',
      face: 'floor',
      provenance: { mounting: 'inferred', position: 'inferred' },
    });
    expect(result.pipeline.placements[0].baselineEvidence).toBeUndefined();
    expect(result.pipeline.observedInstallationChecks?.[0].baselineEvidence?.positionBorrowed).toBe(false);
    expect(result.pipeline.automaticUnderstanding.candidates[0].mounting).toBe('unknown');
    expect({ understanding, baseline }).toEqual(original);
    const wrong = buildCandidatePipeline(
      understanding,
      baseline,
      room,
      observation.image,
      {},
      understanding,
      {},
      { observation, inputFingerprint: 'b'.repeat(64) },
    );
    expect(wrong.plans.toilet).toBeNull();
  });
});


describe('full-frame inference resize provenance', () => {
  it('accepts documented integer rounding and retains normalized intrinsics without forging square source pixels', () => {
    const { observation } = observed();
    observation.image = { width: 386, height: 518 };
    observation.analysisImage = { width: 382, height: 512 };
    observation.intrinsics.fx = observation.intrinsics.fy * 512 / 382;
    const original = structuredClone(observation);
    const result = fitDepthRoomCamera(room, observation, fingerprint);
    expect(result.fit.status).toBe('estimated');
    expect(result.diagnostics.imageResampling?.sourcePixelAspectRatio).not.toBe(1);
    expect(observation).toEqual(original);
    delete observation.analysisImage;
    expect(fitDepthRoomCamera(room, observation, fingerprint).fit.status).toBe('held');
  });
  it('rejects cropped or arbitrarily distorted raster metadata and non-square analysis intrinsics', () => {
    for (const raster of [{ width: 512, height: 300 }, { width: 1201, height: 1000 }]) {
      const { observation } = observed();
      observation.analysisImage = raster;
      expect(fitDepthRoomCamera(room, observation, fingerprint).fit.status).toBe('held');
    }
    const { observation } = observed();
    observation.analysisImage = { width: 512, height: 427 };
    observation.intrinsics.fx *= 1.1;
    expect(fitDepthRoomCamera(room, observation, fingerprint).fit.status).toBe('held');
  });
});
