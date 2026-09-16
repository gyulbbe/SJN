import { describe, it, expect } from 'vitest';
import { estimateAssemblyObservationBounds } from '../src/lib/reconstruction/estimated-assembly-bounds';
import type { SceneCandidate } from '../src/lib/reconstruction/pipeline-contract';
const candidate = (
  id: string,
  kind: SceneCandidate['kind'],
  bounds: SceneCandidate['bounds'],
): SceneCandidate => ({
  id,
  kind,
  bounds,
  reflection: 'physical',
  mounting: 'unknown',
  wall: 'unknown',
  basinStyle: 'unknown',
  shape: 'unknown',
  evidence: ['Test contract observation'],
  uncertainty: [],
});
const parent = () => candidate('counter', 'vanity', { left: 0.15, top: 0.55, right: 0.85, bottom: 0.9 });
const bowl = (id = 'bowl') => candidate(id, 'basin', { left: 0.25, top: 0.4, right: 0.65, bottom: 0.6 });
describe('combined assembly photo bounds', () => {
  it('includes the raised bowl in the same model comparison without editing either observation', () => {
    const p = parent(),
      b = bowl(),
      original = structuredClone([p, b]);
    const result = estimateAssemblyObservationBounds(p, [b]);
    expect(result.status).toBe('combined');
    expect(result.bounds).toEqual({ left: 0.15, top: 0.4, right: 0.85, bottom: 0.9 });
    expect([p, b]).toEqual(original);
    result.bounds.top = 0;
    result.observations[0].bounds.left = 0;
    expect([p, b]).toEqual(original);
  });
  it('keeps both bowls in a double-bowl assembly while preserving their IDs', () => {
    const left = bowl('a'),
      right = bowl('b');
    right.bounds = { left: 0.6, top: 0.38, right: 0.92, bottom: 0.57 };
    const result = estimateAssemblyObservationBounds(parent(), [left, right]);
    expect(result.status).toBe('combined');
    expect(result.componentIds).toEqual(['a', 'b']);
    expect(result.bounds).toEqual({ left: 0.15, top: 0.38, right: 0.92, bottom: 0.9 });
  });
  it.each(['reflected', 'uncertain'] as const)(
    'does not expand the physical assembly using %s parts',
    (reflection) => {
      const b = bowl();
      b.reflection = reflection;
      const r = estimateAssemblyObservationBounds(parent(), [b]);
      expect(r.status).toBe('held');
      expect(r.bounds).toEqual(parent().bounds);
    },
  );
  it('holds physically conflicting ordering and distant regions', () => {
    for (const bounds of [
      { left: 0.9, top: 0.4, right: 1, bottom: 0.5 },
      { left: 0.25, top: 0.9, right: 0.6, bottom: 0.98 },
      { left: 0.25, top: 0.01, right: 0.6, bottom: 0.11 },
    ]) {
      const b = bowl();
      b.bounds = bounds;
      expect(estimateAssemblyObservationBounds(parent(), [b]).status).toBe('held');
    }
  });
  it('rejects duplicate IDs, unsupported assemblies and invalid bounds', () => {
    expect(estimateAssemblyObservationBounds(parent(), [bowl(), bowl()]).status).toBe('held');
    expect(estimateAssemblyObservationBounds(parent(), []).status).toBe('held');
    expect(estimateAssemblyObservationBounds(parent(), [bowl('counter')]).status).toBe('held');
    const b = bowl();
    b.bounds.top = NaN;
    expect(estimateAssemblyObservationBounds(parent(), [b]).status).toBe('held');
  });
});
