import { describe, expect, it } from 'vitest';
import {
  DIVIDER_OBSERVATION_CONTRACT,
  dividerObservationJsonSchemaFor,
  dividerObservationPrompt,
  dividerTargetsSignature,
  parseDividerObservation,
  validateDividerTargets,
  validateDividerTargetsForInventory,
  type DividerObservation,
  type DividerTarget,
} from '../src/lib/reconstruction/divider-observation';
import type { SceneUnderstanding } from '../src/lib/reconstruction/pipeline-contract';
const targets: readonly DividerTarget[] = [
  { id: 'panel', bounds: { left: 0.2, top: 0.1, right: 0.4, bottom: 0.9 } },
];
const inventory = (): SceneUnderstanding => ({
  schemaVersion: 1,
  candidates: [
    {
      ...targets[0],
      kind: 'glassPartition',
      mounting: 'floor',
      wall: 'unknown',
      reflection: 'physical',
      basinStyle: 'unknown',
      shape: 'unknown',
      evidence: ['DO_NOT_SEND_OLD_LABEL_OR_NOTE'],
      uncertainty: [],
    },
  ],
  relations: [],
  roomLayout: { orthogonal: 'unknown', evidence: [], uncertainty: [] },
});
const observation = (changes: Partial<DividerObservation> = {}): DividerObservation => ({
  id: 'panel',
  note: ' Visible folds with an incomplete outer edge. ',
  context: 'physical',
  dividerMaterial: 'fabric-curtain',
  visibleExtent: 'part',
  support: 'unknown',
  ...changes,
});
const raw = (...observations: DividerObservation[]) => JSON.stringify({ schemaVersion: 1, observations });
describe('fixed divider material observation contract', () => {
  it('sends only fixed observed IDs/bounds and exactly grounds its output schema', () => {
    const input = inventory(),
      copy = structuredClone(input),
      fixed = validateDividerTargetsForInventory(input, targets);
    const prompt = dividerObservationPrompt(fixed);
    expect(prompt).not.toContain('DO_NOT_SEND_OLD_LABEL_OR_NOTE');
    expect(prompt.endsWith(JSON.stringify(dividerObservationJsonSchemaFor(fixed)))).toBe(true);
    expect(
      JSON.parse(prompt.split('Fixed targets (ID and observed bounds only):\n')[1].split('\nExact JSON')[0]),
    ).toEqual(targets);
    expect(input).toEqual(copy);
  });
  it('requires exact matching inventory IDs and all four bounds, before inference', () => {
    expect(() =>
      validateDividerTargetsForInventory(inventory(), [{ ...targets[0], id: 'foreign' }]),
    ).toThrow();
    for (const key of ['left', 'top', 'right', 'bottom'] as const)
      expect(() =>
        validateDividerTargetsForInventory(inventory(), [
          { ...targets[0], bounds: { ...targets[0].bounds, [key]: targets[0].bounds[key] + 0.001 } },
        ]),
      ).toThrow();
    const duplicated = inventory();
    duplicated.candidates.push(structuredClone(duplicated.candidates[0]));
    expect(() => validateDividerTargetsForInventory(duplicated, targets)).toThrow();
  });
  it.each(
    [
      [],
      [...targets, ...targets],
      [{ ...targets[0], id: ' ' }],
      [{ ...targets[0], kind: 'glassPartition' }],
      [{ ...targets[0], bounds: { ...targets[0].bounds, right: Infinity } }],
      [{ ...targets[0], bounds: { ...targets[0].bounds, bottom: NaN } }],
      [{ ...targets[0], bounds: { ...targets[0].bounds, left: -0.01 } }],
      [{ ...targets[0], bounds: { ...targets[0].bounds, right: 0.2 } }],
    ].map((invalid) => ({ invalid })),
  )('rejects invalid target structure', ({ invalid }) => {
    expect(() => validateDividerTargets(invalid as readonly DividerTarget[])).toThrow();
  });
  it('keeps equal boxes with distinct IDs and does not invent duplicate links', () => {
    const paired = [targets[0], { ...targets[0], id: 'other' }];
    const result = parseDividerObservation(raw(observation(), observation({ id: 'other' })), paired);
    expect(result.observations).toHaveLength(2);
    expect(result).not.toHaveProperty('duplicates');
  });
  it('validates upper bound and returns independent copies without changing readonly inputs', () => {
    expect(() =>
      validateDividerTargets(Array.from({ length: 25 }, (_, index) => ({ ...targets[0], id: `p${index}` }))),
    ).toThrow();
    const result = validateDividerTargets(targets);
    expect(result).not.toBe(targets);
    expect(result[0].bounds).not.toBe(targets[0].bounds);
    expect(dividerTargetsSignature(targets)).toBe(JSON.stringify(targets));
  });
  it('preserves complete model text values and does not let prose relabel typed material', () => {
    const value = observation({
      note: 'This is a mirror, not a divider; authored contradiction to preserve.',
      dividerMaterial: 'rigid-glass',
      context: 'reflected',
    });
    const result = parseDividerObservation(raw(value), targets);
    expect(result.observations).toEqual([value]);
    expect(result.contract).toBe(DIVIDER_OBSERVATION_CONTRACT);
    expect(result.automaticApplication).toBe(false);
    expect(result.warnings).toEqual([
      { candidateId: 'panel', code: 'target-not-confirmed-direct', action: 'retain-raw-do-not-apply' },
    ]);
    expect(parseDividerObservation(raw(observation()), targets).observations[0].note).toBe(
      observation().note,
    );
  });
  it('preserves incidental support/extent leakage with a separate warning', () => {
    const value = observation({ dividerMaterial: 'not-divider', support: 'frame' });
    const parsed = parseDividerObservation(raw(value), targets);
    expect(parsed.observations[0]).toEqual(value);
    expect(parsed.warnings[0]).toMatchObject({
      code: 'not-divider-incidental-field-leak',
      fields: ['visibleExtent', 'support'],
      action: 'retain-raw-do-not-apply',
    });
  });
  it('rejects missing, duplicated, foreign or extra output fields without partial application', () => {
    for (const value of [
      raw(),
      raw(observation(), observation()),
      raw(observation({ id: 'foreign' })),
      JSON.stringify({ schemaVersion: 1, observations: [observation()], command: 'change' }),
      raw({ ...observation(), command: 'change' } as DividerObservation),
      raw({ ...observation(), dividerMaterial: 'showerCurtain' } as unknown as DividerObservation),
    ])
      expect(() => parseDividerObservation(value, targets)).toThrow();
  });
  it('enforces raw byte size and note limits without truncating evidence', () => {
    expect(() => parseDividerObservation(raw(observation({ note: 'x'.repeat(801) })), targets)).toThrow();
    expect(() => parseDividerObservation(raw(observation({ note: ' '.repeat(20) })), targets)).toThrow();
    expect(() => parseDividerObservation('가'.repeat(50_001), targets)).toThrow();
    expect(
      parseDividerObservation(raw(observation({ note: 'x'.repeat(800) })), targets).observations[0].note,
    ).toHaveLength(800);
  });
});
