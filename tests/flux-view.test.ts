import { describe, it, expect } from 'vitest';
import {
  FLUX_EYE_FOV,
  FLUX_EYE_HEIGHT_MM,
  fluxRoom,
  fluxView,
  fluxViewChoices,
} from '../src/lib/ai-export/view';
import { visibleCeiling, visibleWalls } from '../src/lib/ai-export/scene';
import type { RegionMask } from '../src/lib/ai-export/color';
import { DEFAULT_ROOM } from '../src/lib/room-geometry';
import {
  defaultRoomView,
  roomEyeView,
  roomEyeYawLimit,
  type RoomViewState,
} from '../src/lib/room-viewer/view-state';
import type { Scene } from '../src/lib/types';

const room = structuredClone(DEFAULT_ROOM);
const scene = (patch: Partial<Scene> = {}): Scene => ({
  room: structuredClone(room),
  originalAssetId: 'bg',
  previewAssetId: 'bg',
  imageWidth: 3600,
  imageHeight: 2400,
  surfaces: [],
  protection: { polygon: [], strokes: [] },
  fixtures: [],
  color: { exposure: 0, contrast: 1, saturation: 1, warmth: 0 },
  ...patch,
});

describe('AI input view', () => {
  it('draws every scene with room dimensions in the room; legacy photo-only scenes keep the 2D path', () => {
    expect(fluxRoom(scene(), scene())).toEqual(room);
    expect(fluxRoom(scene({ room: undefined }), scene())).toBeUndefined();
    expect(fluxRoom(scene(), scene({ room: undefined }))).toBeUndefined();
    // Before and After must share the room (the 3D renderer compares them in one space).
    expect(fluxRoom(scene(), scene({ room: { ...room, widthMm: room.widthMm + 100 } }))).toBeUndefined();
  });

  it('offers the three in-room presets, plus the saved in-room view first-selected when there is one', () => {
    expect(fluxViewChoices({})).toEqual({
      choices: ['center', 'left-corner', 'right-corner'],
      initial: 'center',
    });
    // An orbit or photo camera saved in the space viewer is never an AI input.
    expect(fluxViewChoices({ roomView: defaultRoomView() }).initial).toBe('center');
    const saved = roomEyeView(room, 'left-corner');
    saved.eye!.yaw += 7;
    expect(fluxViewChoices({ roomView: saved })).toEqual({
      choices: ['center', 'left-corner', 'right-corner', 'saved'],
      initial: 'saved',
    });
  });

  it('keeps each preset’s place and heading with the AI lens: lower, wider, not shifted', () => {
    for (const choice of ['center', 'left-corner', 'right-corner'] as const) {
      const view = fluxView(room, choice, {});
      const preset = roomEyeView(room, choice).eye!;
      expect(view.projection).toBe('room-eye');
      expect(view.eye!.position).toEqual([preset.position[0], FLUX_EYE_HEIGHT_MM, preset.position[2]]);
      expect(view.eye!.fov).toBe(FLUX_EYE_FOV);
      expect(view.eye!.shift).toBe(0);
      // The wider lens turns a corner view a little less, so the open front stays out of frame.
      expect(Math.abs(view.eye!.yaw)).toBeLessThanOrEqual(roomEyeYawLimit(FLUX_EYE_FOV));
      expect(Math.sign(view.eye!.yaw)).toBe(Math.sign(preset.yaw));
    }
    // A low room keeps the eye below its ceiling.
    const low = { ...room, heightMm: 1000 };
    expect(fluxView(low, 'center', {}).eye!.position[1]).toBe(1000 - 150);
  });

  it('uses the saved in-room view exactly as saved, and the centre preset when it is gone', () => {
    const saved: RoomViewState = roomEyeView(room, 'right-corner');
    saved.eye!.shift = 0.1;
    expect(fluxView(room, 'saved', { roomView: saved }).eye).toEqual(saved.eye);
    // The saved view was replaced by an orbit meanwhile: the centre eye, never the orbit.
    expect(fluxView(room, 'saved', { roomView: defaultRoomView() })).toEqual(fluxView(room, 'center', {}));
  });
});

describe('visibleWalls', () => {
  it('lists the walls covering at least 2% of the mask, left to right, from surfaces and bare faces', () => {
    const width = 100,
      height = 50,
      data = new Uint8Array(width * height);
    // 1: back wall surface (40%), 2: floor, 3: bare left face (3%), 4: right wall surface (1%).
    data.fill(1, 0, 2000);
    data.fill(2, 2000, 3000);
    data.fill(3, 3000, 3150);
    data.fill(4, 3150, 3200);
    data.fill(255, 3200, 3400);
    const mask: RegionMask = {
      width,
      height,
      data,
      regions: [
        { key: 'surface:back', kind: 'wall' },
        { key: 'surface:floor', kind: 'floor' },
        { key: 'face:left', kind: 'wall' },
        { key: 'surface:right', kind: 'wall' },
      ],
    };
    const surfaces = [
      { id: 'back', roomFace: 'back' },
      { id: 'floor', roomFace: 'floor' },
      { id: 'right', roomFace: 'right' },
    ] as Scene['surfaces'];
    expect(visibleWalls(mask, { surfaces })).toEqual(['left', 'back']);
  });
});

describe('visibleCeiling', () => {
  it('names the ceiling only when at least 1% of an in-room capture is left unlabelled', () => {
    const mask = (unlabelled: number): RegionMask => {
      const data = new Uint8Array(1000).fill(1);
      data.fill(0, 0, unlabelled);
      return { width: 100, height: 10, data, regions: [{ key: 'face:back', kind: 'wall' }] };
    };
    expect(visibleCeiling(mask(0))).toBe(false);
    expect(visibleCeiling(mask(9))).toBe(false);
    expect(visibleCeiling(mask(10))).toBe(true);
  });
});
