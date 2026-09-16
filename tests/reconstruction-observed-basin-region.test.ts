import { describe, expect, it } from 'vitest';
import { inspectObservedBasinRegion } from '../src/lib/reconstruction/observed-basin-region';
import type { SceneCandidate } from '../src/lib/reconstruction/pipeline-contract';

type Input = Pick<SceneCandidate, 'kind' | 'basinStyle' | 'bounds'>;
const pedestal = (bounds: Input['bounds']): Input => ({ kind: 'basin', basinStyle: 'pedestal', bounds });
const square = { width: 1000, height: 1000 };

describe('pedestal observation region in pixel units', () => {
  it('uses the same physical pixel rectangle regardless of portrait or landscape normalization', () => {
    const landscape = inspectObservedBasinRegion(
      pedestal({ left: 0.1, right: 0.2, top: 0.1, bottom: 0.15 }),
      { width: 1000, height: 2000 },
    );
    const portrait = inspectObservedBasinRegion(pedestal({ left: 0.1, right: 0.15, top: 0.1, bottom: 0.2 }), {
      width: 2000,
      height: 1000,
    });
    expect(landscape.normalizedAspect).toBeCloseTo(0.5);
    expect(portrait.normalizedAspect).toBeCloseTo(2);
    expect(landscape.pixelWidth).toBeCloseTo(100);
    expect(portrait.pixelWidth).toBeCloseTo(100);
    expect(landscape.pixelHeight).toBeCloseTo(100);
    expect(portrait.pixelHeight).toBeCloseTo(100);
    expect(landscape.bowlOnly).toBe(false);
    expect(portrait.bowlOnly).toBe(false);
  });

  it('recognizes a wide pixel region even when normalized height appears taller', () => {
    const result = inspectObservedBasinRegion(pedestal({ left: 0.1, right: 0.3, top: 0.1, bottom: 0.3 }), {
      width: 2000,
      height: 1000,
    });
    expect(result.normalizedAspect).toBe(1);
    expect(result.pixelAspect).toBe(0.5);
    expect(result.bowlOnly).toBe(true);
    expect(result.source).toBe('aspect-heuristic-not-observed-part');
  });

  it('is invariant under uniform image resizing with unchanged normalized bounds', () => {
    const candidate = pedestal({ left: 0.1, right: 0.5, top: 0.25, bottom: 0.5 });
    const first = inspectObservedBasinRegion(candidate, { width: 1200, height: 800 });
    const resized = inspectObservedBasinRegion(candidate, { width: 600, height: 400 });
    expect(first.bowlOnly).toBe(resized.bowlOnly);
    expect(first.pixelAspect).toBe(resized.pixelAspect);
    expect(first.pixelWidth).toBe(resized.pixelWidth! * 2);
    expect(first.pixelHeight).toBe(resized.pixelHeight! * 2);
  });

  it.each([
    [0.649, true],
    [0.65, false],
    [0.651, false],
  ])('preserves the strict threshold for square-image aspect %s', (aspect, expected) => {
    const result = inspectObservedBasinRegion(
      pedestal({ left: 0, right: 1, top: 0, bottom: Number(aspect) }),
      square,
    );
    expect(result.bowlOnly).toBe(expected);
    expect(result.threshold).toBe(0.65);
  });

  it.each(['wall', 'vanity', 'unknown'] as const)(
    'does not extend the heuristic to basin style %s',
    (basinStyle) => {
      const input: Input = { kind: 'basin', basinStyle, bounds: { left: 0, top: 0, right: 1, bottom: 0.1 } };
      expect(inspectObservedBasinRegion(input, square)).toMatchObject({
        bowlOnly: false,
        status: 'not-applicable',
      });
    },
  );

  it('does not classify another fixture as a basin from its wide rectangle', () => {
    const input: Input = {
      kind: 'wallShelf',
      basinStyle: 'pedestal',
      bounds: { left: 0, top: 0, right: 1, bottom: 0.1 },
    };
    expect(inspectObservedBasinRegion(input, square).status).toBe('not-applicable');
  });

  it.each([
    { width: 0, height: 1000 },
    { width: 1000, height: -1 },
    { width: Number.NaN, height: 1000 },
    { width: 1000, height: Number.POSITIVE_INFINITY },
    { width: 1000.5, height: 1000 },
    { width: Number.MAX_SAFE_INTEGER + 1, height: 1000 },
  ])('does not infer bowl-only fitting with invalid image dimensions %j', (image) => {
    expect(
      inspectObservedBasinRegion(pedestal({ left: 0, top: 0, right: 1, bottom: 0.1 }), image),
    ).toMatchObject({
      status: 'invalid-input',
      bowlOnly: false,
      reason: 'invalid-image-dimensions',
    });
  });

  it.each([
    { left: 0.1, right: 0.1, top: 0, bottom: 0.5 },
    { left: 0.8, right: 0.2, top: 0, bottom: 0.5 },
    { left: -0.01, right: 1, top: 0, bottom: 0.5 },
    { left: 0, right: 1.01, top: 0, bottom: 0.5 },
    { left: 0, right: 1, top: 0.5, bottom: 0.1 },
    { left: 0, right: 1, top: 0, bottom: Number.NaN },
    { left: 0, right: Number.POSITIVE_INFINITY, top: 0, bottom: 0.1 },
  ])('rejects invalid normalized bounds %j without a positive classification', (bounds) => {
    expect(inspectObservedBasinRegion(pedestal(bounds), square)).toMatchObject({
      status: 'invalid-input',
      bowlOnly: false,
      reason: 'invalid-normalized-bounds',
    });
  });

  it('preserves input bounds and installation data without clamping or rewriting', () => {
    const candidate = pedestal({ left: 0.15, right: 0.65, top: 0.1, bottom: 0.4 });
    const original = structuredClone(candidate);
    Object.freeze(candidate.bounds);
    Object.freeze(candidate);
    const result = inspectObservedBasinRegion(candidate, square);
    expect(result.status).toBe('heuristic');
    expect(candidate).toEqual(original);
    expect(inspectObservedBasinRegion(candidate, square)).toEqual(result);
  });
});
