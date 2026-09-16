import { describe, expect, it } from 'vitest';
import { labPhotoCandidates, validPhotoBounds } from '../src/lib/reconstruction/lab-photo-map';
import type { SceneCandidate, SceneUnderstanding } from '../src/lib/reconstruction/pipeline-contract';
import type { ReconstructionCandidate } from '../src/lib/reconstruction/types';
const bounds = { left: 0.1, top: 0.2, right: 0.4, bottom: 0.6 };
const candidate = (id = 'observed'): SceneCandidate => ({
  id,
  kind: 'basin',
  mounting: 'wall',
  wall: 'left',
  basinStyle: 'wall',
  shape: 'round',
  reflection: 'physical',
  bounds: { ...bounds },
  evidence: ['test observation'],
  uncertainty: [],
});
const scene = (candidates: SceneCandidate[]): SceneUnderstanding => ({
  schemaVersion: 1,
  candidates,
  relations: [],
  roomLayout: { orthogonal: 'unknown', evidence: [], uncertainty: [] },
});
const baseline = (
  id: string,
  source: ReconstructionCandidate['source'] = 'deeplab',
): ReconstructionCandidate => ({
  id,
  source,
  kind: 'basin',
  bounds: { ...bounds },
  foot: { x: 0.25, y: 0.6 },
  color: '#ffffff',
  pixels: 10,
  evidence: { semanticPixels: 10, meanMargin: 0.8 },
  status: 'unplaced',
});

describe('original photo candidate mapping', () => {
  it('uses original model boxes and labels, preserving raw data despite corrected fields and user additions', () => {
    const model = scene([candidate()]);
    const edited = scene([
      { ...candidate(), kind: 'toilet', bounds: { left: 0, top: 0, right: 1, bottom: 1 } },
      { ...candidate('added'), provenance: { kind: 'user' } },
    ]);
    const report = {
      pipeline: { model: { understanding: model }, automaticUnderstanding: edited },
      review: { candidates: [] },
    };
    const before = JSON.stringify(report);
    const items = labPhotoCandidates(report);
    expect(items).toEqual([{ id: 'observed', label: '세면대', bounds }]);
    items[0].bounds.left = 0.9;
    expect(JSON.stringify(report)).toBe(before);
  });
  it('never falls back from a valid empty raw model to user-added corrected objects', () => {
    expect(
      labPhotoCandidates({
        pipeline: {
          model: { understanding: scene([]) },
          automaticUnderstanding: scene([candidate('added')]),
        },
        review: { candidates: [] },
      }),
    ).toEqual([]);
  });
  it('excludes explicit user observations in historical snapshots without guessing from IDs or full-frame size', () => {
    const original = { ...candidate('user-looking-id'), bounds: { left: 0, top: 0, right: 1, bottom: 1 } };
    const manual = {
      ...candidate('any-id'),
      provenance: { kind: 'user' as const, position: 'user' as const },
    };
    const result = labPhotoCandidates({
      pipeline: { automaticUnderstanding: scene([original, manual]) },
      review: { candidates: [] },
    });
    expect(result.map((c) => c.id)).toEqual(['user-looking-id']);
  });
  it('keeps held, reflected, and overlapping observations selectable without declaring them placed', () => {
    const candidates = [candidate('held'), { ...candidate('reflected'), reflection: 'reflected' as const }];
    expect(
      labPhotoCandidates({
        pipeline: { model: { understanding: scene(candidates) } },
        review: { candidates: [] },
      }).map((c) => c.id),
    ).toEqual(['held', 'reflected']);
  });
  it('maps legacy baseline raw review and excludes manual additions', () => {
    expect(
      labPhotoCandidates({
        rawReview: { candidates: [baseline('raw'), baseline('manual', 'user')] },
        review: { candidates: [baseline('changed')] },
      }).map((c) => c.id),
    ).toEqual(['raw']);
    expect(labPhotoCandidates({ review: { candidates: [baseline('legacy')] } }).map((c) => c.id)).toEqual([
      'legacy',
    ]);
  });
  it('omits invalid/out-of-range boxes without clamping or rescaling and deduplicates IDs', () => {
    const candidates = [
      candidate(),
      candidate(),
      { ...candidate('wrong-scale'), bounds: { left: 10, top: 20, right: 40, bottom: 60 } },
      { ...candidate('nan'), bounds: { ...bounds, left: NaN } },
    ];
    expect(
      labPhotoCandidates({
        pipeline: { model: { understanding: scene(candidates) } },
        review: { candidates: [] },
      }),
    ).toHaveLength(1);
    expect(validPhotoBounds({ ...bounds, right: bounds.left })).toBe(false);
    expect(validPhotoBounds({ ...bounds, top: -0.01 })).toBe(false);
    expect(validPhotoBounds({ ...bounds, bottom: Infinity })).toBe(false);
  });
});
