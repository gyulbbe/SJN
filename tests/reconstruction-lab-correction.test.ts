import { describe, expect, it } from 'vitest';
import {
  appliedCorrectionReview,
  captureLabCorrection,
  restoreLabCorrectionDraft,
  type LabCorrectionSnapshot,
} from '../src/lib/reconstruction/lab-correction';

function submitted(): Omit<LabCorrectionSnapshot, 'version'> {
  return {
    capturedAt: '2026-09-13T12:00:00.000Z',
    sourceRunId: 'automatic-run',
    sourceModelRunId: 'original-model-run',
    inputKey: 'photo-sha:2400x2400x2400',
    sourceEngineMetadata: {
      id: 'candidate',
      revision: 'historical-analysis',
      modelId: 'local-model',
      modelRevision: 'digest',
      settings: { promptRevision: 8, temperature: 0.7 },
    },
    changedFieldCount: 2,
    draft: {
      corrections: { basin: { shape: 'round', bowlCount: '2', note: '확인한 두 볼' } },
      manual: {
        basin: {
          enabled: true,
          face: 'floor',
          u: '0.16',
          v: '0.52',
          baseHeightMm: '0',
          widthMm: '',
          heightMm: '',
          depthMm: '',
          yawDegrees: '90',
        },
      },
      additions: [],
      disconnectedRelations: ['bowl:partOf:old-cabinet'],
    },
    input: {
      understanding: {
        schemaVersion: 1,
        roomLayout: { orthogonal: 'unknown', evidence: [], uncertainty: ['camera not calibrated'] },
        relations: [],
        candidates: [
          {
            id: 'basin',
            kind: 'vanity',
            mounting: 'floor',
            wall: 'left',
            basinStyle: 'unknown',
            shape: 'round',
            bowlCount: 2,
            reflection: 'physical',
            bounds: { left: 0.05, top: 0.4, right: 0.4, bottom: 0.95 },
            evidence: ['original model observation'],
            uncertainty: ['default dimensions'],
            provenance: { kind: 'model', shape: 'user', bowlCount: 'user', position: 'user' },
          },
        ],
      },
      manualPlacements: { basin: { face: 'floor', u: 0.16, v: 0.52, baseHeightMm: 0, yawDegrees: 90 } },
    },
  };
}

