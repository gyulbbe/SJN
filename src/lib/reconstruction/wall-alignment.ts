import type { RoomDefinition } from '../room-types';
import type { VolumePlacement } from './projection';
import { validateSourceFixture, type SourceFixtureCheck } from './source-camera';
import type { InstallationWall } from './wall-relative-placement';

export type WallAlignmentParent = VolumePlacement & {
  kind: 'basin' | 'vanity';
  version: 2;
  baseHeightMm: number;
};
export type WallAlignmentTarget = {
  kind: 'mirror' | 'mirrorCabinet' | 'wallShelf';
  widthMm: number;
  heightMm: number;
  depthMm: number;
};
export type WallAlignmentInput = {
  room: RoomDefinition;
  parent: WallAlignmentParent;
  /** Explicit user choice; a floor location or default yaw cannot identify this wall. */
  wall: InstallationWall;
  target: WallAlignmentTarget;
  gapMm: number;
};
export type WallAlignmentPlacement = WallAlignmentTarget & {
  version: 2;
  face: InstallationWall;
  u: number;
  v: number;
  baseHeightMm: number;
  yawDegrees: 0;
};
export type WallAlignmentResult =
  | {
      status: 'ready';
      placement: WallAlignmentPlacement;
      reasons: string[];
      parentCheck: SourceFixtureCheck;
      targetCheck: SourceFixtureCheck;
    }
  | {
      status: 'held';
      reasons: string[];
      proposedPlacement?: WallAlignmentPlacement;
      parentCheck?: SourceFixtureCheck;
      targetCheck?: SourceFixtureCheck;
    };

const walls: readonly string[] = ['back', 'left', 'right'];
const positive = (value: number) => Number.isFinite(value) && value > 0;

/** Copy a user-selected position reference once. No AI observation, live attachment, moving or resizing. */
export function proposeWallAlignment(input: WallAlignmentInput): WallAlignmentResult {
  const { room, parent, wall, target, gapMm } = input;
  if (
    room.kind !== 'parametric' ||
    room.version !== 1 ||
    ![room.widthMm, room.heightMm, room.depthMm].every(positive)
  )
    return { status: 'held', reasons: ['공간의 폭·높이·깊이를 확인해 주세요.'] };
  if (!walls.includes(wall))
    return { status: 'held', reasons: ['위치를 맞출 설치 벽을 직접 선택해 주세요.'] };
  if (!['mirror', 'mirrorCabinet', 'wallShelf'].includes(target.kind))
    return { status: 'held', reasons: ['거울·거울장·벽 선반만 세면대 위에 맞출 수 있어요.'] };
  if (!['basin', 'vanity'].includes(parent.kind))
    return { status: 'held', reasons: ['위치 기준으로 세면대 또는 하부장을 선택해 주세요.'] };
  if (!Number.isFinite(gapMm) || gapMm < 0)
    return { status: 'held', reasons: ['위쪽 간격은 0 이상인 유효한 거리여야 해요.'] };
  if (![target.widthMm, target.heightMm, target.depthMm].every(positive))
    return { status: 'held', reasons: ['위에 놓을 모형의 폭·높이·깊이를 확인해 주세요.'] };
  if (
    parent.version !== 2 ||
    !['floor', ...walls].includes(parent.face) ||
    ![parent.u, parent.v].every((value) => Number.isFinite(value) && value >= 0 && value <= 1) ||
    !Number.isFinite(parent.baseHeightMm) ||
    parent.baseHeightMm < 0 ||
    ![parent.widthMm, parent.heightMm, parent.depthMm].every(positive) ||
    (parent.yawDegrees !== undefined && !Number.isFinite(parent.yawDegrees))
  )
    return { status: 'held', reasons: ['기준 모형의 설치 위치·높이·규격을 먼저 확인해 주세요.'] };
  // The copied top height uses the supplied millimetres, never silently scaled dimensions.
  if (parent.scale !== undefined && parent.scale !== 1)
    return { status: 'held', reasons: ['배율이 적용된 기준 모형은 실제 사용 규격을 먼저 확인해 주세요.'] };
  const parentCheck = validateSourceFixture(room, undefined, parent);
  if (!parentCheck.valid)
    return {
      status: 'held',
      reasons: ['기준 모형의 배치를 먼저 확인해 주세요.', ...parentCheck.reasons],
      parentCheck,
    };
  if (parent.face !== 'floor' && parent.face !== wall)
    return { status: 'held', reasons: ['선택한 벽과 기준 모형의 설치 벽이 달라요.'], parentCheck };
  if (parent.face === 'floor') {
    const expectedYaw = wall === 'left' ? 90 : wall === 'right' ? -90 : 0;
    const difference =
      parent.yawDegrees === undefined
        ? Infinity
        : Math.abs(((((parent.yawDegrees - expectedYaw) % 360) + 540) % 360) - 180);
    if (difference > 1e-7)
      return {
        status: 'held',
        reasons: ['바닥 기준 모형의 방향이 선택한 벽과 맞는지 확인해 주세요. 방향은 자동으로 바꾸지 않아요.'],
        parentCheck,
      };
  }
  const baseHeightMm = parent.baseHeightMm + parent.heightMm + gapMm;
  const proposedPlacement: WallAlignmentPlacement = {
    kind: target.kind,
    widthMm: target.widthMm,
    heightMm: target.heightMm,
    depthMm: target.depthMm,
    version: 2,
    face: wall,
    u:
      parent.face !== 'floor'
        ? parent.u
        : wall === 'back'
          ? parent.u
          : wall === 'left'
            ? 1 - parent.v
            : parent.v,
    v: 1 - baseHeightMm / room.heightMm,
    baseHeightMm,
    // Wall-mounted V2 models use their face for orientation, independently of floor yaw.
    yawDegrees: 0,
  };
  const targetCheck = validateSourceFixture(room, undefined, proposedPlacement);
  if (!targetCheck.valid)
    return {
      status: 'held',
      reasons: ['요청한 크기와 간격 그대로는 위 모형을 놓을 수 없어요.', ...targetCheck.reasons],
      proposedPlacement,
      parentCheck,
      targetCheck,
    };
  return {
    status: 'ready',
    placement: proposedPlacement,
    reasons: ['선택한 기준 모형과 간격으로 위치를 복사했어요. 사진에서 자동 판단한 설치 관계는 아니에요.'],
    parentCheck,
    targetCheck,
  };
}
