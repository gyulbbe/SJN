import { describe, expect, it } from 'vitest';
import { DEFAULT_ROOM, createRoomSurfaces } from '../src/lib/room-geometry';
import { createRegionSurface } from '../src/lib/room-surface-regions';
import {
  draftRegionUv,
  MAX_SURFACES,
  movedRegion,
  regionFromDrag,
  regionPlacementIssue,
  regionToolIssue,
  suggestedRegion,
} from '../src/lib/region-editing';
import { DEFAULT_COLOR, EMPTY_MASK, type MaterialVersion, type Scene } from '../src/lib/types';

const tile = (id: string, size: number): MaterialVersion => ({
  id,
  materialId: id,
  version: 1,
  name: id,
  brand: '',
  code: '',
  category: 'tile',
  scope: 'personal',
  description: '',
  color: '#ffffff',
  finish: '',
  widthMm: size,
  heightMm: size,
  depthMm: 8,
  usage: 'both',
  installation: 'wall',
  textureAssetIds: ['t'],
  views: [],
  defaultGroutWidth: 2,
  defaultGroutColor: '#ffffff',
  defaultPattern: 'grid',
  createdAt: '2026-10-22',
});
const materials = { base: tile('base', 300) };
function scene(): Scene {
  return {
    room: { ...DEFAULT_ROOM },
    originalAssetId: 'o',
    previewAssetId: 'p',
    imageWidth: 1200,
    imageHeight: 800,
    surfaces: createRoomSurfaces(DEFAULT_ROOM, 1.5).map((s) => ({
      ...s,
      materialVersionId: 'base',
      tile: { ...s.tile, groutWidth: 2 },
    })),
    fixtures: [],
    protection: EMPTY_MASK(),
    color: { ...DEFAULT_COLOR },
  };
}

describe('region tool helpers', () => {
  it('is only offered on an After design of a room that is writable and not full', () => {
    const value = scene();
    expect(regionToolIssue({ scene: value, editing: 'after', writable: true })).toBeNull();
    expect(regionToolIssue({ scene: { ...value, room: undefined }, editing: 'after', writable: true })).toBe(
      '부분 타일은 방 치수가 있는 공간에서만 쓸 수 있어요.',
    );
    expect(regionToolIssue({ scene: value, editing: 'before', writable: true })).toBe(
      '부분 타일은 After 시안에서만 써요.',
    );
    expect(regionToolIssue({ scene: value, editing: 'after', writable: false })).toContain('읽기 전용');
    const full = { ...value, surfaces: Array.from({ length: MAX_SURFACES }, () => value.surfaces[0]) };
    expect(regionToolIssue({ scene: full, editing: 'after', writable: true })).toContain('100개');
  });
  it('turns a drag in either direction into a rectangle cut to the face, none when too small', () => {
    const size = { width: 2400, height: 2400 };
    expect(regionFromDrag(size, { u: 0.75, v: 0.5 }, { u: 0.25, v: -0.2 })).toEqual({
      leftMm: 600,
      topMm: 0,
      widthMm: 1200,
      heightMm: 1200,
    });
    expect(regionFromDrag(size, { u: 0.5, v: 0.5 }, { u: 0.51, v: 0.7 })).toBeNull();
  });
  it('previews the snapped rectangle the drag will make', () => {
    const value = scene();
    const box = draftRegionUv(value, 'back', { u: 0.3, v: 0.45 }, { u: 0.65, v: 0.8 }, true, materials);
    // Base joints every 302 mm: the start edges follow joint ends, the end edges joint starts.
    expect(box.left * 2400).toBeCloseTo(604, 6);
    expect(box.right * 2400).toBeCloseTo(1508, 6);
    expect(box.top * 2400).toBeCloseTo(1208, 6);
    expect(box.bottom * 2400).toBeCloseTo(1810, 6);
    const plain = draftRegionUv(value, 'back', { u: 0.3, v: 0.45 }, { u: 0.65, v: 0.8 }, false, materials);
    expect(plain).toEqual({ left: 0.3, top: 0.45, right: 0.65, bottom: 0.8 });
  });
  it('moves inside the face and refuses a place over another region', () => {
    const value = scene();
    const size = { width: 2400, height: 2400 };
    const region = { leftMm: 100, topMm: 100, widthMm: 600, heightMm: 600 };
    expect(movedRegion(region, size, -0.5, 0.25)).toEqual({ ...region, leftMm: 0, topMm: 700 });
    expect(movedRegion(region, size, 2, 2)).toEqual({ ...region, leftMm: 1800, topMm: 1800 });
    value.surfaces.push(createRegionSurface(value, 'back', region));
    expect(regionPlacementIssue(value, 'back', { ...region, leftMm: 500 })).toBe(
      '같은 면의 부분 타일끼리 겹칠 수 없어요.',
    );
    expect(regionPlacementIssue(value, 'back', { ...region, leftMm: 700 })).toBeNull();
    expect(regionPlacementIssue(value, 'floor', { ...region, leftMm: 500 })).toBeNull();
  });
  it('suggests a snapped middle third and a floor-level band, or nothing when taken', () => {
    const value = scene();
    const area = suggestedRegion(value, 'back', 'area', materials)!;
    expect(area.leftMm).toBeCloseTo(906, 6);
    expect(area.widthMm).toBeGreaterThanOrEqual(600);
    expect(suggestedRegion(value, 'left', 'band', materials)).toEqual({
      leftMm: 0,
      topMm: 2100,
      widthMm: 2400,
      heightMm: 300,
    });
    value.surfaces.push(createRegionSurface(value, 'back', area));
    expect(suggestedRegion(value, 'back', 'area', materials)).toBeNull();
  });
});
