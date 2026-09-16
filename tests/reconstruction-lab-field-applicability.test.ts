import { describe, expect, it } from 'vitest';
import {
  parseSceneUnderstanding,
  validateUserUnderstanding,
} from '../src/lib/reconstruction/scene-understanding';

function legacyScene() {
  return parseSceneUnderstanding(
    JSON.stringify({
      schemaVersion: 1,
      roomLayout: {
        orthogonal: 'unknown',
        evidence: [],
        uncertainty: [],
        backWallQuad: null,
        lines: [],
        corners: [],
      },
      relations: [],
      candidates: ['cabinet', 'healthy'].map((id) => ({
        id,
        kind: 'vanity',
        mounting: 'floor',
        wall: 'left',
        shape: 'rectangular',
        basinStyle: id === 'cabinet' ? 'vanity' : 'unknown',
        reflection: 'physical',
        bounds: { left: 0.1, top: 0.2, right: 0.6, bottom: 0.8 },
        evidence: ['Synthetic legacy support conflict; not a recognition result'],
        uncertainty: [],
        anchor: null,
      })),
    }),
  );
}

describe('explicit repair of an inapplicable basin support field', () => {
  it('retains a conflicting original candidate until the user explicitly clears its support field', () => {
    const automatic = legacyScene();
    const original = structuredClone(automatic);
    expect(automatic.candidates[0].validation?.issues.map((issue) => issue.code)).toContain(
      'non-basin-support',
    );
    const unchanged = validateUserUnderstanding(structuredClone(automatic), automatic);
    expect(unchanged.candidates[0].validation?.issues.map((issue) => issue.code)).toContain(
      'non-basin-support',
    );
    const supplied = structuredClone(automatic);
    supplied.candidates[0].basinStyle = 'unknown';
    const repaired = validateUserUnderstanding(supplied, automatic);
    expect(repaired.candidates).toHaveLength(2);
    expect(repaired.candidates[0].validation).toBeUndefined();
    expect(repaired.candidates[0].provenance?.mounting).toBe('user');
    expect(repaired.candidates[0].provenance?.kind).toBe('model');
    expect(repaired.candidates[1]).toEqual(automatic.candidates[1]);
    expect(automatic).toEqual(original);
  });

  it('allows the user to restore the applicable basin kind without losing the selected support', () => {
    const automatic = legacyScene();
    const supplied = structuredClone(automatic);
    supplied.candidates[0].kind = 'basin';
    const repaired = validateUserUnderstanding(supplied, automatic);
    expect(repaired.candidates[0].basinStyle).toBe('vanity');
    expect(repaired.candidates[0].kind).toBe('basin');
    expect(repaired.candidates[0].validation).toBeUndefined();
    expect(repaired.candidates[0].provenance?.kind).toBe('user');
    expect(automatic.candidates[0].kind).toBe('vanity');
  });

  it('repairs a kind-changed two-bowl cabinet without changing the original bowl observation', () => {
    const automatic = legacyScene();
    automatic.candidates[0].basinStyle = 'unknown';
    automatic.candidates[0].bowlCount = 2;
    const original = structuredClone(automatic);
    const supplied = structuredClone(automatic);
    supplied.candidates[0].kind = 'toilet';
    const conflict = validateUserUnderstanding(supplied, automatic);
    expect(conflict.candidates[0].validation?.issues.map((issue) => issue.code)).toContain(
      'non-basin-bowl-count',
    );
    delete supplied.candidates[0].bowlCount;
    const repaired = validateUserUnderstanding(supplied, automatic);
    expect(repaired.candidates[0].validation).toBeUndefined();
    expect(repaired.candidates[0].bowlCount).toBeUndefined();
    expect(repaired.candidates[0].provenance?.kind).toBe('user');
    expect(repaired.candidates[0].provenance?.bowlCount).toBe('user');
    expect(repaired.candidates[1]).toEqual(automatic.candidates[1]);
    expect(automatic).toEqual(original);
  });
});
