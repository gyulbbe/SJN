import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import { DEFAULT_ROOM, roomFacePoint } from '../src/lib/room-geometry';
import type { RoomFace } from '../src/lib/room-types';
import type { Quad } from '../src/lib/types';
import type {
  SceneCandidate,
  SceneRoomLayout,
  SourceRoomCorner,
  SourceRoomLine,
} from '../src/lib/reconstruction/pipeline-contract';
import {
  createSourceCamera,
  fitSourceCamera,
  projectSourcePoint,
  solveSourcePlacement,
  sourceRoomCornerPoint,
  unprojectSourceToFace,
  validateSourceFixture,
  type SourceCamera,
} from '../src/lib/reconstruction/source-camera';

const room = { ...DEFAULT_ROOM };
const corners: SourceRoomCorner[] = [
  'back-top-left',
  'back-top-right',
  'back-bottom-right',
  'back-bottom-left',
];
function photoCamera(fov = 62, frontal = false): SourceCamera {
  const camera = new PerspectiveCamera(fov, 1.2, 0.1, 1e7);
  camera.position.set(frontal ? 0 : 450, 1450, 4800);
  camera.lookAt(0, frontal ? 1450 : 1100, 0);
  camera.updateMatrixWorld(true);
  return {
    version: 1,
    positionMm: camera.position.toArray() as SourceCamera['positionMm'],
    quaternion: camera.quaternion.toArray() as SourceCamera['quaternion'],
    verticalFovDegrees: fov,
    image: { width: 1200, height: 1000 },
  };
}
function observations(source: SourceCamera, depth = false): SceneRoomLayout {
  return {
    orthogonal: true,
    evidence: ['synthetic observed corners'],
    uncertainty: [],
    backWallQuad: corners.map(
      (name) => projectSourcePoint(source, sourceRoomCornerPoint(room, name)).point,
    ) as Quad,
    corners: depth
      ? (['front-bottom-left', 'front-bottom-right'] as const).map((corner) => ({
          corner,
          point: projectSourcePoint(source, sourceRoomCornerPoint(room, corner)).point,
          evidence: ['synthetic depth corner'],
        }))
      : undefined,
  };
}
function candidate(source: SourceCamera, face: RoomFace = 'floor'): SceneCandidate {
  const p = projectSourcePoint(source, roomFacePoint(room, face, 0.5, face === 'floor' ? 0.5 : 0.65)).point;
  return {
    id: 'object',
    kind: 'basin',
    bounds: { left: p.x - 0.05, top: p.y - 0.08, right: p.x + 0.05, bottom: p.y },
    mounting: face === 'floor' ? 'floor' : 'wall',
    wall: face === 'floor' ? 'unknown' : face,
    basinStyle: face === 'floor' ? 'pedestal' : 'wall',
    shape: 'rectangular',
    reflection: 'physical',
    evidence: ['test'],
    uncertainty: [],
    anchor: {
      point: p,
      kind: face === 'floor' ? 'floor-contact' : 'wall-attachment',
      evidence: ['test'],
      uncertainty: [],
    },
  };
}

