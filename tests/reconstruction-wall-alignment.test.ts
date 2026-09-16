import { describe, expect, it } from 'vitest';
import { DEFAULT_ROOM } from '../src/lib/room-geometry';
import { reconstructionModelTransform } from '../src/lib/reconstruction/projection';
import {
  proposeWallAlignment,
  type WallAlignmentInput,
  type WallAlignmentParent,
} from '../src/lib/reconstruction/wall-alignment';
import type { InstallationWall } from '../src/lib/reconstruction/wall-relative-placement';

const room = { ...DEFAULT_ROOM, widthMm: 2400, depthMm: 3000, heightMm: 2400 };
function sample(wall: InstallationWall = 'back'): WallAlignmentInput {
  return {
    room: { ...room },
    wall,
    parent: {
      kind: 'basin',
      version: 2,
      face: 'floor',
      u: 0.4,
      v: 0.35,
      baseHeightMm: 0,
      widthMm: 600,
      heightMm: 800,
      depthMm: 480,
      yawDegrees: wall === 'left' ? 90 : wall === 'right' ? -90 : 0,
    },
    target: { kind: 'mirror', widthMm: 700, heightMm: 700, depthMm: 30 },
    gapMm: 150,
  };
}
const ready = (input: WallAlignmentInput) => {
  const result = proposeWallAlignment(input);
  expect(result.status, result.reasons.join(' ')).toBe('ready');
  if (result.status !== 'ready') throw Error(result.reasons.join(' '));
  return result;
};