describe('completed reconstruction correction inputs', () => {
  it('keeps the rendered input independent when the original draft changes or is cleared', () => {
    const input = submitted();
    const snapshot = captureLabCorrection(input);
    input.draft.corrections.basin.shape = 'rectangular';
    input.draft.manual.basin.u = '0.9';
    input.draft.disconnectedRelations!.length = 0;
    input.input.understanding.candidates[0].shape = 'rectangular';
    input.input.manualPlacements.basin.yawDegrees = 0;
    expect(snapshot.draft.corrections.basin.shape).toBe('round');
    expect(snapshot.draft.manual.basin.u).toBe('0.16');
    expect(snapshot.draft.disconnectedRelations).toEqual(['bowl:partOf:old-cabinet']);
    expect(snapshot.input.understanding.candidates[0].shape).toBe('round');
    expect(snapshot.input.manualPlacements.basin.yawDegrees).toBe(90);
  });

  it('protects nested completed values and preserves historical model metadata', () => {
    const input = submitted();
    const snapshot = captureLabCorrection(input);
    input.sourceEngineMetadata.settings.promptRevision = 99;
    expect(Reflect.set(snapshot.draft.manual.basin, 'u', '0.9')).toBe(false);
    expect(Object.isFrozen(snapshot.input.understanding.candidates[0].provenance)).toBe(true);
    expect(snapshot.sourceEngineMetadata.settings.promptRevision).toBe(8);
    expect(snapshot.sourceModelRunId).toBe('original-model-run');
    expect(snapshot.sourceEngineMetadata.revision).toBe('historical-analysis');
  });

  it('exports actual submitted counts, changes, default dimensions and user provenance', () => {
    const snapshot = captureLabCorrection(submitted());
    const exported = appliedCorrectionReview(snapshot);
    expect(exported.recordType).toBe('applied-correction');
    expect(exported.changedFieldCount).toBe(2);
    expect(exported.manuallyPlacedCandidateCount).toBe(1);
    expect(exported.corrections.basin).toEqual({ shape: 'round', bowlCount: '2', note: '확인한 두 볼' });
    expect(exported.manualPlacements.basin.widthMm).toBe('');
    expect(snapshot.input.manualPlacements.basin.widthMm).toBeUndefined();
    expect(snapshot.input.understanding.candidates[0].provenance).toMatchObject({
      kind: 'model',
      shape: 'user',
      position: 'user',
    });
  });

  it('counts only submitted additions and enabled, nonexcluded manual placements', () => {
    const input = submitted();
    const addition = { ...structuredClone(input.input.understanding.candidates[0]), id: 'excluded-addition' };
    input.draft.additions.push(addition);
    input.draft.corrections[addition.id] = { falsePositive: true };
    input.draft.manual[addition.id] = { ...input.draft.manual.basin, enabled: false };
    const exported = appliedCorrectionReview(captureLabCorrection(input));
    expect(exported.addedCandidateCount).toBe(0);
    expect(exported.manuallyPlacedCandidateCount).toBe(1);
    expect(exported.additions).toHaveLength(1); // The rejected user input remains auditable.
    expect(exported.corrections[addition.id].falsePositive).toBe(true);
  });

  it('does not let a downloaded JSON copy change the stored correction', () => {
    const snapshot = captureLabCorrection(submitted());
    const exported = appliedCorrectionReview(snapshot);
    exported.manualPlacements.basin.u = '0.8';
    exported.corrections.basin.note = 'later note';
    exported.disconnectedRelations.push('other');
    expect(appliedCorrectionReview(snapshot).manualPlacements.basin.u).toBe('0.16');
    expect(snapshot.draft.corrections.basin.note).toBe('확인한 두 볼');
    expect(snapshot.draft.disconnectedRelations).toHaveLength(1);
  });

  it('restores a new editable draft without relabelling or changing the completed source', () => {
    const snapshot = captureLabCorrection(submitted());
    const restored = restoreLabCorrectionDraft(snapshot, 'automatic-run', snapshot.inputKey);
    restored.manual.basin.yawDegrees = '180';
    restored.corrections.basin.bowlCount = '1';
    expect(snapshot.input.manualPlacements.basin.yawDegrees).toBe(90);
    expect(snapshot.draft.corrections.basin.bowlCount).toBe('2');
    expect(restored.disconnectedRelations).toEqual(['bowl:partOf:old-cabinet']);
  });

  it('refuses restoring against a different photo, dimensions or observation run', () => {
    const snapshot = captureLabCorrection(submitted());
    expect(() => restoreLabCorrectionDraft(snapshot, 'different-run', snapshot.inputKey)).toThrow('원 분석');
    expect(() =>
      restoreLabCorrectionDraft(snapshot, snapshot.sourceRunId, 'different-photo:2400x2400x2400'),
    ).toThrow('사진·공간');
    expect(() =>
      restoreLabCorrectionDraft(snapshot, snapshot.sourceRunId, 'photo-sha:3000x2400x2400'),
    ).toThrow('사진·공간');
  });

  it('keeps consecutive completed results independently reproducible', () => {
    const input = submitted();
    const first = captureLabCorrection(input);
    const nextInput = {
      ...input,
      draft: restoreLabCorrectionDraft(first, first.sourceRunId, first.inputKey),
      capturedAt: '2026-09-13T12:01:00.000Z',
    };
    nextInput.draft.manual.basin.u = '0.4';
    nextInput.input.manualPlacements.basin.u = 0.4;
    const second = captureLabCorrection(nextInput);
    const persisted = JSON.parse(JSON.stringify({ first, second }));
    expect(persisted.first.input.manualPlacements.basin.u).toBe(0.16);
    expect(persisted.second.input.manualPlacements.basin.u).toBe(0.4);
    expect(persisted.first.capturedAt).not.toBe(persisted.second.capturedAt);
  });
});