function observedLines(source: SourceCamera): SourceRoomLine[] {
  const pairs: [SourceRoomLine['axis'], [number, number, number], [number, number, number]][] = [
    ['width', [-1000, 600, 0], [1000, 600, 0]],
    ['width', [-1000, 2000, 0], [1000, 2000, 0]],
    ['height', [-900, 300, 0], [-900, 2100, 0]],
    ['height', [900, 300, 0], [900, 2100, 0]],
    ['depth', [-950, 0, 300], [-950, 0, 2000]],
    ['depth', [950, 0, 300], [950, 0, 2000]],
  ];
  return pairs.map(([axis, a, b]) => ({
    axis,
    start: projectSourcePoint(source, a).point,
    end: projectSourcePoint(source, b).point,
    evidence: ['actual projected parallel edge'],
  }));
}
function lineLayout(source: SourceCamera): SceneRoomLayout {
  return {
    orthogonal: true,
    backWallQuad: null,
    evidence: [],
    uncertainty: [],
    lines: observedLines(source),
    corners: (['back-bottom-left', 'back-bottom-right'] as const).map((corner) => ({
      corner,
      point: projectSourcePoint(source, sourceRoomCornerPoint(room, corner)).point,
      evidence: ['visible floor/back wall corner'],
    })),
  };
}
describe('source-photo pinhole geometry, independent of the common editor camera', () => {
  it('recovers source pose from observed parallel lines and two metric room corners with the ceiling cropped', () => {
    const source = photoCamera();
    const fit = fitSourceCamera(room, source.image, lineLayout(source));
    expect(fit.status, JSON.stringify(fit)).toBe('estimated');
    expect(fit.method).toBe('room-lines-pinhole');
    expect(fit.camera!.verticalFovDegrees).toBeCloseTo(source.verticalFovDegrees, 6);
    fit.camera!.positionMm.forEach((value, index) => expect(value).toBeCloseTo(source.positionMm[index], 4));
    expect(fit.reprojection!.maxPx).toBeLessThan(1e-6);
    expect(fit.reprojection!.maxLineErrorPx).toBeLessThan(1e-6);
    expect(fit.reprojection!.lineConstraints).toHaveLength(6);
  });
  it.each(['width', 'height', 'depth'] as const)(
    'can use two orthogonal vanishing axes without %s lines',
    (omitted) => {
      const source = photoCamera(),
        layout = lineLayout(source);
      layout.lines = layout.lines!.filter((line) => line.axis !== omitted);
      const fit = fitSourceCamera(room, source.image, layout);
      expect(fit.status, JSON.stringify(fit)).toBe('estimated');
      expect(fit.camera!.verticalFovDegrees).toBeCloseTo(source.verticalFovDegrees, 6);
    },
  );
  it('does not invent metric distance from vanishing directions with no second room point', () => {
    const source = photoCamera(),
      layout = lineLayout(source);
    layout.corners = layout.corners!.slice(0, 1);
    const result = fitSourceCamera(room, source.image, layout);
    expect(result.status).toBe('held');
    expect(result.camera).toBeUndefined();
    expect(result.reasons.join(' ')).toContain('스케일');
  });
  it('holds zero-length, unsupported and inconsistent observed lines', () => {
    const source = photoCamera();
    for (const mutation of [
      (line: SourceRoomLine) => {
        line.end = { ...line.start };
      },
      (line: SourceRoomLine) => {
        line.evidence = [];
      },
      (line: SourceRoomLine) => {
        line.axis = 'depth';
      },
    ]) {
      const layout = lineLayout(source);
      mutation(layout.lines![0]);
      expect(fitSourceCamera(room, source.image, layout).status).toBe('held');
    }
  });
  it('does not resolve intrinsic ambiguity from axes at infinity unless a real FOV is supplied', () => {
    const source = photoCamera(55, true),
      layout = lineLayout(source);
    expect(fitSourceCamera(room, source.image, layout).status).toBe('held');
    const supplied = fitSourceCamera(room, source.image, layout, { verticalFovDegrees: 55 });
    expect(supplied.status, JSON.stringify(supplied)).toBe('estimated');
    expect(supplied.intrinsics).toBe('supplied');
  });

  it('recovers an oblique synthetic camera from the complete measured back wall', () => {
    const source = photoCamera();
    const result = fitSourceCamera(room, source.image, observations(source));
    expect(result.status, JSON.stringify(result)).toBe('estimated');
    expect(result.camera!.verticalFovDegrees).toBeCloseTo(source.verticalFovDegrees, 4);
    result.camera!.positionMm.forEach((value, index) =>
      expect(value).toBeCloseTo(source.positionMm[index], 2),
    );
    expect(result.reprojection!.maxPx).toBeLessThan(0.001);
    expect(result.assumptions.join(' ')).toContain('주점');
  });
  it('uses explicit intrinsics, rather than inventing a focal length for a fronto-parallel rectangle', () => {
    const source = photoCamera(55, true),
      layout = observations(source);
    const held = fitSourceCamera(room, source.image, layout);
    expect(held.status).toBe('held');
    expect(held.camera).toBeUndefined();
    expect(held.reasons.join(' ')).toContain('초점거리');
    const fit = fitSourceCamera(room, source.image, layout, { verticalFovDegrees: 55 });
    expect(fit.status).toBe('estimated');
    expect(fit.intrinsics).toBe('supplied');
    expect(fit.reprojection!.maxPx).toBeLessThan(1e-6);
  });
  it('uses independently observed depth corners to resolve frontal focal-distance ambiguity', () => {
    const source = photoCamera(70, true);
    const fit = fitSourceCamera(room, source.image, observations(source, true));
    expect(fit.status, JSON.stringify(fit)).toBe('estimated');
    expect(fit.camera!.verticalFovDegrees).toBeCloseTo(70, 4);
    expect(fit.reprojection!.observations).toHaveLength(6);
  });
  it('fits six observed non-coplanar corners when one back-wall corner is cropped out', () => {
    const source = { ...photoCamera(75), positionMm: [450, 1450, 6500] as [number, number, number] };
    const names: SourceRoomCorner[] = [
      'back-top-left',
      'back-top-right',
      'back-bottom-right',
      'front-top-left',
      'front-bottom-left',
      'front-bottom-right',
    ];
    const layout: SceneRoomLayout = {
      orthogonal: true,
      evidence: [],
      uncertainty: [],
      backWallQuad: null,
      corners: names.map((corner) => ({
        corner,
        point: projectSourcePoint(source, sourceRoomCornerPoint(room, corner)).point,
        evidence: ['independently observed'],
      })),
    };
    const fit = fitSourceCamera(room, source.image, layout);
    expect(fit.status, JSON.stringify(fit)).toBe('estimated');
    expect(fit.method).toBe('room-corners-pinhole');
    expect(fit.reprojection!.maxPx).toBeLessThan(1e-6);
    expect(fit.camera!.verticalFovDegrees).toBeCloseTo(75, 7);
    fit.camera!.positionMm.forEach((value, index) => expect(value).toBeCloseTo(source.positionMm[index], 5));
  });
  it('does not treat duplicate or coplanar corner constraints as a full camera calibration', () => {
    const source = photoCamera();
    const layout = observations(source);
    layout.backWallQuad = null;
    layout.corners = [...corners, 'back-top-left', 'back-bottom-left'].map((name) => ({
      corner: name as SourceRoomCorner,
      point: projectSourcePoint(source, sourceRoomCornerPoint(room, name as SourceRoomCorner)).point,
      evidence: [],
    }));
    expect(fitSourceCamera(room, source.image, layout).status).toBe('held');
  });
  it.each([false, 'unknown'] as const)(
    'does not silently rectangularize orthogonal=%s rooms',
    (orthogonal) => {
      const source = photoCamera();
      expect(fitSourceCamera(room, source.image, { ...observations(source), orthogonal }).status).toBe(
        'held',
      );
    },
  );
  it('holds cropped/missing, contradictory and invalid corner observations', () => {
    const source = photoCamera(),
      layout = observations(source);
    expect(fitSourceCamera(room, source.image, { ...layout, backWallQuad: null }).status).toBe('held');
    const quad = [...layout.backWallQuad!] as Quad;
    [quad[1], quad[2]] = [quad[2], quad[1]];
    expect(fitSourceCamera(room, source.image, { ...layout, backWallQuad: quad }).status).toBe('held');
    expect(
      fitSourceCamera(room, source.image, {
        ...layout,
        corners: [{ corner: 'back-top-left', point: { x: 0.95, y: 0.95 }, evidence: [] }],
      }).status,
    ).toBe('held');
    const bad = observations(source, true);
    bad.corners![0].point = { x: 0.1, y: 0.1 };
    const wrong = fitSourceCamera(room, source.image, bad, { verticalFovDegrees: source.verticalFovDegrees });
    expect(wrong.status).toBe('held');
    expect(wrong.reprojection!.maxPx).toBeGreaterThan(50);
  });
  it.each(['floor', 'back', 'left', 'right'] as const)(
    'round trips a real 3D point on the %s face',
    (face) => {
      const source = photoCamera();
      const point = roomFacePoint(room, face, 0.45, 0.55);
      const screen = projectSourcePoint(source, point);
      const inverse = unprojectSourceToFace(room, source, screen.point, face)!;
      expect(inverse.inFace).toBe(true);
      expect(inverse.u).toBeCloseTo(0.45, 9);
      expect(inverse.v).toBeCloseTo(0.55, 9);
      expect(new Vector3(...inverse.worldMm).distanceTo(point)).toBeLessThan(1e-6);
    },
  );
  it('does not clamp a wall intersection outside the physical room', () => {
    const source = photoCamera();
    const point = projectSourcePoint(source, new Vector3(room.widthMm, 1000, 0)).point;
    const inverse = unprojectSourceToFace(room, source, point, 'back')!;
    expect(inverse.inFace).toBe(false);
    expect(inverse.u).toBeCloseTo(1.5);
  });
  it('places a wall basin without a floor anchor and labels dimensions as defaults', () => {
    const source = photoCamera(),
      item = candidate(source, 'back');
    const fit = fitSourceCamera(room, source.image, observations(source));
    const result = solveSourcePlacement(room, fit, item);
    expect(result.status).toBe('estimated');
    expect(result.placement!.baseHeightMm).toBeCloseTo(840, 2);
    expect(result.reprojectionErrorPx).toBeLessThan(1e-6);
    expect(result.provenance.dimensions).toBe('default');
    const changedSize = {
      ...item,
      bounds: { ...item.bounds, left: item.bounds.left - 0.1, top: item.bounds.top - 0.1 },
    };
    expect(solveSourcePlacement(room, fit, changedSize).placement).toEqual(result.placement);
  });
  it('keeps a visible-through bath while holding a reflection, without dropping either candidate', () => {
    const source = photoCamera(),
      fit = fitSourceCamera(room, source.image, observations(source));
    const bath = { ...candidate(source), id: 'bath', kind: 'bath' as const };
    const through = solveSourcePlacement(room, fit, bath, [
      { frontId: 'glass', behindId: 'bath', relation: 'visibleThrough', evidence: ['transparent partition'] },
    ]);
    expect(through.status).toBe('estimated');
    expect(through.reasons.join(' ')).toContain('유지');
    const reflected = solveSourcePlacement(room, fit, { ...bath, reflection: 'reflected' });
    expect(reflected.status).toBe('held');
    expect(reflected.candidateId).toBe(bath.id);
    expect(reflected.reasons.join(' ')).toContain('삭제하지');
  });
  it('holds a cropped contact and uncertain mounting instead of planting them at a default coordinate', () => {
    const source = photoCamera(),
      fit = fitSourceCamera(room, source.image, observations(source)),
      item = candidate(source);
    const cropped = { ...item, anchor: undefined, bounds: { ...item.bounds, bottom: 1 } };
    expect(solveSourcePlacement(room, fit, cropped)).toMatchObject({ status: 'held', candidateId: item.id });
    expect(solveSourcePlacement(room, fit, { ...item, mounting: 'unknown' }).placement).toBeUndefined();
    expect(solveSourcePlacement(room, { ...fit, status: 'held' }, item).placement).toBeUndefined();
  });
  it('holds an unrelated anchor instead of bypassing the cropped-product guard with another object point', () => {
    const source = photoCamera(),
      fit = fitSourceCamera(room, source.image, observations(source));
    const original = candidate(source);
    const shifted = { ...original, bounds: { left: 0.1, top: 0.6, right: 0.2, bottom: 1 } };
    expect(solveSourcePlacement(room, fit, shifted).status).toBe('held');
    expect(solveSourcePlacement(room, fit, shifted).reasons.join(' ')).toContain('다른 물체');
    const noEvidence = { ...original, anchor: { ...original.anchor!, evidence: ['  '] } };
    expect(solveSourcePlacement(room, fit, noEvidence).placement).toBeUndefined();
  });
  it('does not fit unsubstantiated named corners or a back-wall quad with no observation evidence', () => {
    const source = photoCamera();
    const missingCornerEvidence = lineLayout(source);
    missingCornerEvidence.corners![0].evidence = ['  '];
    expect(fitSourceCamera(room, source.image, missingCornerEvidence).status).toBe('held');
    const missingWallEvidence = observations(source);
    missingWallEvidence.evidence = [];
    expect(fitSourceCamera(room, source.image, missingWallEvidence).status).toBe('held');
  });
  it('reports floating/outside fixtures without silently scaling or translating the input', () => {
    const source = photoCamera();
    const placement = {
      version: 2 as const,
      face: 'floor' as const,
      u: 0.5,
      v: 0.5,
      widthMm: 600,
      heightMm: 800,
      depthMm: 480,
      baseHeightMm: 0,
    };
    expect(validateSourceFixture(room, source, placement).valid).toBe(true);
    const floating = { ...placement, baseHeightMm: 80 };
    expect(validateSourceFixture(room, source, floating).reasons.join(' ')).toContain('바닥에 닿지');
    expect(floating.baseHeightMm).toBe(80);
    const outside = { ...placement, u: 0.98 };
    expect(validateSourceFixture(room, source, outside).valid).toBe(false);
    expect(outside.u).toBe(0.98);
  });
  it('reports source bbox discrepancy separately from the camera fitting error', () => {
    const source = photoCamera();
    const placement = {
      version: 2 as const,
      face: 'floor' as const,
      u: 0.5,
      v: 0.5,
      widthMm: 600,
      heightMm: 800,
      depthMm: 480,
      baseHeightMm: 0,
    };
    const first = validateSourceFixture(room, source, placement);
    expect(validateSourceFixture(room, source, placement, first.projectedBounds).bboxErrorPx).toBeLessThan(
      1e-9,
    );
    expect(
      validateSourceFixture(room, source, placement, { left: 0, top: 0, right: 1, bottom: 1 }).bboxErrorPx,
    ).toBeGreaterThan(50);
  });
  it('validates quaternion/image inputs before constructing a source camera', () => {
    const source = photoCamera();
    expect(() => createSourceCamera({ ...source, quaternion: [0, 0, 0, 0] })).toThrow();
    expect(() => createSourceCamera({ ...source, image: { width: 0, height: 20 } })).toThrow();
  });
});