describe('explicit wall alignment above a user-selected fixture', () => {
  it.each(['back', 'left', 'right'] as const)(
    'aligns a floor parent on %s in actual world coordinates',
    (wall) => {
      const input = sample(wall),
        result = ready(input);
      const parentOrigin = reconstructionModelTransform(room, input.parent).origin;
      const childOrigin = reconstructionModelTransform(room, result.placement).origin;
      expect(result.placement.face).toBe(wall);
      if (wall === 'back') expect(childOrigin.x).toBeCloseTo(parentOrigin.x, 8);
      else expect(childOrigin.z).toBeCloseTo(parentOrigin.z, 8);
      expect(result.targetCheck.worldBoundsMm!.min[1] - result.parentCheck.worldBoundsMm!.max[1]).toBe(150);
      expect(result.placement.u).toBeCloseTo(wall === 'back' ? 0.4 : wall === 'left' ? 0.65 : 0.35);
      expect(result.placement.baseHeightMm).toBe(950);
      expect(result.placement.v).toBeCloseTo(1 - 950 / room.heightMm);
      expect(result.parentCheck.valid).toBe(true);
      expect(result.targetCheck.valid).toBe(true);
    },
  );
  it.each(['back', 'left', 'right'] as const)(
    'copies %s wall-mounted parent centre and actual top height',
    (wall) => {
      const input = sample(wall);
      input.parent = {
        ...input.parent,
        face: wall,
        u: 0.6,
        v: 1 - 500 / room.heightMm,
        baseHeightMm: 500,
        heightMm: 200,
        basinVariant: 'wall',
      };
      delete input.parent.yawDegrees;
      const result = ready(input);
      const parentOrigin = reconstructionModelTransform(room, input.parent).origin;
      const childOrigin = reconstructionModelTransform(room, result.placement).origin;
      expect(result.placement.u).toBe(0.6);
      expect(result.placement.baseHeightMm).toBe(850);
      expect(wall === 'back' ? childOrigin.x : childOrigin.z).toBeCloseTo(
        wall === 'back' ? parentOrigin.x : parentOrigin.z,
      );
      expect(result.targetCheck.worldBoundsMm!.min[1] - result.parentCheck.worldBoundsMm!.max[1]).toBe(150);
    },
  );
  it.each(['mirror', 'mirrorCabinet', 'wallShelf'] as const)(
    'retains supplied %s dimensions and supports a vanity parent',
    (kind) => {
      const input = sample();
      input.parent.kind = 'vanity';
      input.target = { kind, widthMm: 517, heightMm: 219, depthMm: 137 };
      expect(ready(input).placement).toMatchObject({ kind, widthMm: 517, heightMm: 219, depthMm: 137 });
    },
  );
  it('allows zero gap without introducing a default distance', () => {
    const input = sample();
    input.gapMm = 0;
    const result = ready(input);
    expect(result.placement.baseHeightMm).toBe(800);
    expect(result.targetCheck.worldBoundsMm!.min[1]).toBe(result.parentCheck.worldBoundsMm!.max[1]);
  });
  it('accepts equivalent complete-turn floor orientations without rewriting the parent', () => {
    for (const [wall, yaw] of [
      ['back', 360],
      ['left', 450],
      ['right', 270],
    ] as const) {
      const input = sample(wall);
      input.parent.yawDegrees = yaw;
      ready(input);
      expect(input.parent.yawDegrees).toBe(yaw);
    }
  });
  it.each([undefined, 45, 0])(
    'holds a floor parent whose yaw %s does not establish the chosen left alignment',
    (yaw) => {
      const input = sample('left');
      input.parent.yawDegrees = yaw;
      const before = structuredClone(input);
      const result = proposeWallAlignment(input);
      expect(result.status).toBe('held');
      expect(result.reasons.join(' ')).toContain('방향');
      expect(input).toEqual(before);
    },
  );
  it('rejects an explicit wall that conflicts with the actual wall-mounted parent', () => {
    const input = sample('left');
    input.parent = {
      ...input.parent,
      face: 'back',
      baseHeightMm: 500,
      v: 1 - 500 / room.heightMm,
      heightMm: 200,
    };
    const result = proposeWallAlignment(input);
    expect(result.status).toBe('held');
    expect(result.reasons.join(' ')).toContain('설치 벽이 달라');
  });
  it.each([
    ['widthMm', 3000],
    ['heightMm', 1800],
    ['depthMm', 4000],
  ] as const)(
    'retains an oversized target %s=%s as a held proposal without moving or shrinking',
    (dimension, value) => {
      const input = sample();
      input.target[dimension] = value;
      const result = proposeWallAlignment(input);
      expect(result.status).toBe('held');
      if (result.status !== 'held') throw Error('Expected held');
      expect(result.targetCheck?.valid).toBe(false);
      expect(result.proposedPlacement?.[dimension]).toBe(value);
      expect(result.proposedPlacement?.u).toBe(input.parent.u);
      expect(result.proposedPlacement?.baseHeightMm).toBe(950);
      expect(Object.values(result.targetCheck!.overflowMm!).some((n) => n > 1)).toBe(true);
      expect(result).not.toHaveProperty('placement');
    },
  );
  it.each(['floor-elevated', 'room-overflow', 'wall-height-conflict', 'scale', 'legacy'] as const)(
    'holds an invalid parent: %s',
    (failure) => {
      const input = sample();
      if (failure === 'floor-elevated') input.parent.baseHeightMm = 50;
      if (failure === 'room-overflow') input.parent.u = 0;
      if (failure === 'wall-height-conflict')
        Object.assign(input.parent, { face: 'back', baseHeightMm: 500, v: 0.2 });
      if (failure === 'scale') input.parent.scale = 2;
      if (failure === 'legacy') input.parent.version = 1 as unknown as 2;
      const before = structuredClone(input),
        result = proposeWallAlignment(input);
      expect(result.status).toBe('held');
      expect(result).not.toHaveProperty('proposedPlacement');
      expect(input).toEqual(before);
      if (['floor-elevated', 'room-overflow', 'wall-height-conflict'].includes(failure))
        expect(result.parentCheck?.valid).toBe(false);
    },
  );
  it.each(['negative-gap', 'nan-gap', 'zero-room', 'nan-parent', 'infinite-target'] as const)(
    'rejects invalid scalar inputs: %s',
    (failure) => {
      const input = sample();
      if (failure === 'negative-gap') input.gapMm = -1;
      if (failure === 'nan-gap') input.gapMm = NaN;
      if (failure === 'zero-room') input.room.heightMm = 0;
      if (failure === 'nan-parent') input.parent.u = NaN;
      if (failure === 'infinite-target') input.target.depthMm = Infinity;
      expect(proposeWallAlignment(input).status).toBe('held');
    },
  );
  it('requires a supported target, a basin/vanity parent, and an explicit valid wall', () => {
    const wrongTarget = sample();
    wrongTarget.target.kind = 'toilet' as 'mirror';
    const wrongParent = sample();
    wrongParent.parent.kind = 'bath' as WallAlignmentParent['kind'];
    const missingWall = sample();
    missingWall.wall = undefined as unknown as InstallationWall;
    const floorWall = sample();
    floorWall.wall = 'floor' as InstallationWall;
    for (const input of [wrongTarget, wrongParent, missingWall, floorWall])
      expect(proposeWallAlignment(input).status).toBe('held');
  });
  it('returns a detached copy and identifies the result as a selected reference, not an AI observation', () => {
    const input = sample('right'),
      before = structuredClone(input);
    const result = ready(input);
    expect(result.reasons.join(' ')).toContain('자동 판단한 설치 관계는 아니');
    expect(input).toEqual(before);
    result.placement.widthMm = 12;
    result.placement.u = 0;
    expect(input).toEqual(before);
  });
});
