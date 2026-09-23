import { describe, expect, it } from 'vitest';
import { parseRangeInput, snapRangeValue, stepRangeValue } from '../src/lib/range-input';

const grout = { min: 0, max: 15, step: 0.5 };
const rotation = { min: -180, max: 180, step: 1 };
const shading = { min: 0, max: 1, step: 0.01 };

describe('typed slider values', () => {
  it('clamps to the slider range and snaps to its step', () => {
    expect(parseRangeInput('3.2', grout)).toBe(3);
    expect(parseRangeInput('3.3', grout)).toBe(3.5);
    expect(parseRangeInput('-200', rotation)).toBe(-180);
    expect(parseRangeInput('1e9', rotation)).toBe(180);
    expect(parseRangeInput('90', rotation)).toBe(90);
  });

  it('keeps decimal steps free of float noise', () => {
    expect(parseRangeInput('0.35', shading)).toBe(0.35);
    expect(parseRangeInput('0.357', shading)).toBe(0.36);
    expect(snapRangeValue(0.1 + 0.2, shading)).toBe(0.3);
  });

  it('accepts spaces and a decimal comma but rejects empty or non-numeric text', () => {
    expect(parseRangeInput(' 4 ', grout)).toBe(4);
    expect(parseRangeInput('2,5', grout)).toBe(2.5);
    expect(parseRangeInput('', grout)).toBeNull();
    expect(parseRangeInput('   ', grout)).toBeNull();
    expect(parseRangeInput('abc', grout)).toBeNull();
  });

  it('nudges by one or ten steps and stops at the range edges', () => {
    expect(stepRangeValue(90, 1, rotation)).toBe(91);
    expect(stepRangeValue(90, -1, rotation, 10)).toBe(80);
    expect(stepRangeValue(0.99, 1, shading)).toBe(1);
    expect(stepRangeValue(1, 1, shading)).toBe(1);
    expect(stepRangeValue(0, -1, grout)).toBe(0);
  });
});