describe('wall attachment and fixture bottom are separate observations', () => {
  it('keeps the attachment but uses the visible bottom for estimated base height', () => {
    const source = photoCamera();
    const c = candidate(source, 'back');
    const low = projectSourcePoint(source, roomFacePoint(room, 'back', 0.5, 0.75)).point;
    c.bounds.bottom = low.y;
    const placement = solveSourcePlacement(
      room,
      {
        status: 'estimated',
        camera: source,
        reasons: [],
        assumptions: [],
        method: 'back-wall-pinhole',
        intrinsics: 'supplied',
      },
      c,
    );
    expect(placement.status).toBe('estimated');
    expect(placement.anchor!.point).toEqual(c.anchor!.point);
    expect(placement.placement!.baseHeightMm).toBeCloseTo(room.heightMm * 0.25, 3);
    expect(placement.anchor!.worldMm[1]).toBeGreaterThan(placement.placement!.baseHeightMm);
    expect(placement.reasons.join(' ')).toContain('부착점과 제품 하단');
  });
  it('keeps quarantined observations unplaced even when supplied a valid source camera', () => {
    const source = photoCamera();
    const c = candidate(source);
    c.validation = { status: 'needs-review', issues: [{ code: 'anchor', message: 'invalid floor support' }] };
    const placement = solveSourcePlacement(
      room,
      {
        status: 'estimated',
        camera: source,
        reasons: [],
        assumptions: [],
        method: 'back-wall-pinhole',
        intrinsics: 'supplied',
      },
      c,
    );
    expect(placement.status).toBe('held');
    expect(placement.placement).toBeUndefined();
    expect(placement.reasons).toContain('invalid floor support');
  });
});

