import { renderRoomBackground, type RoomBackground } from '../room-background';
import type { RoomDimensions } from '../room-types';

export type ReconstructionTargetFrame = { width: number; height: number };

/** Reanalysis must retain the existing comparison camera, including its exact pixel frame. */
export async function prepareReconstructionTargetFrame(
  room: RoomDimensions,
  target: ReconstructionTargetFrame,
): Promise<RoomBackground> {
  const frame = { width: target.width, height: target.height };
  if (
    !Number.isSafeInteger(frame.width) ||
    !Number.isSafeInteger(frame.height) ||
    frame.width < 1 ||
    frame.height < 1 ||
    frame.width * frame.height > 40_000_000
  )
    throw new Error('기존 비교 공간의 화면 크기가 올바르지 않아 분석을 시작하지 않았어요.');
  // The transient renderer is disposed before returning. Keep only the PNG during analysis.
  const background = await renderRoomBackground(room, frame);
  if (background.width !== frame.width || background.height !== frame.height)
    throw new Error(
      `기존 비교 공간의 화면 크기(${frame.width}×${frame.height})를 이 기기에서 유지할 수 없어 분석을 시작하지 않았어요. 이 크기를 지원하는 기기에서 다시 시도해 주세요.`,
    );
  return background;
}
