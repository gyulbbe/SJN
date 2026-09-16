import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { PlaneRandom, MOGE_PLANE_SEED } from '../src/lib/reconstruction/moge-browser/plane-random';
import reference from './fixtures/moge-plane-rng-reference.json';
function digest(values: number[]) {
  const bytes = Buffer.alloc(values.length * 8);
  values.forEach((v, i) => bytes.writeBigInt64LE(BigInt(v), 8 * i));
  return createHash('sha256').update(bytes).digest('hex');
}
describe('plane sampling agrees with unmodified NumPy 2.2.6 reference', () => {
  it('matches sequential Floyd, tail-shuffle, buffered integers, and empty samples', () => {
    expect(reference.seed).toBe(MOGE_PLANE_SEED);
    const rng = new PlaneRandom();
    for (const step of reference.steps) {
      const values =
        step.kind === 'sample'
          ? rng.sample(
              Array.from({ length: step.n }, (_, i) => i),
              step.k,
            )
          : Array.from({ length: step.k }, () => rng.integer(step.n));
      expect(values.slice(0, 10)).toEqual(step.head);
      expect(digest(values)).toBe(step.sha256);
    }
  });
  it('rejects an unversioned seed and invalid sampling sizes', () => {
    expect(() => new PlaneRandom(5)).toThrow();
    const rng = new PlaneRandom();
    expect(() => rng.integer(0)).toThrow();
    expect(() => rng.integer(1048577)).toThrow();
    expect(() => rng.sample([1], 2)).toThrow();
    expect(rng.integer(1)).toBe(0);
  });
  it('samples values without mutating the population', () => {
    const ids = [11, 18, 21, 27],
      saved = [...ids];
    expect([...new PlaneRandom().sample(ids, 4)].sort((a, b) => a - b)).toEqual(ids);
    expect(ids).toEqual(saved);
  });
});