describe('cropped fixture bottom versus observed contact', () => {
  it.each([true, false])(
    'does not derive a wall bottom from the image edge with attachment=%s',
    (withAnchor) => {
      // A narrow crop of a known camera still intersects the physical wall at the image edge.
      // That intersection must not be mistaken for the unseen object's bottom.
      const source = photoCamera(30, true);
      const c = candidate(source, 'back');
      c.bounds.bottom = 1;
      if (!withAnchor) delete c.anchor;
      const fit = {
        status: 'estimated' as const,
        camera: source,
        reasons: [],
        assumptions: [],
        method: 'back-wall-pinhole' as const,
        intrinsics: 'supplied' as const,
      };
      expect(unprojectSourceToFace(room, source, { x: c.anchor?.point.x ?? 0.5, y: 1 }, 'back')!.inFace).toBe(
        true,
      );
      const result = solveSourcePlacement(room, fit, c);
      expect(result.status).toBe('held');
      expect(result.placement).toBeUndefined();
      expect(result.reasons.join(' ')).toContain('제품 하단이 사진 밖으로 잘렸어요');
    },
  );

  it('retains an explicit floor contact visible within a partially cropped product', () => {
    const source = photoCamera();
    const c = candidate(source);
    c.bounds.bottom = 1;
    const original = structuredClone(c);
    const fit = {
      status: 'estimated' as const,
      camera: source,
      reasons: [],
      assumptions: [],
      method: 'back-wall-pinhole' as const,
      intrinsics: 'supplied' as const,
    };
    const result = solveSourcePlacement(room, fit, c);
    expect(result.status).toBe('estimated');
    expect(result.placement).toMatchObject({ face: 'floor', baseHeightMm: 0 });
    expect(result.anchor!.point).toEqual(c.anchor!.point);
    expect(result.placement!.u).toBeCloseTo(0.5, 8);
    expect(result.placement!.v).toBeCloseTo(0.5, 8);
    expect(c).toEqual(original);
  });

  it('does not invent a horizontal wall centre from a side crop without an attachment', () => {
    const source = photoCamera();
    const c = candidate(source, 'back');
    c.bounds.left = 0;
    delete c.anchor;
    const fit = {
      status: 'estimated' as const,
      camera: source,
      reasons: [],
      assumptions: [],
      method: 'back-wall-pinhole' as const,
      intrinsics: 'supplied' as const,
    };
    expect(solveSourcePlacement(room, fit, c).reasons.join(' ')).toContain('좌우 범위가 잘려');
  });

  it('still uses an explicit wall attachment and visible bottom when the top or side is cropped', () => {
    const source = photoCamera();
    const c = candidate(source, 'back');
    c.bounds.top = c.bounds.left = 0;
    const fit = {
      status: 'estimated' as const,
      camera: source,
      reasons: [],
      assumptions: [],
      method: 'back-wall-pinhole' as const,
      intrinsics: 'supplied' as const,
    };
    const result = solveSourcePlacement(room, fit, c);
    expect(result.status).toBe('estimated');
    expect(result.placement!.baseHeightMm).toBeCloseTo(840, 2);
  });
});

