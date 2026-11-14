import { describe, expect, it } from 'vitest';
import {
  TILE_JOINT_FULL_PX,
  TILE_JOINT_MIN_PX,
  TILE_JOINT_WIDTH_GLSL,
  tileJointWidth,
} from '../src/lib/render/tile-atlas';

describe('the drawn joint width (2026-11-14, docs/light-tuning-results-20261114.md)', () => {
  it('draws a sub-pixel joint one pixel wide where the tile is large on screen', () => {
    // A 2 mm joint of a 600 mm tile at 5 mm a pixel (a 2,400 mm wall in the 1,024 px AI capture).
    expect(tileJointWidth(2, 600, 5)).toBeCloseTo(5 * TILE_JOINT_MIN_PX);
    // Close up the joint is wider than a pixel and stays as it is.
    expect(tileJointWidth(2, 600, 0.5)).toBe(2);
  });
  it('keeps the physical width for tiles a few pixels small, fading in between', () => {
    // A 20 mm mosaic at 10 mm a pixel is 2 px: the joint keeps its 2 mm (the average stays true).
    expect(tileJointWidth(2, 20, 10)).toBe(2);
    // 4.5 px: half way.
    expect(tileJointWidth(1, 45, 10)).toBeCloseTo(5);
    expect(tileJointWidth(1, TILE_JOINT_FULL_PX * 10, 10)).toBeCloseTo(10);
  });
  it('only widens a joint: a surface without joints is skipped by the shaders before it is asked', () => {
    expect(tileJointWidth(3, 600, 1)).toBe(3);
    expect(TILE_JOINT_WIDTH_GLSL).toContain('max(vec2(grout)');
  });
});