describe('retained physical placement diagnostics', () => {
  const placement = {
    version: 2 as const,
    face: 'floor' as const,
    u: 0.5,
    v: 0.5,
    widthMm: 600,
    heightMm: 800,
    depthMm: 400,
    baseHeightMm: 0,
  };
  it('reports each crossed room plane in mm without hiding the failed proposal', () => {
    const input = { ...placement, u: 0, v: 0, baseHeightMm: -50 };
    const copy = structuredClone(input);
    const check = validateSourceFixture(room, undefined, input);
    expect(check.valid).toBe(false);
    expect(check.worldBoundsMm).toEqual({
      min: [-room.widthMm / 2 - 300, -50, -200],
      max: [-room.widthMm / 2 + 300, 750, 200],
    });
    expect(check.overflowMm).toEqual({ left: 300, right: 0, back: 200, front: 0, below: 50, above: 0 });
    expect(check.projectedBounds).toBeUndefined();
    expect(input).toEqual(copy);
  });
  it('accounts for model rotation and opposite room planes', () => {
    const check = validateSourceFixture(room, undefined, {
      ...placement,
      u: 1,
      v: 1,
      yawDegrees: 90,
      baseHeightMm: room.heightMm - 200,
    });
    expect(check.overflowMm?.right).toBeCloseTo(200, 8);
    expect(check.overflowMm?.front).toBeCloseTo(300, 8);
    expect(check.overflowMm?.above).toBeCloseTo(600, 8);
    expect(check.valid).toBe(false);
  });
  it('uses the same wall depth offset as rendering, with no false rear intrusion', () => {
    const check = validateSourceFixture(room, undefined, {
      ...placement,
      face: 'back',
      v: 0.75,
      baseHeightMm: room.heightMm / 4,
    });
    expect(check.valid).toBe(true);
    expect(check.worldBoundsMm?.min[2]).toBe(0);
    expect(Object.values(check.overflowMm!)).toEqual([0, 0, 0, 0, 0, 0]);
  });
  it('retains sub-tolerance physical overflow but keeps the existing 1mm validation tolerance', () => {
    const check = validateSourceFixture(room, undefined, { ...placement, u: (300 - 0.5) / room.widthMm });
    expect(check.valid).toBe(true);
    expect(check.overflowMm!.left).toBeCloseTo(0.5, 8);
  });
  it('does not invent numeric bounds for invalid geometry', () => {
    const check = validateSourceFixture(room, undefined, { ...placement, widthMm: Infinity });
    expect(check.valid).toBe(false);
    expect(check.worldBoundsMm).toBeUndefined();
    expect(check.overflowMm).toBeUndefined();
  });
});
